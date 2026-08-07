// cf-panel 前端逻辑：登录、分组服务器列表、xterm 终端（自动重连）、公告/设置、PAT 管理
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  let token = localStorage.getItem('cfpanel_token') || '';
  let canExec = true; // 当前用户是否有 exec 权限（PAT 按 scopes，admin 恒有；控制终端/文件菜单显隐）
  let serversCache = [];
  let pushWs = null;       // 服务器列表实时推送 WS
  let pushTimer = null;    // 每 3 秒发一次 sync 请求的定时器
  let pushRetries = 0;     // 推送重连计数
  let monitorState = null; // { serverId, serverName, range } 当前监控视图
  let monitorChart = null; // Chart.js 实例（切换范围时销毁重建）
  const TERM_RETRY_MAX = 3; // 终端断线自动重连次数

  // ---------- 基础 ----------
  async function api(path, opts = {}) {
    const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
    if (token) headers.authorization = `Bearer ${token}`;
    const resp = await fetch(path, { ...opts, headers });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    return data;
  }

  function toast(msg, ms = 2500) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add('hidden'), ms);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fmtBytes(n) {
    if (n == null) return '-';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = n, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 100 ? 0 : 1) + units[i];
  }

  // ---------- 公开设置（公告/站点名，存 D1 kv_json） ----------
  let geoEnabled = false; // IP 归属地第三方查询开关（默认关闭）
  async function loadPublic() {
    try {
      const s = await api('/api/public/settings');
      if (s.site_name) document.title = s.site_name;
      geoEnabled = !!s.geo_lookup;
      const bar = $('#notice-bar');
      if (s.notice) {
        bar.textContent = s.notice;
        bar.classList.remove('hidden');
      } else {
        bar.classList.add('hidden');
      }
    } catch { /* ignore */ }
  }

  // ---------- 鉴权视图 ----------
  function showAuth() {
    stopPush();
    $('#auth').classList.remove('hidden');
    $('#app').classList.add('hidden');
  }
  function showApp(user) {
    $('#auth').classList.add('hidden');
    $('#app').classList.remove('hidden');
    $('#whoami').textContent = user.is_pat ? `令牌（${escapeHtml(user.username)}）` : escapeHtml(user.username || 'admin');
    // PAT：exec 权限决定终端/文件菜单显隐（admin 恒有 exec）
    canExec = user.role === 1 || (user.pat && user.pat.scopes.includes('server:exec'));
    loadServers(); // 先拉一次，WS 建立后每 3 秒由服务端推送覆盖
    startPush();
    resetIdle(); // 空闲观看保护：登录后开始计时
  }

  let loginBusy = false;
  async function doLogin() {
    if (loginBusy) return; // 防重复提交
    loginBusy = true;
    const btn = $('#btn-login');
    btn.disabled = true;
    btn.textContent = '登录中...';
    const password = $('#auth-pass').value;
    const msg = $('#auth-msg');
    msg.textContent = '';
    try {
      const data = await api('/api/login', { method: 'POST', body: JSON.stringify({ password }) });
      token = data.token;
      localStorage.setItem('cfpanel_token', token);
      showApp(data.user);
    } catch (e) {
      msg.textContent = e.message;
    } finally {
      loginBusy = false;
      btn.disabled = false;
      btn.textContent = '登录';
    }
  }

  // ---------- 服务器 ----------
  async function loadServers() {
    try {
      serversCache = await api('/api/servers');
      renderServers();
    } catch (e) {
      if (String(e.message).includes('401') || String(e.message).includes('unauthorized')) {
        token = ''; localStorage.removeItem('cfpanel_token'); showAuth(); return; // showAuth 内会 stopPush
      }
      toast(e.message);
    }
  }

  // 悬浮指标详情：展示 agent 上报的全部监控条目 + 系统信息
  function metricTipHtml(m, info) {
    const e = m.extra || {};
    const rows = [];
    rows.push(['CPU', m.cpu != null ? m.cpu.toFixed(1) + '%' : '-']);
    rows.push(['内存', m.mem_used != null
      ? fmtBytes(m.mem_used) + (m.mem_total ? ' / ' + fmtBytes(m.mem_total) + ' (' + (m.mem_used / m.mem_total * 100).toFixed(0) + '%)' : '')
      : '-']);
    rows.push(['Swap', e.swap != null ? fmtBytes(e.swap) : '-']);
    rows.push(['负载 (1/5/15)', [e.load1, e.load5, e.load15].map((v) => (v != null ? Number(v).toFixed(2) : '-')).join(' / ')]);
    rows.push(['网络', (m.net_in != null ? '↓ ' + fmtBytes(m.net_in) + '/s' : '-') + ' · ' + (m.net_out != null ? '↑ ' + fmtBytes(m.net_out) + '/s' : '-')]);
    if (e.procs != null) rows.push(['进程数', e.procs]);
    if (e.tcp != null) rows.push(['TCP / UDP', e.tcp + ' / ' + (e.udp != null ? e.udp : '-')]);
    rows.push(['温度', e.temp != null ? Number(e.temp).toFixed(1) + ' °C' : 'N/A']);
    const items = rows.map(([k, v]) => `<div class="mt-row"><span>${k}</span><b>${v}</b></div>`).join('');
    // 系统信息：内核 / IP 等（info 仅在 info_json 变更时更新）
    let sysHtml = '';
    if (info) {
      const sys = [
        ['系统', info.os],
        ['内核', info.kern],
        ['IPv4', info.ip4],
        ['IPv6', info.ip6],
      ].filter(([, v]) => v);
      if (sys.length) {
        sysHtml = `<div class="mt-sub">系统信息</div>` + sys.map(([k, v]) =>
          `<div class="mt-row"><span>${k}</span><b>${escapeHtml(v)}</b></div>`).join('');
      }
    }
    let diskHtml = '';
    if (Array.isArray(e.disk) && e.disk.length) {
      diskHtml = `<div class="mt-sub">磁盘（${e.disk.length} 个挂载点）</div><div class="mt-disk">` +
        e.disk.map((d) => `<div><span title="${escapeHtml(d.m)}">${escapeHtml(d.m)}</span><b>${d.u}%</b></div>`).join('') + '</div>';
    }
    return `<div class="mt-title">实时指标</div>${items}${sysHtml}${diskHtml}`;
  }

  // 指标行 HTML（数值随推送变化；tooltip 数据内嵌 data-metric，事件委托绑定不受重建影响）
  function metricBlockHtml(s) {
    const m = s.metric;
    if (!m) return '';
    // 磁盘使用率：取所有挂载点中最大
    function diskPct() {
      const arr = m.extra && m.extra.disk;
      if (!Array.isArray(arr) || !arr.length) return '-';
      return Math.max(...arr.map((d) => Number(d.u) || 0)) + '%';
    }
    return `
        <div class="metric" data-metric="${escapeHtml(JSON.stringify({ metric: m, info: s.info || null }))}">
          <span class="m-cell"><b>${m.cpu == null ? '-' : m.cpu.toFixed(1) + '%'}</b><i>CPU</i></span>
          <span class="m-cell"><b>${fmtBytes(m.mem_used)}</b><i>内存</i></span>
          <span class="m-cell"><b>${m.extra && m.extra.load1 != null ? Number(m.extra.load1).toFixed(2) : '-'}</b><i>负载</i></span>
          <span class="m-cell"><b>${m.net_in != null ? fmtBytes(m.net_in) + '/s' : '-'}</b><i>网络↓</i></span>
          <span class="m-cell"><b>${m.extra && m.extra.swap != null ? fmtBytes(m.extra.swap) : '-'}</b><i>Swap</i></span>
          <span class="m-cell"><b>${diskPct()}</b><i>磁盘</i></span>
        </div>`;
  }
  // 探活行 HTML
  function probesBlockHtml(s) {
    if (!Array.isArray(s.probes) || !s.probes.length) return '';
    return `
        <div class="probes">${s.probes.map((p) => `<span class="probe ${p.ok ? 'ok' : 'down'}" title="${escapeHtml(p.name)}${p.code ? ` · HTTP ${p.code}` : ''}"><i class="dot"></i>${escapeHtml(p.name)}</span>`).join('')}</div>`;
  }
  function cardHtml(s) {
    const m = s.metric;
    // 开机时间（秒 → 天）
    const up = m && m.extra && m.extra.uptime ? `开机 ${(m.extra.uptime / 86400).toFixed(1)}天` : '';
    // 归属地优先用节点公网出口 IP（wan_ip，仅非私网才使用，能查到地理位置），回退 agent 上报的网卡 IP
    const wan = (s.wan_ip && !GEO_PRIVATE.test(s.wan_ip)) ? s.wan_ip : '';
    const ip = (wan || (s.info && s.info.ip4) || '').trim();
    const info = s.info ? [s.info.os, up, ip].filter(Boolean).join(' · ') : up;
    return `
      <div class="card" data-id="${s.id}">
        <div class="card-head">
          <div class="card-title">
            <span class="name">${escapeHtml(s.name)}</span>
            <button class="more-btn" title="节点操作">⋯</button>
            <div class="card-menu hidden">
              ${canExec ? `<button data-act="term" data-id="${s.id}" data-name="${escapeHtml(s.name)}">终端</button>
              <button data-act="file" data-id="${s.id}" data-name="${escapeHtml(s.name)}">文件</button>` : ''}
              <button data-act="mon" data-id="${s.id}" data-name="${escapeHtml(s.name)}">监控</button>
              <button data-act="custom" data-id="${s.id}" data-name="${escapeHtml(s.name)}">自定义指标</button>
              <button data-act="del" data-id="${s.id}" data-name="${escapeHtml(s.name)}" class="dd-danger">删除</button>
            </div>
          </div>
          <span class="badge ${s.online ? 'on' : 'off'}"><i class="dot"></i>${s.online ? '在线' : '离线'}</span>
        </div>
        ${metricBlockHtml(s)}
        ${probesBlockHtml(s)}
        <div class="meta" data-ip="${escapeHtml(ip)}"><span class="cid">#${s.id}</span>${info ? ' · ' + escapeHtml(info) : ''}</div>
      </div>`;
  }

  // ---------- IP 归属地（HTTPS 免费接口，前端查询；内网 IP 跳过） ----------
  const geoCache = new Map(); // ip -> 归属地标签（国家城市）
  // 私网/保留地址不查询：10.x 172.16-31.x 192.168.x 127.x 169.254.x 0.x 100.64-127.x
  const GEO_PRIVATE = /^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
  async function geoLookup(ip) {
    if (!ip || GEO_PRIVATE.test(ip)) return '';
    if (geoCache.has(ip)) return geoCache.get(ip) || '';
    let label = '';
    // 仅用 HTTPS 源（http:// 在 HTTPS 面板下是混合内容，会被浏览器直接拦截）
    // 主：ipapi.co（https，免费无 key）；备：ipwho.is（https，免费无 key）
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 5000);
      const r = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, { signal: ctl.signal });
      clearTimeout(t);
      const j = await r.json();
      if (j && j.country_name) label = j.country_name + (j.city ? ' ' + j.city : '');
    } catch { /* 换备选 */ }
    if (!label) {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 5000);
        const r = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, { signal: ctl.signal });
        clearTimeout(t);
        const j = await r.json();
        if (j && j.success) label = (j.country || '') + (j.city ? ' ' + j.city : '');
      } catch { /* 查询失败则不显示 */ }
    }
    geoCache.set(ip, label);
    return label;
  }
  // 渲染后异步补充卡片 IP 归属地（默认不查询第三方，保护服务器公网 IP 隐私）
  async function lookupGeo() {
    if (!geoEnabled) return;
    const els = [...document.querySelectorAll('#servers .card .meta[data-ip]')];
    // 并行查询（每个查询有独立 5s 超时，顺序无关），避免多机时串行等待数十秒
    await Promise.allSettled(els.map(async (el) => {
      const ip = el.dataset.ip;
      if (!ip || el.dataset.geoDone) return;
      const label = await geoLookup(ip);
      if (label && el.isConnected) {
        el.dataset.geoDone = '1';
        el.textContent = `${el.textContent} （${label}）`;
      }
    }));
  }

  // 顶部概览条：服务器总数/在线数/平均 CPU/平均负载/总内存
  function renderOverview() {
    const total = serversCache.length;
    const onlineList = serversCache.filter((s) => s.online);
    const mets = onlineList.map((s) => s.metric).filter(Boolean);
    $('#ov-total').textContent = total;
    $('#ov-online').textContent = onlineList.length;
    $('#ov-online').style.color = onlineList.length ? '' : 'var(--muted)';
    if (mets.length) {
      const cpu = mets.reduce((a, m) => a + (m.cpu || 0), 0) / mets.length;
      const load = mets.reduce((a, m) => a + ((m.extra && m.extra.load1) || 0), 0) / mets.length;
      const mem = mets.reduce((a, m) => a + (m.mem_used || 0), 0);
      $('#ov-cpu').textContent = cpu.toFixed(1) + '%';
      $('#ov-load').textContent = load.toFixed(2);
      $('#ov-mem').textContent = fmtBytes(mem);
    } else {
      $('#ov-cpu').textContent = '-';
      $('#ov-load').textContent = '-';
      $('#ov-mem').textContent = '-';
    }
  }

  // 在线老化：服务端只在推送时算 online，两次推送之间由前端按 last_seen_s 倒计时判离线。
  // 20s = 快宽限 15s + 5s 余量；无最新指标（冷启动/D1 兜底）的服务器保留服务端判定不覆盖
  function agingServers() {
    const agingNow = Date.now() / 1000;
    for (const s of serversCache) {
      if (s.metric && s.metric.last_seen_s) {
        s.online = agingNow - s.metric.last_seen_s < 20;
      }
    }
  }
  // 分组标题序列（用于判断分组结构是否变化）
  function groupList() {
    const sorted = [...serversCache].sort((a, b) => (a.display_index || 0) - (b.display_index || 0));
    const groups = {};
    for (const s of sorted) {
      const g = s.group || '未分组';
      (groups[g] = groups[g] || []).push(s);
    }
    // 组内按 display_index（序号）排序，分组按名称排序，「未分组」始终排最后
    return Object.keys(groups).sort(
      (a, b) => (a === '未分组') - (b === '未分组') || a.localeCompare(b, 'zh')
    );
  }
  function renderServers() {
    const box = $('#servers');
    agingServers();
    renderOverview();
    if (!serversCache.length) {
      box.innerHTML = '<div class="empty"><p>还没有服务器</p><p class="muted">点「添加服务器」生成 agent 配置后开始监控</p></div>';
      return;
    }
    const groups = groupList();
    const byGroup = (g) => serversCache
      .filter((s) => (s.group || '未分组') === g)
      .sort((a, b) => (a.display_index || 0) - (b.display_index || 0));
    box.innerHTML = groups.map((g) => `
      <h3 class="group-title">${escapeHtml(g)}（${byGroup(g).length}）</h3>
      <div class="grid">${byGroup(g).map(cardHtml).join('')}</div>`).join('');
    lookupGeo(); // 异步补充各卡片 IP 归属地
  }
  // 推送到达：增量更新已有卡片（指标/探活/徽章），不重建卡片 DOM——
  // 防每秒/每推送全量重建导致 hover 高亮抖动、打开的节点菜单被销毁
  function updateServerCards() {
    const box = $('#servers');
    agingServers();
    // 推送数据已更新：关闭可能过期的指标 tooltip 静态快照（数据时点已变）
    metricTip.classList.remove('show');
    tipSource = null;
    // 服务器增删或分组结构变化 → 低频全量重建
    const domIds = new Set([...box.querySelectorAll('.card')].map((c) => Number(c.dataset.id)));
    const wantIds = new Set(serversCache.map((s) => s.id));
    if (domIds.size !== wantIds.size || [...domIds].some((id) => !wantIds.has(id))) {
      renderServers();
      return;
    }
    const domGroups = [...box.querySelectorAll('.group-title')].map((h) => h.textContent.replace(/[（(]\d+[）)]\s*$/, ''));
    const wantGroups = groupList();
    if (domGroups.join('|') !== wantGroups.join('|')) {
      renderServers();
      return;
    }
    // 增量更新各卡片内容
    for (const s of serversCache) {
      const card = box.querySelector(`.card[data-id="${s.id}"]`);
      if (!card) continue;
      const metaEl = card.querySelector('.meta');
      // 在线徽章（状态切换才动 DOM）
      const badge = card.querySelector('.badge');
      if (badge) {
        const on = s.online;
        if ((on && !badge.classList.contains('on')) || (!on && !badge.classList.contains('off'))) {
          badge.className = `badge ${on ? 'on' : 'off'}`;
          badge.innerHTML = `<i class="dot"></i>${on ? '在线' : '离线'}`;
        }
      }
      // 指标行（重建该块；不含菜单/事件绑定，全局 click 委托不受影响）
      const mh = metricBlockHtml(s);
      const metricEl = card.querySelector('.metric');
      if (mh) {
        if (metricEl) metricEl.outerHTML = mh;
        else if (metaEl) metaEl.insertAdjacentHTML('beforebegin', mh);
      } else if (metricEl) {
        metricEl.remove();
      }
      // 探活行
      const ph = probesBlockHtml(s);
      const probesEl = card.querySelector('.probes');
      if (ph) {
        if (probesEl) probesEl.outerHTML = ph;
        else if (metaEl) metaEl.insertAdjacentHTML('beforebegin', ph);
      } else if (probesEl) {
        probesEl.remove();
      }
    }
    renderOverview();
  }
  // 每秒在线老化：只更新徽章/概览条，不重建 DOM
  function updateAging() {
    agingServers();
    renderOverview();
    document.querySelectorAll('#servers .card').forEach((card) => {
      const s = serversCache.find((x) => x.id === Number(card.dataset.id));
      if (!s) return;
      const badge = card.querySelector('.badge');
      if (!badge) return;
      const on = s.online;
      if ((on && badge.classList.contains('on')) || (!on && badge.classList.contains('off'))) return;
      badge.className = `badge ${on ? 'on' : 'off'}`;
      badge.innerHTML = `<i class="dot"></i>${on ? '在线' : '离线'}`;
    });
  }

  async function addServer() {
    const name = $('#inp-name').value.trim();
    const group = $('#inp-group').value.trim();
    const sortOrder = Number($('#inp-order').value) || 0;
    if (!name) return toast('请输入服务器名称');
    try {
      const cfg = await api('/api/servers', { method: 'POST', body: JSON.stringify({ name, group, sort_order: sortOrder }) });
      const text = `服务器已添加，agent 配置（仅显示一次）：\n\nWSS 地址: ${cfg.wss_base}\nKEY: ${cfg.agent_key}`;
      $('#add-modal').classList.add('hidden');
      unlockScroll();
      infoDialog('服务器已添加 · agent 配置（仅显示一次）', text); // 内部会重新 lockScroll，弹窗期间保持锁定
      loadServers();
    } catch (e) {
      toast(e.message);
    }
  }

  // 连接建立发一次 sync 拉初始列表，此后数据由服务端上报驱动推送（WS 被动接收，不再 3s 轮询）。
  // pushTimer 改为「本地在线老化」：每秒只更新在线徽章/概览条（last_seen_s 随时间流逝
  // 自动判离线，死机服务器不再永远显示在线）；不重建 DOM，防 hover 高亮抖动/菜单被打断
  function startPushTimer() {
    if (pushTimer) clearInterval(pushTimer);
    try { if (pushWs && pushWs.readyState === WebSocket.OPEN) pushWs.send('sync'); } catch { /* ignore */ }
    pushTimer = setInterval(() => {
      if (document.hidden) return; // 后台由 visibilitychange 关 WS，无需老化
      updateAging();
    }, 1000);
  }
  function stopPushTimer() {
    if (pushTimer) { clearInterval(pushTimer); pushTimer = null; }
  }

  // ---------- 服务器列表实时刷新（WS /ws/push，客户端每 3 秒发 sync 请求一次） ----------
  function startPush() {
    if (pushWs && (pushWs.readyState === WebSocket.CONNECTING || pushWs.readyState === WebSocket.OPEN)) return;
    if (!token) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    // token 不放 URL（避免进访问日志/浏览器历史），连接后首帧发送鉴权
    const ws = new WebSocket(`${proto}://${location.host}/ws/push`);
    pushWs = ws;

    ws.onopen = () => {
      pushRetries = 0;
      try { ws.send(JSON.stringify({ type: 'auth', token })); } catch { /* ignore */ }
      startPushTimer();
    };
    ws.onmessage = (ev) => {
      try {
        const list = JSON.parse(ev.data);
        if (Array.isArray(list)) {
          serversCache = list;
          updateServerCards();
        }
      } catch { /* 忽略非 JSON 帧 */ }
    };
    ws.onclose = (ev) => {
      stopPushTimer();
      if (pushWs !== ws) return; // 已被 stopPush 主动关闭
      if (!token) return;
      if (ev && ev.code === 1008) {
        // 鉴权已失效（PAT 撤销/连接被服务端拒绝）：清除登录态回登录页，避免 3s 重连死循环
        token = '';
        localStorage.removeItem('cfpanel_token');
        showAuth();
        return;
      }
      if (pushRetries < 5) {
        pushRetries += 1;
        setTimeout(startPush, 3000);
      } else {
        toast('实时刷新连接失败，正在自动重试...');
        // 重连耗尽后 30s 兜底重试：服务恢复后自动连回，无需手动刷新
        setTimeout(startPush, 30000);
      }
    };
    ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
  }

  function stopPush() {
    stopPushTimer();
    if (!pushWs) return;
    const w = pushWs;
    pushWs = null;
    try { w.close(); } catch { /* ignore */ }
  }

  // ---------- 空闲观看保护（类似视频网站"继续观看？"） ----------
  // 长时间无浏览器操作 → 提示并暂停实时刷新：断开 /ws/push → 观看者数减 1 →
  // 服务端下发慢采 → agent 恢复 120s 上报，节省 Cloudflare 额度（快采 5s ≈ 17,280 帧/天/机）
  const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 无操作 10 分钟判定空闲
  const IDLE_PROMPT_MS = 60 * 1000;       // 提示后 60s 无响应自动暂停
  let idleTimer = null;
  let idlePromptTimer = null;
  let idlePaused = false;
  let idlePrompting = false; // 提示弹窗显示中（期间用户活动不清自动暂停倒计时）

  function resetIdle() {
    if (idlePaused || !token) return;
    clearTimeout(idleTimer);
    if (!idlePrompting) clearTimeout(idlePromptTimer); // 提示中保留 60s 自动暂停兜底
    idleTimer = setTimeout(onIdleTimeout, IDLE_TIMEOUT_MS);
  }
  function onIdleTimeout() {
    if (!token || idlePaused || idlePrompting) return;
    idlePrompting = true;
    const pause = () => { idlePrompting = false; pauseViewing(); };
    // 确认=继续观看（重置计时）；取消=立即暂停；关闭弹窗=忽略提示（60s 倒计时自动暂停兜底）
    confirmDialog('长时间未操作。为节省 Cloudflare 额度，将暂停实时刷新（agent 将恢复慢采）。\n\n点击「确认」继续观看，或「取消」暂停；60 秒无响应将自动暂停。', () => { idlePrompting = false; resetIdle(); }, pause);
    idlePromptTimer = setTimeout(() => { idlePrompting = false; pauseViewing(); }, IDLE_PROMPT_MS);
  }
  function pauseViewing() {
    if (idlePaused) return;
    idlePaused = true;
    idlePrompting = false;
    clearTimeout(idleTimer);
    clearTimeout(idlePromptTimer);
    stopPush(); // 断开 /ws/push → 观看者减 1 → agent 恢复慢采
    toast('已暂停实时刷新（agent 恢复慢采，节省额度）。移动鼠标或按键即可恢复。');
  }
  function resumeViewing() {
    if (!idlePaused) return;
    idlePaused = false;
    idlePrompting = false;
    startPush(); // 重连 /ws/push → 观看者加 1 → agent 恢复快采
    resetIdle();
    toast('已恢复实时刷新。');
  }
  // 用户活动：暂停中 → 恢复观看；观看中 → 重置空闲计时
  ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'].forEach((ev) => {
    document.addEventListener(ev, () => {
      if (idlePaused) resumeViewing();
      else resetIdle();
    }, { passive: true });
  });

  // 后台标签页隐藏时关闭整个 WS（观看者计数减 1 → agent 恢复慢采，后台接近零成本）；
  // 恢复可见时重建连接：onopen 发 auth + startPushTimer 立即拉取一次并恢复 3s 定时
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopPush();
    } else if (token) {
      startPush();
    }
  });

  // ---------- 弹窗滚动锁定：打开时锁住页面滚动，避免滚动穿透到背景 ----------
  function lockScroll() { document.body.style.overflow = 'hidden'; }
  function unlockScroll() { document.body.style.overflow = ''; }

  // ---------- 通用对话框（替代系统 alert/confirm） ----------
  function closeDialog() {
    $('#dialog').classList.add('hidden');
    unlockScroll();
  }
  function infoDialog(title, text, mono = true) {
    $('#dialog-title').textContent = title;
    $('#dialog-text').textContent = text;
    $('#dialog-text').classList.toggle('mono', !!mono);
    $('#btn-dialog-ok').classList.add('hidden');
    $('#btn-dialog-cancel').textContent = '知道了';
    $('#btn-dialog-cancel').classList.remove('hidden');
    $('#dialog').classList.remove('hidden');
    lockScroll();
    $('#btn-dialog-close').onclick = closeDialog;
    $('#btn-dialog-cancel').onclick = closeDialog;
  }
  function confirmDialog(message, onOk, onCancel) {
    $('#dialog-title').textContent = '确认';
    $('#dialog-text').textContent = message;
    $('#dialog-text').classList.remove('mono');
    $('#btn-dialog-ok').classList.remove('hidden');
    $('#btn-dialog-cancel').textContent = '取消';
    $('#btn-dialog-cancel').classList.remove('hidden');
    $('#dialog').classList.remove('hidden');
    lockScroll();
    $('#btn-dialog-close').onclick = closeDialog;
    $('#btn-dialog-cancel').onclick = () => { closeDialog(); onCancel && onCancel(); };
    $('#btn-dialog-ok').onclick = () => { closeDialog(); onOk && onOk(); };
  }

  // ---------- 终端（断线自动重连） ----------
  function openTerminal(serverId, serverName) {
    $('#term-title').textContent = `终端 · ${serverName}`;
    $('#term-modal').classList.remove('hidden');
    lockScroll();
    $('#term').innerHTML = '';

    const Term = window.Terminal;
    const Fit = (window.FitAddon && window.FitAddon.FitAddon) || window.FitAddon;
    const term = new Term({ cursorBlink: true, fontSize: 13, theme: { background: '#000' } });
    const fit = new Fit();
    term.loadAddon(fit);
    term.open($('#term'));

    let ws = null;
    let closed = false;
    let retries = 0;
    let noDataTimer = null;  // 连接后无数据超时（open_terminal 可能丢失）
    let rebuilding = false;  // 无响应重建中，避免与 onclose 重连重复

    const close = () => {
      if (closed) return;
      closed = true;
      if (noDataTimer) { clearTimeout(noDataTimer); noDataTimer = null; }
      try { ws && ws.close(); } catch { /* ignore */ }
      term.dispose();
      $('#term-modal').classList.add('hidden');
      unlockScroll();
      // 移除 resize 监听器，防多次开关终端累积内存泄漏
      window.removeEventListener('resize', onResize);
    };
    $('#btn-term-close').onclick = close;

    function connect() {
      api('/api/terminal', { method: 'POST', body: JSON.stringify({ server_id: serverId }) })
        .then((res) => {
          const proto = location.protocol === 'https:' ? 'wss' : 'ws';
          // token 不放 URL（避免进访问日志/浏览器历史），连接后首帧发送鉴权
          const w = new WebSocket(`${proto}://${location.host}/ws/terminal/${res.session_id}`);
          ws = w;
          w.binaryType = 'arraybuffer';

          w.onopen = () => {
            retries = 0;
            rebuilding = false;
            term.focus();
            // 必须先发 auth（服务端首帧鉴权），再调用会触发 onResize 发 resize 帧的 fit.fit()，
            // 否则 resize 抢在 auth 前被当作未鉴权拒绝（表现为首次"连接断开"，重连才成功）
            try { w.send(JSON.stringify({ type: 'auth', token })); } catch { /* ignore */ }
            fit.fit();
            w.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
            // 自愈：连接后长时间无数据（open_terminal 在 agent 重连窗口丢失）→ 重建会话
            if (noDataTimer) clearTimeout(noDataTimer);
            noDataTimer = setTimeout(() => {
              noDataTimer = null;
              if (closed || rebuilding) return;
              term.write('\r\n\x1b[90m[会话无响应，正在重建...]\x1b[0m\r\n');
              rebuilding = true;
              try { w.close(); } catch { /* ignore */ }
              connect();
            }, 8000);
          };
          w.onmessage = (ev) => {
            if (noDataTimer) { clearTimeout(noDataTimer); noDataTimer = null; } // 有数据即会话正常
            if (typeof ev.data === 'string') term.write(ev.data);
            else term.write(new Uint8Array(ev.data));
          };
          w.onclose = (ev) => {
            if (closed) return;
            if (rebuilding) return; // 重建已由无响应分支的 connect() 接管
            if (noDataTimer) { clearTimeout(noDataTimer); noDataTimer = null; }
            if (ev && ev.code === 1008) {
              // 鉴权已失效（PAT 撤销/服务端拒绝）：关闭会话并回登录页，不再重连
              closed = true;
              term.write('\r\n\x1b[90m[权限已失效，连接已关闭]\x1b[0m\r\n');
              token = '';
              localStorage.removeItem('cfpanel_token');
              showAuth();
              return;
            }
            if (retries < TERM_RETRY_MAX) {
              retries += 1;
              term.write(`\r\n\x1b[90m[连接断开，${retries}s 后自动重连...]\x1b[0m\r\n`);
              setTimeout(connect, retries * 1000);
            } else {
              term.write('\r\n\x1b[90m[连接已关闭]\x1b[0m\r\n');
            }
          };
          w.onerror = () => { try { w.close(); } catch { /* ignore */ } };
        })
        .catch((e) => {
          if (closed) return;
          if (retries < TERM_RETRY_MAX) {
            retries += 1;
            term.write(`\r\n[创建会话失败：${e.message}，${retries}s 后重试]\r\n`);
            setTimeout(connect, retries * 1000);
          } else {
            term.write(`\r\n[创建会话失败：${e.message}]\r\n`);
          }
        });
    }

    // 键盘输入 → WS；窗口变化 → resize 帧（走 DO → 控制 WS → stty）
    term.onData((data) => { if (ws && ws.readyState === 1) ws.send(data); });
    term.onResize(({ cols, rows }) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols, rows })); });
    const onResize = () => { if (!closed) { try { fit.fit(); } catch { /* ignore */ } } };
    window.addEventListener('resize', onResize);

    connect();
  }

  // ---------- 文件管理（目录浏览 / 上传 / 下载） ----------
  let fileWs = null;
  let fileCwd = '/';
  let fileServerId = 0;      // 当前文件会话所属服务器（断线重连用）
  let fileServerName = '';
  const FILE_CHUNK = 512 * 1024;       // 分段传输块大小 512KB（base64 后 ~683KB < workerd 入站 1MB 限制）
  const FILE_MAX = 500 * 1024 * 1024;  // 单文件大小上限 500MB
  let fileUpload = null;               // { size, sent } 上传进度
  let fileDownload = null;             // { path, size, parts, received } 下载进度
  let fileFilterTimer = null;          // 过滤输入框 debounce 定时器

  // 重新拉取列表（带当前通配符过滤规则）。过滤在 agent 端完成（先过滤再截断 1000 条），
  // 避免大目录下前端只拿到截断区间子集而遗漏匹配文件
  function reloadFileList() {
    let pattern = $('#file-filter').value.trim();
    // Everything 风格：无通配符的纯文本按「子串包含」匹配（*文本*）——输入 dotnet 能匹配
    // dotnet-sdk-*.exe 等任意位置包含的文件；含 * 或 ? 时保留通配符语义（*.log、dotnet*）
    if (pattern && !/[*?]/.test(pattern)) pattern = `*${pattern}*`;
    const body = { type: 'list', path: fileCwd };
    if (pattern) body.pattern = pattern;
    fileSend(body);
  }

  function fileParent(p) {
    const t = String(p || '/').replace(/\/+$/, '');
    const i = t.lastIndexOf('/');
    return i <= 0 ? '/' : t.slice(0, i);
  }
  function fileJoin(dir, name) {
    return (dir === '/' ? '' : dir) + '/' + name;
  }

  async function openFileManager(serverId, serverName) {
    try {
      fileServerId = serverId;
      fileServerName = serverName;
      const res = await api('/api/file/open', { method: 'POST', body: JSON.stringify({ server_id: serverId }) });
      fileCwd = '/';
      $('#file-title').textContent = `文件管理 · ${serverName}`;
      $('#file-path').value = '/';
      $('#file-filter').value = '';
      $('#file-msg').textContent = '';
      $('#file-list').innerHTML = '<tr><td colspan="4" class="muted">连接中...</td></tr>';
      $('#file-modal').classList.remove('hidden');
      lockScroll();
      closeFileWs();
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      // token 不放 URL（避免进访问日志/浏览器历史），连接后首帧发送鉴权
      const ws = new WebSocket(`${proto}://${location.host}/ws/file/${res.session_id}`);
      fileWs = ws;
      ws.onopen = () => { fileSend({ type: 'auth', token }); reloadFileList(); };
      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') {
          // Binary 混合帧：read_result（JSON 头\n + 原始字节，无 base64 膨胀）
          const p = ev.data instanceof ArrayBuffer
            ? Promise.resolve(new Uint8Array(ev.data))
            : ev.data.arrayBuffer().then((b) => new Uint8Array(b));
          p.then((buf) => {
            const nl = buf.indexOf(10);
            if (nl < 0) return;
            let j; try { j = JSON.parse(new TextDecoder().decode(buf.subarray(0, nl))); } catch { return; }
            if (j.type === 'read_result' && j.ok) onReadResult(j, buf.subarray(nl + 1));
          }).catch(() => { /* ignore */ });
          return;
        }
        let j; try { j = JSON.parse(ev.data); } catch { return; }
        if (j.type === 'list_result' && j.ok) {
          renderFileList(j.entries); // agent 端已按过滤规则返回
          // 截断提示随状态更新（从截断目录切到正常目录时清除残留提示）
          $('#file-msg').textContent = j.truncated ? '目录条目过多，仅显示前 1000 项' : '';
        }
        else if (j.type === 'write_result' && j.ok) onWriteResult(j);
        else if (j.type === 'error') $('#file-msg').textContent = `错误：${j.message}`;
      };
      ws.onclose = () => {
        if (fileWs !== ws) return;
        fileWs = null;
        // 断线提示（弹窗仍打开时）；点「刷新」会重新建立会话（M2：与终端一致，不静默失效）
        if (!$('#file-modal').classList.contains('hidden')) $('#file-msg').textContent = '连接断开，点击「刷新」重连';
      };
      ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
    } catch (e) {
      toast(e.message);
    }
  }

  function closeFileWs() {
    if (fileWs) { try { fileWs.close(); } catch { /* ignore */ } fileWs = null; }
  }

  function closeFileModal() {
    closeFileWs();
    $('#file-modal').classList.add('hidden');
    unlockScroll();
  }

  function fileSend(obj) {
    if (fileWs && fileWs.readyState === 1) fileWs.send(JSON.stringify(obj));
  }

  function renderFileList(entries) {
    const rows = entries.map((e) => {
      const size = e.type === 'dir' ? '—' : fmtBytes(e.size);
      const time = e.mtime ? new Date(e.mtime * 1000).toLocaleString('zh-CN') : '—';
      const nameCell = e.type === 'dir'
        ? `<a class="f-dir" data-path="${escapeHtml(fileJoin(fileCwd, e.name))}">📁 ${escapeHtml(e.name)}</a>`
        : `<span class="f-file">📄 ${escapeHtml(e.name)}</span>`;
      const dl = e.type === 'file' ? `<button class="ghost f-dl" data-path="${escapeHtml(fileJoin(fileCwd, e.name))}" data-size="${e.size}">下载</button>` : '';
      return `<tr><td>${nameCell}</td><td>${size}</td><td>${escapeHtml(time)}</td><td>${dl}</td></tr>`;
    });
    $('#file-list').innerHTML = rows.join('') || '<tr><td colspan="4" class="muted">空目录</td></tr>';
  }

  // 分段下载：按 1MB 逐段拉取，累计到文件大小后组装 Blob 下载
  // 下载进行中显示/结束隐藏取消按钮
  function setDlCancelVisible(v) { $('#btn-dl-cancel').classList.toggle('hidden', !v); }
  function downloadFile(path, size) {
    if (fileDownload) { $('#file-msg').textContent = '已有下载进行中，请等待完成'; return; } // 并发防护
    if (size > FILE_MAX) { $('#file-msg').textContent = '文件超过 500MB 限制'; return; }
    if (size <= 0) { $('#file-msg').textContent = '空文件，无需下载'; return; }
    fileDownload = { path, size, parts: [], received: 0 };
    $('#file-msg').textContent = '开始下载...';
    setDlCancelVisible(true);
    fileSend({ type: 'read', path, offset: 0, limit: FILE_CHUNK });
  }
  // 取消下载：停止后续 read 请求（并发已被 downloadFile 防护拦截）
  function cancelDownload() {
    if (!fileDownload) return;
    fileDownload = null;
    $('#file-msg').textContent = '已取消下载';
    setDlCancelVisible(false);
  }

  function onReadResult(j, data) {
    if (!fileDownload || j.path !== fileDownload.path) {
      // 取消后的迟到响应：静默丢弃（正常异常路径已由 downloadFile 并发防护覆盖）
      return;
    }
    if (j.got === 0) {
      // 读取到 EOF 但未达预期 size → 文件已缩短/被替换，中止避免无限循环
      $('#file-msg').textContent = `文件已变化或缩短，中止下载（已完成 ${fileDownload.received}/${fileDownload.size} 字节）`;
      fileDownload = null;
      setDlCancelVisible(false);
      return;
    }
    // 混合帧：data 为原始字节（Uint8Array），由 onmessage Binary 分支传入
    if (!data) return;
    fileDownload.parts.push(data);
    fileDownload.received += j.got;
    const pct = fileDownload.size ? Math.min(100, Math.round((fileDownload.received / fileDownload.size) * 100)) : 0;
    $('#file-msg').textContent = `下载中：${pct}%`;
    if (fileDownload.received >= fileDownload.size) {
      try {
        // Blob 直接引用分块数组（不复制），避免 500MB 级文件的二次内存拷贝
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob(fileDownload.parts));
        a.download = fileDownload.path.split('/').pop() || 'download';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(a.href);
        $('#file-msg').textContent = `已下载：${fileDownload.path}`;
      } catch {
        $('#file-msg').textContent = '下载失败';
      }
      fileDownload = null;
      setDlCancelVisible(false);
    } else {
      fileSend({ type: 'read', path: j.path, offset: fileDownload.received, limit: FILE_CHUNK });
    }
  }

  // 分段上传：1MB 一段，最后一块 commit=true（agent 端原子写）。
  // stop-and-wait——每块等 write_result 确认后才发下一块，队列有界（1 块）。
  // upload_id：唯一标识本次上传（临时文件 {path}.upload.{id}），并发/重复上传互不冲突；
  // acked 按 agent 返回的真实 written 字节累计。
  function uploadFile(file) {
    if (file.size > FILE_MAX) { $('#file-msg').textContent = '文件超过 500MB 限制'; return; }
    const uploadId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(36).slice(2);
    fileUpload = { size: file.size, sent: 0, acked: 0, uploadId, path: fileJoin(fileCwd, file.name) };
    const reader = new FileReader();
    const sendNext = () => {
      if (!fileUpload || fileUpload.sent >= fileUpload.size) return;
      const chunk = file.slice(fileUpload.sent, Math.min(fileUpload.sent + FILE_CHUNK, file.size));
      reader.onload = () => {
        if (!fileUpload) return; // 取消上传后 reader 异步完成，避免引用已置空对象
        const commit = fileUpload.sent + chunk.size >= file.size;
        // 混合帧：JSON 头 + '\n' + 原始字节（Binary 帧，无 base64 膨胀）
        const head = new TextEncoder().encode(JSON.stringify({ type: 'write', path: fileUpload.path, offset: fileUpload.sent, commit, upload_id: fileUpload.uploadId }) + '\n');
        const data = new Uint8Array(reader.result);
        const frame = new Uint8Array(head.length + data.length);
        frame.set(head, 0);
        frame.set(data, head.length);
        if (fileWs && fileWs.readyState === 1) fileWs.send(frame.buffer);
        fileUpload.sent += chunk.size; // 下一块在 onWriteResult 确认后发送
      };
      reader.readAsArrayBuffer(chunk);
    };
    fileUpload.sendNext = sendNext;
    $('#btn-file-cancel').classList.remove('hidden');
    sendNext();
  }

  // 取消上传：发 abort 清理 agent 临时文件
  function cancelUpload() {
    if (!fileUpload) return;
    fileSend({ type: 'abort', path: fileUpload.path, upload_id: fileUpload.uploadId });
    fileUpload = null;
    $('#file-msg').textContent = '已取消上传';
    $('#btn-file-cancel').classList.add('hidden');
  }

  // 只有所有块都收到 write_result 确认后才算完成；acked 按真实 written 累计
  function onWriteResult(j) {
    if (!fileUpload) return; // 无进行中的上传任务，忽略
    const w = Number(j.written) || 0;
    fileUpload.acked = Math.min(fileUpload.size, fileUpload.acked + w);
    if (fileUpload.acked >= fileUpload.size) {
      fileUpload = null;
      $('#file-msg').textContent = '上传完成';
      $('#btn-file-cancel').classList.add('hidden');
      reloadFileList(); // 刷新列表（此时文件已完整写入，保留当前过滤规则）
    } else {
      $('#file-msg').textContent = `上传中：${Math.round((fileUpload.acked / fileUpload.size) * 100)}%`;
      if (fileUpload.sendNext) fileUpload.sendNext(); // 确认后发下一块
    }
  }

  // ---------- 监控（简易文本图，支持时间范围） ----------
  const MONITOR_STEP_MAX = 240; // 长区间降采样目标点数
  const MONITOR_RANGE_LABEL = { '1h': '近1小时', '12h': '近12小时', '3d': '近3天', '7d': '近7天', '30d': '近30天' };
  const MONITOR_COLORS = ['#8b5cf6', '#22d3ee', '#f472b6', '#34d399', '#fbbf24', '#a78bfa'];

  // 长区间数据太多时按区间平均降采样，保证可读性
  function downsample(rows, max = MONITOR_STEP_MAX) {
    if (rows.length <= max) return rows;
    const step = rows.length / max;
    const out = [];
    for (let i = 0; i < max; i++) {
      const start = Math.floor(i * step);
      const slice = rows.slice(start, Math.max(start + 1, Math.floor((i + 1) * step)));
      const agg = { ts: slice[0].ts };
      for (const k of ['cpu', 'mem_used', 'net_in', 'net_out']) {
        const vals = slice.map((r) => r[k]).filter((v) => v != null);
        agg[k] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      }
      out.push(agg);
    }
    return out;
  }

  let monitorReqSeq = 0; // 监控 range 请求序号（快速切换时丢弃过期响应）
  async function showMonitor(serverId, serverName, range) {
    range = range || '12h';
    monitorState = { serverId, serverName, range };
    const seq = ++monitorReqSeq;
    document.querySelectorAll('.range-btn').forEach((b) => b.classList.toggle('active', b.dataset.range === range));
    try {
      const data = await api(`/api/monitor?server_id=${serverId}&range=${range}`);
      if (seq !== monitorReqSeq) return; // 过期响应（慢的旧 range 先返回）丢弃，防覆盖新 range 图表
      const rows = data.system || data; // 兼容：新结构 {system, custom}
      const custom = data.custom || {};
      const label = MONITOR_RANGE_LABEL[range] || range;
      const cCount = Object.keys(custom).length;
      $('#monitor-title').textContent = `监控 · ${serverName}（${label}，${rows.length} 点${rows.length > MONITOR_STEP_MAX ? '，降采样' : ''}${cCount ? ` +${cCount} 自定义` : ''}）`;
      $('#monitor-modal').classList.remove('hidden'); // 先显示，保证 canvas 有尺寸
      lockScroll();
      renderMonitorChart(downsample(rows), custom);
    } catch (e) {
      toast(e.message);
    }
  }

  function renderMonitorChart(rows, custom) {
    const wrap = $('#monitor-modal .chart-wrap');
    if (monitorChart) { monitorChart.destroy(); monitorChart = null; }
    // 重建 canvas（用固定容器定位，canvas 可能被上次提示文本覆盖导致元素为空）
    const canvas = wrap.querySelector('#monitor-chart');
    if (!canvas || canvas.tagName !== 'CANVAS') wrap.innerHTML = '<canvas id="monitor-chart"></canvas>';
    if (!window.Chart) {
      wrap.innerHTML = '<p class="muted" style="padding:24px">图表库（Chart.js）加载失败，请检查网络。</p>';
      return;
    }
    if (!rows.length) {
      wrap.innerHTML = '<p class="muted" style="padding:24px">该时间范围暂无数据。</p>';
      return;
    }
    const labels = rows.map((r) => new Date(r.ts * 60000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }));
    const cpus = rows.map((r) => r.cpu);
    const mems = rows.map((r) => (r.mem_used == null ? null : +(r.mem_used / 1048576).toFixed(1)));
    const netIns = rows.map((r) => (r.net_in == null ? null : +(r.net_in / 1024).toFixed(1)));
    const netOuts = rows.map((r) => (r.net_out == null ? null : +(r.net_out / 1024).toFixed(1)));
    const datasets = [
      { label: 'CPU %', data: cpus, borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,.12)', fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2 },
      { label: '内存 MB', data: mems, borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,.08)', fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2, yAxisID: 'y1' },
      { label: '网络↓ KB/s', data: netIns, borderColor: '#22d3ee', backgroundColor: 'transparent', tension: 0.3, pointRadius: 0, borderWidth: 1.5, yAxisID: 'y1', spanGaps: true },
      { label: '网络↑ KB/s', data: netOuts, borderColor: '#f472b6', backgroundColor: 'transparent', tension: 0.3, pointRadius: 0, borderWidth: 1.5, yAxisID: 'y1', spanGaps: true },
    ];
    // 自定义指标（按 ts 对齐系统时间轴，共用右轴；量纲差异仅看趋势）
    Object.entries(custom || {}).forEach(([name, points]) => {
      if (!Array.isArray(points) || !points.length) return;
      const cMap = new Map(points.map((p) => [p.ts, p.value]));
      datasets.push({
        label: name,
        data: rows.map((r) => (cMap.has(r.ts) ? cMap.get(r.ts) : null)),
        borderColor: MONITOR_COLORS[datasets.length % MONITOR_COLORS.length],
        backgroundColor: 'transparent',
        tension: 0.3, pointRadius: 0, borderWidth: 1.5, yAxisID: 'y1',
      });
    });
    monitorChart = new Chart($('#monitor-chart'), {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: '#8b949e', boxWidth: 12 } },
          tooltip: { backgroundColor: '#1c2230', borderColor: '#2d333b', borderWidth: 1, titleColor: '#e6edf3', bodyColor: '#8b949e' },
        },
        scales: {
          x: { ticks: { color: '#8b949e', maxTicksLimit: 8, maxRotation: 0 }, grid: { color: 'rgba(255,255,255,.04)' } },
          y: { position: 'left', ticks: { color: '#8b949e' }, grid: { color: 'rgba(255,255,255,.04)' } },
          y1: { position: 'right', grid: { drawOnChartArea: false }, ticks: { color: '#8b949e' } },
        },
      },
    });
  }

  // ---------- 自定义指标面板（agent CUSTOM_METRICS 采集，存 D1 metrics_custom） ----------
  let customChart = null;
  let customState = { serverId: 0, range: '12h' };

  function openCustomModal(serverId, serverName) {
    customState = { serverId: serverId || 0, range: '12h' };
    $('#custom-title').textContent = serverName ? `自定义指标 · ${serverName}` : '自定义指标';
    $('#custom-modal').classList.remove('hidden');
    lockScroll();
    document.querySelectorAll('#custom-modal .range-btn').forEach((b) => b.classList.toggle('active', b.dataset.range === customState.range));
    api('/api/servers').then((list) => {
      $('#custom-server').innerHTML = '<option value="">选择服务器</option>' +
        list.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
      if (customState.serverId) {
        $('#custom-server').value = String(customState.serverId);
        loadCustomMetrics();
      }
    }).catch((e) => toast(e.message));
  }

  async function loadCustomMetrics() {
    const id = Number($('#custom-server').value) || 0;
    customState.serverId = id;
    if (!id) { renderCustomChart({}); return; }
    try {
      const data = await api(`/api/monitor?server_id=${id}&range=${customState.range}`);
      renderCustomChart(data.custom || {});
    } catch (e) {
      toast(e.message);
    }
  }

  function renderCustomChart(custom) {
    const wrap = $('#custom-modal .chart-wrap');
    if (customChart) { customChart.destroy(); customChart = null; }
    // 若 canvas 被上次提示文本覆盖则重建（用固定容器定位，防重复打开时 #custom-chart 为空）
    const canvas = wrap.querySelector('#custom-chart');
    if (!canvas || canvas.tagName !== 'CANVAS') wrap.innerHTML = '<canvas id="custom-chart"></canvas>';
    if (!window.Chart) {
      wrap.innerHTML = '<p class="muted" style="padding:24px">图表库（Chart.js）加载失败，请检查网络。</p>';
      return;
    }
    const names = Object.keys(custom || {});
    if (!names.length) {
      wrap.innerHTML = '<p class="muted" style="padding:24px">该服务器暂无自定义指标。请在 agent 配置 CUSTOM_METRICS（JSON：name+cmd）后自动上报。</p>';
      return;
    }
    const tsSet = new Set();
    names.forEach((n) => (custom[n] || []).forEach((p) => tsSet.add(p.ts)));
    const tsArr = [...tsSet].sort((a, b) => a - b);
    const labels = tsArr.map((t) => new Date(t * 60000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }));
    const datasets = names.map((n, i) => {
      // Map 索引：O(n) 建索引 + O(1) 查询，避免逐点 find 的 O(n²)（对齐监控图）
      const pMap = new Map((custom[n] || []).map((p) => [p.ts, p.value]));
      return {
        label: n,
        data: tsArr.map((t) => (pMap.has(t) ? pMap.get(t) : null)),
        borderColor: MONITOR_COLORS[i % MONITOR_COLORS.length],
        backgroundColor: 'transparent',
        tension: 0.3, pointRadius: 0, borderWidth: 1.5, spanGaps: true,
      };
    });
    customChart = new Chart($('#custom-chart'), {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: '#8b949e', boxWidth: 12 } },
          tooltip: { backgroundColor: '#1c2230', borderColor: '#2d333b', borderWidth: 1, titleColor: '#e6edf3', bodyColor: '#8b949e' },
        },
        scales: {
          x: { ticks: { color: '#8b949e', maxTicksLimit: 8, maxRotation: 0 }, grid: { color: 'rgba(255,255,255,.04)' } },
          y: { position: 'left', ticks: { color: '#8b949e' }, grid: { color: 'rgba(255,255,255,.04)' } },
        },
      },
    });
  }

  // ---------- 自定义指标设置（生成 agent env 配置片段） ----------
  function openCustomSetupModal() {
    $('#custom-setup-modal').classList.remove('hidden');
    lockScroll();
    $('#custom-setup-out').textContent = '';
  }
  function genCustomCfg() {
    const raw = $('#custom-setup-editor').value.trim();
    try {
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) throw new Error('必须是数组');
      for (const it of arr) {
        if (!it || typeof it !== 'object' || !it.name || !it.cmd) throw new Error('每项需包含 name 与 cmd');
      }
      $('#custom-setup-out').textContent = `# 追加到 /etc/cf-panel-agent.env\nCUSTOM_METRICS='${JSON.stringify(arr)}'`;
    } catch (e) {
      toast('JSON 格式错误：' + e.message);
    }
  }
  function copyCustomCfg() {
    const txt = $('#custom-setup-out').textContent;
    if (!txt) return toast('请先生成配置');
    navigator.clipboard.writeText(txt).then(() => toast('已复制')).catch(() => toast('复制失败，请手动复制'));
  }

  // ---------- 服务监控（服务探活 PROBES）设置 ----------
  function openServiceSetupModal() {
    $('#service-setup-modal').classList.remove('hidden');
    lockScroll();
    $('#service-setup-out').textContent = '';
  }
  function genServiceCfg() {
    const raw = $('#service-probes-input').value.trim();
    if (!raw) return toast('请输入探测配置');
    const items = raw.split(',');
    for (const it of items) {
      const parts = it.split(':');
      if (parts.length < 3 || !['http', 'tcp'].includes(parts[1])) {
        return toast(`格式错误：「${it}」应为 名称:类型(http|tcp):目标`);
      }
    }
    $('#service-setup-out').textContent = `# 追加到 /etc/cf-panel-agent.env\nPROBES="${raw}"`;
  }
  function copyServiceCfg() {
    const txt = $('#service-setup-out').textContent;
    if (!txt) return toast('请先生成配置');
    navigator.clipboard.writeText(txt).then(() => toast('已复制')).catch(() => toast('复制失败，请手动复制'));
  }

  // ---------- 设置 / PAT ----------
  const ALERT_PRESETS = [
    { name: 'Server酱', desc: 'GET，token 在 URL', method: 'GET', url: 'https://sctapi.ftqq.com/{token}.send?title={title}&desp={message}', body: '', ct: '', headers: '' },
    { name: '钉钉机器人', desc: 'POST JSON，token 在 URL', method: 'POST', url: 'https://oapi.dingtalk.com/robot/send?access_token={token}', body: '{"msgtype":"text","text":{"content":"{message}"}}', ct: '', headers: '' },
    { name: '企业微信机器人', desc: 'POST JSON，token 在 URL', method: 'POST', url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key={token}', body: '{"msgtype":"text","text":{"content":"{message}"}}', ct: '', headers: '' },
    { name: 'Telegram Bot', desc: 'POST JSON，token 在 URL', method: 'POST', url: 'https://api.telegram.org/bot{token}/sendMessage', body: '{"chat_id":"你的chat_id","text":"{message}"}', ct: '', headers: '' },
    { name: 'Bark', desc: 'GET，token 在 URL', method: 'GET', url: 'https://api.day.app/{token}/{title}/{message}', body: '', ct: '', headers: '' },
    { name: 'Slack', desc: 'POST 结构化 JSON，token 走 Header', method: 'POST', url: 'https://hooks.slack.com/services/T/B/{token}', body: '', ct: '', headers: '{"Authorization":"Bearer {token}"}' },
  ];

  function renderAlertPresets() {
    const box = $('#alert-preset-list');
    if (!box) return;
    box.innerHTML = ALERT_PRESETS.map((p, i) => `
      <div class="alert-preset">
        <span class="ap-name">${escapeHtml(p.name)}</span>
        <span class="muted">${escapeHtml(p.desc)}</span>
        <button class="ghost ap-use" data-i="${i}">使用</button>
      </div>`).join('');
  }

  // ---------- 下拉菜单各功能入口 ----------
  function openAddModal() {
    $('#inp-name').value = '';
    $('#inp-group').value = '';
    $('#inp-order').value = '';
    $('#add-modal').classList.remove('hidden');
    lockScroll();
    setTimeout(() => $('#inp-name').focus(), 50);
  }

  function openSiteModal() {
    $('#site-modal').classList.remove('hidden');
    lockScroll();
    api('/api/public/settings').then((s) => {
      // 直接回填实际存储值（不再硬编码默认名判断，避免用户真的设成 "cf-panel" 时显示为空）
      $('#set-site-name').value = s.site_name || '';
      $('#set-notice').value = s.notice || '';
      $('#set-geo').checked = !!s.geo_lookup;
    }).catch(() => { /* ignore */ });
  }

  function openAlertsModal() {
    $('#alerts-modal').classList.remove('hidden');
    lockScroll();
    renderAlertPresets();
    api('/api/settings').then((s) => {
      const a = s.alerts || {};
      $('#set-alert-method').value = a.method || 'POST';
      $('#set-alert-url').value = a.webhook_url || '';
      $('#set-alert-token').value = a.webhook_token || '';
      $('#set-alert-body').value = a.body_template || '';
      $('#set-alert-content-type').value = a.content_type || '';
      $('#set-alert-headers').value = a.headers ? JSON.stringify(a.headers) : '';
      $('#set-alert-cpu').value = a.cpu_pct || '';
      $('#set-alert-mem').value = a.mem_pct || '';
      $('#set-alert-disk').value = a.disk_pct || '';
      $('#set-alert-load').value = a.load || '';
      $('#set-alert-cooldown').value = a.cooldown_min || '';
      $('#set-alert-offline').value = a.offline_after_s || '';
    }).catch(() => { /* ignore */ });
  }

  function openTokensModal() {
    $('#tokens-modal').classList.remove('hidden');
    lockScroll();
    loadTokens();
    loadTokenServerHint();
  }

  // 在 PAT 弹窗展示「server_id = 服务器名」参考列表，方便填白名单
  async function loadTokenServerHint() {
    try {
      const list = await api('/api/servers');
      $('#tok-hint').textContent = list.length
        ? 'server_id 参考：' + list.map((s) => `${s.id}=${s.name}`).join('，')
        : '暂无服务器';
    } catch { /* 加载失败则不提示 */ }
  }

  async function saveSite() {
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ site_name: $('#set-site-name').value, notice: $('#set-notice').value, geo_lookup: $('#set-geo').checked }),
      });
      toast('站点信息已保存');
      loadPublic();
    } catch (e) {
      toast(e.message);
    }
  }

  async function saveAlerts() {
    const num = (v) => (v.trim() ? Number(v) : 0);
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          alerts: {
            webhook_url: $('#set-alert-url').value.trim(),
            webhook_token: $('#set-alert-token').value.trim(),
            method: $('#set-alert-method').value,
            body_template: $('#set-alert-body').value.trim(),
            content_type: $('#set-alert-content-type').value.trim(),
            headers: $('#set-alert-headers').value.trim(),
            cpu_pct: num($('#set-alert-cpu').value),
            mem_pct: num($('#set-alert-mem').value),
            disk_pct: num($('#set-alert-disk').value),
            load: num($('#set-alert-load').value),
            cooldown_min: num($('#set-alert-cooldown').value),
            offline_after_s: num($('#set-alert-offline').value),
          },
        }),
      });
      toast('告警配置已保存');
    } catch (e) {
      toast(e.message);
    }
  }

  async function loadTokens() {
    try {
      const rows = await api('/api/tokens');
      $('#token-list').innerHTML = rows.length
        ? rows.map((r) => `
            <li>${escapeHtml(r.name)} · ${escapeHtml(r.scopes)}${r.server_ids ? ' · ids=' + escapeHtml(r.server_ids) : ''}
              <button data-tok-del="${r.id}" class="danger">删除</button></li>`).join('')
        : '<li class="muted">暂无令牌</li>';
    } catch (e) {
      $('#token-list').innerHTML = `<li class="muted">${escapeHtml(e.message)}</li>`;
    }
  }

  async function createToken() {
    const scopes = [];
    if ($('#tok-read').checked) scopes.push('server:read');
    if ($('#tok-exec').checked) scopes.push('server:exec');
    if (!scopes.length) return toast('至少勾选一个权限');
    const serverIDs = $('#tok-servers').value.split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
    try {
      const res = await api('/api/tokens', {
        method: 'POST',
        body: JSON.stringify({ name: $('#tok-name').value.trim(), scopes, server_ids: serverIDs.length ? serverIDs : null }),
      });
      infoDialog('令牌已创建（仅显示一次）', `令牌：\n${res.token}\n\n用法：Authorization: Bearer ${res.token}`);
      $('#tok-name').value = '';
      $('#tok-servers').value = '';
      loadTokens();
    } catch (e) {
      toast(e.message);
    }
  }

  function deleteToken(id) {
    confirmDialog('确认删除该令牌？', async () => {
      try {
        await api(`/api/tokens/${id}`, { method: 'DELETE' });
        loadTokens();
      } catch (e) {
        toast(e.message);
      }
    });
  }

  // ---------- 审计日志（仅管理员，保留 90 天） ----------
  const AUDIT_ACTION_LABEL = { 'server.create': '添加服务器', 'server.delete': '删除服务器', 'terminal.open': '打开终端', 'file.open': '文件管理' };
  async function openAuditModal() {
    $('#audit-modal').classList.remove('hidden');
    lockScroll();
    await loadAuditLogs();
  }
  async function loadAuditLogs() {
    try {
      const rows = await api('/api/audit-logs?limit=200');
      $('#audit-list').innerHTML = rows.length
        ? rows.map((r) => `
            <li><div class="audit-row">
              <span class="audit-action">${escapeHtml(AUDIT_ACTION_LABEL[r.action] || r.action)}</span>
              <span class="audit-info">${escapeHtml(r.username || `uid=${r.user_id}`)}${r.target_server_id ? ` · server#${escapeHtml(r.target_server_id)}` : ''}${r.detail ? ` · ${escapeHtml(r.detail)}` : ''}</span>
              <span class="audit-time">${escapeHtml(r.created_at || '')}</span>
            </div></li>`).join('')
        : '<li class="muted">暂无审计记录</li>';
    } catch (e) {
      $('#audit-list').innerHTML = `<li class="muted">${escapeHtml(e.message)}</li>`;
    }
  }

  // ---------- 用量观测（仅管理员，/api/usage 额度估算） ----------
  async function openUsageModal() {
    $('#usage-modal').classList.remove('hidden');
    lockScroll();
    await loadUsage();
  }
  async function loadUsage() {
    try {
      const u = await api('/api/usage');
      $('#usage-note').textContent = u.note || '';
      const est = u.estimates_per_day || {};
      $('#usage-est').innerHTML = `
        <div class="usage-item"><span class="usage-num">${est.report_frames ?? '-'}</span><span class="usage-label">上报帧/天</span></div>
        <div class="usage-item"><span class="usage-num">${est.do_events ?? '-'}</span><span class="usage-label">DO 事件/天</span></div>
        <div class="usage-item"><span class="usage-num">${est.d1_writes ?? '-'}</span><span class="usage-label">D1 写行/天</span></div>`;
      // Worker 请求计数（实例级，evict/重启清零，仅趋势参考）
      const apiRows = Object.entries(u.api || {}).sort((a, b) => b[1] - a[1]).slice(0, 10);
      $('#usage-list').innerHTML = apiRows.length
        ? apiRows.map(([k, v]) => `
            <li><div class="audit-row">
              <span class="audit-action">${escapeHtml(k)}</span>
              <span class="audit-info">${v} 次</span>
            </div></li>`).join('')
        : '<li class="muted">暂无请求计数（Worker 实例级）</li>';
    } catch (e) {
      $('#usage-est').innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
      $('#usage-list').innerHTML = '';
    }
  }

  // ---------- 事件绑定 ----------
  $('#btn-login').onclick = (e) => { e.preventDefault(); doLogin(); };

  // 卡片指标悬浮详情：全局 tooltip（挂 body 下，避免 .card:hover transform 包含块破坏 fixed 定位）
  const metricTip = document.createElement('div');
  metricTip.className = 'm-tip';
  document.body.appendChild(metricTip);
  let tipSource = null; // 当前 tooltip 对应的指标区元素
  // 定位到指标区正下方（下方放不下则显示在指标区上方）
  function positionTipForMetric(tip, metricEl) {
    const r = metricEl.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    let x = r.left;
    let y = r.bottom + 8;
    if (x + w > window.innerWidth - 8) x = Math.max(8, window.innerWidth - w - 8);
    if (y + h > window.innerHeight - 8) y = Math.max(8, r.top - h - 8);
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }
  // 点击指标区弹出（固定在指标下方）；再次点击同一指标区/点击外部关闭
  document.addEventListener('click', (e) => {
    const metricEl = e.target.closest('.metric');
    if (metricEl) {
      if (tipSource === metricEl && metricTip.classList.contains('show')) {
        metricTip.classList.remove('show');
        tipSource = null;
        return;
      }
      const raw = metricEl.dataset.metric;
      if (!raw) return;
      let d;
      try { d = JSON.parse(raw); } catch { return; }
      // 兼容新结构 {metric, info} 与旧结构（直接 metric 对象）
      const mm = d && d.metric ? d.metric : d;
      const ii = d && d.metric ? d.info : null;
      tipSource = metricEl;
      metricTip.innerHTML = metricTipHtml(mm, ii);
      metricTip.classList.add('show');
      positionTipForMetric(metricTip, metricEl);
      return;
    }
    if (e.target.closest('.m-tip')) return; // 点击 tooltip 内部不关闭（可滚动）
    metricTip.classList.remove('show');
    tipSource = null;
  });

  // 下拉菜单：切换 / 点击外部关闭 / 菜单项路由
  $('#btn-menu').onclick = (e) => { e.stopPropagation(); $('#dropdown').classList.toggle('hidden'); };
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#dropdown') && !e.target.closest('#btn-menu')) $('#dropdown').classList.add('hidden');
    if (!e.target.closest('.card-menu')) {
      document.querySelectorAll('#servers .card-menu').forEach((m) => m.classList.add('hidden'));
    }
  });
  $('#dropdown').addEventListener('click', (e) => {
    const item = e.target.closest('.dd-item');
    if (!item) return;
    $('#dropdown').classList.add('hidden');
    const act = item.dataset.menu;
    if (act === 'add-server') openAddModal();
    else if (act === 'site') openSiteModal();
    else if (act === 'alerts') openAlertsModal();
    else     if (act === 'custom-setup') openCustomSetupModal();
    else if (act === 'service-setup') openServiceSetupModal();
    else if (act === 'tokens') openTokensModal();
    else if (act === 'audit-logs') openAuditModal();
    else if (act === 'usage') openUsageModal();
    else if (act === 'logout') { token = ''; localStorage.removeItem('cfpanel_token'); showAuth(); }
  });

  // 添加服务器弹窗
  $('#btn-add-server').onclick = addServer;
  $('#btn-add-close').onclick = () => { $('#add-modal').classList.add('hidden'); unlockScroll(); };
  $('#inp-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') addServer(); });

  // 站点信息弹窗
  $('#btn-site-close').onclick = () => { $('#site-modal').classList.add('hidden'); unlockScroll(); };
  $('#btn-save-site').onclick = saveSite;

  // 告警弹窗
  $('#btn-alerts-close').onclick = () => { $('#alerts-modal').classList.add('hidden'); unlockScroll(); };
  $('#btn-save-alerts').onclick = saveAlerts;

  // 自定义指标查看弹窗
  $('#btn-custom-close').onclick = () => { $('#custom-modal').classList.add('hidden'); unlockScroll(); };
  $('#custom-server').addEventListener('change', loadCustomMetrics);
  $('#custom-modal').addEventListener('click', (e) => {
    const btn = e.target.closest('.range-btn');
    if (!btn || !customState.serverId) return;
    customState.range = btn.dataset.range;
    document.querySelectorAll('#custom-modal .range-btn').forEach((b) => b.classList.toggle('active', b.dataset.range === customState.range));
    loadCustomMetrics();
  });

  // 自定义指标设置弹窗
  $('#btn-custom-setup-close').onclick = () => { $('#custom-setup-modal').classList.add('hidden'); unlockScroll(); };
  $('#btn-custom-gen').onclick = genCustomCfg;
  $('#btn-custom-copy').onclick = copyCustomCfg;

  // 服务监控设置弹窗
  $('#btn-service-setup-close').onclick = () => { $('#service-setup-modal').classList.add('hidden'); unlockScroll(); };
  $('#btn-service-gen').onclick = genServiceCfg;
  $('#btn-service-copy').onclick = copyServiceCfg;

  // 访问令牌弹窗
  $('#btn-tokens-close').onclick = () => { $('#tokens-modal').classList.add('hidden'); unlockScroll(); };
  $('#btn-create-token').onclick = createToken;

  // 审计日志弹窗
  $('#btn-audit-close').onclick = () => { $('#audit-modal').classList.add('hidden'); unlockScroll(); };
  // 用量观测弹窗
  $('#btn-usage-close').onclick = () => { $('#usage-modal').classList.add('hidden'); unlockScroll(); };
  $('#token-list').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tok-del]');
    if (btn) deleteToken(Number(btn.dataset.tokDel));
  });

  $('#servers').addEventListener('click', (e) => {
    // 卡片 ⋯ 按钮：切换本卡操作菜单，并收起其他卡片菜单
    const more = e.target.closest('.more-btn');
    if (more) {
      e.stopPropagation();
      const menu = more.parentElement.querySelector('.card-menu');
      document.querySelectorAll('#servers .card-menu').forEach((m) => { if (m !== menu) m.classList.add('hidden'); });
      menu.classList.toggle('hidden');
      return;
    }
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const card = btn.closest('.card');
    if (card) card.querySelector('.card-menu').classList.add('hidden');
    const { act, id, name } = btn.dataset;
    if (act === 'term') openTerminal(Number(id), name);
    else if (act === 'file') openFileManager(Number(id), name);
    else if (act === 'mon') showMonitor(Number(id), name);
    else if (act === 'custom') openCustomModal(Number(id), name);
    else if (act === 'del') {
      confirmDialog(`确认删除服务器「${name}」？`, () => {
        api(`/api/servers/${id}`, { method: 'DELETE' }).then(loadServers).catch((e2) => toast(e2.message));
      });
    }
  });

  // 监控时间范围切换 + 关闭
  $('#monitor-modal').addEventListener('click', (e) => {
    const btn = e.target.closest('.range-btn');
    if (btn && monitorState) showMonitor(monitorState.serverId, monitorState.serverName, btn.dataset.range);
  });
  $('#btn-monitor-close').onclick = () => { $('#monitor-modal').classList.add('hidden'); unlockScroll(); };

  // 告警渠道预设：点击「使用」填入表单模板
  $('#alert-preset-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.ap-use');
    if (!btn) return;
    const p = ALERT_PRESETS[Number(btn.dataset.i)];
    if (!p) return;
    $('#set-alert-method').value = p.method;
    $('#set-alert-url').value = p.url;
    $('#set-alert-body').value = p.body;
    $('#set-alert-content-type').value = p.ct;
    $('#set-alert-headers').value = p.headers;
    $('#set-alert-token').value = '';
    toast(`已填入「${p.name}」模板，请填写 Token`);
  });

  // 文件管理操作
  $('#btn-file-close').onclick = closeFileModal;
  $('#btn-file-cancel').onclick = cancelUpload;
  $('#btn-dl-cancel').onclick = cancelDownload;
  $('#file-refresh').onclick = () => {
    // WS 断开时重建会话（旧会话已失效）；在线则正常刷新列表
    if (!fileWs || fileWs.readyState !== 1) {
      if (fileServerId) openFileManager(fileServerId, fileServerName);
      return;
    }
    reloadFileList();
  };
  $('#file-up').onclick = () => { fileCwd = fileParent(fileCwd); $('#file-path').value = fileCwd; reloadFileList(); };
  $('#file-go').onclick = () => { const p = $('#file-path').value.trim(); if (!p) return; fileCwd = p; reloadFileList(); };
  $('#file-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#file-go').click(); });
  $('#file-input').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) uploadFile(f); e.target.value = ''; });
  // 文件名通配符过滤：debounce 后发 list（pattern 由 agent 端匹配，先过滤再截断）
  $('#file-filter').addEventListener('input', () => {
    clearTimeout(fileFilterTimer);
    fileFilterTimer = setTimeout(reloadFileList, 200);
  });
  $('#file-list').addEventListener('click', (e) => {
    const dir = e.target.closest('.f-dir');
    // 目录点击统一走 reloadFileList（保持当前过滤词，与「刷新」行为一致）
    if (dir) { fileCwd = dir.dataset.path; $('#file-path').value = fileCwd; reloadFileList(); return; }
    const dl = e.target.closest('.f-dl');
    if (dl) downloadFile(dl.dataset.path, Number(dl.dataset.size) || 0);
  });

  // ---------- 弹窗可访问性（role/aria + Esc 关闭 + 焦点管理） ----------
  // 对所有 .modal 注入 dialog 语义；用 MutationObserver 统一做"打开聚焦首个可聚焦元素、
  // 关闭恢复焦点到触发元素"，无需改造各弹窗的打开/关闭调用。
  {
    // 覆盖所有弹窗：.modal 与 .monitor-modal（监控/自定义指标两处）
    const modals = [...document.querySelectorAll('.modal, .monitor-modal')];
    modals.forEach((m) => {
      m.setAttribute('role', 'dialog');
      m.setAttribute('aria-modal', 'true');
    });
    let lastFocus = null;
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        const el = m.target;
        if (el.classList.contains('hidden')) {
          if (lastFocus && lastFocus.focus) lastFocus.focus(); // 关闭：恢复焦点
        } else {
          lastFocus = document.activeElement; // 打开：记录触发元素
          const f = el.querySelector('input,button,select,textarea,[tabindex]');
          if (f && !f.disabled) f.focus();
        }
      }
    });
    modals.forEach((m) => mo.observe(m, { attributes: true, attributeFilter: ['class'] }));
    // Esc 关闭当前打开的弹窗：模拟点击其"关闭"按钮，走既有清理逻辑（如终端 ws/resize），
    // 焦点恢复由上面的 MutationObserver 统一处理
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const open = modals.find((m) => !m.classList.contains('hidden'));
      if (!open) return;
      const closeBtn = open.querySelector('.modal-head button');
      if (closeBtn) closeBtn.click();
      else {
        open.classList.add('hidden');
        unlockScroll();
      }
    });
  }

  // ---------- 启动 ----------
  (async function boot() {
    loadPublic();
    if (!token) return showAuth();
    try {
      const me = await api('/api/me');
      showApp(me);
    } catch (e) {
      token = '';
      localStorage.removeItem('cfpanel_token');
      showAuth();
    }
  })();
})();
