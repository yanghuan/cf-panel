// cf-panel 前端逻辑：登录、分组服务器列表、xterm 终端（自动重连）、公告/设置、PAT 管理
(() => {
  'use strict';
  // 工具函数与 <cf-ip> 组件从 utils.js 解构；api 层从 api.js 解构（index.html 中均须先加载）
  const { $, escapeHtml, fmtBytes, normalizeFileEntry, fileJoin, fileParent, fileBase, downsample, lockScroll, unlockScroll,
          MONITOR_STEP_MAX, MONITOR_RANGE_LABEL, MONITOR_COLORS,
          GEO_PRIVATE, setGeoEnabled, flagHtml, osIconHtml, isSystemPath, isBinaryExt, loadScript, loadCss, loadMonaco, loadMarkdown, geoLookup, IdleGuard } = CfUtils;
  const { api, setTokenGetter, FileSession, TermSession, PushSession } = CfApi;
  let token = localStorage.getItem('cfpanel_token') || '';

  // ---------- 主题（dark / light） ----------
  let theme = localStorage.getItem('cfpanel_theme') === 'light' ? 'light' : 'dark';
  let activeTerm = null; // 打开中的 xterm 实例（主题切换热更新；关闭时置 null）
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  // 终端配色：从 CSS 变量取（与 .term 容器底色一致）；xterm 需显式前景/光标色
  const termTheme = () => ({
    background: cssVar('--term-bg'),
    foreground: cssVar('--text'),
    cursor: cssVar('--accent'),
    cursorAccent: cssVar('--term-bg'),
    selectionBackground: theme === 'light' ? 'rgba(99, 102, 241, .25)' : 'rgba(103, 113, 154, .45)',
  });
  function applyTheme(t) {
    theme = t;
    document.documentElement.dataset.theme = t;
    localStorage.setItem('cfpanel_theme', t);
    const btn = $('#btn-theme');
    if (btn) btn.textContent = t === 'light' ? '🌙' : '☀️'; // 显示"将切换到"的目标图标
    if (window.monaco) window.monaco.editor.setTheme(t === 'light' ? 'vs' : 'vs-dark');
    if (activeTerm) activeTerm.options.theme = termTheme(); // 终端开着 → 热更新配色
    // 监控弹窗开着 → 用缓存数据重建图表（轴/文字/tooltip 颜色随主题）
    if (monitorLast && !$('#monitor-modal').classList.contains('hidden')) {
      renderMonitorChart(monitorLast.rows, monitorLast.custom, monitorLast.downsampled);
    }
  }
  setTokenGetter(() => token); // api 层通过 getter 读取当前 token
  let canExec = true; // 当前用户是否有 exec 权限（PAT 按 scopes，admin 恒有；控制终端/文件菜单显隐）
  let isAdmin = true; // 当前用户是否面板管理员（JWT 登录；PAT 恒 false；控制修改/删除等管理菜单显隐）
  let serversCache = [];
  let groupOrder = []; // 分组显示顺序（组名数组，下标即顺序；管理员经 ↑↓ 调整，PUT /api/group-order 持久化）
  let pushTimer = null;    // 每 3 秒发一次 sync 请求的定时器（老化）
  let monitorState = null; // { serverId, serverName, range } 当前监控视图
  let monitorCharts = []; // Chart.js 实例数组（每指标一张图，切换范围时全部销毁重建）
  let monitorLast = null; // 最近一次图表渲染参数（主题切换时零请求重建）

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
      const [list, ord] = await Promise.all([
        api('/api/servers'),
        api('/api/group-order').catch(() => ({ order: [] })), // 读取失败不阻塞列表（按名称兜底排序）
      ]);
      serversCache = Array.isArray(list) ? list : [];
      groupOrder = Array.isArray(ord && ord.order) ? ord.order : [];
      renderServers();
    } catch (e) {
      if (String(e.message).includes('401') || String(e.message).includes('unauthorized')) {
        token = ''; localStorage.removeItem('cfpanel_token'); showAuth(); return; // showAuth 内会 stopPush
      }
      toast(e.message);
    }
  }

  // 磁盘整体使用率：新格式 {m,used,total} 累计求和（与 tooltip 标题栏累计一致）；
  // 全为旧格式 {m,u}（无字节值无法累计）时回退最大值。返回 {used,total,pct} 或 null
  function diskSumOf(m) {
    const arr = m && m.extra && m.extra.disk;
    if (!Array.isArray(arr) || !arr.length) return null;
    let used = 0, total = 0, maxU = 0;
    for (const d of arr) {
      if (d.used != null && d.total > 0) { used += d.used; total += d.total; }
      else maxU = Math.max(maxU, Number(d.u) || 0);
    }
    if (total > 0) return { used, total, pct: +(used / total * 100).toFixed(1) };
    return maxU > 0 ? { pct: +maxU.toFixed(1) } : null;
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
    if (e.disk_io && (e.disk_io.read_kbs != null || e.disk_io.write_kbs != null || e.disk_io.util_pct != null)) {
      const io = e.disk_io;
      rows.push(['磁盘 IO', [
        io.read_kbs != null ? `↓ ${io.read_kbs}KB/s` : null,
        io.write_kbs != null ? `↑ ${io.write_kbs}KB/s` : null,
        io.r_iops != null && io.w_iops != null ? `IOPS ${io.r_iops}/${io.w_iops}` : null,
        io.util_pct != null ? `util ${io.util_pct}%` : null,
      ].filter(Boolean).join(' · ') || '-']);
    }
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
      // 磁盘项：新格式 {m, used, total}（百分比由前端算）；旧格式 {m, u} 回退
      const diskRow = (d) => {
        if (d.used != null && d.total > 0) {
          const pct = (d.used / d.total * 100).toFixed(0);
          return `${fmtBytes(d.used)} / ${fmtBytes(d.total)} (${pct}%)`;
        }
        return `${escapeHtml(d.u)}%`;
      };
      // 累计：仅统计新格式项（旧格式无字节值无法求和）；单挂载点时与明细行重复，不显示
      let sumUsed = 0, sumTotal = 0;
      for (const d of e.disk) if (d.used != null && d.total > 0) { sumUsed += d.used; sumTotal += d.total; }
      const sumHtml = e.disk.length > 1 && sumTotal > 0
        ? `<b title="累计">${fmtBytes(sumUsed)} / ${fmtBytes(sumTotal)} (${(sumUsed / sumTotal * 100).toFixed(0)}%)</b>`
        : '';
      diskHtml = `<div class="mt-sub mt-disk-head"><span>磁盘（${e.disk.length} 个挂载点）</span>${sumHtml}</div><div class="mt-disk">` +
        e.disk.map((d) => `<div><span title="${escapeHtml(d.m)}">${escapeHtml(d.m)}</span><b>${diskRow(d)}</b></div>`).join('') + '</div>';
    }
    return `<div class="mt-title">实时指标</div>${items}${sysHtml}${diskHtml}`;
  }

  // 指标行 HTML（数值随推送变化；tooltip 数据内嵌 data-metric，事件委托绑定不受重建影响）
  // 有百分比来源的格（CPU/内存/Swap/磁盘）以背景进度条呈现：--p 比例 + --bar-c 分级色（CSS 伪元素渲染）
  function metricBlockHtml(s) {
    const m = s.metric;
    if (!m) return '';
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
    // 磁盘整体使用率（累计，与 tooltip 标题栏一致）
    const dSum = diskSumOf(m);
    const dPct = dSum ? dSum.pct : null;
    // 指标区只挂 data-id：完整指标 JSON 不再内嵌 DOM 属性（50 机 ≈ 75KB 属性膨胀 +
    // 推送每 5s outerHTML 重建时的重复序列化）；tooltip 展开时从 serversCache 现取
    return `
        <div class="metric" data-id="${s.id}">
          <span class="m-cell"${barAttr(m.cpu)}><b>${m.cpu == null ? '-' : m.cpu.toFixed(1) + '%'}</b><i>CPU</i></span>
          <span class="m-cell"${barAttr(memPct)}><b>${fmtBytes(m.mem_used)}</b><i>内存</i></span>
          <span class="m-cell" data-nobar><b>${m.extra && m.extra.load1 != null ? Number(m.extra.load1).toFixed(2) : '-'}</b><i>负载</i></span>
          <span class="m-cell" data-nobar><b>${m.net_in != null ? fmtBytes(m.net_in) + '/s' : '-'}</b><i>网络↓</i></span>
          <span class="m-cell"${barAttr(swapPct)}><b>${swap != null ? fmtBytes(swap) : '-'}</b><i>Swap</i></span>
          <span class="m-cell"${barAttr(dPct)}><b>${dPct == null ? '-' : dPct.toFixed(1) + '%'}</b><i>磁盘</i></span>
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
            <span class="name"><span class="flag" data-flag="${escapeHtml(ip)}"></span>${osIconHtml(s.info && s.info.os)}${escapeHtml(s.name)}</span>
            <button class="more-btn" title="节点操作">⋯</button>
            <div class="card-menu hidden">
              ${canExec ? `<button data-act="term" data-id="${s.id}" data-name="${escapeHtml(s.name)}">终端</button>
              <button data-act="file" data-id="${s.id}" data-name="${escapeHtml(s.name)}">文件</button>` : ''}
              <button data-act="mon" data-id="${s.id}" data-name="${escapeHtml(s.name)}">监控</button>
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
  // 20s = 快宽限 15s + 5s 余量；无最新指标（冷启动/D1 兜底）的服务器保留服务端判定不覆盖。
  // 推送后 30s 内跳过老化：服务端对"首观者切快采"有 30s 过渡期（慢宽限 180s，防 agent
  // 切快采完成前误判离线），本地 20s 阈值若立即覆盖会把刚推送判在线的徽章打成离线——
  // 后台超一个慢采周期后切回时必现在线→离线→在线闪烁；30s 后 agent 已恢复快采，阈值正常生效
  let lastPushAt = 0; // 最近一次推送/同步到达时刻（ms）
  const AGING_PUSH_GRACE_MS = 30 * 1000; // 与服务端 PANEL_SWITCH_GRACE_MS 过渡期对齐
  function agingServers() {
    if (Date.now() - lastPushAt < AGING_PUSH_GRACE_MS) return;
    const agingNow = Date.now() / 1000;
    for (const s of serversCache) {
      if (s.metric && s.metric.last_seen_s) {
        s.online = agingNow - s.metric.last_seen_s < 20;
      }
    }
  }
  // 分组标题序列（用于判断分组结构是否变化）
  function groupList() {
    const groups = {};
    for (const s of serversCache) {
      const g = s.group || '未分组';
      (groups[g] = groups[g] || []).push(s);
    }
    // 组内按 display_index（序号）排序；分组按 groupOrder 数组下标排序，
    // 未配置的组追加尾部按名称排，「未分组」始终最后
    const idx = (g) => { const i = groupOrder.indexOf(g); return i < 0 ? groupOrder.length : i; };
    return Object.keys(groups).sort(
      (a, b) => (a === '未分组') - (b === '未分组') || idx(a) - idx(b) || a.localeCompare(b, 'zh')
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
    // 组标题：名称 + 计数 + 管理员可见的 ↑↓ 排序按钮（未分组固定最后，不给按钮；
    // 边界禁用以「可排序组」序列计算——与 groupSort handler 的交换逻辑一致）
    const sortable = groups.filter((g) => g !== '未分组');
    const gTitle = (g, count) => {
      const pos = sortable.indexOf(g);
      // 边界方向不可用时直接隐藏（首组无 ↑、末组无 ↓），比禁用态更干净
      const sortBtns = isAdmin && pos >= 0
        ? `<span class="g-sort">${pos > 0 ? `<button data-gact="up" data-group="${escapeHtml(g)}" title="上移">↑</button>` : ''}${pos < sortable.length - 1 ? `<button data-gact="down" data-group="${escapeHtml(g)}" title="下移">↓</button>` : ''}</span>`
        : '';
      return `<h3 class="group-title"><span class="g-name">${escapeHtml(g)}（${count}）</span>${sortBtns}</h3>`;
    };
    box.innerHTML = groups.map((g) => `
      ${gTitle(g, byGroup(g).length)}
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
    const domGroups = [...box.querySelectorAll('.group-title')].map((h) => (h.querySelector('.g-name') || h).textContent.replace(/[（(]\d+[）)]\s*$/, ''));
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
    onData: (list) => { serversCache = list; lastPushAt = Date.now(); updateServerCards(); },
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
    onPromptDismiss: () => {
      // 暂停时提示弹窗可能仍显示（60s 无响应自动暂停路径）——关闭残留的过期弹窗；
      // 仅在确实开着时关闭（保持滚动锁计数严格配对，见 utils.js lockScroll）
      const d = $('#dialog');
      if (d && !d.classList.contains('hidden')) closeDialog();
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
  async function openTerminal(serverId, serverName) {
    $('#term-title').textContent = `终端 · ${serverName}`;
    $('#term-modal').classList.remove('hidden');
    lockScroll();
    $('#term').innerHTML = '<p class="muted" style="padding:24px">终端组件加载中...</p>';
    // xterm + fit 首次使用才加载（缓存后零开销）；失败提示并关闭弹窗
    try {
      await Promise.all([
        loadCss('/vendor/xterm.min.css'),
        loadScript('/vendor/xterm.min.js'),
        loadScript('/vendor/addon-fit.min.js'),
      ]);
    } catch (e) {
      toast(e.message || '终端组件加载失败');
      $('#term-modal').classList.add('hidden'); // 此时尚未建会话/挂事件，直接收起弹窗即可
      unlockScroll();
      return;
    }
    if ($('#term-modal').classList.contains('hidden')) return; // 加载期间已关闭
    $('#term').innerHTML = '';

    const Term = window.Terminal;
    const Fit = (window.FitAddon && window.FitAddon.FitAddon) || window.FitAddon;
    const term = new Term({ cursorBlink: true, fontSize: 13, theme: termTheme() });
    activeTerm = term; // 主题切换时热更新 options.theme（applyTheme 引用）
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
      activeTerm = null;
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
  // 移动路径选择器状态（null=关闭）：复用主 WS 会话的 list 指令，onList 按 path 分流渲染
  let fileSelector = null; // { cwd, srcPath, srcName, srcIsDir, entries }
  const fileSess = new FileSession({
    onList: (entries, truncated, path) => {
      // 选择器打开且本次 list 目标为选择器目录 → 渲染选择器；否则渲染主列表
      if (fileSelector && path === fileSelector.cwd) {
        fileSelector.entries = entries || [];
        renderSelectorList();
      } else {
        renderFileList(entries);
        localStorage.setItem(`cfpanel_file_cwd:${fileServerId}`, path); // 记住最后浏览目录（下次打开恢复）
        $('#file-msg').textContent = truncated ? '目录条目过多，仅显示前 1000 项' : '';
      }
    },
    onUploadProgress: (pct) => { $('#file-msg').textContent = `上传中：${pct}%`; },
    onUploadDone: (path) => { $('#btn-file-cancel').classList.add('hidden'); $('#file-msg').textContent = ''; toast(`已上传：${path}`); reloadFileList(); },
    onUploadCanceled: () => { $('#btn-file-cancel').classList.add('hidden'); $('#file-msg').textContent = '已取消上传'; },
    onDownloadProgress: (pct) => { $('#file-msg').textContent = `下载中：${pct}%`; },
    onDownloadDone: (path, parts, dlName) => {
      $('#btn-dl-cancel').classList.add('hidden');
      try {
        // Blob 直接引用分块数组（不复制），避免 500MB 级文件的二次内存拷贝
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob(parts));
        a.download = dlName || CfUtils.fileBase(path) || 'download';
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
    onMkdirDone: () => { reloadFileList(); toast('目录已创建'); },
    onTouchDone: () => { reloadFileList(); toast('文件已创建'); },
    onMoveDone: (path) => { reloadFileList(); toast(`已移动到：${path}`); },
    onEditLoaded: (path, text) => openFileEditor(path, text),
    // 错误同时 toast：编辑器保存后弹窗已关闭、文件弹窗可能未开——仅写 file-msg 会零提示
    onError: (msg) => { $('#file-msg').textContent = `错误：${msg}`; toast(`文件操作错误：${msg}`); },
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
    // 恢复该服务器上次浏览目录（列表成功时持久化；格式异常则回退根目录）。
    // 绝对路径判定兼容 Windows 盘符（C:\Users\me）——仅认 / 会把 Windows 上次目录
    // 回退成 "/"，在 Windows agent 上被 fail closed 判为系统路径导致列表为空
    const saved = localStorage.getItem(`cfpanel_file_cwd:${serverId}`);
    const cwd = saved && /^(?:[/]|[A-Za-z]:[\\/])/.test(saved) ? saved : '/';
    $('#file-path').value = cwd;
    $('#file-filter').value = '';
    $('#file-msg').textContent = '';
    $('#file-list').innerHTML = '<tr><td colspan="4" class="muted">连接中...</td></tr>';
    $('#file-modal').classList.remove('hidden');
    lockScroll();
    fileSess.open(serverId, cwd); // 建会话 + WS + auth + 初始列表
  }

  function closeFileModal() {
    fileSess.close();
    $('#file-modal').classList.add('hidden');
    unlockScroll();
  }

  function renderFileList(entries) {
    const safeEntries = (Array.isArray(entries) ? entries : []).map(normalizeFileEntry);
    fileEntries = safeEntries; // 缓存已收口条目供上传同名检测
    const rows = safeEntries.map((e) => {
      const size = e.type === 'dir' ? '—' : fmtBytes(e.size);
      const time = e.mtime ? new Date(e.mtime * 1000).toLocaleString('zh-CN') : '—';
      const path = fileJoin(fileSess.cwd, e.name);
      const nameCell = e.type === 'dir'
        ? `<a class="f-dir" data-path="${escapeHtml(path)}">📁 ${escapeHtml(e.name)}</a>`
        : `<span class="f-file">📄 ${escapeHtml(e.name)}</span>`;
      // 行操作：⋯ 下拉菜单（下载/编辑/移动/重命名/删除）。目录下载 = 打包 zip。
      // 受保护系统路径（与 agent 黑名单同规则）：仅保留下载（读操作），隐藏全部写操作——
      // 系统目录的写操作请走终端 Shell；agent 端仍有最终防线，此处是 UX 层
      const prot = isSystemPath(path);
      // 在线编辑：非目录 + ≤1MB + 非系统路径 + 非二进制扩展名（空文件也放行，编辑器当空文本）
      const editable = !prot && e.type !== 'dir' && e.size <= 1024 * 1024 && !isBinaryExt(e.name);
      const menu = `<div class="row-menu-wrap">
        <button class="row-menu" type="button" title="操作" aria-label="操作">⋯</button>
        <div class="row-menu-pop hidden">
          <button class="f-act-dl" type="button" data-path="${escapeHtml(path)}" data-type="${escapeHtml(e.type)}" data-size="${escapeHtml(e.size)}">下载</button>
          ${editable ? `<button class="f-act-edit" type="button" data-path="${escapeHtml(path)}" data-size="${escapeHtml(e.size)}">编辑</button>` : ''}
          ${prot ? '' : `<button class="f-act-mv" type="button" data-path="${escapeHtml(path)}">移动</button>
          <button class="f-act-ren" type="button" data-path="${escapeHtml(path)}">重命名</button>
          <button class="f-act-del danger" type="button" data-path="${escapeHtml(path)}" data-type="${escapeHtml(e.type)}">删除</button>`}
        </div>
      </div>`;
      return `<tr><td>${nameCell}</td><td>${size}</td><td>${escapeHtml(time)}</td><td class="f-ops">${menu}</td></tr>`;
    });
    $('#file-list').innerHTML = rows.join('') || '<tr><td colspan="4" class="muted">空目录</td></tr>';
    // cwd 为受保护系统目录时禁用上传与新建（写操作会被 agent 拒；特殊需求走终端 Shell）
    const cwdProt = isSystemPath(fileSess.cwd);
    const upBtn = document.querySelector('label.file-upload');
    if (upBtn) {
      upBtn.classList.toggle('hidden', cwdProt);
      upBtn.title = cwdProt ? '系统目录受保护，禁止上传；如需操作请使用终端 Shell' : '';
    }
    $('#file-input').disabled = cwdProt;
    $('#btn-file-mkdir').classList.toggle('hidden', cwdProt);
    $('#btn-file-touch').classList.toggle('hidden', cwdProt);
  }

  // 新建目录 / 新建文件（当前 cwd 下；名字不带 /，agent mkdir -p 语义 + touch create_new）
  function mkDir() {
    promptDialog(`新建目录（路径：${escapeHtml(fileSess.cwd)}）`, 'new-dir', (name) => {
      if (!name || name.includes('/')) return toast('目录名不能包含 /');
      fileSess.mkdir(fileJoin(fileSess.cwd, name));
    });
  }
  function touchFile() {
    promptDialog(`新建文件（路径：${escapeHtml(fileSess.cwd)}）`, 'new-file.txt', (name) => {
      if (!name || name.includes('/')) return toast('文件名不能包含 /');
      fileSess.touch(fileJoin(fileSess.cwd, name));
    });
  }

  // ---------- 在线编辑器：Monaco（CDN 懒加载，失败回退 textarea）----------
  // dirty 跟踪：内容 != 打开时的初始文本 → 保存按钮高亮提示；扩大：toggle 全屏布局
  let editorPath = '';
  let editorInitial = '';   // 打开时的初始内容（dirty 判定基准）
  let editorDirty = false;
  let monacoEditor = null;  // Monaco 实例（null = textarea 回退模式）
  let monacoReady = false;  // 本会话 Monaco 是否可用（失败后本会话直接走 textarea，不反复重试）
  let editorPreviewing = false; // Markdown 预览模式（仅 md 文件显示切换按钮）

  // 后缀 → Monaco 语言 ID（均为 min 版内置 basic-languages，无需额外加载）
  const EDITOR_LANGS = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    json: 'json', jsonc: 'json',
    yaml: 'yaml', yml: 'yaml', xml: 'xml', svg: 'xml', xsl: 'xml', plist: 'xml',
    html: 'html', htm: 'html', vue: 'html',
    css: 'css', scss: 'scss', less: 'less',
    md: 'markdown', mdx: 'markdown', rst: 'restructuredtext',
    sql: 'sql', psql: 'sql', mysql: 'mysql',
    sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
    py: 'python', pyw: 'python', rb: 'ruby', go: 'go', rs: 'rust',
    c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', hxx: 'cpp', cxx: 'cpp',
    cs: 'csharp', java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala',
    swift: 'swift', dart: 'dart', php: 'php', phtml: 'php',
    pl: 'perl', pm: 'perl', lua: 'lua', r: 'r', tcl: 'tcl',
    groovy: 'shell', vb: 'vb',
    bat: 'bat', cmd: 'bat', ps1: 'powershell', psm1: 'powershell',
    ini: 'ini', conf: 'ini', cfg: 'ini', env: 'ini', toml: 'ini', properties: 'ini',
    tf: 'hcl', tfvars: 'hcl', hcl: 'hcl',
    graphql: 'graphql', gql: 'graphql', proto: 'protobuf',
    log: 'plaintext', txt: 'plaintext',
  };
  // 无后缀 / 点文件的文件名 → 语言（basename 精确匹配）
  const EDITOR_FILE_LANGS = {
    dockerfile: 'dockerfile', makefile: 'shell', gnumakefile: 'shell',
    bashrc: 'shell', bash_profile: 'shell', bash_logout: 'shell',
    profile: 'shell', zshrc: 'shell', zshenv: 'shell', zprofile: 'shell',
    gitconfig: 'ini', editorconfig: 'ini',
  };
  function editorLang(path) {
    const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
    const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : base;
    return EDITOR_FILE_LANGS[base] || EDITOR_LANGS[ext] || 'plaintext';
  }

  function setEditorDirty(dirty) {
    editorDirty = dirty;
    const btn = $('#btn-editor-save');
    btn.classList.toggle('dirty', dirty);
    btn.textContent = dirty ? '保存 ●' : '保存';
    // 有未保存改动时标题加标记
    $('#file-editor-title').textContent = `编辑：${editorPath}${dirty ? ' *' : ''}`;
  }

  async function openFileEditor(path, text) {
    editorPath = path;
    editorInitial = text;
    monacoEditor = null;
    setEditorDirty(false);
    // Markdown 文件显示「预览」按钮；打开新文件时预览态复位
    editorPreviewing = false;
    $('#btn-editor-preview').classList.toggle('hidden', editorLang(path) !== 'markdown');
    $('#btn-editor-preview').textContent = '预览';
    $('#editor-md-preview').classList.add('hidden');
    $('#file-editor-title').textContent = `编辑：${path}`;
    $('#file-editor-text').value = text; // textarea 始终持有内容（回退与保存兜底）
    $('#file-editor-modal').classList.remove('hidden');
    $('#file-editor-modal').classList.remove('expanded');
    $('#btn-editor-expand').textContent = '扩大';
    lockScroll();
    if (!monacoReady) {
      try {
        const monaco = await loadMonaco();
        monacoReady = true;
        initMonaco(monaco, path, text);
      } catch {
        // CDN 不可达（无网/被墙）：回退 textarea，本会话不再重试
        $('#file-editor-text').classList.remove('hidden');
        $('#editor-monaco-host').classList.add('hidden');
      }
      return;
    }
    // Monaco 已就绪（本会话内重复打开）
    initMonaco(window.monaco, path, text);
  }

  function initMonaco(monaco, path, text) {
    $('#file-editor-text').classList.add('hidden');
    const host = $('#editor-monaco-host');
    host.classList.remove('hidden');
    if (monacoEditor) {
      monacoEditor.getModel().dispose();
      monacoEditor.dispose();
      monacoEditor = null;
    }
    monaco.editor.setTheme(theme === 'light' ? 'vs' : 'vs-dark');
    const model = monaco.editor.createModel(text, editorLang(path), monaco.Uri.parse('file://' + path));
    monacoEditor = monaco.editor.create(host, {
      model,
      theme: theme === 'light' ? 'vs' : 'vs-dark', fontSize: 13, automaticLayout: true,
      minimap: { enabled: false }, scrollBeyondLastLine: false, tabSize: 4,
      renderWhitespace: 'selection', wordWrap: 'on',
    });
    model.onDidChangeContent(() => setEditorDirty(model.getValue() !== editorInitial));
    setTimeout(() => monacoEditor && monacoEditor.focus(), 50);
  }

  function editorGetValue() {
    return monacoEditor ? monacoEditor.getValue() : $('#file-editor-text').value;
  }

  function saveFileEditor() {
    // 连接断开（文件弹窗被关/WS 掉线）时 upload 会静默丢弃发送帧——编辑内容丢失且零提示。
    // 先校验连接，断开则阻止保存（编辑器保持打开，重连后可重试）
    if (!fileSess.connected) {
      toast('文件连接已断开，无法保存。请打开文件管理器并点击「刷新」重连后重试');
      return;
    }
    const text = editorGetValue();
    const name = CfUtils.fileBase(editorPath) || 'edit.tmp';
    // File 构造（Blob + name）：复用上传状态机分块写回；显式 path（编辑期间 cwd 可能已变化）
    fileSess.upload(new File([text], name, { type: 'text/plain' }), { overwrite: true, path: editorPath });
    closeFileEditor();
    $('#file-msg').textContent = '保存中...';
  }

  function toggleEditorExpand() {
    const modal = $('#file-editor-modal');
    const expanded = modal.classList.toggle('expanded');
    $('#btn-editor-expand').textContent = expanded ? '还原' : '扩大';
    // Monaco automaticLayout 异步自适应；textarea 用 CSS flex 自动撑满
    if (monacoEditor) setTimeout(() => monacoEditor && monacoEditor.layout(), 60);
  }

  // Markdown 预览/编辑切换：marked 渲染 + DOMPurify 消毒（内容来自服务器文件，innerHTML 前必须过滤 XSS）
  async function toggleEditorPreview() {
    const btn = $('#btn-editor-preview');
    if (editorPreviewing) { // 预览 → 编辑：恢复原编辑视图（Monaco 或 textarea 回退）
      $('#editor-md-preview').classList.add('hidden');
      if (monacoEditor) $('#editor-monaco-host').classList.remove('hidden');
      else $('#file-editor-text').classList.remove('hidden');
      editorPreviewing = false;
      btn.textContent = '预览';
      return;
    }
    let md;
    try { md = await loadMarkdown(); }
    catch { toast('预览组件加载失败，请稍后重试'); return; }
    $('#editor-md-preview').innerHTML = md.purify.sanitize(md.marked.parse(editorGetValue()));
    $('#editor-md-preview').classList.remove('hidden');
    $('#file-editor-text').classList.add('hidden');
    $('#editor-monaco-host').classList.add('hidden');
    editorPreviewing = true;
    btn.textContent = '编辑';
  }

  function closeFileEditor() {
    fileSess.cancelEditText();
    editorPreviewing = false;
    $('#btn-editor-preview').classList.add('hidden');
    $('#btn-editor-preview').textContent = '预览';
    $('#editor-md-preview').classList.add('hidden');
    $('#editor-md-preview').innerHTML = ''; // 清空引用，释放大文档 DOM
    if (monacoEditor) {
      monacoEditor.getModel().dispose();
      monacoEditor.dispose();
      monacoEditor = null;
    }
    $('#file-editor-text').classList.remove('hidden'); // 复位：下次回退模式可见
    $('#editor-monaco-host').classList.add('hidden');
    $('#file-editor-modal').classList.add('hidden');
    $('#file-editor-modal').classList.remove('expanded');
    setEditorDirty(false);
    unlockScroll();
  }

  // ---------- 移动路径选择器（浏览目录选目标 + 文件名输入；复用主 WS 的 list 指令） ----------
  function openFileSelector(srcPath, srcName, srcIsDir) {
    fileSelector = { cwd: fileParent(srcPath), srcPath, srcName, srcIsDir, entries: [] };
    $('#sel-title').textContent = `移动：${srcPath}`;
    $('#sel-name').value = srcName;
    $('#file-selector-modal').classList.remove('hidden');
    lockScroll();
    fileSess.list(fileSelector.cwd, ''); // 拉取起始目录（onList 按 path 分流）
  }
  function closeFileSelector() {
    fileSelector = null;
    $('#file-selector-modal').classList.add('hidden');
    unlockScroll();
  }
  // 选择器目录列表：仅显示子目录（点进入）；底部即时同名提示
  function renderSelectorList() {
    if (!fileSelector) return;
    const dirs = fileSelector.entries.filter((e) => e.type === 'dir');
    const rows = dirs.map((e) => {
      const p = fileJoin(fileSelector.cwd, e.name);
      const prot = isSystemPath(p);
      return `<tr><td><a class="f-dir${prot ? ' f-prot' : ''}" data-path="${escapeHtml(p)}">📁 ${escapeHtml(e.name)}${prot ? ' 🔒' : ''}</a></td></tr>`;
    });
    $('#sel-list').innerHTML = rows.join('') || '<tr><td class="muted">（无子目录）</td></tr>';
    $('#sel-cwd').textContent = fileSelector.cwd;
    // 目标目录为系统目录 → 禁止确认（agent 也会拦，此处提前提示）
    const protCwd = isSystemPath(fileSelector.cwd);
    $('#btn-sel-ok').disabled = protCwd;
    $('#sel-msg').textContent = protCwd ? '系统目录受保护，不可作为目标；如需操作请使用终端 Shell' : '';
    checkSelectorConflict();
  }
  // 即时同名冲突提示（最终以 agent 拒绝为准——列表可能过期）
  function checkSelectorConflict() {
    if (!fileSelector) return;
    const name = $('#sel-name').value.trim();
    const conflict = name && fileSelector.entries.some((e) => e.name === name);
    const sameSrc = name === fileSelector.srcName && fileSelector.cwd === fileParent(fileSelector.srcPath);
    $('#btn-sel-ok').disabled = isSystemPath(fileSelector.cwd) || !name || sameSrc;
    if (sameSrc) $('#sel-msg').textContent = '与源位置相同，无需移动';
    else if (conflict) $('#sel-msg').textContent = `目标已存在同名「${name}」，将被拒绝（不覆盖）`;
    else if (!isSystemPath(fileSelector.cwd)) $('#sel-msg').textContent = '';
  }
  function selEnter(path) {
    if (!fileSelector) return;
    fileSelector.cwd = path;
    fileSess.list(path, '');
  }
  function selUp() {
    if (!fileSelector) return;
    const up = fileParent(fileSelector.cwd);
    if (up !== fileSelector.cwd) selEnter(up);
  }
  function confirmSelectorMove() {
    if (!fileSelector) return;
    const name = $('#sel-name').value.trim();
    // 两种分隔符都拒绝（Windows '\' 越目录；与 agent 端 file_rename/file_move 校验同步）
    if (!name || name.includes('/') || name.includes('\\')) return toast('文件名不能为空且不含路径分隔符');
    const dest = fileJoin(fileSelector.cwd, name);
    if (dest === fileSelector.srcPath) return toast('与源位置相同');
    fileSess.move(fileSelector.srcPath, dest);
    closeFileSelector();
    $('#file-msg').textContent = `移动中：${dest}`;
  }

  // 上传/下载入口：状态机在 FileSession（api.js），这里只负责 UI 接线。
  // 上传前检测当前目录同名文件（服务端首块同样强制校验 overwrite，双保险）——同名需二次确认
  function uploadFile(file) {
    if (isSystemPath(fileSess.cwd)) {
      toast('系统目录受保护，禁止上传；如需操作请使用终端 Shell');
      return;
    }
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
    // Chart.js 首次使用才加载（200KB，缓存后零开销）；与数据请求并行
    const chartReady = loadScript('/vendor/chart.umd.min.js').catch((e) => {
      if (seq !== monitorReqSeq) return; // 已切换其他 range，无需提示
      toast(e.message || '图表库加载失败');
      return null;
    });
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
      if (null === await chartReady) return; // 图表库加载失败（toast 已提示），数据请求不再渲染
      if (seq !== monitorReqSeq) return; // 等待期间已切换 range
      renderMonitorChart(downsample(rows), custom, downsampled);
    } catch (e) {
      toast(e.message);
    }
  }

  // 监控图表：每个指标独立一张图（CPU / 内存 / 网络 / 自定义指标），纵向排列，
  // 各自独立刻度轴——量纲不同不再挤在一张图（原双轴方案可读性差）
  function renderMonitorChart(rows, custom, downsampled) {
    monitorLast = { rows, custom, downsampled }; // 缓存：主题切换时零请求重建
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
    // 公共刻度样式；unit 可选（如 '%'/'KB/s'）→ Y 轴刻度值后追加单位。
    // 颜色读 CSS 变量：随 data-theme 切换（主题切换时整图重建取新值）
    const axisStyle = (unit) => ({
      ticks: {
        color: cssVar('--muted'), maxTicksLimit: 8, maxRotation: 0,
        callback: unit ? (v) => `${v}${unit}` : undefined,
      },
      grid: { color: cssVar('--chart-grid') },
    });
    const chartOpts = (yUnit) => ({
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: cssVar('--muted'), boxWidth: 12 } },
        tooltip: { backgroundColor: cssVar('--panel-solid'), borderColor: cssVar('--border'), borderWidth: 1, titleColor: cssVar('--text'), bodyColor: cssVar('--muted') },
      },
      scales: { x: axisStyle(), y: axisStyle(yUnit) },
    });
    // 取最后一个非 null 数据点（标题右侧最新值用）
    const lastVal = (arr) => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i]; return null; };
    // 实时更新注册表：每张图的 chart 实例、涉及的 dataset 索引、从最新 metric 取值与格式化的函数
    const liveCharts = [];
    // 生成一块"标题 + 最新值 + canvas"的图块并创建 Chart 实例；
    // tooltipLabel 可选（自定义 tooltip 内容）；latestText 为标题右侧最新数据文本；yUnit 为 Y 轴刻度单位；
    // fmt 可选（实时更新时自定义标题右侧最新值文本，默认数值用 ' · ' 连接）；
    // y2Unit 可选（右侧 Y 轴单位，dataset 用 yAxisID: 'y2' 挂右轴，如 %util）；
    // gridCol 可选（1-3 显式指定 3 列网格中的列，控制换行位置）；spanFull 整行占满（自定义指标）
    const mkChart = (title, datasets, tooltipLabel, latestText, liveGet, yUnit, fmt, y2Unit, gridCol, spanFull) => {
      const id = `mc-${monitorCharts.length + 1}`;
      const div = document.createElement('div');
      div.className = 'm-chart' + (spanFull ? ' m-chart-full' : '');
      if (gridCol) div.style.gridColumn = String(gridCol);
      div.innerHTML = `<h4 class="m-chart-title">${title}<span class="m-chart-latest">${latestText || ''}</span></h4><div class="m-chart-body"><canvas id="${id}"></canvas></div>`;
      wrap.appendChild(div);
      const opts = chartOpts(yUnit);
      if (y2Unit) {
        opts.scales.y2 = axisStyle(y2Unit);
        opts.scales.y2.position = 'right'; // 右轴移到最右侧（Chart.js 默认与左轴堆叠）
        opts.scales.y2.grid = { drawOnChartArea: false }; // 双轴网格不叠加
      }
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
          fmt: fmt || ((values) => values.filter((v) => v != null).join(' · ')),
        });
      }
    };
    const memPctOf = (r) => (r && r.mem_total > 0 ? +(r.mem_used / r.mem_total * 100).toFixed(1) : null);
    const swapPctOf = (r) => { const s = r && r.extra && r.extra.swap, t = r && r.extra && r.extra.swap_total; return s != null && t > 0 ? +(s / t * 100).toFixed(1) : null; };
    // tooltip 格式化：按 dataset label 追加单位或函数格式化（如 {CPU:(v)=>v.toFixed(1)+'%'}）；未配置的不追加
    const tipWith = (units) => (ctx) => {
      const v = ctx.raw;
      if (v == null) return '';
      const u = units[ctx.dataset.label];
      return `${ctx.dataset.label}：${typeof u === 'function' ? u(v) : v}${typeof u === 'string' ? u : ''}`;
    };

    // CPU：独立图（%）
    const cpuData = rows.map((r) => r.cpu);
    mkChart('CPU（%）', [{ label: 'CPU', data: cpuData, ...lineCfg('#3b82f6', 'rgba(59,130,246,.12)'), fill: true }], tipWith({ CPU: (v) => v.toFixed(1) + '%' }),
      lastVal(cpuData) != null ? `${lastVal(cpuData).toFixed(1)}%` : '',
      (m) => (m.cpu == null ? null : m.cpu.toFixed(1) + '%'),
      '%', undefined, undefined, 1);
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
      [['内存', lastVal(memPctData)], ['Swap', lastVal(swapPctData)]].filter(([, v]) => v != null).map(([d, v]) => `${d}：${v}%`).join(' · '),
      (m) => [memPctOf(m), swapPctOf(m)].map((v) => (v == null ? null : v + '%')),
      '%',
      ([mem, swap]) => [['内存', mem], ['Swap', swap]].filter(([, v]) => v != null).map(([d, v]) => `${d}：${v}`).join(' · '),
      undefined, 2);
    // 负载：1/5/15 分钟三条线（无单位），独立图
    const load1Data = rows.map((r) => (r && r.extra && r.extra.load1 != null ? Number(r.extra.load1) : null));
    const load5Data = rows.map((r) => (r && r.extra && r.extra.load5 != null ? Number(r.extra.load5) : null));
    const load15Data = rows.map((r) => (r && r.extra && r.extra.load15 != null ? Number(r.extra.load15) : null));
    mkChart('负载 (1/5/15)', [
      { label: '1m', data: load1Data, ...lineCfg('#3b82f6', 'transparent') },
      { label: '5m', data: load5Data, ...lineCfg('#f59e0b', 'transparent') },
      { label: '15m', data: load15Data, ...lineCfg('#34d399', 'transparent') },
    ], tipWith({ '1m': (v) => v.toFixed(2), '5m': (v) => v.toFixed(2), '15m': (v) => v.toFixed(2) }),
      [lastVal(load1Data), lastVal(load5Data), lastVal(load15Data)].filter((v) => v != null).map((v) => v.toFixed(2)).join(' / '),
      (m) => {
        const e = (m && m.extra) || {};
        return [e.load1, e.load5, e.load15].map((v) => (v == null ? null : Number(v).toFixed(2)));
      },
      '',
      (vals) => vals.filter((v) => v != null).join(' / '),
      undefined, 3);
    // 磁盘：整体使用率（累计，与卡片/tooltip 标题栏一致），% 量纲独立图；tooltip 显示累计当前值/最大值
    const diskSumData = rows.map(diskSumOf);
    const diskPctData = diskSumData.map((d) => (d ? d.pct : null));
    mkChart('磁盘（%）', [
      { label: '磁盘', data: diskPctData, ...lineCfg('#34d399', 'rgba(52,211,153,.08)'), fill: true },
    ],
      (ctx) => {
        const d = diskSumData[ctx.dataIndex];
        if (!d) return '';
        return d.used != null ? `磁盘：${fmtBytes(d.used)} / ${fmtBytes(d.total)}（${d.pct}%）` : `磁盘：${d.pct}%`;
      },
      lastVal(diskPctData) != null ? `${lastVal(diskPctData)}%` : '',
      (m) => { const d = diskSumOf(m); return d ? d.pct + '%' : null; },
      '%', undefined, undefined, 1);
    // 磁盘 IO：读写速率（KB/s，左轴）+ %util（右轴 %）双轴一图——吞吐与忙占比同看；
    // IOPS 量纲独立（次/秒）单独一张
    const ioOf = (r) => (r && r.extra && r.extra.disk_io) || null;
    const ioReadData = rows.map((r) => { const io = ioOf(r); return io && io.read_kbs != null ? io.read_kbs : null; });
    const ioWriteData = rows.map((r) => { const io = ioOf(r); return io && io.write_kbs != null ? io.write_kbs : null; });
    const ioUtilData = rows.map((r) => { const io = ioOf(r); return io && io.util_pct != null ? io.util_pct : null; });
    const ioLast = (io) => (io && io.read_kbs != null ? `↓ ${io.read_kbs} KB/s` : '') +
      (io && io.write_kbs != null ? ` · ↑ ${io.write_kbs} KB/s` : '') +
      (io && io.util_pct != null ? ` · util ${io.util_pct}%` : '');
    mkChart('磁盘 IO（KB/s · %）', [
      { label: '读', data: ioReadData, ...lineCfg('#22d3ee', 'transparent') },
      { label: '写', data: ioWriteData, ...lineCfg('#f472b6', 'transparent') },
      { label: 'util', data: ioUtilData, ...lineCfg('#34d399', 'transparent'), yAxisID: 'y2' },
    ], tipWith({ 读: ' KB/s', 写: ' KB/s', util: '%' }),
      ioLast({ read_kbs: lastVal(ioReadData), write_kbs: lastVal(ioWriteData), util_pct: lastVal(ioUtilData) }),
      (m) => {
        const io = ioOf(m);
        return [io && io.read_kbs, io && io.write_kbs, io && io.util_pct].map((v) => (v == null ? null : v));
      },
      'KB/s',
      ([r, w, u]) => [r != null ? `↓ ${r} KB/s` : null, w != null ? `↑ ${w} KB/s` : null, u != null ? `util ${u}%` : null].filter(Boolean).join(' · '),
      '%', 2);
    const ioRData = rows.map((r) => { const io = ioOf(r); return io && io.r_iops != null ? io.r_iops : null; });
    const ioWData = rows.map((r) => { const io = ioOf(r); return io && io.w_iops != null ? io.w_iops : null; });
    mkChart('磁盘 IOPS', [
      { label: '读', data: ioRData, ...lineCfg('#22d3ee', 'transparent') },
      { label: '写', data: ioWData, ...lineCfg('#f472b6', 'transparent') },
    ], tipWith({ 读: ' 次/秒', 写: ' 次/秒' }),
      [['读', lastVal(ioRData)], ['写', lastVal(ioWData)]].filter(([, v]) => v != null).map(([d, v]) => `${d} ${v}`).join(' · '),
      (m) => {
        const io = ioOf(m);
        return [io && io.r_iops, io && io.w_iops].map((v) => (v == null ? null : v));
      },
      '次/秒',
      ([r, w]) => [['读', r], ['写', w]].filter(([, v]) => v != null).map(([d, v]) => `${d} ${v}`).join(' · '),
      undefined, 3);
    // 网络：上下行同量纲（KB/s）放一张，便于对比
    const netInData = rows.map((r) => (r.net_in == null ? null : +(r.net_in / 1024).toFixed(1)));
    const netOutData = rows.map((r) => (r.net_out == null ? null : +(r.net_out / 1024).toFixed(1)));
    mkChart('网络（KB/s）', [
      { label: '下行', data: netInData, ...lineCfg('#22d3ee', 'transparent') },
      { label: '上行', data: netOutData, ...lineCfg('#f472b6', 'transparent') },
    ], tipWith({ 下行: ' KB/s', 上行: ' KB/s' }),
      [['↓', lastVal(netInData)], ['↑', lastVal(netOutData)]].filter(([, v]) => v != null).map(([d, v]) => `${d} ${v} KB/s`).join(' · '),
      (m) => {
        const vals = [m.net_in, m.net_out].map((v) => (v == null ? null : +(v / 1024).toFixed(1)));
        return [['↓', vals[0]], ['↑', vals[1]]].filter(([, v]) => v != null).map(([d, v]) => `${d} ${v} KB/s`).join(' · ');
      },
      'KB/s', undefined, undefined, 1);
    // 连接数：TCP + UDP（与网络图风格一致，双线便于对比）
    const tcpData = rows.map((r) => (r && r.extra && r.extra.tcp != null ? r.extra.tcp : null));
    const udpData = rows.map((r) => (r && r.extra && r.extra.udp != null ? r.extra.udp : null));
    mkChart('连接数（TCP/UDP）', [
      { label: 'TCP', data: tcpData, ...lineCfg('#22d3ee', 'transparent') },
      { label: 'UDP', data: udpData, ...lineCfg('#f472b6', 'transparent') },
    ], null,
      [['TCP', lastVal(tcpData)], ['UDP', lastVal(udpData)]].filter(([, v]) => v != null).map(([d, v]) => `${d}：${v}`).join(' · '),
      (m) => {
        const e = (m && m.extra) || {};
        return [e.tcp, e.udp].map((v) => (v == null ? null : v));
      },
      '',
      ([tcp, udp]) => [['TCP', tcp], ['UDP', udp]].filter(([, v]) => v != null).map(([d, v]) => `${d}：${v}`).join(' · '),
      undefined, 2);
    // 进程数：extra.procs（整数），独立图
    const procsData = rows.map((r) => (r && r.extra && r.extra.procs != null ? r.extra.procs : null));
    mkChart('进程数', [
      { label: '进程', data: procsData, ...lineCfg('#a78bfa', 'rgba(167,139,250,.08)'), fill: true },
    ], null,
      lastVal(procsData) != null ? String(lastVal(procsData)) : '',
      (m) => (m && m.extra && m.extra.procs != null ? m.extra.procs : null),
      '', undefined, undefined, 3);
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
        }).filter(Boolean).join(' · '),
        null, null, null, null, null, true);
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
      }
      lc.chart.update('none'); // 无动画，避免 5s 推送抖动
      if (lc.latestEl) lc.latestEl.textContent = lc.fmt(values);
    }
    // tsArr 为共享窗口，只推进一次（在图表循环外——否则 N 张图窗口被移 N 位、尾部出现重复 minTs）
    if (append) {
      monitorLive.tsArr.push(minTs);
      monitorLive.tsArr.shift();
    }
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
      // 指标区只挂 data-id，从 serversCache 现取最新数据（推送每 5s 更新缓存，
      // 展开时即最新——旧 data-metric 内嵌是快照，反而可能过期）
      const sid = Number(metricEl.dataset.id);
      const s = serversCache.find((x) => x.id === sid);
      if (!s || !s.metric) return;
      tipSource = metricEl;
      metricTip.innerHTML = metricTipHtml(s.metric, s.info || null);
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
    else if (act === 'edit') openEditModal(Number(id), name, btn.dataset.group, btn.dataset.order);
    else if (act === 'del') {
      confirmDialog(`确认删除服务器「${name}」？`, () => {
        api(`/api/servers/${id}`, { method: 'DELETE' }).then(loadServers).catch((e2) => toast(e2.message));
      });
    }
  });

  // 分组排序：↑↓ 与相邻组交换位置（以当前视觉顺序为准重建全量数组，
  // 未入表的组顺带纳入、孤儿条目顺带清理），乐观渲染 + 失败回滚
  $('#servers').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-gact]');
    if (!btn || btn.disabled) return;
    const g = btn.dataset.group;
    const visual = groupList().filter((x) => x !== '未分组'); // 未分组固定最后，不参与
    const i = visual.indexOf(g);
    const j = btn.dataset.gact === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= visual.length) return;
    [visual[i], visual[j]] = [visual[j], visual[i]];
    const prev = groupOrder;
    groupOrder = visual;
    renderServers(); // 乐观：立即呈现新顺序
    try {
      const r = await api('/api/group-order', { method: 'PUT', body: JSON.stringify({ order: visual }) });
      groupOrder = (r && Array.isArray(r.order)) ? r.order : visual; // 后端裁剪后的权威顺序
    } catch (e2) {
      groupOrder = prev;
      toast(e2.message);
    }
    renderServers();
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
    monitorLast = null; // 数据缓存一并释放
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
    // 刷新兼跳转（原独立「跳转」按钮已并入）：路径输入框即目标目录，与 cwd 相同则等效刷新
    const p = $('#file-path').value.trim();
    if (p) fileSess.cwd = p;
    // WS 断开时重建会话（旧会话已失效，cwd 已更新，重连后按新路径列表）；在线则刷新列表
    if (fileSess.connected) reloadFileList();
    else if (fileServerId) fileSess.reconnect();
  };
  $('#file-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#file-refresh').click(); });
  $('#file-up').onclick = () => { fileSess.cwd = fileParent(fileSess.cwd); $('#file-path').value = fileSess.cwd; reloadFileList(); };
  // 主题切换（顶栏 ☀️/🌙）：切换 data-theme + Monaco + 监控图表重建（applyTheme 内处理）
  $('#btn-theme').onclick = () => applyTheme(theme === 'light' ? 'dark' : 'light');
  applyTheme(theme); // 初始化按钮图标（data-theme 已由 theme-init.js 预置，无 FOUC）
  $('#file-input').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) uploadFile(f); e.target.value = ''; });
  // 新建目录 / 新建文件 / 在线编辑器 / 移动选择器
  $('#btn-file-mkdir').onclick = mkDir;
  $('#btn-file-touch').onclick = touchFile;
  $('#btn-editor-save').onclick = saveFileEditor;
  $('#btn-editor-preview').onclick = toggleEditorPreview;
  $('#btn-editor-close').onclick = () => {
    // 有未保存改动时二次确认（Monaco 与 textarea 共用 editorDirty）
    if (editorDirty) confirmDialog('有未保存的修改，确认放弃？', closeFileEditor);
    else closeFileEditor();
  };
  $('#btn-editor-expand').onclick = toggleEditorExpand;
  $('#file-editor-text').addEventListener('input', () => setEditorDirty($('#file-editor-text').value !== editorInitial));
  // Ctrl/Cmd+S 保存
  $('#file-editor-modal').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      saveFileEditor();
    }
  });
  $('#btn-sel-close').onclick = closeFileSelector;
  $('#btn-sel-ok').onclick = confirmSelectorMove;
  $('#btn-sel-up').onclick = selUp;
  $('#sel-go').onclick = () => { const p = $('#sel-path').value.trim(); if (p) selEnter(p); };
  $('#sel-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#sel-go').click(); });
  $('#sel-name').addEventListener('input', checkSelectorConflict);
  // 选择器目录点击进入（事件委托）
  $('#sel-list').addEventListener('click', (e) => {
    const a = e.target.closest('a.f-dir');
    if (a) selEnter(a.dataset.path);
  });
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
      const old = CfUtils.fileBase(ren.dataset.path);
      // 原生 prompt() → promptDialog（对话框体系一致，回车确认/Esc 取消）
      promptDialog(`重命名：${ren.dataset.path}（仅改名，不支持跨目录）`, old, (name) => {
        if (name.includes('/') || name.includes('\\')) return toast('名称不能包含路径分隔符');
        fileSess.rename(ren.dataset.path, name);
      });
      return;
    }
    const mv = e.target.closest('.f-act-mv');
    if (mv) {
      closeRowMenus();
      openFileSelector(mv.dataset.path, CfUtils.fileBase(mv.dataset.path), mv.dataset.type === 'dir');
      return;
    }
    const ed = e.target.closest('.f-act-edit');
    if (ed) {
      closeRowMenus();
      fileSess.editText(ed.dataset.path, Number(ed.dataset.size) || 0);
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
    // 焦点恢复由上面的 MutationObserver 统一处理。
    // 目标弹窗取最后一个非 hidden（弹窗统一 z-index:10，DOM 顺序即视觉叠放顺序——
    // 编辑器叠在文件弹窗之上时，第一次 Esc 应关编辑器而非背景文件弹窗）；
    // 关闭按钮只认 ✕（button.icon）——编辑器 head 第一个按钮是「保存」、选择器是
    // 「移动到此处」，取第一个按钮会把 Esc 变成危险操作（保存/移动）导致内容丢失
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const open = [...modals].reverse().find((m) => !m.classList.contains('hidden'));
      if (!open) return;
      const closeBtn = open.querySelector('.modal-head button.icon');
      if (closeBtn) { closeBtn.click(); return; }
      // 无 ✕ 按钮的弹窗分派到各自的关闭入口（保持 dirty 确认/状态清理等既有逻辑）
      if (open.id === 'file-editor-modal') { $('#btn-editor-close').click(); return; }
      if (open.id === 'file-selector-modal') { closeFileSelector(); return; }
      open.classList.add('hidden');
      unlockScroll();
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
