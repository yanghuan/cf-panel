// ============================================================
// cf-panle — Cloudflare Worker 主逻辑
// REST API + WebSocket 中转（Durable Object: TerminalDO）
// 依赖：D1(DB)、KV(KV)、DO(TERMINAL)、secret: JWT_SECRET
// 对齐 docs/architecture.md §3.2 / §3.3 / §6
// ============================================================

// ---------------- 通用工具 ----------------

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
function err(message, status = 400) {
  return json({ error: message }, status);
}
function secret(env) {
  return env.JWT_SECRET || 'dev-secret'; // 生产务必 wrangler secret put JWT_SECRET
}

function b64u(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
async function hmacSha256(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, dataBytes));
}
async function signJwt(payload, env) {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64u(JSON.stringify(payload));
  const sig = b64u(await hmacSha256(new TextEncoder().encode(secret(env)), new TextEncoder().encode(h + '.' + p)));
  return `${h}.${p}.${sig}`;
}
async function verifyJwt(token, env) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const sig = await hmacSha256(new TextEncoder().encode(secret(env)), new TextEncoder().encode(parts[0] + '.' + parts[1]));
    if (b64u(sig) !== parts[2]) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64uDecode(parts[1])));
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations: 100000, hash: 'SHA-256' },
    key,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}
function randomHex(len = 32) {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return bytesToHex(a);
}
// agent 密钥 → 存储用哈希（与 JWT_SECRET 绑定，防止直接撞库）
async function agentKeyHash(key, env) {
  return bytesToHex(await hmacSha256(new TextEncoder().encode(secret(env)), new TextEncoder().encode(key)));
}

async function authUser(request, env) {
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const payload = await verifyJwt(token, env);
  if (!payload || !payload.uid) return null;
  // 单管理员模式：密码在环境变量，登录即管理员
  return { id: payload.uid, username: 'admin', role: payload.role || 1 };
}

