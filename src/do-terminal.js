// cf-panel — Durable Object：WebSocket 中转核心（分片实例 TerminalDO）
import {
  SESSION_TTL_MS, MAX_SESSIONS_PER_SERVER, SESSION_ABS_MS,
  REPORT_FAST_INTERVAL_S, REPORT_SLOW_INTERVAL_S, PAT_CHECK_INTERVAL_MS,
} from './config.js';
import { json, err, doPanel, sha256Hex, hashSecret } from './utils.js';
import { authUserByToken, isAdmin, canExec } from './auth.js';
import { handleReport } from './report.js';

export class TerminalDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // streamId -> {streamId, serverId, creatorUserId, createdAt, userWs, agentWs}
    this.agents = new Map(); // serverId -> 控制 WS
    this.agentInterval = new Map(); // serverId -> 当前下发的上报间隔（秒），避免重复下发
    this.pendingTerm = new Map(); // streamId -> {tries, timer} open_terminal 确认重发
    this.lastPingAt = new Map(); // serverId -> 上次心跳时间（控制通道保活，防健康连接被 read -t 180 误判半开）
  }

  async fetch(request) {
    this.maybeSweep();
    this.rebuildIndex(); // 休眠唤醒后内存索引可能已丢，先从存活的 WS 附件重建
    const url = new URL(request.url);
    const path = url.pathname;

    // 内部 RPC：观看者数变化事件（0→1 快采 / 1→0 慢采），更新本分片全部 agent 上报间隔
    if (path === '/rpc/set_viewers' && request.method === 'POST') {
      const body = await request.json();
      const want = (Number(body.count) || 0) > 0 ? REPORT_FAST_INTERVAL_S : REPORT_SLOW_INTERVAL_S;
      for (const [serverId, w] of this.agents) {
        if (this.agentInterval.get(serverId) !== want) {
          this.agentInterval.set(serverId, want);
          try { w.send(JSON.stringify({ type: 'set_report_interval', interval: want })); } catch { /* ignore */ }
        }
      }
      return json({ ok: true });
    }

    // 内部 RPC：删除服务器时断开该 agent 的常驻控制通道与相关会话（key 已删，重连会被 401 拒绝）
    if (path === '/rpc/drop_server' && request.method === 'POST') {
      const body = await request.json();
      const serverId = Number(body.serverId) || 0;
      const w = this.agents.get(serverId);
      if (w) {
        try { w.close(); } catch { /* ignore */ }
        this.agents.delete(serverId);
      }
      const sids = [];
      for (const [sid, sess] of this.sessions) {
        if (sess.serverId !== serverId) continue;
        sids.push(sid);
        try { sess.userWs && sess.userWs.close(); } catch { /* ignore */ }
        try { sess.agentWs && sess.agentWs.close(); } catch { /* ignore */ }
        this.sessions.delete(sid);
        this.state.storage.delete('sess:' + sid).catch(() => {}); // 清理持久化会话
      }
      // 清理该服务器的 open_terminal 待确认（定时器停止）
      for (const sid of sids) {
        const r = this.pendingTerm.get(sid);
        if (r && r.timer) clearTimeout(r.timer);
        this.pendingTerm.delete(sid);
      }
      return json({ ok: true });
    }

    // 内部 RPC：worker 创建终端/文件会话时调用
    if (path === '/rpc' && request.method === 'POST') {
      const body = await request.json();
      if (body.op === 'create' || body.op === 'open_file') {
        const isFile = body.op === 'open_file';
        // 先确认 agent 在线，离线时不创建/不落盘（避免失败会话残留）
        const agentWs = this.agents.get(body.serverId);
        if (!agentWs) return json({ error: 'agent offline' }, 502);
        // 每服务器并发会话上限（防批量创建耗尽 PTY/bash/FD/WebSocket）
        let active = 0;
        for (const s of this.sessions.values()) {
          if (s.serverId === body.serverId) active += 1;
        }
        if (active >= MAX_SESSIONS_PER_SERVER) {
          return json({ error: `too many active sessions (max ${MAX_SESSIONS_PER_SERVER})` }, 429);
        }
        const createdAt = Date.now();
        this.sessions.set(body.streamId, {
          streamId: body.streamId,
          serverId: body.serverId,
          creatorUserId: body.creatorUserId,
          createdAt,
          type: isFile ? 'file' : 'terminal',
          userWs: null,
          agentWs: null,
          userBuf: [], // 浏览器鉴权挂接前缓冲 agent 输出（如初始 bash 提示符），鉴权后补发
          agentBuf: [], // agent 数据流挂接前缓冲浏览器输入，挂接后按序补发
        });
        // 会话元数据持久化到 DO Storage：防 DO 休眠后、浏览器/agent WS 挂接前会话丢失
        // （否则前端会先看到"连接断开"，重连才成功）
        try {
          await this.state.storage.put('sess:' + body.streamId, {
            streamId: body.streamId,
            serverId: body.serverId,
            creatorUserId: body.creatorUserId,
            createdAt,
            type: isFile ? 'file' : 'terminal',
          });
        } catch { /* 持久化失败则降级为纯内存会话 */ }
        // 安排 TTL 回收 alarm（两端都无连接时由 maybeSweep 按时回收）
        try {
          const existing = await this.state.storage.getAlarm();
          const next = createdAt + SESSION_TTL_MS + 1000;
          if (existing == null || next < existing) this.state.storage.setAlarm(next);
        } catch { /* 无法安排 alarm 时依赖 fetch 时 maybeSweep */ }
        agentWs.send(JSON.stringify({ type: isFile ? 'open_file' : 'open_terminal', stream_id: body.streamId }));
        // 终端会话：确认重发机制——agent 收到并 spawn 后回 terminal_ready，
        // 未确认则定时重发（最多 3 次），避免控制通道重连窗口丢指令
        if (!isFile) this.scheduleTermAck(agentWs, body.streamId, body.serverId);
        return json({ ok: true });
      }
      return err('bad op');
    }

    // GET /ws/terminal/:id | /ws/file/:id —— 浏览器会话（防 UUID 劫持）
    // 鉴权改为首条消息（{type:'auth', token}），token 不进 URL（防访问日志/浏览器历史泄露）；
    // 未鉴权前不挂接 userWs，任何数据都不会流向浏览器，防劫持语义不变
    let m = path.match(/^\/ws\/(terminal|file)\/(.+)$/);
    if (m) {
      const streamId = m[2];
      const sess = await this.hydrateSession(streamId);
      if (!sess) return new Response('session not found', { status: 404 });
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({
        role: 'user-pending', sid: streamId, serverId: sess.serverId,
        creatorUserId: sess.creatorUserId, type: sess.type, createdAt: sess.createdAt,
      });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // GET /ws/agent/control —— agent 常驻控制通道（key 指纹定位 + hash 校验）
    if (path === '/ws/agent/control') {
      const key = request.headers.get('x-agent-key') || url.searchParams.get('key') || '';
      const keyId = await sha256Hex(key);
      const server = await this.env.DB.prepare('SELECT * FROM servers WHERE agent_key_id = ?').bind(keyId).first();
      if (!server) return new Response('unknown agent', { status: 401 });
      const hash = await hashSecret(key, this.env);
      if (hash !== server.agent_key_hash) return new Response('bad key', { status: 401 });
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      // 控制通道（重）连接：说明旧连接已断/网络切换，关闭该服务器旧的终端/文件会话流，
      // 让 agent 侧 websocat 收到 close → 退出 → 触发清理链（kill pty/bash/脚本），防半开残留。
      // 配合服务端心跳后，健康连接不会因 read -t 180 误重连，故此处只会在真正断链时触发。
      this.dropAgentSessions(server.id);
      this.agents.set(server.id, pair[1]);
      // 附件随连接持久化：休眠唤醒后靠它重建 agents 索引（role 区分控制通道与会话流）
      pair[1].serializeAttachment({ role: 'control', serverId: server.id });
      // 记录节点公网出口 IP（CF-Connecting-IP，Cloudflare 注入；本地 dev 回退 X-Forwarded-For）
      try {
        const wanIp = request.headers.get('cf-connecting-ip') || (request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
        if (wanIp && wanIp !== server.wan_ip) {
          await this.env.DB.prepare('UPDATE servers SET wan_ip = ? WHERE id = ?').bind(wanIp, server.id).run();
        }
      } catch { /* 记录失败不影响连接 */ }
      // 连接建立即标记在线（不等首次上报），避免上报延迟/丢帧导致误显示离线
      try {
        const now = Math.floor(Date.now() / 1000);
        await this.env.DB.prepare('UPDATE servers SET last_seen = ? WHERE id = ?').bind(now, server.id).run();
      } catch { /* 标记失败不影响连接 */ }
      // 连接建立即下发当前上报间隔（省配额：有观看者快采 / 无观看者慢采）
      try {
        const vResp = await doPanel(this.env).fetch('https://do.internal/viewers');
        const v = await vResp.json();
        const iv = (v.count || 0) > 0 ? REPORT_FAST_INTERVAL_S : REPORT_SLOW_INTERVAL_S;
        this.agentInterval.set(server.id, iv);
        pair[1].send(JSON.stringify({ type: 'set_report_interval', interval: iv }));
      } catch { /* 查询失败则 agent 用自身默认间隔 */ }
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // GET /ws/agent/terminal?sid= | /ws/agent/file?sid= —— agent 数据流（key 校验 + stream 归属校验）
    if (path === '/ws/agent/terminal' || path === '/ws/agent/file') {
      const sid = url.searchParams.get('sid') || '';
      const key = request.headers.get('x-agent-key') || url.searchParams.get('key') || '';
      const sess = await this.hydrateSession(sid);
      if (!sess) return new Response('session not found', { status: 404 });
      const server = await this.env.DB.prepare('SELECT * FROM servers WHERE id = ?').bind(sess.serverId).first();
      if (!server) return new Response('unknown agent', { status: 401 });
      const hash = await hashSecret(key, this.env);
      if (hash !== server.agent_key_hash) return new Response('bad key', { status: 401 });
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      // 挂接 agent 数据流并按序补发缓冲的浏览器输入
      this.attachAgentFlow(sess, pair[1]);
      // 附件随连接持久化：休眠唤醒后靠它重建会话索引
      pair[1].serializeAttachment({
        role: 'agent', sid, serverId: sess.serverId,
        creatorUserId: sess.creatorUserId, type: sess.type, createdAt: sess.createdAt,
      });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    return new Response('not found', { status: 404 });
  }

  // 控制通道（重）连接时调用：关闭该服务器旧的终端/文件会话流。
  // agent 侧 websocat 收到 close → 退出 → 触发清理链（kill pty/bash/脚本），防半开残留。
  dropAgentSessions(serverId) {
    for (const [, sess] of this.sessions) {
      if (sess.serverId !== serverId) continue;
      if (sess.agentWs) {
        try { sess.agentWs.close(); } catch { /* ignore */ }
      }
    }
  }

  // 取会话：先查内存，内存丢失（DO 休眠后）则从 DO Storage 水合兜底
  async hydrateSession(streamId) {
    let sess = this.sessions.get(streamId);
    if (sess) return sess;
    try {
      const raw = await this.state.storage.get('sess:' + streamId);
      if (raw) {
        sess = { ...raw, userWs: null, agentWs: null, userBuf: [], agentBuf: [] };
        this.sessions.set(streamId, sess);
      }
    } catch { /* 水合失败按不存在处理 */ }
    return sess;
  }

  // 惰性清理：两端都断开且超过 TTL 的僵尸会话 → 删除；并清理对应 pendingTerm。
  // 若有未到期的僵尸会话，则安排 DO alarm 到最早到期时间——Hibernation 下零流量也会
  // 被 alarm 短暂唤醒执行清理，避免"必须等下一次 fetch 才回收"的滞留（alarm 每次 = 1 次请求，僵尸会话罕见，成本可忽略）。
  maybeSweep() {
    const now = Date.now();
    let next = Infinity;
    for (const [sid, sess] of this.sessions) {
      // 绝对最长会话时长——即使两端有连接，到期也强制回收（防活跃会话长期占用 PTY/FD/WS）
      if (now - sess.createdAt > SESSION_ABS_MS) {
        if (sess.userWs) { try { sess.userWs.close(); } catch { /* ignore */ } }
        if (sess.agentWs) { try { sess.agentWs.close(); } catch { /* ignore */ } }
        this.sessions.delete(sid);
        this.state.storage.delete('sess:' + sid).catch(() => {}); // 清理持久化会话
        continue;
      }
      if (sess.userWs || sess.agentWs) {
        // 活跃会话也按绝对 TTL 排 alarm：确保 4h 到期时准时回收，不依赖后续 fetch/alarm 偶发触发
        next = Math.min(next, sess.createdAt + SESSION_ABS_MS);
        continue;
      }
      if (now - sess.createdAt > SESSION_TTL_MS) {
        this.sessions.delete(sid);
        this.state.storage.delete('sess:' + sid).catch(() => {}); // 清理持久化会话
      } else {
        next = Math.min(next, sess.createdAt + SESSION_TTL_MS);
      }
    }
    // 清理已无会话的 open_terminal 待确认（流已回收，停止定时器，防泄漏）
    for (const sid of [...this.pendingTerm.keys()]) {
      if (!this.sessions.has(sid)) {
        const r = this.pendingTerm.get(sid);
        if (r && r.timer) clearTimeout(r.timer);
        this.pendingTerm.delete(sid);
      }
    }
    if (next !== Infinity) {
      try { this.state.storage.setAlarm(next + 1000); } catch { /* ignore */ }
    }
  }

  // Hibernation alarm：零流量时也被唤醒执行清理；无僵尸会话则无需设定 alarm，保持休眠
  async alarm() {
    this.rebuildIndex();
    this.maybeSweep();
  }

  // open_terminal 确认重发：下发后 5s 未收到 agent 的 terminal_ready 则重发，最多 3 次
  // 解决 agent 控制通道重连窗口内指令丢失导致的终端"打不开"
  // 记录 serverId + agentWs 归属：cleanup 断开时只清理关联项，不影响其他服务器/会话
  scheduleTermAck(agentWs, streamId, serverId) {
    if (this.pendingTerm.has(streamId)) return;
    const rec = { tries: 0, timer: null, serverId, agentWs };
    this.pendingTerm.set(streamId, rec);
    const retry = () => {
      const r = this.pendingTerm.get(streamId);
      if (!r) return; // 已确认（terminal_ready）或已清理
      if (agentWs.readyState === 1) {
        try { agentWs.send(JSON.stringify({ type: 'open_terminal', stream_id: streamId })); } catch { /* ignore */ }
      }
      r.tries += 1;
      if (r.tries < 3) r.timer = setTimeout(retry, 5000);
      else this.pendingTerm.delete(streamId); // 3 次后放弃（前端有自愈兜底）
    };
    rec.timer = setTimeout(retry, 5000);
  }

  // Hibernation：DO 实例空闲冻结后，WebSocket 连接由 workerd 托管持久，但本类
  // 实例的 sessions/agents 内存 Map 会随冻结全部丢失。附件（serializeAttachment）
  // 随连接持久化，唤醒后据此惰性重建索引，避免误判 "agent offline" / "session not found"。
  // 活跃态（索引已非空）跳过，避免每次消息 O(N) 遍历。
  rebuildIndex() {
    if (this.sessions.size > 0 || this.agents.size > 0) return;
    const socks = this.state.getWebSockets?.() || [];
    for (const ws of socks) {
      const att = ws.deserializeAttachment();
      if (att === null || att === undefined) continue;
      if (typeof att === 'string') {
        // 兼容旧格式：控制通道附件为 String(server.id)
        const serverId = Number(att);
        if (Number.isInteger(serverId) && serverId > 0) this.agents.set(serverId, ws);
        continue;
      }
      if (typeof att !== 'object') continue;
      if (att.role === 'control') {
        if (Number(att.serverId) > 0) this.agents.set(Number(att.serverId), ws);
      } else if (att.role === 'user' || att.role === 'agent') {
        let sess = this.sessions.get(att.sid);
        if (!sess) {
          sess = {
            streamId: att.sid,
            serverId: att.serverId,
            creatorUserId: att.creatorUserId,
            createdAt: att.createdAt,
            type: att.type,
            userWs: null,
            agentWs: null,
            userBuf: [],
            agentBuf: [],
          };
          this.sessions.set(att.sid, sess);
        }
        if (att.role === 'user') sess.userWs = ws;
        else sess.agentWs = ws;
      }
    }
  }

  // 挂接 agent 数据流：赋值 agentWs + 按序补发挂接前缓冲的浏览器输入（防静默丢弃）
  attachAgentFlow(sess, ws) {
    sess.agentWs = ws;
    if (sess.agentBuf && sess.agentBuf.length) {
      for (const m of sess.agentBuf) {
        try { ws.send(m); } catch { /* ignore */ }
      }
      sess.agentBuf = [];
    }
  }

  // 从连接附件解析 serverId（兼容旧字符串格式与新对象格式）
  wsServerId(ws) {
    const att = ws.deserializeAttachment();
    if (att === null || att === undefined) return 0;
    if (typeof att === 'string') return Number(att) || 0;
    if (typeof att === 'object') return Number(att.serverId) || 0;
    return 0;
  }

  // Hibernation：消息转发（双向对拷 + resize 走控制通道）
  async webSocketMessage(ws, message) {
    this.rebuildIndex(); // 休眠唤醒后索引可能已丢，先按附件重建
    // 浏览器侧待鉴权连接（role: user-pending）：首帧必须是 {type:'auth', token}
    const att = ws.deserializeAttachment?.();
    if (att && att.role === 'user-pending') {
      let j = null;
      try { j = JSON.parse(typeof message === 'string' ? message : ''); } catch { /* 非 JSON */ }
      const token = j && j.type === 'auth' ? String(j.token || '') : '';
      // WS 首帧鉴权与 REST 一致（JWT 管理员直接放行；PAT/member 需服务器存在且可执行/为创建者）
      const user = token ? await authUserByToken(token, this.env) : null;
      const sess = await this.hydrateSession(att.sid);
      if (!user || !sess) {
        try { ws.close(1008, 'unauthorized'); } catch { /* ignore */ }
        return;
      }
      let allowed = isAdmin(user);
      if (!allowed) {
        const server = await this.env.DB.prepare('SELECT * FROM servers WHERE id = ?').bind(sess.serverId).first();
        if (user.pat) {
          // PAT：必须服务器存在且 canExec（exec scope + server_ids 白名单），不享受 creatorUserId 兜底
          allowed = !!server && canExec(user, server);
        } else {
          // JWT member：会话创建者
          allowed = !!server && user.id === sess.creatorUserId;
        }
      }
      if (!allowed) {
        try { ws.close(1008, 'unauthorized'); } catch { /* ignore */ }
        return;
      }
      // 鉴权通过 → 挂接为会话用户端；附件升级为 user 角色（供休眠唤醒重建索引）。
      // patToken 随附件持久化：PAT 撤销后每次浏览器消息重校验，撤销即关闭（JWT 不存，保持零 D1 读）
      sess.userWs = ws;
      sess.lastPatCheck = Date.now(); // 首帧已校验，PAT 重校验节流起点
      ws.serializeAttachment({
        role: 'user', sid: att.sid, serverId: sess.serverId,
        creatorUserId: sess.creatorUserId, type: sess.type, createdAt: sess.createdAt,
        patToken: user.pat ? token : null,
      });
      // 补发鉴权前缓冲的 agent 输出（如初始 bash 提示符），保证打开即见首屏
      if (sess.userBuf && sess.userBuf.length) {
        for (const m of sess.userBuf) {
          try { ws.send(m); } catch { /* ignore */ }
        }
        sess.userBuf = [];
      }
      return;
    }
    // agent 控制通道（不在任何 session）：处理监控上报 {type:"report"} 与终端确认 {type:"terminal_ready"}
    const sess = [...this.sessions.values()].find((s) => s.userWs === ws || s.agentWs === ws);
    if (!sess) {
      if (typeof message === 'string') {
        try {
          const j = JSON.parse(message);
          if (j && j.type === 'terminal_ready') {
            // agent 已收到 open_terminal 并开始 spawn → 停止确认重发
            const r = this.pendingTerm.get(j.stream_id);
            if (r && r.timer) clearTimeout(r.timer);
            this.pendingTerm.delete(j.stream_id);
            return;
          }
          if (j && j.type === 'report') {
            const serverId = this.wsServerId(ws);
            if (serverId) {
              await handleReport(this.env, {
                serverId,
                cpu: j.cpu,
                mem_used: j.mem_used,
                mem_total: j.mem_total,
                net_in: j.net_in,
                net_out: j.net_out,
                extra: j.extra,
                info: j.info,
                probes: j.probes,
                custom: j.custom,
              });
              await this.syncAgentInterval(ws, serverId);
              // 控制通道保活心跳（30s 限频）：agent 端 read -t 180 需要周期性下行流量，
              // 否则健康但安静（无指令下发）时会被误判半开而每 ~180s 重连
              const nowP = Date.now();
              const lastP = this.lastPingAt.get(serverId) || 0;
              if (nowP - lastP > 30000) {
                this.lastPingAt.set(serverId, nowP);
                try { ws.send(JSON.stringify({ type: 'ping' })); } catch { /* ignore */ }
              }
            }
          }
        } catch { /* 忽略非 JSON 的控制消息 */ }
      }
      return;
    }

    if (ws === sess.userWs) {
      // PAT 撤销校验（节流）：每 10s 重查一次 D1（打字 2~5 消息/s → 10s 一次，−98%；
      // 撤销后最迟 10s 内的一次输入即关闭连接；挂机连接由会话 TTL/绝对 TTL 兜底回收）
      const uatt = ws.deserializeAttachment?.();
      if (uatt && uatt.patToken) {
        const nowP = Date.now();
        if (!sess.lastPatCheck || nowP - sess.lastPatCheck >= PAT_CHECK_INTERVAL_MS) {
          sess.lastPatCheck = nowP;
          const u = await authUserByToken(uatt.patToken, this.env);
          if (!u) {
            try { ws.close(1008, 'unauthorized'); } catch { /* ignore */ }
            return;
          }
        }
      }
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
      else if (sess.agentBuf && sess.agentBuf.length < 128) {
        // agent 数据流尚未挂接 → 缓冲浏览器输入（有上限），挂接后按序补发，避免静默丢弃
        sess.agentBuf.push(message);
      }
    } else if (ws === sess.agentWs) {
      // agent → DO → 浏览器（纯字节透传）
      if (sess.userWs) {
        sess.userWs.send(message);
      } else if (sess.userBuf && sess.userBuf.length < 128) {
        // 浏览器尚未鉴权挂接：缓冲首屏输出（如 bash 初始提示符），避免被丢弃
        sess.userBuf.push(message);
      }
    }
  }

  // 省配额策略：观看者数变化由 PanelDO 事件驱动（/rpc/set_viewers 更新 agentInterval 并广播），
  // 上报时仅读内存（0 个 DO 调用）；仅当内存无记录（实例 evict / 新连接）时查 /viewers 兜底初始化。
  async syncAgentInterval(ws, serverId) {
    if (this.agentInterval.has(serverId)) return; // 事件驱动已维护
    let want = REPORT_SLOW_INTERVAL_S;
    try {
      const resp = await doPanel(this.env).fetch('https://do.internal/viewers');
      const v = await resp.json();
      want = (v.count || 0) > 0 ? REPORT_FAST_INTERVAL_S : REPORT_SLOW_INTERVAL_S;
    } catch { /* 兜底慢采 */ }
    this.agentInterval.set(serverId, want);
    ws.send(JSON.stringify({ type: 'set_report_interval', interval: want }));
  }

  async webSocketClose(ws) {
    this.rebuildIndex(); // 确保索引完整后再清理，否则休眠唤醒后的断连无法正确解除
    this.cleanup(ws);
  }
  async webSocketError(ws) {
    this.rebuildIndex();
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
        // 会话数据流断开 → 仅清理该会话的 open_terminal 待确认（数据流已不可用）
        const r = this.pendingTerm.get(sid);
        if (r && r.timer) clearTimeout(r.timer);
        this.pendingTerm.delete(sid);
      }
      if (!sess.userWs && !sess.agentWs) {
        this.sessions.delete(sid);
        this.state.storage.delete('sess:' + sid).catch(() => {}); // 清理持久化会话
      }
    }
    for (const [serverId, w] of this.agents) {
      if (w === ws) {
        this.agents.delete(serverId);
        // 控制通道断开 → 仅清理该 agent（serverId）的待确认，不影响其他服务器/会话
        for (const [sid, r] of [...this.pendingTerm]) {
          if (r.serverId === serverId) {
            if (r.timer) clearTimeout(r.timer);
            this.pendingTerm.delete(sid);
          }
        }
      }
    }
  }
}
