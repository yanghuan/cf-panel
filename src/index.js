// ============================================================
// cf-panle — Cloudflare Worker 主逻辑
// REST API + WebSocket 中转（Durable Object: TerminalDO，多分片）
// 依赖：D1(DB)、KV(KV)、DO(TERMINAL)、secret: JWT_SECRET / PANEL_PASSWORD
// 对齐 docs/architecture.md §3.2 / §3.3 / §6
// ============================================================

// ---------------- 常量 ----------------

const SHARDS = 4; // DO 分片数（改大后旧会话不可达，一般不用动）
const SESSION_TTL_MS = 10 * 60 * 1000; // 会话两端都断开超过 10 分钟 → 回收
const PAT_PREFIX = 'cfp_'; // PAT token 前缀
const SCOPE_READ = 'server:read';
const SCOPE_EXEC = 'server:exec';

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
function randomHex(len = 32) {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return bytesToHex(a);
}
// 任何秘密（agent key / PAT token）统一用 HMAC 哈希后落库
async function hashSecret(value, env) {
  return bytesToHex(await hmacSha256(new TextEncoder().encode(secret(env)), new TextEncoder().encode(value)));
}

// ---------------- 分片路由 ----------------

function shardForServerId(serverId) {
  return Number(serverId) % SHARDS;
}
function makeStreamId(serverId) {
  return `${shardForServerId(serverId)}-${crypto.randomUUID()}`;
}
function shardFromStreamId(streamId) {
  const n = parseInt(String(streamId).split('-')[0], 10);
  return Number.isInteger(n) ? n % SHARDS : 0;
}
function doForShard(env, n) {
  return env.TERMINAL.get(env.TERMINAL.idFromName(`shard-${n}`));
}

// ---------------- 鉴权（JWT 或 PAT） ----------------

async function authUser(request, env) {
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;

  // 1) PAT：以 cfp_ 开头
  if (token.startsWith(PAT_PREFIX)) {
    const hash = await hashSecret(token, env);
    const row = await env.DB.prepare('SELECT * FROM api_tokens WHERE token_hash = ?').bind(hash).first();
    if (!row) return null;
    let scopes = [];
    try { scopes = JSON.parse(row.scopes || '[]'); } catch { /* ignore */ }
    let serverIDs = null;
    if (row.server_ids) {
      try { serverIDs = JSON.parse(row.server_ids); } catch { serverIDs = null; }
    }
    return { id: row.user_id, username: `token:${row.name}`, role: 0, pat: { scopes, serverIDs } };
  }

  // 2) JWT（面板登录）
  const payload = await verifyJwt(token, env);
  if (!payload || !payload.uid) return null;
  return { id: payload.uid, username: 'admin', role: 1, pat: null };
}

// 面板管理员（JWT 登录，非 PAT）
function isAdmin(user) {
  return user && user.role === 1 && !user.pat;
}
function canAccessServer(user, server) {
  if (!user) return false;
  if (isAdmin(user)) return true;
  if (user.pat) {
    if (user.pat.serverIDs && !user.pat.serverIDs.includes(server.id)) return false;
    return user.pat.scopes.includes(SCOPE_READ);
  }
  return server.user_id === user.id;
}
function canExec(user, server) {
  if (!user) return false;
  if (isAdmin(user)) return true;
  if (user.pat) {
    if (user.pat.serverIDs && !user.pat.serverIDs.includes(server.id)) return false;
    return user.pat.scopes.includes(SCOPE_EXEC);
  }
  return server.user_id === user.id;
}