// ---------------- REST API ----------------

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // POST /api/login —— 面板单密码（配置在 CF secret: PANEL_PASSWORD）
  if (method === 'POST' && path === '/api/login') {
    const body = await request.json().catch(() => ({}));
    const password = String(body.password || '');
    if (!env.PANEL_PASSWORD) return err('server misconfigured: PANEL_PASSWORD not set', 500);
    if (password !== env.PANEL_PASSWORD) return err('bad password', 401);
    const token = await signJwt({ uid: 1, role: 1, exp: Math.floor(Date.now() / 1000) + 86400 }, env);
    return json({ token, user: { id: 1, username: 'admin', role: 1 } });
  }

  // ---- 以下全部需要登录 ----
  const user = await authUser(request, env);
  if (!user) return err('unauthorized', 401);

  // GET /api/me —— 当前用户信息
  if (method === 'GET' && path === '/api/me') {
    return json({ id: user.id, username: user.username, role: user.role });
  }

  // GET /api/servers —— 服务器列表（admin 全量，member 只看自己的）
  if (method === 'GET' && path === '/api/servers') {
    const rows = user.role === 1
      ? await env.DB.prepare('SELECT * FROM servers ORDER BY display_index, id').all()
      : await env.DB.prepare('SELECT * FROM servers WHERE user_id = ? ORDER BY display_index, id').bind(user.id).all();
    const now = Date.now();
    const list = rows.results.map((s) => ({
      id: s.id,
      name: s.name,
      group: s.group || '',
      uuid: s.uuid,
      online: s.online === 1 && now - (s.last_seen || 0) < 60000,
    }));
    return json(list);
  }

  // POST /api/servers —— 注册一台服务器（name + 可选 group；生成 agent 配置，明文 key 只返回一次）
  if (method === 'POST' && path === '/api/servers') {
    const body = await request.json().catch(() => ({}));
    const name = String(body.name || '').trim();
    if (!name) return err('name required');
    const group = String(body.group || '').trim();
    const uuid = crypto.randomUUID();
    const key = randomHex(32);
    const hash = await agentKeyHash(key, env);
    await env.DB.prepare('INSERT INTO servers (uuid, name, "group", user_id, agent_key_hash) VALUES (?,?,?,?,?)')
      .bind(uuid, name, group, user.id, hash)
      .run();
    await env.DB.prepare('INSERT INTO audit_logs (user_id, action, target_server_id) VALUES (?,?,?)')
      .bind(user.id, 'server.create', 0)
      .run();
    return json({
      uuid,
      agent_key: key,
      wss_base: `wss://${url.host}/ws/agent`,
      report_url: `https://${url.host}/api/report`,
    });
  }

  // DELETE /api/servers/:id —— admin 或 owner
  if (method === 'DELETE' && path.startsWith('/api/servers/')) {
    const id = Number(path.split('/')[3]) || 0;
    if (user.role !== 1) {
      const s = await env.DB.prepare('SELECT id FROM servers WHERE id = ? AND user_id = ?').bind(id, user.id).first();
      if (!s) return err('forbidden', 403);
    }
    await env.DB.prepare('DELETE FROM servers WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }

  // POST /api/terminal —— 创建终端会话（§3.3：生成 streamId 并通知 agent）
  if (method === 'POST' && path === '/api/terminal') {
    const body = await request.json().catch(() => ({}));
    const server = await env.DB.prepare('SELECT * FROM servers WHERE id = ?').bind(Number(body.server_id) || 0).first();
    if (!server) return err('server not found', 404);
    if (user.role !== 1 && server.user_id !== user.id) return err('forbidden', 403);
    const streamId = crypto.randomUUID();
    const doId = env.TERMINAL.idFromName('main');
    const resp = await env.TERMINAL.get(doId).fetch('https://do.internal/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'create', streamId, serverId: server.id, creatorUserId: user.id }),
    });
    if (!resp.ok) return err(`agent not reachable: ${await resp.text()}`, 502);
    await env.DB.prepare('INSERT INTO audit_logs (user_id, action, target_server_id) VALUES (?,?,?)')
      .bind(user.id, 'terminal.open', server.id)
      .run();
    return json({ session_id: streamId, server_id: server.id, server_name: server.name });
  }

  // POST /api/report —— agent 监控上报（无登录，用 uuid + key 校验）
  if (method === 'POST' && path === '/api/report') {
    const body = await request.json().catch(() => ({}));
    const server = await env.DB.prepare('SELECT * FROM servers WHERE uuid = ?').bind(String(body.uuid || '')).first();
    if (!server) return err('unknown agent', 401);
    const hash = await agentKeyHash(String(body.key || ''), env);
    if (hash !== server.agent_key_hash) return err('bad key', 401);
    const ts = Math.floor(Date.now() / 1000);
    const minTs = Math.floor(ts / 60);
    await env.DB.prepare('UPDATE servers SET last_seen = ?, online = 1 WHERE id = ?').bind(ts, server.id).run();
    await env.DB.prepare(
      `INSERT INTO metrics_min (server_id, ts, cpu, mem_used, net_in, net_out) VALUES (?,?,?,?,?,?)
       ON CONFLICT(server_id, ts) DO UPDATE SET cpu=?, mem_used=?, net_in=?, net_out=?`
    )
      .bind(
        server.id, minTs,
        body.cpu ?? null, body.mem_used ?? null, body.net_in ?? null, body.net_out ?? null,
        body.cpu ?? null, body.mem_used ?? null, body.net_in ?? null, body.net_out ?? null
      )
      .run();
    return json({ ok: true });
  }

  // GET /api/monitor?server_id= —— 监控历史（近 12 小时分钟数据）
  if (method === 'GET' && path === '/api/monitor') {
    const serverId = Number(url.searchParams.get('server_id')) || 0;
    const s = await env.DB.prepare('SELECT * FROM servers WHERE id = ?').bind(serverId).first();
    if (!s) return err('not found', 404);
    if (user.role !== 1 && s.user_id !== user.id) return err('forbidden', 403);
    const rows = await env.DB.prepare('SELECT * FROM metrics_min WHERE server_id = ? ORDER BY ts DESC LIMIT 720').bind(serverId).all();
    return json(rows.results.reverse());
  }

  return err('not found', 404);
}

// ---------------- WebSocket 路由（转发 DO） ----------------

async function handleWs(request, env) {
  const url = new URL(request.url);
  const doId = env.TERMINAL.idFromName('main');
  const stub = env.TERMINAL.get(doId);
  const target = new URL(request.url);
  target.protocol = 'https:';
  target.hostname = 'do.internal';
  return stub.fetch(target.toString(), request);
}

// ---------------- Durable Object：WebSocket 中转核心 ----------------

