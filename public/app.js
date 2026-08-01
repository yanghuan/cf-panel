// cf-panle 前端逻辑：登录、分组服务器列表、xterm 终端（自动重连）、公告/设置、PAT 管理
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  let token = localStorage.getItem('cfpanle_token') || '';
  let serversCache = [];
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

  // ---------- 公开设置（公告/站点名，存 KV） ----------
  async function loadPublic() {
    try {
      const s = await api('/api/public/settings');
      if (s.site_name) document.title = s.site_name;
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
    $('#auth').classList.remove('hidden');
    $('#app').classList.add('hidden');
  }
  function showApp(user) {
    $('#auth').classList.add('hidden');
    $('#app').classList.remove('hidden');
    $('#whoami').textContent = user.is_pat ? `令牌（${escapeHtml(user.username)}）` : '管理员';
    loadServers();
  }

  async function doLogin() {
    const password = $('#auth-pass').value;
    const msg = $('#auth-msg');
    msg.textContent = '';
    try {
      const data = await api('/api/login', { method: 'POST', body: JSON.stringify({ password }) });
      token = data.token;
      localStorage.setItem('cfpanle_token', token);
      showApp(data.user);
    } catch (e) {
      msg.textContent = e.message;
    }
  }

  // ---------- 服务器 ----------
  async function loadServers() {
    try {
      serversCache = await api('/api/servers');
      renderServers();
    } catch (e) {
      if (String(e.message).includes('401') || String(e.message).includes('unauthorized')) {
        token = ''; localStorage.removeItem('cfpanle_token'); showAuth(); return;
      }
      toast(e.message);
    }
  }

  function cardHtml(s) {
    return `
      <div class="card">
        <div class="name">${escapeHtml(s.name)}</div>
        <div class="meta">uuid: ${escapeHtml(s.uuid)}</div>
        <div><span class="badge ${s.online ? 'on' : 'off'}">${s.online ? '在线' : '离线'}</span></div>
        <div class="actions">
          <button data-act="term" data-id="${s.id}" data-name="${escapeHtml(s.name)}">终端</button>
          <button data-act="mon" data-id="${s.id}" data-name="${escapeHtml(s.name)}" class="ghost">监控</button>
          <button data-act="del" data-id="${s.id}" class="danger">删除</button>
        </div>
      </div>`;
  }

  function renderServers() {
    const box = $('#servers');
    if (!serversCache.length) {
      box.innerHTML = '<p style="color:var(--muted)">还没有服务器，点「添加服务器」生成 agent 配置。</p>';
      return;
    }
    // 组内按 display_index（序号）排序
    const sorted = [...serversCache].sort((a, b) => (a.display_index || 0) - (b.display_index || 0));
    const groups = {};
    for (const s of sorted) {
      const g = s.group || '未分组';
      (groups[g] = groups[g] || []).push(s);
    }
    box.innerHTML = Object.keys(groups).map((g) => `
      <h3 class="group-title">${escapeHtml(g)}（${groups[g].length}）</h3>
      <div class="grid">${groups[g].map(cardHtml).join('')}</div>`).join('');
  }

  async function addServer() {
    const name = $('#inp-name').value.trim();
    const group = $('#inp-group').value.trim();
    const sortOrder = Number($('#inp-order').value) || 0;
    if (!name) return toast('请输入服务器名称');
    try {
      const cfg = await api('/api/servers', { method: 'POST', body: JSON.stringify({ name, group, sort_order: sortOrder }) });
      const text = `服务器已添加，agent 配置（仅显示一次）：\n\nWSS 地址: ${cfg.wss_base}\nUUID: ${cfg.uuid}\nKEY: ${cfg.agent_key}\n\n上报地址: ${cfg.report_url}`;
      alert(text); // 一次性展示 agent 凭据
      $('#inp-name').value = '';
      $('#inp-group').value = '';
      $('#inp-order').value = '';
      loadServers();
    } catch (e) {
      toast(e.message);
    }
  }

  // ---------- 终端（断线自动重连） ----------
  function openTerminal(serverId, serverName) {
    $('#term-title').textContent = `终端 · ${serverName}`;
    $('#term-modal').classList.remove('hidden');
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

    const close = () => {
      if (closed) return;
      closed = true;
      try { ws && ws.close(); } catch { /* ignore */ }
      term.dispose();
      $('#term-modal').classList.add('hidden');
    };
    $('#btn-term-close').onclick = close;

    function connect() {
      api('/api/terminal', { method: 'POST', body: JSON.stringify({ server_id: serverId }) })
        .then((res) => {
          const proto = location.protocol === 'https:' ? 'wss' : 'ws';
          ws = new WebSocket(`${proto}://${location.host}/ws/terminal/${res.session_id}?token=${encodeURIComponent(token)}`);
          ws.binaryType = 'arraybuffer';

          ws.onopen = () => {
            retries = 0;
            fit.fit();
            term.focus();
            ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
          };
          ws.onmessage = (ev) => {
            if (typeof ev.data === 'string') term.write(ev.data);
            else term.write(new Uint8Array(ev.data));
          };
          ws.onclose = () => {
            if (closed) return;
            if (retries < TERM_RETRY_MAX) {
              retries += 1;
              term.write(`\r\n\x1b[90m[连接断开，${retries}s 后自动重连...]\x1b[0m\r\n`);
              setTimeout(connect, retries * 1000);
            } else {
              term.write('\r\n\x1b[90m[连接已关闭]\x1b[0m\r\n');
            }
          };
          ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
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
    window.addEventListener('resize', () => { if (!closed) { try { fit.fit(); } catch { /* ignore */ } } });

    connect();
  }

  // ---------- 监控（简易文本图） ----------
  async function showMonitor(serverId, serverName) {
    try {
      const rows = await api(`/api/monitor?server_id=${serverId}`);
      $('#monitor-title').textContent = `监控 · ${serverName}（近 ${rows.length} 分钟）`;
      const lines = rows.map((r) => {
        const t = new Date(r.ts * 60000).toISOString().slice(11, 16);
        const cpu = r.cpu == null ? '-' : r.cpu.toFixed(1) + '%';
        const mem = r.mem_used == null ? '-' : (r.mem_used / 1048576).toFixed(0) + 'M';
        return `${t}  cpu=${cpu}  mem=${mem}`;
      });
      $('#monitor-chart').textContent = lines.join('\n') || '暂无数据';
      $('#monitor-panel').classList.remove('hidden');
    } catch (e) {
      toast(e.message);
    }
  }

  // ---------- 设置 / PAT ----------
  function openSettings() {
    $('#settings-modal').classList.remove('hidden');
    api('/api/public/settings').then((s) => {
      $('#set-site-name').value = s.site_name === 'cf-panle' ? '' : s.site_name;
      $('#set-notice').value = s.notice || '';
    }).catch(() => { /* ignore */ });
    loadTokens();
  }

  async function saveSettings() {
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ site_name: $('#set-site-name').value, notice: $('#set-notice').value }),
      });
      toast('设置已保存');
      loadPublic();
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
      alert(`令牌已创建（仅显示一次）：\n\n${res.token}\n\n用法：Authorization: Bearer ${res.token}`);
      $('#tok-name').value = '';
      $('#tok-servers').value = '';
      loadTokens();
    } catch (e) {
      toast(e.message);
    }
  }

  async function deleteToken(id) {
    if (!confirm('确认删除该令牌？')) return;
    try {
      await api(`/api/tokens/${id}`, { method: 'DELETE' });
      loadTokens();
    } catch (e) {
      toast(e.message);
    }
  }

  // ---------- 事件绑定 ----------
  $('#btn-login').onclick = (e) => { e.preventDefault(); doLogin(); };
  $('#btn-logout').onclick = () => { token = ''; localStorage.removeItem('cfpanle_token'); showAuth(); };
  $('#btn-add-server').onclick = addServer;
  $('#btn-refresh').onclick = loadServers;
  $('#btn-settings').onclick = openSettings;
  $('#btn-settings-close').onclick = () => $('#settings-modal').classList.add('hidden');
  $('#btn-save-settings').onclick = saveSettings;
  $('#btn-create-token').onclick = createToken;
  $('#token-list').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tok-del]');
    if (btn) deleteToken(Number(btn.dataset.tokDel));
  });

  $('#servers').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const { act, id, name } = btn.dataset;
    if (act === 'term') openTerminal(Number(id), name);
    else if (act === 'mon') showMonitor(Number(id), name);
    else if (act === 'del') {
      if (!confirm(`确认删除服务器「${name}」？`)) return;
      api(`/api/servers/${id}`, { method: 'DELETE' }).then(loadServers).catch((e2) => toast(e2.message));
    }
  });

  // ---------- 启动 ----------
  (async function boot() {
    loadPublic();
    if (!token) return showAuth();
    try {
      const me = await api('/api/me');
      showApp(me);
    } catch (e) {
      token = '';
      localStorage.removeItem('cfpanle_token');
      showAuth();
    }
  })();
})();
