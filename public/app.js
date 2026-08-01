// cf-panle 前端逻辑：登录/注册、服务器列表、xterm.js 终端
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  let token = localStorage.getItem('cfpanle_token') || '';
  let serversCache = [];

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

  // ---------- 鉴权视图 ----------
  function showAuth() { $('#auth').classList.remove('hidden'); $('#app').classList.add('hidden'); }
  function showApp(user) {
    $('#auth').classList.add('hidden');
    $('#app').classList.remove('hidden');
    $('#whoami').textContent = `${escapeHtml(user.username)}${user.role === 1 ? '（管理员）' : ''}`;
    loadServers();
  }

  async function doAuth(kind) {
    const username = $('#auth-user').value.trim();
    const password = $('#auth-pass').value;
    const msg = $('#auth-msg');
    msg.textContent = '';
    try {
      const data = await api(`/api/${kind}`, { method: 'POST', body: JSON.stringify({ username, password }) });
      if (kind === 'login') {
        token = data.token;
        localStorage.setItem('cfpanle_token', token);
        showApp(data.user);
      } else {
        msg.textContent = '注册成功，请登录';
        toast('注册成功，请登录');
      }
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
      if (String(e.message).includes('401')) { token = ''; localStorage.removeItem('cfpanle_token'); showAuth(); return; }
      toast(e.message);
    }
  }

  function renderServers() {
    const box = $('#servers');
    if (!serversCache.length) {
      box.innerHTML = '<p style="color:var(--muted)">还没有服务器，点「添加服务器」生成 agent 配置。</p>';
      return;
    }
    box.innerHTML = serversCache.map((s) => `
      <div class="card">
        <div class="name">${escapeHtml(s.name)}</div>
        <div class="meta">uuid: ${escapeHtml(s.uuid)}</div>
        <div><span class="badge ${s.online ? 'on' : 'off'}">${s.online ? '在线' : '离线'}</span></div>
        <div class="actions">
          <button data-act="term" data-id="${s.id}" data-name="${escapeHtml(s.name)}">终端</button>
          <button data-act="mon" data-id="${s.id}" data-name="${escapeHtml(s.name)}" class="ghost">监控</button>
          <button data-act="del" data-id="${s.id}" class="danger">删除</button>
        </div>
      </div>`).join('');
  }

  async function addServer() {
    const name = $('#inp-name').value.trim();
    if (!name) return toast('请输入服务器名称');
    try {
      const cfg = await api('/api/servers', { method: 'POST', body: JSON.stringify({ name }) });
      const text = `服务器已添加，agent 配置（仅显示一次）：\n\nWSS 地址: ${cfg.wss_base}\nUUID: ${cfg.uuid}\nKEY: ${cfg.agent_key}\n\n上报地址: ${cfg.report_url}`;
      alert(text); // 一次性展示 agent 凭据
      $('#inp-name').value = '';
      loadServers();
    } catch (e) {
      toast(e.message);
    }
  }

  // ---------- 终端 ----------
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

    const close = () => {
      if (closed) return;
      closed = true;
      try { ws && ws.close(); } catch { /* ignore */ }
      term.dispose();
      $('#term-modal').classList.add('hidden');
    };
    $('#btn-term-close').onclick = close;

    api('/api/terminal', { method: 'POST', body: JSON.stringify({ server_id: serverId }) })
      .then((res) => {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        ws = new WebSocket(`${proto}://${location.host}/ws/terminal/${res.session_id}?token=${encodeURIComponent(token)}`);
        ws.binaryType = 'arraybuffer';

        ws.onopen = () => {
          fit.fit();
          term.focus();
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        };
        ws.onmessage = (ev) => {
          if (typeof ev.data === 'string') term.write(ev.data);
          else term.write(new Uint8Array(ev.data));
        };
        ws.onclose = () => {
          term.write('\r\n\x1b[90m[连接已关闭]\x1b[0m\r\n');
        };
        ws.onerror = () => toast('终端连接错误');
      })
      .catch((e) => {
        term.write(`\r\n[创建会话失败] ${e.message}\r\n`);
      });

    // 键盘输入 → WS；窗口变化 → resize 帧（走 DO → 控制 WS → stty）
    term.onData((data) => { if (ws && ws.readyState === 1) ws.send(data); });
    term.onResize(({ cols, rows }) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols, rows })); });
    window.addEventListener('resize', () => { if (!closed) { try { fit.fit(); } catch { /* ignore */ } } });
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

  // ---------- 事件绑定 ----------
  $('#btn-login').onclick = (e) => { e.preventDefault(); doAuth('login'); };
  $('#btn-register').onclick = () => doAuth('register');
  $('#btn-logout').onclick = () => { token = ''; localStorage.removeItem('cfpanle_token'); showAuth(); };
  $('#btn-add-server').onclick = addServer;
  $('#btn-refresh').onclick = loadServers;

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