export class TerminalDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // streamId -> {streamId, serverId, creatorUserId, userWs, agentWs}
    this.agents = new Map(); // serverId -> 控制 WS
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 内部 RPC：worker 创建终端会话时调用
    if (path === '/rpc' && request.method === 'POST') {
      const body = await request.json();
      if (body.op === 'create') {
        this.sessions.set(body.streamId, {
          streamId: body.streamId,
          serverId: body.serverId,
          creatorUserId: body.creatorUserId,
          userWs: null,
          agentWs: null,
        });
        const agentWs = this.agents.get(body.serverId);
        if (!agentWs) return json({ error: 'agent offline' }, 502);
        agentWs.send(JSON.stringify({ type: 'open_terminal', stream_id: body.streamId }));
        return json({ ok: true });
      }
      return err('bad op');
    }

    // GET /ws/terminal/:id —— 浏览器会话（校验创建者/admin，防 UUID 劫持 §6.1）
    let m = path.match(/^\/ws\/terminal\/(.+)$/);
    if (m) {
      const streamId = m[1];
      const sess = this.sessions.get(streamId);
      if (!sess) return new Response('session not found', { status: 404 });
      const token = url.searchParams.get('token') || '';
      const payload = await verifyJwt(token, this.env);
      if (!payload || !payload.uid) return new Response('unauthorized', { status: 401 });
      if (!(payload.role === 1 || payload.uid === sess.creatorUserId)) return new Response('forbidden', { status: 403 });
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      sess.userWs = pair[1];
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // GET /ws/agent/control —— agent 常驻控制通道（uuid + key 校验）
    if (path === '/ws/agent/control') {
      const uuid = url.searchParams.get('uuid') || '';
      const key = request.headers.get('x-agent-key') || url.searchParams.get('key') || '';
      const server = await this.env.DB.prepare('SELECT * FROM servers WHERE uuid = ?').bind(uuid).first();
      if (!server) return new Response('unknown agent', { status: 401 });
      const hash = await agentKeyHash(key, this.env);
      if (hash !== server.agent_key_hash) return new Response('bad key', { status: 401 });
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      this.agents.set(server.id, pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // GET /ws/agent/terminal?sid=&key= —— agent 终端数据流（stream 归属校验 §6.2）
    if (path === '/ws/agent/terminal') {
      const sid = url.searchParams.get('sid') || '';
      const key = request.headers.get('x-agent-key') || url.searchParams.get('key') || '';
      const sess = this.sessions.get(sid);
      if (!sess) return new Response('session not found', { status: 404 });
      const server = await this.env.DB.prepare('SELECT * FROM servers WHERE id = ?').bind(sess.serverId).first();
      if (!server) return new Response('unknown agent', { status: 401 });
      const hash = await agentKeyHash(key, this.env);
      if (hash !== server.agent_key_hash) return new Response('bad key', { status: 401 });
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      sess.agentWs = pair[1];
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    return new Response('not found', { status: 404 });
  }

  // Hibernation：消息转发（§3.3 双向对拷 + resize 走控制通道）
  async webSocketMessage(ws, message) {
    const sess = [...this.sessions.values()].find((s) => s.userWs === ws || s.agentWs === ws);
    if (!sess) return;

    if (ws === sess.userWs) {
      // 浏览器 → DO
      if (typeof message === 'string') {
        try {
          const j = JSON.parse(message);
          if (j && j.type === 'resize') {
            const agentWs = this.agents.get(sess.serverId);
            if (agentWs) {
              agentWs.send(JSON.stringify({ type: 'resize', stream_id: sess.streamId, rows: Number(j.rows) || 24, cols: Number(j.cols) || 80 }));
            }
            return;
          }
        } catch {
          /* 不是 JSON，当普通输入透传 */
        }
      }
      if (sess.agentWs) sess.agentWs.send(message);
    } else if (ws === sess.agentWs) {
      // agent → DO → 浏览器（纯字节透传）
      if (sess.userWs) sess.userWs.send(message);
    }
  }

  async webSocketClose(ws) {
    this.cleanup(ws);
  }
  async webSocketError(ws) {
    this.cleanup(ws);
  }

  cleanup(ws) {
    for (const [sid, sess] of this.sessions) {
      if (sess.userWs === ws) {
        sess.userWs = null;
        if (sess.agentWs) {
          try { sess.agentWs.close(); } catch { /* ignore */ }
        }
      }
      if (sess.agentWs === ws) {
        sess.agentWs = null;
        if (sess.userWs) {
          try { sess.userWs.close(); } catch { /* ignore */ }
        }
      }
      if (!sess.userWs && !sess.agentWs) this.sessions.delete(sid);
    }
    for (const [serverId, w] of this.agents) {
      if (w === ws) this.agents.delete(serverId);
    }
  }
}

// ---------------- Worker 入口 ----------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/ws/')) return handleWs(request, env);
    return handleApi(request, env);
  },
};
