// cf-panel 前端逻辑：登录、分组服务器列表、xterm 终端（自动重连）、公告/设置、PAT 管理
(() => {
  'use strict';
  // 工具函数与 <cf-ip> 组件从 utils.js 解构；api 层从 api.js 解构（index.html 中均须先加载）
  const { $, escapeHtml, fmtBytes, fileJoin, fileParent, downsample, lockScroll, unlockScroll,
          MONITOR_STEP_MAX, MONITOR_RANGE_LABEL, MONITOR_COLORS,
          GEO_PRIVATE, setGeoEnabled, flagHtml, geoLookup, IdleGuard } = CfUtils;
  const { api, setTokenGetter, FileSession, TermSession, PushSession } = CfApi;
  let token = localStorage.getItem('cfpanel_token') || '';
  setTokenGetter(() => token); // api 层通过 getter 读取当前 token
  let canExec = true; // 当前用户是否有 exec 权限（PAT 按 scopes，admin 恒有；控制终端/文件菜单显隐）
  let isAdmin = true; // 当前用户是否面板管理员（JWT 登录；PAT 恒 false；控制修改/删除等管理菜单显隐）
  let serversCache = [];
  let pushTimer = null;    // 每 3 秒发一次 sync 请求的定时器（老化）
  let monitorState = null; // { serverId, serverName, range } 当前监控视图
  let monitorCharts = []; // Chart.js 实例数组（每指标一张图，切换范围时全部销毁重建）

  // ---------- 基础 ----------
  function toast(msg, ms = 2500) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add('hidden'), ms);
  }

  // ---------- 公开设置（公告/站点名，存 D1 kv_json） ----------
  async function loadPublic() {
    try {
      const s = await api('/api/public/settings');
      if (s.site_name) document.title = s.site_name;
      setGeoEnabled(s.geo_lookup); // IP 归属地开关（默认关闭，由 utils.js 管理）
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
    // PAT：exec 权限决定终端/文件菜单显隐（admin 恒有 exec）；修改/删除等管理操作仅 admin（PAT 恒隐藏）
    canExec = user.role === 1 || (user.scopes && user.scopes.includes('server:exec'));
    isAdmin = !user.is_pat;
    // 头部下拉菜单的管理项（添加服务器/站点/告警/自定义指标/服务监控/令牌/审计/用量）按 isAdmin 隐藏，
    // PAT 用户不再看到点击后 403 的入口（退出保留）
    const ADMIN_MENUS = new Set(['add-server', 'site', 'alerts', 'custom-setup', 'service-setup', 'tokens', 'audit-logs', 'usage']);
    document.querySelectorAll('#dropdown .dd-item').forEach((btn) => {
      const m = btn.dataset.menu;
      btn.classList.toggle('hidden', !isAdmin && m && ADMIN_MENUS.has(m));
    });
    loadServers(); // 先拉一次，WS 建立后每 3 秒由服务端推送覆盖
    startPush();
    idleGuard.start(); // 空闲观看保护：登录后开始计时
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
      // 用户名可选：多用户（PANEL_USERS）区分同名密码，单管理员可留空
      const data = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: $('#auth-user').value.trim(), password }) });
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
    rows.push(['Swap', e.swap != null
      ? fmtBytes(e.swap) + (e.swap_total ? ' / ' + fmtBytes(e.swap_total) + ' (' + (e.swap / e.swap_total * 100).toFixed(0) + '%)' : '')
      : '-']);
    rows.push(['负载 (1/5/15)', [e.load1, e.load5, e.load15].map((v) => (v != null ? Number(v).toFixed(2) : '-')).join(' / ')]);
    rows.push(['网络', (m.net_in != null ? '↓ ' + fmtBytes(m.net_in) + '/s' : '-') + ' · ' + (m.net_out != null ? '↑ ' + fmtBytes(m.net_out) + '/s' : '-')]);
    if (e.procs != null) rows.push(['进程数', escapeHtml(e.procs)]);
    if (e.tcp != null) rows.push(['TCP / UDP', escapeHtml(e.tcp) + ' / ' + (e.udp != null ? escapeHtml(e.udp) : '-')]);
    rows.push(['温度', e.temp != null ? Number(e.temp).toFixed(1) + ' °C' : 'N/A']);
    const items = rows.map(([k, v]) => `<div class="mt-row"><span>${k}</span><b>${v}</b></div>`).join('');
    // 系统信息：内核 / IP 等（info 仅在 info_json 变更时更新）
    // IP 用 <cf-ip> 组件（自动归属地查询；私网/回环被 GEO_PRIVATE 过滤仅显示 IP）
    let sysHtml = '';
    if (info) {
      const sys = [
        ['系统', info.os],
        ['内核', info.kern],
        ['Agent', info.agent_version],
      ].filter(([, v]) => v);
      let sysRows = sys.map(([k, v]) => `<div class="mt-row"><span>${k}</span><b>${escapeHtml(v)}</b></div>`).join('');
      if (info.ip4) sysRows += `<div class="mt-row"><span>IPv4</span><b><cf-ip ip="${escapeHtml(info.ip4)}"></cf-ip></b></div>`;
      if (info.ip6) sysRows += `<div class="mt-row"><span>IPv6</span><b><cf-ip ip="${escapeHtml(info.ip6)}"></cf-ip></b></div>`;
      if (sysRows) sysHtml = `<div class="mt-sub">系统信息</div>` + sysRows;
    }
    let diskHtml = '';
    if (Array.isArray(e.disk) && e.disk.length) {
      diskHtml = `<div class="mt-sub">磁盘（${e.disk.length} 个挂载点）</div><div class="mt-disk">` +
        e.disk.map((d) => `<div><span title="${escapeHtml(d.m)}">${escapeHtml(d.m)}</span><b>${escapeHtml(d.u)}%</b></div>`).join('') + '</div>';
    }
    return `<div class="mt-title">实时指标</div>${items}${sysHtml}${diskHtml}`;
  }

  // 指标行 HTML（数值随推送变化；tooltip 数据内嵌 data-metric，事件委托绑定不受重建影响）
  // 有百分比来源的格（CPU/内存/Swap/磁盘）以背景进度条呈现：--p 比例 + --bar-c 分级色（CSS 伪元素渲染）
  function metricBlockHtml(s) {
    const m = s.metric;
    if (!m) return '';
    // 磁盘使用率：取所有挂载点中最大
    function diskPct() {
      const arr = m.extra && m.extra.disk;
      if (!Array.isArray(arr) || !arr.length) return null;
      return Math.max(...arr.map((d) => Number(d.u) || 0));
    }
    const barColor = (p) => (p >= 90 ? '#f85149' : p >= 70 ? '#d29922' : 'var(--accent)');
    // pct 为百分比数值（0-100）：null（无数据/无总量）→ data-nobar 标记，CSS 隐藏填充与波浪；
    // 有值 → --p 比例 + --bar-c 分级色
    const barAttr = (pct) => (pct == null
      ? ' data-nobar'
      : ` style="--p:${(Math.max(0, Math.min(pct, 100)) / 100).toFixed(3)};--bar-c:${barColor(pct)}"`);
    const memPct = m.mem_total > 0 ? m.mem_used / m.mem_total * 100 : null;
    const swap = m.extra && m.extra.swap;
    const swapTotal = m.extra && m.extra.swap_total;
    const swapPct = swap != null && swapTotal > 0 ? swap / swapTotal * 100 : null;
    const dPct = diskPct();
    return `
        <div class="metric" data-metric="${escapeHtml(JSON.stringify({ metric: m, info: s.info || null }))}">
          <span class="m-cell"${barAttr(m.cpu)}><b>${m.cpu == null ? '-' : m.cpu.toFixed(1) + '%'}</b><i>CPU</i></span>
          <span class="m-cell"${barAttr(memPct)}><b>${fmtBytes(m.mem_used)}</b><i>内存</i></span>
          <span class="m-cell" data-nobar><b>${m.extra && m.extra.load1 != null ? Number(m.extra.load1).toFixed(2) : '-'}</b><i>负载</i></span>
          <span class="m-cell" data-nobar><b>${m.net_in != null ? fmtBytes(m.net_in) + '/s' : '-'}</b><i>网络↓</i></span>
          <span class="m-cell"${barAttr(swapPct)}><b>${swap != null ? fmtBytes(swap) : '-'}</b><i>Swap</i></span>
          <span class="m-cell"${barAttr(dPct)}><b>${dPct == null ? '-' : dPct + '%'}</b><i>磁盘</i></span>
        </div>`;
  }
  // 探活行 HTML
  function probesBlockHtml(s) {
    if (!Array.isArray(s.probes) || !s.probes.length) return '';
    return `
        <div class="probes">${s.probes.map((p) => `<span class="probe ${p.ok ? 'ok' : 'down'}" title="${escapeHtml(p.name)}${p.code ? ` · HTTP ${escapeHtml(p.code)}` : ''}"><i class="dot"></i>${escapeHtml(p.name)}</span>`).join('')}</div>`;
  }
  function cardHtml(s) {
    const m = s.metric;
    // 开机时间（秒 → 天）
    const up = m && m.extra && m.extra.uptime ? `开机 ${(m.extra.uptime / 86400).toFixed(1)}天` : '';
    // IP 优先 wan_ip，回退 agent 上报的网卡 IP；私网与否不再这里过滤（<cf-ip> 内部 GEO_PRIVATE 守卫生效，私网仅显示 IP 不查归属地）
    const ip = (s.wan_ip || (s.info && s.info.ip4) || '').trim();
    const info = s.info ? [s.info.os, up].filter(Boolean).join(' · ') : up;
    return `
      <div class="card" data-id="${s.id}">
        <div class="card-head">
          <div class="card-title">
            <span class="name"><span class="flag" data-flag="${escapeHtml(ip)}"></span>${escapeHtml(s.name)}</span>
            <button class="more-btn" title="节点操作">⋯</button>
            <div class="card-menu hidden">
              ${canExec ? `<button data-act="term" data-id="${s.id}" data-name="${escapeHtml(s.name)}">终端</button>
              <button data-act="file" data-id="${s.id}" data-name="${escapeHtml(s.name)}">文件</button>` : ''}
              <button data-act="mon" data-id="${s.id}" data-name="${escapeHtml(s.name)}">监控</button>
              <button data-act="custom" data-id="${s.id}" data-name="${escapeHtml(s.name)}">自定义指标</button>
              ${isAdmin ? `<button data-act="edit" data-id="${s.id}" data-name="${escapeHtml(s.name)}" data-group="${escapeHtml(s.group || '')}" data-order="${s.display_index || 0}">修改</button>
              <button data-act="del" data-id="${s.id}" data-name="${escapeHtml(s.name)}" class="dd-danger">删除</button>` : ''}
            </div>
          </div>
          <span class="badge ${s.online ? 'on' : 'off'}"><i class="dot"></i>${s.online ? '在线' : '离线'}</span>
        </div>
        ${metricBlockHtml(s)}
        ${probesBlockHtml(s)}
        <div class="meta"><span class="cid">#${s.id}</span>${info ? ' · ' + escapeHtml(info) : ''}${ip ? ` · <cf-ip ip="${escapeHtml(ip)}"></cf-ip>` : ''}</div>
      </div>`;
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
      box.innerHTML = '<div class="empty"><p>还没有服务器</p><p class="muted">点<a href="#" class="empty-add" id="empty-add">「添加服务器」</a>生成 agent 配置后开始监控</p></div>';
      // 事件绑定：内嵌链接点击直接打开添加服务器弹窗（与 toolbar「＋」同入口）
      const emptyAdd = $('#empty-add');
      if (emptyAdd) emptyAdd.onclick = (e) => { e.preventDefault(); openAddModal(); };
      return;
    }
    const groups = groupList();
    const byGroup = (g) => serversCache
      .filter((s) => (s.group || '未分组') === g)
      .sort((a, b) => (a.display_index || 0) - (b.display_index || 0));
    box.innerHTML = groups.map((g) => `
      <h3 class="group-title">${escapeHtml(g)}（${byGroup(g).length}）</h3>
      <div class="grid">${byGroup(g).map(cardHtml).join('')}</div>`).join('');
    updateFlags(); // 卡片旗帜异步补全（geo 查询受 geoEnabled 开关控制）
  }
  // 旗帜补全：对卡片名前的 [data-flag] 占位查国家代码 → 渲染 emoji 旗帜；
  // geo 关闭/私网/查询失败 → 移除占位（不显示空位）
  function updateFlags() {
    document.querySelectorAll('#servers .flag[data-flag]').forEach((el) => {
      const ip = el.dataset.flag || '';
      if (!ip) { el.remove(); return; }
      geoLookup(ip).then((res) => {
        if (!el.isConnected) return;
        const cc = res && res.cc;
        if (cc && flagHtml(cc)) el.innerHTML = flagHtml(cc);
        else el.remove();
      });
    });
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
      // 监控弹窗打开且为该服务器：实时更新图表末点（同分钟替换 / 跨分钟追加滚动）
      updateMonitorLive(s);
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

  // 服务器表单双模式：editServerId = null 添加，否则为修改中的服务器 id
  let editServerId = null;

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

  // 修改服务器（菜单「修改」）：预填当前值，提交 PATCH；不动 agent key，在线状态不受影响
  function openEditModal(id, name, group, order) {
    editServerId = id;
    $('#add-modal-title').textContent = '修改服务器';
    $('#btn-add-server').textContent = '保存修改';
    $('#inp-name').value = name || '';
    $('#inp-group').value = group || '';
    $('#inp-order').value = order != null ? String(order) : '';
    $('#add-modal').classList.remove('hidden');
    lockScroll();
    setTimeout(() => $('#inp-name').focus(), 50);
  }

  async function saveEditServer() {
    const name = $('#inp-name').value.trim();
    const group = $('#inp-group').value.trim();
    const sortOrder = Number($('#inp-order').value) || 0;
    if (!name) return toast('请输入服务器名称');
    try {
      await api(`/api/servers/${editServerId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name, group, sort_order: sortOrder }),
      });
      $('#add-modal').classList.add('hidden');
      unlockScroll();
      editServerId = null;
      toast('服务器信息已更新');
      loadServers();
    } catch (e) {
      toast(e.message);
    }
  }

  // 表单提交分发：添加 / 修改共用 Enter 与按钮
  function submitServerForm() {
    if (editServerId) saveEditServer();
    else addServer();
  }

  // 连接建立发一次 sync 拉初始列表，此后数据由服务端上报驱动推送（WS 被动接收，不再 3s 轮询）。
  // pushTimer 改为「本地在线老化」：每秒只更新在线徽章/概览条（last_seen_s 随时间流逝
  // 自动判离线，死机服务器不再永远显示在线）；不重建 DOM，防 hover 高亮抖动/菜单被打断
  function startPushTimer() {
    if (pushTimer) clearInterval(pushTimer);
    pushSess.sync(); // 连接后立即拉最新列表
    pushTimer = setInterval(() => {
      if (document.hidden) return; // 后台由 visibilitychange 关 WS，无需老化
      updateAging();
    }, 1000);
  }
  function stopPushTimer() {
    if (pushTimer) { clearInterval(pushTimer); pushTimer = null; }
  }

  // ---------- 服务器列表实时刷新（WS /ws/push；连接/重连在 api.js 的 PushSession） ----------
  // PushSession：连接生命周期 + 指数重连 + 30s 兜底 + 1008 权限失效，数据经回调交给 UI
  const pushSess = new PushSession({
    onOpen: () => startPushTimer(), // 连接建立后启动老化计时器
    onData: (list) => { serversCache = list; updateServerCards(); },
    onAuthFail: () => { token = ''; localStorage.removeItem('cfpanel_token'); showAuth(); },
    onLongRetry: () => toast('实时刷新连接失败，正在自动重试...'),
  });
  function startPush() {
    if (!token) return;
    pushSess.open();
  }
  function stopPush() {
    stopPushTimer();
    pushSess.close(); // 主动关闭（idle 暂停/后台隐藏/登出），不再重连
  }

  // ---------- 空闲观看保护（IdleGuard 在 utils.js；计时/状态机，动作回调注入） ----------
  // 长时间无浏览器操作 → 提示并暂停实时刷新：断开 /ws/push → 观看者数减 1 →
  // 服务端下发慢采 → agent 恢复 120s 上报，节省 Cloudflare 额度（快采 5s ≈ 17,280 帧/天/机）
  const idleGuard = new IdleGuard({
    timeout: 10 * 60 * 1000, // 无操作 10 分钟判定空闲
    promptMs: 60 * 1000,     // 提示后 60s 无响应自动暂停
    isActive: () => !!token,
    onPrompt: (onContinue, onPause) => {
      // 确认=继续观看（重置计时）；取消=立即暂停；关闭弹窗=忽略提示（60s 倒计时自动暂停兜底）
      confirmDialog('长时间未操作。为节省 Cloudflare 额度，将暂停实时刷新（agent 将恢复慢采）。\n\n点击「确认」继续观看，或「取消」暂停；60 秒无响应将自动暂停。', onContinue, onPause);
    },
    onPause: () => {
      stopPush(); // 断开 /ws/push → 观看者减 1 → agent 恢复慢采
      toast('已暂停实时刷新（agent 恢复慢采，节省额度）。移动鼠标或按键即可恢复。');
    },
    onResume: () => {
      startPush(); // 重连 /ws/push → 观看者加 1 → agent 恢复快采
      toast('已恢复实时刷新。');
    },
  });
  idleGuard.bind();

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
  // promptDialog —— 替代原生 prompt()（Safari/移动端体验差、样式割裂）；
  // 复用通用对话框，动态插入输入框，回车=确认，Esc=取消
  let promptInputEl = null;
  function promptDialog(title, defaultValue, onOk, onCancel) {
    $('#dialog-title').textContent = title;
    $('#dialog-text').textContent = '';
    $('#dialog-text').classList.remove('mono');
    if (!promptInputEl) {
      promptInputEl = document.createElement('input');
      promptInputEl.type = 'text';
      promptInputEl.className = 'dlg-input';
      promptInputEl.maxLength = 200;
      $('#dialog-text').after(promptInputEl);
      promptInputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') $('#btn-dialog-ok').click();
      });
    }
    promptInputEl.value = defaultValue || '';
    promptInputEl.style.display = 'block';
    $('#btn-dialog-ok').classList.remove('hidden');
    $('#btn-dialog-cancel').textContent = '取消';
    $('#btn-dialog-cancel').classList.remove('hidden');
    $('#dialog').classList.remove('hidden');
    lockScroll();
    const finish = () => {
      if (promptInputEl) promptInputEl.style.display = 'none';
      closeDialog();
    };
    $('#btn-dialog-close').onclick = () => { finish(); onCancel && onCancel(); };
    $('#btn-dialog-cancel').onclick = () => { finish(); onCancel && onCancel(); };
    $('#btn-dialog-ok').onclick = () => {
      const v = promptInputEl.value.trim();
      finish();
      if (v) onOk && onOk(v);
    };
    setTimeout(() => promptInputEl.focus(), 0);
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

    // 终端会话（连接/重连/自愈状态机在 api.js 的 TermSession，渲染走注入的 xterm）
    const sess = new TermSession(term, fit, {
      onAuthFail: () => { token = ''; localStorage.removeItem('cfpanel_token'); showAuth(); },
    });
    // 键盘输入 → WS；窗口变化 → resize 帧（走 DO → 控制 WS → stty）
    term.onData((data) => sess.send(data));
    term.onResize(({ cols, rows }) => sess.resize(cols, rows));
    const onResize = () => { if (!sess.closed) { try { fit.fit(); } catch { /* ignore */ } } };
    window.addEventListener('resize', onResize);
    $('#btn-term-close').onclick = () => {
      sess.close(); // 内部 dispose + 关 WS + 清定时器
      window.removeEventListener('resize', onResize); // 防多次开关终端累积内存泄漏
      $('#term-modal').classList.add('hidden');
      unlockScroll();
    };

    sess.open(serverId); // 建会话 + WS + auth + fit + 重连/自愈
  }

  // ---------- 文件管理（目录浏览 / 上传 / 下载；连接/协议/状态机在 api.js 的 FileSession） ----------
  let fileServerId = 0;      // 当前文件会话所属服务器（断线重连用）
  let fileServerName = '';
  let fileFilterTimer = null;          // 过滤输入框 debounce 定时器
  let fileEntries = [];      // 当前目录条目缓存（上传前同名检测用）

  // FileSession：连接/协议/上传下载状态机（api.js，零 DOM），UI 通过回调处理
  const fileSess = new FileSession({
    onList: (entries, truncated) => {
      renderFileList(entries);
      $('#file-msg').textContent = truncated ? '目录条目过多，仅显示前 1000 项' : '';
    },
    onUploadProgress: (pct) => { $('#file-msg').textContent = `上传中：${pct}%`; },
    onUploadDone: (path) => { $('#btn-file-cancel').classList.add('hidden'); reloadFileList(); },
    onUploadCanceled: () => { $('#btn-file-cancel').classList.add('hidden'); $('#file-msg').textContent = '已取消上传'; },
    onDownloadProgress: (pct) => { $('#file-msg').textContent = `下载中：${pct}%`; },
    onDownloadDone: (path, parts, dlName) => {
      $('#btn-dl-cancel').classList.add('hidden');
      try {
        // Blob 直接引用分块数组（不复制），避免 500MB 级文件的二次内存拷贝
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob(parts));
        a.download = dlName || path.split('/').pop() || 'download';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(a.href);
        $('#file-msg').textContent = `已下载：${dlName || path}`;
      } catch { $('#file-msg').textContent = '下载失败'; }
    },
    onDownloadCanceled: () => { $('#btn-dl-cancel').classList.add('hidden'); $('#file-msg').textContent = '已取消下载'; },
    // 重命名/删除成功后刷新列表（zip 下载完成的 delete 清理不回执，不会误触 onDeleteDone）
    onRenameDone: (path) => { reloadFileList(); toast(`已重命名为：${path}`); },
    onDeleteDone: () => { reloadFileList(); toast('已删除'); },
    onError: (msg) => { $('#file-msg').textContent = `错误：${msg}`; },
    onDisconnected: () => { if (!$('#file-modal').classList.contains('hidden')) $('#file-msg').textContent = '连接断开，点击「刷新」重连'; },
  });

  // 重新拉取列表（带当前过滤规则）。过滤在 agent 端完成（先过滤再截断 1000 条），
  // 避免大目录下前端只拿到截断区间子集而遗漏匹配文件
  function reloadFileList() {
    fileSess.list(fileSess.cwd, $('#file-filter').value);
  }

  async function openFileManager(serverId, serverName) {
    fileServerId = serverId;
    fileServerName = serverName;
    $('#file-title').textContent = `文件管理 · ${serverName}`;
    $('#file-path').value = '/';
    $('#file-filter').value = '';
    $('#file-msg').textContent = '';
    $('#file-list').innerHTML = '<tr><td colspan="4" class="muted">连接中...</td></tr>';
    $('#file-modal').classList.remove('hidden');
    lockScroll();
    fileSess.open(serverId, '/'); // 建会话 + WS + auth + 初始列表
  }

  function closeFileModal() {
    fileSess.close();
    $('#file-modal').classList.add('hidden');
    unlockScroll();
  }

  function renderFileList(entries) {
    fileEntries = entries || []; // 缓存条目供上传同名检测
    const rows = entries.map((e) => {
      const size = e.type === 'dir' ? '—' : fmtBytes(e.size);
      const time = e.mtime ? new Date(e.mtime * 1000).toLocaleString('zh-CN') : '—';
      const path = fileJoin(fileSess.cwd, e.name);
      const nameCell = e.type === 'dir'
        ? `<a class="f-dir" data-path="${escapeHtml(path)}">📁 ${escapeHtml(e.name)}</a>`
        : `<span class="f-file">📄 ${escapeHtml(e.name)}</span>`;
      // 行操作：⋯ 下拉菜单（下载/重命名/删除）。目录下载 = 打包 zip。
      const menu = `<div class="row-menu-wrap">
        <button class="row-menu" type="button" title="操作" aria-label="操作">⋯</button>
        <div class="row-menu-pop hidden">
          <button class="f-act-dl" type="button" data-path="${escapeHtml(path)}" data-type="${e.type}" data-size="${e.size}">下载</button>
          <button class="f-act-ren" type="button" data-path="${escapeHtml(path)}">重命名</button>
          <button class="f-act-del danger" type="button" data-path="${escapeHtml(path)}" data-type="${e.type}">删除</button>
        </div>
      </div>`;
      return `<tr><td>${nameCell}</td><td>${size}</td><td>${escapeHtml(time)}</td><td class="f-ops">${menu}</td></tr>`;
    });
    $('#file-list').innerHTML = rows.join('') || '<tr><td colspan="4" class="muted">空目录</td></tr>';
  }

  // 上传/下载入口：状态机在 FileSession（api.js），这里只负责 UI 接线。
  // 上传前检测当前目录同名文件（服务端首块同样强制校验 overwrite，双保险）——同名需二次确认
  function uploadFile(file) {
    const target = fileJoin(fileSess.cwd, file.name);
    const existing = fileEntries.some((e) => e.type !== 'dir' && fileJoin(fileSess.cwd, e.name) === target);
    if (existing) {
      confirmDialog(`「${file.name}」已存在，是否覆盖？`, () => {
        $('#btn-file-cancel').classList.remove('hidden');
        fileSess.upload(file, { overwrite: true });
      });
      return;
    }
    $('#btn-file-cancel').classList.remove('hidden');
    fileSess.upload(file);
  }
  function cancelUpload() { fileSess.cancelUpload(); }
  function downloadFile(path, size) {
    $('#btn-dl-cancel').classList.remove('hidden');
    fileSess.download(path, size);
  }
  function cancelDownload() { fileSess.cancelDownload(); }

  // ---------- 监控（简易文本图，支持时间范围） ----------
  let monitorReqSeq = 0; // 监控 range 请求序号（快速切换时丢弃过期响应）
  // 实时更新状态：打开监控时记录（serverId + 图表分钟戳窗口 + 是否降采样）。
  // 推送到达时按时间戳更新末点：同分钟→替换末点，跨分钟→追加滚动（保持窗口长度）
  let monitorLive = null; // { serverId, tsArr, downsampled, charts: [{chart, getVal, latestEl}] }
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
      const downsampled = rows.length > MONITOR_STEP_MAX;
      $('#monitor-title').textContent = `监控 · ${serverName}（${label}，${rows.length} 点${downsampled ? '，降采样' : ''}${cCount ? ` +${cCount} 自定义` : ''}）`;
      $('#monitor-modal').classList.remove('hidden'); // 先显示，保证 canvas 有尺寸
      lockScroll();
      renderMonitorChart(downsample(rows), custom, downsampled);
    } catch (e) {
      toast(e.message);
    }
  }

  // 监控图表：每个指标独立一张图（CPU / 内存 / 网络 / 自定义指标），纵向排列，
  // 各自独立刻度轴——量纲不同不再挤在一张图（原双轴方案可读性差）
  function renderMonitorChart(rows, custom, downsampled) {
    const wrap = $('#monitor-modal .chart-wrap');
    monitorCharts.forEach((c) => { try { c.destroy(); } catch { /* ignore */ } });
    monitorCharts = [];
    monitorLive = null;
    wrap.innerHTML = '';
    if (!window.Chart) {
      wrap.innerHTML = '<p class="muted" style="padding:24px">图表库（Chart.js）加载失败，请检查网络。</p>';
      return;
    }
    if (!rows.length) {
      wrap.innerHTML = '<p class="muted" style="padding:24px">该时间范围暂无数据。</p>';
      return;
    }
    const tsArr = rows.map((r) => r.ts);
    const labels = rows.map((r) => new Date(r.ts * 60000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }));
    const lineCfg = (color, fill) => ({ borderColor: color, backgroundColor: fill, tension: 0.3, pointRadius: 0, borderWidth: 1.8, spanGaps: true });
    // 公共刻度样式；unit 可选（如 '%'/'KB/s'）→ Y 轴刻度值后追加单位
    const axisStyle = (unit) => ({
      ticks: {
        color: '#8b949e', maxTicksLimit: 8, maxRotation: 0,
        callback: unit ? (v) => `${v}${unit}` : undefined,
      },
      grid: { color: 'rgba(255,255,255,.04)' },
    });
    const chartOpts = (yUnit) => ({
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#8b949e', boxWidth: 12 } },
        tooltip: { backgroundColor: '#1c2230', borderColor: '#2d333b', borderWidth: 1, titleColor: '#e6edf3', bodyColor: '#8b949e' },
      },
      scales: { x: axisStyle(), y: axisStyle(yUnit) },
    });
    // 取最后一个非 null 数据点（标题右侧最新值用）
    const lastVal = (arr) => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i]; return null; };
    // 实时更新注册表：每张图的 chart 实例、涉及的 dataset 索引、从最新 metric 取值与格式化的函数
    const liveCharts = [];
    // 生成一块"标题 + 最新值 + canvas"的图块并创建 Chart 实例；
    // tooltipLabel 可选（自定义 tooltip 内容）；latestText 为标题右侧最新数据文本；yUnit 为 Y 轴刻度单位
    const mkChart = (title, datasets, tooltipLabel, latestText, liveGet, yUnit) => {
      const id = `mc-${monitorCharts.length + 1}`;
      const div = document.createElement('div');
      div.className = 'm-chart';
      div.innerHTML = `<h4 class="m-chart-title">${title}<span class="m-chart-latest">${latestText || ''}</span></h4><div class="m-chart-body"><canvas id="${id}"></canvas></div>`;
      wrap.appendChild(div);
      const opts = chartOpts(yUnit);
      if (tooltipLabel) opts.plugins.tooltip.callbacks = { label: tooltipLabel };
      const chart = new Chart(document.getElementById(id), {
        type: 'line',
        data: { labels, datasets },
        options: opts,
      });
      monitorCharts.push(chart);
      if (liveGet) {
        liveCharts.push({
          chart,
          latestEl: div.querySelector('.m-chart-latest'),
          datasetCount: datasets.length,
          get: liveGet, // (metric) => Array<value|null>（每 dataset 一个值）
          fmt: (values) => values.filter((v) => v != null).join(' · '), // 覆盖时可自定义
        });
      }
    };
    const memPctOf = (r) => (r && r.mem_total > 0 ? +(r.mem_used / r.mem_total * 100).toFixed(1) : null);
    const swapPctOf = (r) => { const s = r && r.extra && r.extra.swap, t = r && r.extra && r.extra.swap_total; return s != null && t > 0 ? +(s / t * 100).toFixed(1) : null; };

    // CPU：独立图（%）
    const cpuData = rows.map((r) => r.cpu);
    mkChart('CPU（%）', [{ label: 'CPU', data: cpuData, ...lineCfg('#3b82f6', 'rgba(59,130,246,.12)'), fill: true }], null,
      lastVal(cpuData) != null ? `${lastVal(cpuData).toFixed(1)}%` : '',
      (m) => (m.cpu == null ? null : m.cpu.toFixed(1) + '%'),
      '%');
    // 内存 + Swap：同为 % 量纲合并一张图；tooltip 显示各自 当前值/总量/百分比
    const memPctData = rows.map(memPctOf);
    const swapPctData = rows.map(swapPctOf);
    mkChart('内存 / Swap（%）', [
      { label: '内存', data: memPctData, ...lineCfg('#f59e0b', 'rgba(245,158,11,.08)'), fill: true },
      { label: 'Swap', data: swapPctData, ...lineCfg('#22d3ee', 'transparent') },
    ],
      (ctx) => {
        const r = rows[ctx.dataIndex];
        if (!r) return '';
        if (ctx.datasetIndex === 1) {
          const s = r.extra && r.extra.swap;
          if (s == null) return '';
          const mb = +(s / 1048576).toFixed(1);
          const t = r.extra && r.extra.swap_total;
          if (t > 0) return `Swap：${mb} MB / ${+(t / 1048576).toFixed(1)} MB（${swapPctOf(r)}%）`;
          return `Swap：${mb} MB`;
        }
        if (r.mem_used == null) return '';
        const mmb = +(r.mem_used / 1048576).toFixed(1);
        if (r.mem_total > 0) return `内存：${mmb} MB / ${+(r.mem_total / 1048576).toFixed(1)} MB（${memPctOf(r)}%）`;
        return `内存：${mmb} MB`;
      },
      [lastVal(memPctData), lastVal(swapPctData)].filter((v) => v != null).map((v) => `${v}%`).join(' · '),
      (m) => [memPctOf(m), swapPctOf(m)].map((v) => (v == null ? null : v + '%')),
      '%');
    // 网络：上下行同量纲（KB/s）放一张，便于对比
    const netInData = rows.map((r) => (r.net_in == null ? null : +(r.net_in / 1024).toFixed(1)));
    const netOutData = rows.map((r) => (r.net_out == null ? null : +(r.net_out / 1024).toFixed(1)));
    mkChart('网络（KB/s）', [
      { label: '下行', data: netInData, ...lineCfg('#22d3ee', 'transparent') },
      { label: '上行', data: netOutData, ...lineCfg('#f472b6', 'transparent') },
    ], null,
      [['↓', lastVal(netInData)], ['↑', lastVal(netOutData)]].filter(([, v]) => v != null).map(([d, v]) => `${d} ${v} KB/s`).join(' · '),
      (m) => {
        const vals = [m.net_in, m.net_out].map((v) => (v == null ? null : +(v / 1024).toFixed(1)));
        return [['↓', vals[0]], ['↑', vals[1]]].filter(([, v]) => v != null).map(([d, v]) => `${d} ${v} KB/s`).join(' · ');
      },
      'KB/s');
    // 自定义指标：按 ts 对齐系统时间轴，独立一张（量纲差异仅看趋势）
    const cNames = Object.keys(custom || {}).filter((n) => Array.isArray(custom[n]) && custom[n].length);
    if (cNames.length) {
      mkChart('自定义指标', cNames.map((n, i) => {
        const cMap = new Map(custom[n].map((p) => [p.ts, p.value]));
        return { label: n, data: rows.map((r) => (cMap.has(r.ts) ? cMap.get(r.ts) : null)), ...lineCfg(MONITOR_COLORS[i % MONITOR_COLORS.length], 'transparent') };
      }), null,
        cNames.map((n) => {
          const pts = custom[n].filter((p) => p.value != null);
          const v = pts.length ? pts[pts.length - 1].value : null;
          return v != null ? `${escapeHtml(n)}: ${v}` : '';
        }).filter(Boolean).join(' · '));
    }
    // 实时更新注册：推送到达时按分钟戳更新各图末点（同分钟替换、跨分钟追加滚动）。
    // 自定义指标走分钟级 D1 直写、推送不含，不注册（保持快照）
    monitorLive = {
      serverId: monitorState.serverId,
      tsArr,
      maxLen: tsArr.length,
      downsampled: !!downsampled, // 降采样窗口：只替换末点不追加（避免破坏采样窗口语义）
      charts: liveCharts,
    };
  }

  // 推送到达 → 更新监控图末点（若监控弹窗打开且为该服务器）
  // 时间语义：推送的最新 metric 对应当前分钟；与图表末点分钟戳比较——
  // 同分钟 → 替换末点；跨分钟 → 追加滚动（移出最旧点，保持窗口长度）
  function updateMonitorLive(s) {
    if (!monitorLive || !s || s.id !== monitorLive.serverId) return;
    const m = s.metric;
    if (!m || !monitorLive.charts.length) return;
    const minTs = Math.floor(Date.now() / 1000 / 60);
    const lastTs = monitorLive.tsArr[monitorLive.tsArr.length - 1];
    const append = minTs > lastTs && !monitorLive.downsampled;
    const label = new Date(minTs * 60000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    for (const lc of monitorLive.charts) {
      const values = lc.get(m);
      if (!values || !values.length) continue;
      lc.chart.data.datasets.forEach((ds, i) => {
        const v = values[i] == null ? null : values[i];
        if (append) {
          ds.data.push(v);
          ds.data.shift(); // 保持窗口长度（时间轴右移）
        } else {
          ds.data[ds.data.length - 1] = v; // 同分钟：替换末点
        }
      });
      if (append) {
        lc.chart.data.labels.push(label);
        lc.chart.data.labels.shift();
        monitorLive.tsArr.push(minTs);
        monitorLive.tsArr.shift();
      }
      lc.chart.update('none'); // 无动画，避免 5s 推送抖动
      if (lc.latestEl) lc.latestEl.textContent = lc.fmt(values);
    }
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
    editServerId = null;
    $('#add-modal-title').textContent = '添加服务器';
    $('#btn-add-server').textContent = '添加服务器';
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

  // 组装当前弹窗表单的告警配置（保存/测试共用）
  function collectAlertForm() {
    const num = (v) => (v.trim() ? Number(v) : 0);
    return {
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
    };
  }

  async function saveAlerts() {
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ alerts: collectAlertForm() }),
      });
      toast('告警配置已保存');
    } catch (e) {
      toast(e.message);
    }
  }

  // 测试 Webhook：用当前表单配置（未保存）发一条测试通知并回显 HTTP 状态
  async function testWebhook() {
    const el = $('#webhook-test-result');
    el.textContent = '发送中…';
    try {
      const res = await api('/api/settings/test_webhook', {
        method: 'POST',
        body: JSON.stringify({ alerts: collectAlertForm() }),
      });
      el.textContent = res.ok
        ? `✓ 发送成功（HTTP ${res.status}）`
        : `✗ 发送失败：${res.error || `HTTP ${res.status}`}`;
    } catch (e) {
      el.textContent = `✗ ${e.message}`;
    }
  }

  function fmtTokenExpiry(exp) {
    if (!exp) return '永久有效';
    const expired = exp * 1000 < Date.now();
    return `${new Date(exp * 1000).toLocaleString()}${expired ? '（已过期）' : ''}`;
  }
  async function loadTokens() {
    try {
      const rows = await api('/api/tokens');
      $('#token-list').innerHTML = rows.length
        ? rows.map((r) => `
            <li>${escapeHtml(r.name)} · ${escapeHtml(r.scopes)}${r.server_ids ? ' · ids=' + escapeHtml(r.server_ids) : ''} · 到期：${escapeHtml(fmtTokenExpiry(r.expires_at))}
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
    const expDays = Number($('#tok-expires').value);
    try {
      const res = await api('/api/tokens', {
        method: 'POST',
        body: JSON.stringify({
          name: $('#tok-name').value.trim(),
          scopes,
          server_ids: serverIDs.length ? serverIDs : null,
          expires_in_days: expDays > 0 ? expDays : undefined,
        }),
      });
      infoDialog('令牌已创建（仅显示一次）', `令牌：\n${res.token}\n\n用法：Authorization: Bearer ${res.token}\n\n有效期：${res.expires_at ? new Date(res.expires_at * 1000).toLocaleString() : '永久有效'}`);
      $('#tok-name').value = '';
      $('#tok-servers').value = '';
      $('#tok-expires').value = '';
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

  // ---------- 审计日志（仅管理员，保留 90 天；筛选/分页/CSV 导出） ----------
  const AUDIT_ACTION_LABEL = {
    'server.create': '添加服务器', 'server.update': '修改服务器', 'server.delete': '删除服务器',
    'terminal.open': '打开终端', 'file.open': '文件管理', 'file.upload': '上传文件',
    'file.write': '写入文件', 'file.zip': '打包目录', 'file.rename': '重命名', 'file.delete': '删除文件',
    'exec.command': '执行命令',
  };
  const auditState = { limit: 100, offset: 0, action: '', user: '', serverId: '' };
  async function openAuditModal() {
    $('#audit-modal').classList.remove('hidden');
    lockScroll();
    // 动作筛选下拉（后端按 action 精确匹配）
    const sel = $('#audit-filter-action');
    if (sel.options.length <= 1) {
      for (const [k, v] of Object.entries(AUDIT_ACTION_LABEL)) {
        const opt = document.createElement('option');
        opt.value = k; opt.textContent = v;
        sel.appendChild(opt);
      }
    }
    await loadAuditLogs();
  }
  async function loadAuditLogs() {
    try {
      const q = new URLSearchParams({ limit: auditState.limit, offset: auditState.offset });
      if (auditState.action) q.set('action', auditState.action);
      if (auditState.user) q.set('user', auditState.user);
      if (auditState.serverId) q.set('server_id', auditState.serverId);
      const body = await api(`/api/audit-logs?${q}`);
      const rows = body.rows || body; // 兼容：新格式 {rows,total}
      $('#audit-list').innerHTML = rows.length
        ? rows.map((r) => `
            <li><div class="audit-row">
              <span class="audit-action">${escapeHtml(AUDIT_ACTION_LABEL[r.action] || r.action)}</span>
              <span class="audit-info">${escapeHtml(r.username || `uid=${r.user_id}`)}${r.client_ip ? ` · <cf-ip ip="${escapeHtml(r.client_ip)}"></cf-ip>` : ''}${r.target_server_id ? ` · server#${escapeHtml(r.target_server_id)}` : ''}${r.detail ? ` · ${escapeHtml(r.detail)}` : ''}</span>
              <span class="audit-time">${escapeHtml(r.created_at || '')}</span>
            </div></li>`).join('')
        : '<li class="muted">暂无审计记录</li>';
      const total = Number(body.total || rows.length);
      const from = total ? auditState.offset + 1 : 0;
      const to = Math.min(auditState.offset + rows.length, total);
      $('#audit-pager-info').textContent = total ? `第 ${from}-${to} 条 / 共 ${total} 条` : '';
      $('#btn-audit-prev').disabled = auditState.offset <= 0;
      $('#btn-audit-next').disabled = auditState.offset + rows.length >= total;
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

  // 添加服务器弹窗（添加/修改双模式：按钮与 Enter 走同一分发）
  $('#btn-add-server').onclick = submitServerForm;
  $('#btn-add-server-plus').onclick = openAddModal; // toolbar「＋」入口与菜单「添加服务器」同入口
  $('#btn-add-close').onclick = () => { $('#add-modal').classList.add('hidden'); unlockScroll(); };
  $('#inp-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitServerForm(); });

  // 站点信息弹窗
  $('#btn-site-close').onclick = () => { $('#site-modal').classList.add('hidden'); unlockScroll(); };
  $('#btn-save-site').onclick = saveSite;

  // 告警弹窗
  $('#btn-alerts-close').onclick = () => { $('#alerts-modal').classList.add('hidden'); unlockScroll(); };
  $('#btn-save-alerts').onclick = saveAlerts;
  $('#btn-test-webhook').onclick = testWebhook;

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
  // 审计筛选/分页/CSV
  $('#btn-audit-apply').onclick = () => {
    auditState.offset = 0;
    auditState.action = $('#audit-filter-action').value;
    auditState.user = $('#audit-filter-user').value.trim();
    auditState.serverId = $('#audit-filter-server').value.trim();
    loadAuditLogs();
  };
  $('#btn-audit-prev').onclick = () => { auditState.offset = Math.max(0, auditState.offset - auditState.limit); loadAuditLogs(); };
  $('#btn-audit-next').onclick = () => { auditState.offset += auditState.limit; loadAuditLogs(); };
  $('#btn-audit-csv').onclick = async () => {
    // CSV 需带 Authorization 头：fetch 拿 Blob 后触发下载
    const q = new URLSearchParams({ format: 'csv' });
    if (auditState.action) q.set('action', auditState.action);
    if (auditState.user) q.set('user', auditState.user);
    if (auditState.serverId) q.set('server_id', auditState.serverId);
    try {
      const res = await fetch(`/api/audit-logs?${q}`, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`导出失败：HTTP ${res.status}`);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'audit-logs.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
    } catch (e) { toast(e.message); }
  };
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
    else if (act === 'edit') openEditModal(Number(id), name, btn.dataset.group, btn.dataset.order);
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
  $('#btn-monitor-close').onclick = () => {
    $('#monitor-modal').classList.add('hidden');
    unlockScroll();
    // 关闭时销毁图表实例（释放内存；下次打开 renderMonitorChart 会重建）
    monitorCharts.forEach((c) => { try { c.destroy(); } catch { /* ignore */ } });
    monitorCharts = [];
    monitorLive = null;
  };

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
    if (fileSess.connected) reloadFileList();
    else if (fileServerId) fileSess.reconnect();
  };
  $('#file-up').onclick = () => { fileSess.cwd = fileParent(fileSess.cwd); $('#file-path').value = fileSess.cwd; reloadFileList(); };
  $('#file-go').onclick = () => { const p = $('#file-path').value.trim(); if (!p) return; fileSess.cwd = p; reloadFileList(); };
  $('#file-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#file-go').click(); });
  $('#file-input').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) uploadFile(f); e.target.value = ''; });
  // 文件名通配符过滤：debounce 后发 list（pattern 由 agent 端匹配，先过滤再截断）
  $('#file-filter').addEventListener('input', () => {
    clearTimeout(fileFilterTimer);
    fileFilterTimer = setTimeout(reloadFileList, 200);
  });
  // 行操作下拉菜单：⋯ 切换显隐；点菜单项执行操作；点其他区域关闭
  $('#file-list').addEventListener('click', (e) => {
    const dir = e.target.closest('.f-dir');
    // 目录点击统一走 reloadFileList（保持当前过滤词，与「刷新」行为一致）
    if (dir) { fileSess.cwd = dir.dataset.path; $('#file-path').value = fileSess.cwd; reloadFileList(); return; }
    const menuBtn = e.target.closest('.row-menu');
    if (menuBtn) {
      e.stopPropagation(); // 阻止冒泡到 document（否则点 ⋯ 立即关闭）
      closeRowMenus(menuBtn);
      const pop = menuBtn.parentElement.querySelector('.row-menu-pop');
      if (pop) pop.classList.toggle('hidden');
      return;
    }
    const dl = e.target.closest('.f-act-dl');
    if (dl) {
      closeRowMenus();
      const path = dl.dataset.path;
      if (dl.dataset.type === 'dir') { $('#file-msg').textContent = '正在打包目录，请稍候...'; fileSess.zipDownload(path); }
      else downloadFile(path, Number(dl.dataset.size) || 0);
      return;
    }
    const ren = e.target.closest('.f-act-ren');
    if (ren) {
      closeRowMenus();
      const old = ren.dataset.path.split('/').pop();
      // 原生 prompt() → promptDialog（对话框体系一致，回车确认/Esc 取消）
      promptDialog(`重命名：${ren.dataset.path}（仅改名，不支持跨目录）`, old, (name) => {
        fileSess.rename(ren.dataset.path, name);
      });
      return;
    }
    const del = e.target.closest('.f-act-del');
    if (del) {
      closeRowMenus();
      const isDir = del.dataset.type === 'dir';
      confirmDialog(`确认删除「${del.dataset.path}」${isDir ? '（目录将递归删除）' : ''}？\n此操作不可恢复！`, () => fileSess.delete(del.dataset.path));
    }
  });
  // 点击表格外任意位置关闭已展开的菜单
  document.addEventListener('click', () => closeRowMenus());
  function closeRowMenus(except) {
    document.querySelectorAll('#file-list .row-menu-pop').forEach((p) => {
      if (p.parentElement.querySelector('.row-menu') !== except) p.classList.add('hidden');
    });
  }

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