// ---------------- REST API ----------------

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // POST /api/login —— 面板单密码（CF secret: PANEL_PASSWORD）
  if (method === 'POST' && path === '/api/login') {
    const body = await request.json().catch(() => ({}));
    const password = String(body.password || '');
    if (!env.PANEL_PASSWORD) return err('server misconfigured: PANEL_PASSWORD not set', 500);
    if (password !== env.PANEL_PASSWORD) return err('bad password', 401);
    const token = await signJwt({ uid: 1, role: 1, exp: Math.floor(Date.now() / 1000) + 86400 }, env);
    return json({ token, user: { id: 1, username: 'admin', role: 1 } });
  }

  // GET /api/public/settings —— 公开配置（KV，无需登录）
  if (method === 'GET' && path === '/api/public/settings') {
    const settings = (await env.KV.get('settings', 'json')) || {};
    return json({ site_name: settings.site_name || 'cf-panle', notice: settings.notice || '' });
  }

  // ---- 以下全部需要登录（JWT 或 PAT）----
  const user = await authUser(request, env);
  if (!user) return err('unauthorized', 401);

  // GET /api/me —— 当前用户
  if (method === 'GET' && path === '/api/me') {
    return json({ id: user.id, username: user.username, role: user.role, is_pat: !!user.pat });
  }

  // GET /api/servers —— 服务器列表（admin 全量；PAT 按白名单+read scope；member 看自己的）
  if (method === 'GET' && path === '/api/servers') {
    let rows;
    if (isAdmin(user)) {
      rows = await env.DB.prepare('SELECT * FROM servers ORDER BY "group", display_index, id').all();
    } else if (user.pat) {
      rows = await env.DB.prepare('SELECT * FROM servers ORDER BY "group", display_index, id').all();
      rows.results = rows.results.filter((s) => canAccessServer(user, s));
    } else {
      rows = await env.DB.prepare('SELECT * FROM servers WHERE user_id = ? ORDER BY "group", display_index, id').bind(user.id).all();
    }
    const now = Date.now();
    const list = rows.results.map((s) => ({
      id: s.id,
      name: s.name,
      group: s.group || '',
      display_index: s.display_index || 0,
      uuid: s.uuid,
      online: s.online === 1 && now - (s.last_seen || 0) < 60000,
    }));
    return json(list);
  }

  // POST /api/servers —— 注册一台服务器（name + 可选 group + 可选序号；仅管理员）
  if (method === 'POST' && path === '/api/servers') {
    if (!isAdmin(user)) return err('forbidden', 403);
    const body = await request.json().catch(() => ({}));
    const name = String(body.name || '').trim();
    if (!name) return err('name required');
    const group = String(body.group || '').trim();
    const displayIndex = Number(body.sort_order) || 0;
    const uuid = crypto.randomUUID();
    const key = randomHex(32);
    const hash = await hashSecret(key, env);
    await env.DB.prepare('INSERT INTO servers (uuid, name, "group", display_index, user_id, agent_key_hash) VALUES (?,?,?,?,?,?)')
      .bind(uuid, name, group, displayIndex, user.id, hash)
      .run();
    await env.DB.prepare('INSERT INTO audit_logs (user_id, action) VALUES (?,?)').bind(user.id, 'server.create').run();
    return json({
      uuid,
      agent_key: key,
      wss_base: `wss://${url.host}/ws/agent`,
      report_url: `https://${url.host}/api/report`,
    });
  }

  // DELETE /api/servers/:id —— 仅管理员
  if (method === 'DELETE' && path.startsWith('/api/servers/')) {
    if (!isAdmin(user)) return err('forbidden', 403);
    const id = Number(path.split('/')[3]) || 0;
    await env.DB.prepare('DELETE FROM servers WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }

  // POST /api/terminal —— 创建终端会话（exec 权限 + 服务器归属）
  if (method === 'POST' && path === '/api/terminal') {
    const body = await request.json().catch(() => ({}));
    const server = await env.DB.prepare('SELECT * FROM servers WHERE id = ?').bind(Number(body.server_id) || 0).first();
    if (!server) return err('server not found', 404);
    if (!canExec(user, server)) return err('forbidden', 403);
    const streamId = makeStreamId(server.id);
    const stub = doForShard(env, shardForServerId(server.id));
    const resp = await stub.fetch('https://do.internal/rpc', {
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

  // POST /api/report —— agent 监控上报（uuid + key 校验，无需登录）
  if (method === 'POST' && path === '/api/report') {
    const body = await request.json().catch(() => ({}));
    const server = await env.DB.prepare('SELECT * FROM servers WHERE uuid = ?').bind(String(body.uuid || '')).first();
    if (!server) return err('unknown agent', 401);
    const hash = await hashSecret(String(body.key || ''), env);
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
    if (!canAccessServer(user, s)) return err('forbidden', 403);
    const rows = await env.DB.prepare('SELECT * FROM metrics_min WHERE server_id = ? ORDER BY ts DESC LIMIT 720').bind(serverId).all();
    return json(rows.results.reverse());
  }

  // ---- PAT 管理（仅管理员）----
  if (path === '/api/tokens') {
    if (!isAdmin(user)) return err('forbidden', 403);
    if (method === 'GET') {
      const rows = await env.DB.prepare('SELECT id, name, scopes, server_ids, created_at FROM api_tokens ORDER BY id').all();
      return json(rows.results);
    }
    if (method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const name = String(body.name || '').trim();
      if (!name) return err('name required');
      let scopes = body.scopes || [SCOPE_READ];
      if (Array.isArray(body.scopes) && body.scopes.length) scopes = body.scopes;
      scopes = scopes.filter((s) => typeof s === 'string');
      const serverIDs = Array.isArray(body.server_ids) ? body.server_ids.map(Number).filter((n) => n > 0) : null;
      const token = PAT_PREFIX + randomHex(32);
      const hash = await hashSecret(token, env);
      await env.DB.prepare('INSERT INTO api_tokens (user_id, name, token_hash, scopes, server_ids) VALUES (?,?,?,?,?)')
        .bind(user.id, name, hash, JSON.stringify(scopes), serverIDs ? JSON.stringify(serverIDs) : null)
        .run();
      return json({ token }); // 明文只返回一次
    }
    return err('method not allowed', 405);
  }
  if (method === 'DELETE' && path.startsWith('/api/tokens/')) {
    if (!isAdmin(user)) return err('forbidden', 403);
    const id = Number(path.split('/')[3]) || 0;
    await env.DB.prepare('DELETE FROM api_tokens WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }

  // ---- 面板设置（KV，仅管理员）----
  if (method === 'PUT' && path === '/api/settings') {
    if (!isAdmin(user)) return err('forbidden', 403);
    const body = await request.json().catch(() => ({}));
    const current = (await env.KV.get('settings', 'json')) || {};
    const next = {
      site_name: body.site_name !== undefined ? String(body.site_name).trim() : current.site_name,
      notice: body.notice !== undefined ? String(body.notice).trim() : current.notice,
    };
    await env.KV.put('settings', JSON.stringify(next));
    return json(next);
  }

  return err('not found', 404);
}

// ---------------- WebSocket 路由（按分片转发 DO） ----------------

async function handleWs(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  let shard = 0;

  if (path.startsWith('/ws/terminal/')) {
    shard = shardFromStreamId(path.slice('/ws/terminal/'.length));
  } else if (path === '/ws/agent/control') {
    const uuid = url.searchParams.get('uuid') || '';
    const server = await env.DB.prepare('SELECT * FROM servers WHERE uuid = ?').bind(uuid).first();
    if (!server) return new Response('unknown agent', { status: 401 });
    shard = shardForServerId(server.id);
  } else if (path === '/ws/agent/terminal') {
    shard = shardFromStreamId(url.searchParams.get('sid') || '');
  }

  const stub = doForShard(env, shard);
  const target = new URL(request.url);
  target.protocol = 'https:';
  target.hostname = 'do.internal';
  return stub.fetch(target.toString(), request);
}

// ---------------- Durable Object：WebSocket 中转核心（分片实例） ----------------

export class TerminalDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // streamId -> {streamId, serverId, creatorUserId, createdAt, userWs, agentWs}
    this.agents = new Map(); // serverId -> 控制 WS
    this.lastSweep = 0;
  }

  async fetch(request) {
    this.maybeSweep();
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
          createdAt: Date.now(),
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
      const hash = await hashSecret(key, this.env);
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
      const hash = await hashSecret(key, this.env);
      if (hash !== server.agent_key_hash) return new Response('bad key', { status: 401 });
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      sess.agentWs = pair[1];
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    return new Response('not found', { status: 404 });
  }

  // 惰性清理：两端都断开且超过 TTL 的僵尸会话（每 60s 至多扫一次）
  maybeSweep() {
    const now = Date.now();
    if (now - this.lastSweep < 60 * 1000) return;
    this.lastSweep = now;
    for (const [sid, sess] of this.sessions) {
      if (!sess.userWs && !sess.agentWs && now - sess.createdAt > SESSION_TTL_MS) {
        this.sessions.delete(sid);
      }
    }
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
