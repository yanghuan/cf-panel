// cf-panel — Durable Object：WebSocket 中转核心（分片实例 TerminalDO）
import { json, err, doPanel, sha256Hex, verifySecretHash } from './utils.js';
import { authIdentityByToken, authUserByIdentity, isAdmin, canExec } from './auth.js';
import { handleReport } from './report.js';

// 本模块专用常量（会话/上报间隔/PAT 校验，就近定义便于对照使用代码）
const SESSION_TTL_MS = 10 * 60 * 1000; // 会话两端都断开超过 10 分钟 → 回收
const MAX_SESSIONS_PER_SERVER = 8; // 每服务器并发会话上限（超限 429，防 PTY/bash/FD 耗尽）
const SESSION_ABS_MS = 4 * 60 * 60 * 1000; // 会话绝对最长时长（含活跃连接，到期强制回收）
const WS_AUTH_TIMEOUT_MS = 10 * 1000; // 浏览器 WS 建连后必须在 10s 内发送 auth 首帧
const MAX_PENDING_USER_WS = 128; // 单分片未鉴权浏览器连接上限
const PAT_CHECK_INTERVAL_MS = 10 * 1000; // PAT 终端连接重校验间隔（每条消息 → 10s 一次，−98%）
const REPORT_FAST_INTERVAL_S = 5;  // 有观看者：5 秒上报（快采 28,800 → 17,280 帧/天/机）
const REPORT_SLOW_INTERVAL_S = 120; // 无人查看：120 秒上报
const EXEC_DEFAULT_TIMEOUT_MS = 25 * 1000; // MCP exec 默认超时（须 < DO fetch 默认 30s 超时，由内部先返回）
const EXEC_MAX_TIMEOUT_MS = 25 * 1000;
const EXEC_TIMEOUT_GRACE_MS = 5 * 1000; // DO 兜底定时器比 agent 实际超时晚 5s：agent 先回执（含部分 stdout），DO 定时器仅兜底防悬挂
const UPLOAD_CHUNK_BYTES = 48 * 1024; // /api/file_upload 分片帧数据上限（控制通道入站 64KB，留 JSON 头/边界余量）
const UPLOAD_TIMEOUT_MS = 120 * 1000; // 上传总超时（流式转发 + agent 写盘；agent 失联时兜底返回，防悬挂）
const UPLOAD_MAX_DEFAULT = 100 * 1024 * 1024; // 单次上传大小上限默认 100MB（磁盘耗尽防护；agent 端 FILE_LIMIT 500MB 兜底）
const AGENT_UPDATE_MAX_BYTES = 32 * 1024 * 1024; // 更新包硬上限（远高于当前 2~4MB，防异常 manifest）
const AGENT_UPDATE_TIMEOUT_MS = 180 * 1000; // GitHub→Worker→DO→Agent + 校验/替换总超时

export class TerminalDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // streamId -> {streamId, serverId, creatorUserId, createdAt, userWs, agentWs}
    this.agents = new Map(); // serverId -> 控制 WS
    this.agentInterval = new Map(); // serverId -> 当前下发的上报间隔（秒），避免重复下发
    this.pendingOpen = new Map(); // streamId -> {tries, timer, type} open_terminal/open_file 确认重发
    this.pendingExec = new Map(); // execId -> {resolve, timer, serverId} MCP 一次性命令等待
    this.pendingUpload = new Map(); // uploadId -> {resolve, timer} /api/file_upload 等待 upload_result
    this.pendingUpdate = new Map(); // updateId -> {resolve,timer,serverId} Agent 更新等待最终校验/替换回执
    this.uploading = new Set(); // serverId -> 普通文件上传进行中（控制通道单 WS，防并发帧交错）
    this.updating = new Set(); // serverId -> Agent 更新进行中（与上传/更新互斥，防 Binary 帧交错）
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
      // 清理该服务器的 open_terminal/open_file 待确认（定时器停止）
      for (const sid of sids) {
        const r = this.pendingOpen.get(sid);
        if (r && r.timer) clearTimeout(r.timer);
        this.pendingOpen.delete(sid);
      }
      return json({ ok: true });
    }

    // 内部 RPC：worker 创建终端/文件会话时调用
    if (path === '/rpc' && request.method === 'POST') {
      const body = await request.json();
      if (body.op === 'create' || body.op === 'open_file') {
        const isFile = body.op === 'open_file';
        if (this.updating.has(body.serverId)) return json({ error: 'agent update in progress' }, 409);
        // 先确认 agent 在线，离线时不创建/不落盘（避免失败会话残留）
        const agentWs = this.agents.get(body.serverId);
        if (!agentWs) return json({ error: 'agent offline', code: 'AGENT_OFFLINE' }, 502);
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
          creatorUser: String(body.creatorUser || ''),
          clientIp: String(body.clientIp || ''), // 文件写审计用（WS 消息路径无请求头，随会话存储）
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
            creatorUser: String(body.creatorUser || ''),
            clientIp: String(body.clientIp || ''),
            createdAt,
            type: isFile ? 'file' : 'terminal',
          });
        } catch { /* 持久化失败则降级为纯内存会话 */ }
        // 安排 TTL 回收 alarm（两端都无连接时由 maybeSweep 按时回收）
        try {
          const existing = await this.state.storage.getAlarm();
          const next = createdAt + SESSION_TTL_MS + 1000;
          if (existing == null || next < existing) await this.state.storage.setAlarm(next);
        } catch { /* 无法安排 alarm 时依赖 fetch 时 maybeSweep */ }
        // 会话指令：确认重发机制（open_file 补齐）——agent 收到并启动后回
        // terminal_ready/file_ready，未确认则定时重发（最多 3 次），避免控制通道重连窗口丢指令
        const openType = isFile ? 'open_file' : 'open_terminal';
        agentWs.send(JSON.stringify({ type: openType, stream_id: body.streamId }));
        this.scheduleOpenAck(agentWs, body.streamId, body.serverId, openType);
        return json({ ok: true });
      }
      return err('bad op');
    }

    // 内部 RPC：MCP 一次性命令执行（不建终端会话，控制通道直达，等 agent 返回 exec_result）
    // 调用方（routes.mcpExecCommand）已完成 canExec 鉴权；此处只负责下发与等待。
    if (path === '/rpc/exec' && request.method === 'POST') {
      const body = await request.json();
      const serverId = Number(body.serverId) || 0;
      const command = String(body.command || '').trim();
      if (!command) return err('empty command');
      if (this.updating.has(serverId)) return json({ error: 'agent update in progress' }, 409);
      const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || EXEC_DEFAULT_TIMEOUT_MS, 1000), EXEC_MAX_TIMEOUT_MS);
      const agentWs = this.agents.get(serverId);
      if (!agentWs) return json({ error: 'agent offline', code: 'AGENT_OFFLINE' }, 502);
      const execId = `e-${crypto.randomUUID()}`;
      const result = await new Promise((resolve) => {
        // 兜底定时器晚于 agent 实际超时（EXEC_TIMEOUT_GRACE_MS）：正常路径 agent 先回执
        // exec_result（超时=无输出，agent 侧已 kill 进程组），此处仅防 agent 失联/回执丢失导致的悬挂。
        const timer = setTimeout(() => {
          this.pendingExec.delete(execId);
          resolve({ error: `command timed out after ${Math.floor(timeoutMs / 1000)}s` });
        }, timeoutMs + EXEC_TIMEOUT_GRACE_MS);
        this.pendingExec.set(execId, { resolve, timer, serverId });
        try {
          agentWs.send(JSON.stringify({ type: 'exec', exec_id: execId, command, timeout_s: Math.floor(timeoutMs / 1000) }));
        } catch {
          clearTimeout(timer);
          this.pendingExec.delete(execId);
          resolve({ error: 'failed to send exec command' });
        }
      });
      return json(result);
    }

    // 内部 RPC：Agent 自更新（仅 routes 管理员接口调用）。Release 二进制流式切 48KB
    // 专用 agent_update 帧；Agent 同目录 staging + SHA/版本校验 + self-replace 后回执并退出。
    if (path === '/rpc/agent_update' && request.method === 'POST') {
      const serverId = Number(url.searchParams.get('server_id')) || 0;
      const buildId = String(request.headers.get('x-agent-build-id') || '');
      const platform = String(request.headers.get('x-agent-platform') || '');
      const sha256 = String(request.headers.get('x-agent-sha256') || '').toLowerCase();
      const size = Number(request.headers.get('x-agent-size'));
      if (!serverId || !/^[A-Za-z0-9._-]{1,64}$/.test(buildId)
          || !/^[A-Za-z0-9_-]{3,32}$/.test(platform)
          || !/^[0-9a-f]{64}$/.test(sha256)
          || !Number.isSafeInteger(size) || size <= 0 || size > AGENT_UPDATE_MAX_BYTES) {
        return err('invalid agent update metadata');
      }
      const agentWs = this.agents.get(serverId);
      if (!agentWs) return json({ error: 'agent offline', code: 'AGENT_OFFLINE' }, 502);
      if (this.updating.has(serverId) || this.uploading.has(serverId)) {
        return json({ error: 'agent update/upload already in progress' }, 409);
      }
      if ([...this.pendingExec.values()].some((r) => r.serverId === serverId)) {
        return json({ error: 'command execution in progress' }, 409);
      }
      this.updating.add(serverId);
      // 更新会退出 Agent；先关闭活跃终端/文件流，确保 PTY/临时文件按正常链路清理。
      this.dropAgentSessions(serverId);
      try {
        return await this.doAgentUpdate(agentWs, request, {
          serverId, buildId, platform, sha256, size,
        });
      } finally {
        this.updating.delete(serverId);
      }
    }

    // 内部 RPC：/api/file_upload 流式上传（调用方 routes 已鉴权 canExec）
    // Worker 流式读请求 body → 自动切成 ≤48KB 分片 → 控制通道 Binary 混合帧发给 agent →
    // agent 写临时文件（offset 校验）→ 最后一帧 commit 原子替换 → 回执 upload_result。
    // 客户端零分片逻辑：curl --data-binary @file 一行即可，大文件天然流式（不占内存）。
    if (path === '/rpc/upload' && request.method === 'POST') {
      const serverId = Number(url.searchParams.get('server_id')) || 0;
      const targetPath = url.searchParams.get('path') || '';
      const overwrite = url.searchParams.get('overwrite') === '1';
      if (!serverId) return err('server_id is required');
      if (!targetPath || !targetPath.startsWith('/')) return err('path is required (absolute)');
      const agentWs = this.agents.get(serverId);
      if (!agentWs) return json({ error: 'agent offline', code: 'AGENT_OFFLINE' }, 502);
      if (this.uploading.has(serverId) || this.updating.has(serverId)) {
        return json({ error: 'upload/update already in progress for this server' }, 409);
      }
      this.uploading.add(serverId);
      try {
        return await this.doUpload(agentWs, targetPath, overwrite, request);
      } finally {
        this.uploading.delete(serverId);
      }
    }

    // GET /ws/terminal/:id | /ws/file/:id —— 浏览器会话（防 UUID 劫持）
    // 鉴权改为首条消息（{type:'auth', token}），token 不进 URL（防访问日志/浏览器历史泄露）；
    // 未鉴权前不挂接 userWs，任何数据都不会流向浏览器，防劫持语义不变
    let m = path.match(/^\/ws\/(terminal|file)\/(.+)$/);
    if (m) {
      const streamId = m[2];
      const sess = await this.hydrateSession(streamId);
      if (!sess) return new Response('session not found', { status: 404 });
      const pending = (this.state.getWebSockets?.() || []).filter((ws) => {
        try { return ws.deserializeAttachment?.()?.role === 'user-pending'; } catch { return false; }
      }).length;
      if (pending >= MAX_PENDING_USER_WS) return new Response('too many pending connections', { status: 429 });
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      const authDeadline = Date.now() + WS_AUTH_TIMEOUT_MS;
      pair[1].serializeAttachment({
        role: 'user-pending', sid: streamId, serverId: sess.serverId,
        creatorUserId: sess.creatorUserId, creatorUser: sess.creatorUser || '',
        clientIp: sess.clientIp || '', type: sess.type, createdAt: sess.createdAt, authDeadline,
      });
      try {
        const existing = await this.state.storage.getAlarm();
        if (existing == null || authDeadline < existing) await this.state.storage.setAlarm(authDeadline);
      } catch { /* 无法安排 alarm 时仍受 pending 数量硬上限保护 */ }
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // GET /ws/agent/control —— agent 常驻控制通道（只接受请求头，避免凭证进入 URL 日志/历史）
    if (path === '/ws/agent/control') {
      const key = request.headers.get('x-agent-key') || '';
      if (!key) return new Response('missing agent key', { status: 401 });
      const keyId = await sha256Hex(key);
      const server = await this.env.DB.prepare('SELECT * FROM servers WHERE agent_key_id = ?').bind(keyId).first();
      if (!server) return new Response('unknown agent', { status: 401 });
      if (!(await verifySecretHash(key, server.agent_key_hash, this.env))) {
        return new Response('bad key', { status: 401 });
      }
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      // 控制通道（重）连接：说明旧连接已断/网络切换，关闭该服务器旧的终端/文件会话流，
      // 让 agent 侧 websocat 收到 close → 退出 → 触发清理链（kill pty/bash/脚本），防半开残留。
      // 配合服务端心跳后，健康连接不会因 read -t 180 误重连，故此处只会在真正断链时触发。
      this.dropAgentSessions(server.id);
      // 替换语义：同服务器已登记的控制通道（同 key 双开实例或断链后的半开残留）主动
      // 关闭，收敛到「一服务器一活连接」。否则两条连接交替 report 造成面板信息来回
      // 跳变（版本号/更新模式），DO 冻结唤醒后 rebuildIndex 还可能让半开死连接压过
      // 活连接，更新/exec 指令发往死连接悬挂超时。
      // close code 4001 = superseded：agent 收到后进入长退避，避免旧实例立即重连与新
      // 连接互踢形成 ping-pong 循环。
      const prevAgent = this.agents.get(server.id);
      if (prevAgent && prevAgent !== pair[1]) {
        try { prevAgent.close(4001, 'superseded by new connection'); } catch { /* ignore */ }
      }
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

    // GET /ws/agent/terminal?sid= | /ws/agent/file?sid= —— agent 数据流（header key + stream 归属校验）
    if (path === '/ws/agent/terminal' || path === '/ws/agent/file') {
      const sid = url.searchParams.get('sid') || '';
      const key = request.headers.get('x-agent-key') || '';
      if (!key) return new Response('missing agent key', { status: 401 });
      const sess = await this.hydrateSession(sid);
      if (!sess) return new Response('session not found', { status: 404 });
      const server = await this.env.DB.prepare('SELECT * FROM servers WHERE id = ?').bind(sess.serverId).first();
      if (!server) return new Response('unknown agent', { status: 401 });
      if (!(await verifySecretHash(key, server.agent_key_hash, this.env))) {
        return new Response('bad key', { status: 401 });
      }
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      // 挂接 agent 数据流并按序补发缓冲的浏览器输入
      this.attachAgentFlow(sess, pair[1]);
      // 附件随连接持久化：休眠唤醒后靠它重建会话索引
      pair[1].serializeAttachment({
        role: 'agent', sid, serverId: sess.serverId,
        creatorUserId: sess.creatorUserId, creatorUser: sess.creatorUser || '',
        clientIp: sess.clientIp || '', type: sess.type, createdAt: sess.createdAt,
      });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    return new Response('not found', { status: 404 });
  }

  // /api/file_upload 核心：流式读 body → 自动切 ≤48KB 分片 → 控制通道 Binary 混合帧 → 等 upload_result。
  // 客户端零分片逻辑（curl --data-binary @file 一行）；分片顺序由 offset 严格保证（agent 端校验）。
  async doAgentUpdate(agentWs, request, meta) {
    const updateId = `au-${crypto.randomUUID()}`;
    let failed = false;
    let resolveResult;
    const resultPromise = new Promise((resolve) => { resolveResult = resolve; });
    const timer = setTimeout(() => {
      failed = true;
      this.pendingUpdate.delete(updateId);
      try { agentWs.close(1011, 'agent update timeout'); } catch { /* ignore */ }
      resolveResult({ ok: false, error: 'agent update timed out' });
    }, AGENT_UPDATE_TIMEOUT_MS);
    this.pendingUpdate.set(updateId, { resolve: resolveResult, timer, serverId: meta.serverId });
    try {
      const encoder = new TextEncoder();
      const sendFrame = (offset, piece, commit) => {
        if (failed) return;
        const head = encoder.encode(JSON.stringify({
          type: 'agent_update', update_id: updateId, build_id: meta.buildId,
          platform: meta.platform, size: meta.size, sha256: meta.sha256, offset, commit,
        }) + '\n');
        const frame = new Uint8Array(head.length + piece.length);
        frame.set(head, 0);
        frame.set(piece, head.length);
        try {
          agentWs.send(frame.buffer);
        } catch {
          failed = true;
          resolveResult({ ok: false, error: 'agent disconnected during update' });
        }
      };
      const reader = request.body ? request.body.getReader() : null;
      let offset = 0;
      try {
        while (reader && !failed) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || !value.length) continue;
          if (offset + value.length > meta.size) {
            failed = true;
            resolveResult({ ok: false, error: 'agent update body exceeds manifest size' });
            break;
          }
          // 不拼整包：直接把上游 chunk 切成 ≤48KB WS 帧，内存峰值与 fetch chunk 等量。
          for (let pos = 0; pos < value.length && !failed; pos += UPLOAD_CHUNK_BYTES) {
            const piece = value.subarray(pos, Math.min(value.length, pos + UPLOAD_CHUNK_BYTES));
            sendFrame(offset, piece, false);
            offset += piece.length;
          }
        }
      } catch (e) {
        failed = true;
        resolveResult({ ok: false, error: `agent update stream failed: ${e.message}` });
      }
      if (failed && reader) {
        try { await reader.cancel(); } catch { /* ignore */ }
      }
      if (!failed && offset !== meta.size) {
        failed = true;
        resolveResult({
          ok: false,
          error: `agent update size mismatch: expected ${meta.size}, got ${offset}`,
        });
      }
      if (!failed) sendFrame(offset, new Uint8Array(0), true);
      const result = await resultPromise;
      if (!result.ok) {
        // 中途失败时关闭控制通道，让 Agent control_conn 退出并清理 staging；随后自动重连。
        if (failed) { try { agentWs.close(1011, 'update relay failed'); } catch { /* ignore */ } }
        const message = result.error || 'agent update failed';
        const status = /timed out/.test(message) ? 504 : /disconnected|stream failed/.test(message) ? 502 : 400;
        return json({ error: message }, status);
      }
      if (result.build_id !== meta.buildId || result.size !== meta.size || !result.restarting) {
        return json({ error: 'agent update result does not match manifest' }, 502);
      }
      return json({ ...result, update_id: updateId, transferred: offset });
    } finally {
      clearTimeout(timer);
      this.pendingUpdate.delete(updateId);
    }
  }

  async doUpload(agentWs, targetPath, overwrite, request) {
    const uploadId = `u-${crypto.randomUUID()}`;
    let resolveResult;
    const resultPromise = new Promise((resolve) => { resolveResult = resolve; });
    const timer = setTimeout(() => {
      this.pendingUpload.delete(uploadId);
      resolveResult({ ok: false, error: 'upload timed out' });
    }, UPLOAD_TIMEOUT_MS);
    this.pendingUpload.set(uploadId, { resolve: resolveResult, timer });
    // 大小上限：优先环境变量 UPLOAD_MAX_MB（磁盘耗尽防护）。
    // 显式解析：0/非数字回退默认 100MB（不支持 0=无限）；上限钳到 agent 端 FILE_LIMIT
    //（500MB 绝对硬上限，README/routes.js 工具描述同口径——UPLOAD_MAX_DEFAULT 是默认值
    // 不是上限，钳 100 会静默砍掉文档承诺的"调高到 500"能力）
    const UPLOAD_ABS_MAX_MB = 500;
    const rawMax = Number(this.env.UPLOAD_MAX_MB);
    const maxMb = Number.isFinite(rawMax) && rawMax > 0
      ? Math.min(rawMax, UPLOAD_ABS_MAX_MB)
      : UPLOAD_MAX_DEFAULT / (1024 * 1024);
    const maxBytes = maxMb * 1024 * 1024;
    try {
      const encoder = new TextEncoder();
      let failed = false; // agent 断连/超限后置位：停止发帧并提前退出读循环
      // 发一帧：JSON 头 + '\n' + 原始字节（Binary 混合帧，与文件会话同构）
      const sendFrame = (offset, piece, commit) => {
        if (failed) return;
        const head = encoder.encode(JSON.stringify({
          type: 'upload', upload_id: uploadId, path: targetPath, offset, commit, overwrite,
        }) + '\n');
        const frame = new Uint8Array(head.length + piece.length);
        frame.set(head, 0);
        frame.set(piece, head.length);
        try {
          agentWs.send(frame.buffer);
        } catch {
          failed = true;
          resolveResult({ ok: false, error: 'agent disconnected during upload' });
        }
      };
      // 流式读 body：跨块拼接后切帧，不整体缓冲（大文件内存友好）
      const reader = request.body ? request.body.getReader() : null;
      let offset = 0;
      let buf = new Uint8Array(0);
      while (reader && !failed) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length) {
          if (offset + value.length > maxBytes) {
            failed = true;
            resolveResult({ ok: false, error: `upload exceeds ${Math.round(maxBytes / (1024 * 1024))}MB limit` });
            break;
          }
          const combined = new Uint8Array(buf.length + value.length);
          combined.set(buf, 0);
          combined.set(value, buf.length);
          buf = combined;
        }
        while (!failed && buf.length >= UPLOAD_CHUNK_BYTES) {
          sendFrame(offset, buf.slice(0, UPLOAD_CHUNK_BYTES), false);
          offset += UPLOAD_CHUNK_BYTES;
          buf = buf.slice(UPLOAD_CHUNK_BYTES);
        }
      }
      if (!failed && buf.length > 0) {
        sendFrame(offset, buf, false);
        offset += buf.length;
      }
      // commit 帧（空数据）：agent 端 fsync + rename 原子替换（失败路径不发，避免残留 commit）
      if (!failed) sendFrame(offset, new Uint8Array(0), true);
      const result = await resultPromise;
      if (!result.ok) return json({ error: result.error || 'upload failed' }, result.error && /too large|exceeds/.test(result.error) ? 413 : 400);
      return json({ ok: true, path: targetPath, size: offset, upload_id: uploadId });
    } finally {
      clearTimeout(timer);
      this.pendingUpload.delete(uploadId);
    }
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

  // 惰性清理：两端都断开且超过 TTL 的僵尸会话 → 删除；并清理对应 pendingOpen。
  // 若有未到期的僵尸会话，则安排 DO alarm 到最早到期时间——Hibernation 下零流量也会
  // 被 alarm 短暂唤醒执行清理，避免"必须等下一次 fetch 才回收"的滞留（alarm 每次 = 1 次请求，僵尸会话罕见，成本可忽略）。
  async maybeSweep() {
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
    // 清理已无会话的 open_terminal/open_file 待确认（流已回收，停止定时器，防泄漏）
    for (const sid of [...this.pendingOpen.keys()]) {
      if (!this.sessions.has(sid)) {
        const r = this.pendingOpen.get(sid);
        if (r && r.timer) clearTimeout(r.timer);
        this.pendingOpen.delete(sid);
      }
    }
    // 未鉴权浏览器连接不属于 sess.userWs，必须单独按 attachment deadline 回收。
    for (const ws of this.state.getWebSockets?.() || []) {
      let att = null;
      try { att = ws.deserializeAttachment?.(); } catch { /* ignore */ }
      if (!att || att.role !== 'user-pending') continue;
      const deadline = Number(att.authDeadline) || 0;
      if (deadline <= now) {
        try { ws.close(1008, 'authentication timeout'); } catch { /* ignore */ }
      } else {
        next = Math.min(next, deadline);
      }
    }
    if (next !== Infinity) {
      try { await this.state.storage.setAlarm(next + 1000); } catch { /* ignore */ }
    }
  }

  // Hibernation alarm：零流量时也被唤醒执行清理；无僵尸会话则无需设定 alarm，保持休眠
  async alarm() {
    this.rebuildIndex();
    await this.maybeSweep();
  }

  // open_terminal/open_file 确认重发：下发后 5s 未收到 agent 的 *_ready 则重发，最多 3 次
  // 解决 agent 控制通道重连窗口内指令丢失导致的终端/文件"打不开"（open_file 补齐）
  // 记录 serverId + agentWs 归属：cleanup 断开时只清理关联项，不影响其他服务器/会话
  scheduleOpenAck(agentWs, streamId, serverId, openType) {
    if (this.pendingOpen.has(streamId)) return;
    const rec = { tries: 0, timer: null, serverId, agentWs, type: openType };
    this.pendingOpen.set(streamId, rec);
    const retry = () => {
      const r = this.pendingOpen.get(streamId);
      if (!r) return; // 已确认（*_ready）或已清理
      if (agentWs.readyState === 1) {
        try { agentWs.send(JSON.stringify({ type: r.type, stream_id: streamId })); } catch { /* ignore */ }
      }
      r.tries += 1;
      if (r.tries < 3) r.timer = setTimeout(retry, 5000);
      else this.pendingOpen.delete(streamId); // 3 次后放弃（前端有自愈兜底）
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
            creatorUser: att.creatorUser || '',
            clientIp: att.clientIp || '',
            createdAt: att.createdAt,
            type: att.type,
            userWs: null,
            agentWs: null,
            userBuf: [],
            agentBuf: [],
          };
          this.sessions.set(att.sid, sess);
        } else {
          // 兼容升级前缺字段的 agent 附件：后遇到的新 user 附件时补齐审计上下文。
          if (!sess.creatorUser && att.creatorUser) sess.creatorUser = att.creatorUser;
          if (!sess.clientIp && att.clientIp) sess.clientIp = att.clientIp;
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
      if (att.authDeadline && Date.now() > att.authDeadline) {
        try { ws.close(1008, 'authentication timeout'); } catch { /* ignore */ }
        return;
      }
      let j = null;
      try { j = JSON.parse(typeof message === 'string' ? message : ''); } catch { /* 非 JSON */ }
      const token = j && j.type === 'auth' ? String(j.token || '') : '';
      // WS 首帧鉴权与 REST 一致（JWT 管理员直接放行；PAT/member 需服务器存在且可执行/为创建者）
      const authenticated = token ? await authIdentityByToken(token, this.env) : null;
      const user = authenticated && authenticated.user;
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
      // 鉴权通过 → 挂接为会话用户端；附件只保存不可逆 PAT HMAC 或已验证 JWT claims。
      // 创建者身份/IP 随附件保存，休眠唤醒后文件操作审计仍完整。
      if (!sess.creatorUser) sess.creatorUser = user.username || '';
      if (!sess.clientIp && att.clientIp) sess.clientIp = att.clientIp;
      sess.userWs = ws;
      sess.lastAuthCheck = Date.now();
      ws.serializeAttachment({
        role: 'user', sid: att.sid, serverId: sess.serverId,
        creatorUserId: sess.creatorUserId, creatorUser: sess.creatorUser || '',
        clientIp: sess.clientIp || '', type: sess.type, createdAt: sess.createdAt,
        auth: authenticated.identity,
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
    // 附件已含 sid → O(1) 定位（原来每条消息 O(N) 扫 sessions，终端按键高频路径）
    const sess = (att && att.sid && this.sessions.get(att.sid)) ||
      [...this.sessions.values()].find((s) => s.userWs === ws || s.agentWs === ws);
    if (!sess) {
      if (typeof message === 'string') {
        try {
          const j = JSON.parse(message);
          if (j && (j.type === 'terminal_ready' || j.type === 'file_ready')) {
            // agent 已收到 open_terminal/open_file 并开始启动 → 停止确认重发（file_ready 补齐）
            const r = this.pendingOpen.get(j.stream_id);
            if (r && r.timer) clearTimeout(r.timer);
            this.pendingOpen.delete(j.stream_id);
            return;
          }
          if (j && j.type === 'exec_result') {
            // MCP 一次性命令结果：resolve 等待中的 /rpc/exec（Promise resolve 幂等，超时/断连兜底）
            const r = this.pendingExec.get(j.exec_id);
            if (r) {
              clearTimeout(r.timer);
              this.pendingExec.delete(j.exec_id);
              r.resolve({
                exit_code: j.exit_code,
                stdout: j.stdout || '',
                stderr: j.stderr || '',
                timed_out: !!j.timed_out,
                error: j.error || null,
              });
            }
            return;
          }
          if (j && j.type === 'upload_result') {
            // /api/file_upload 结果。agent 对每个分片帧都回执（非 commit 帧 ok:true 表示
            // "该块已写入临时文件"）——只有 commit 帧的回执才代表"文件已 fsync+rename 完成"。
            // 首帧即 resolve 会在大文件上传中提前返回成功（目标文件尚不存在/后续块写失败
            // 客户端无从得知）。失败帧（ok:false）保持立即 resolve 的快速失败语义。
            const r = this.pendingUpload.get(j.upload_id);
            if (r && (j.commit === true || !j.ok)) {
              clearTimeout(r.timer);
              this.pendingUpload.delete(j.upload_id);
              r.resolve({ ok: !!j.ok, error: j.error || null, size: j.size || 0 });
            }
            return;
          }
          if (j && j.type === 'agent_update_result') {
            const r = this.pendingUpdate.get(j.update_id);
            if (r) {
              clearTimeout(r.timer);
              this.pendingUpdate.delete(j.update_id);
              r.resolve({
                ok: !!j.ok,
                error: j.error || null,
                build_id: j.build_id || null,
                size: Number(j.size) || 0,
                restarting: !!j.restarting,
              });
            }
            return;
          }
          if (j && j.type === 'report') {
            try {
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
            } catch (e) { console.error('handleReport failed:', e); }
          }
        } catch { /* 忽略非 JSON 的控制消息 */ }
      }
      return;
    }

    if (ws === sess.userWs) {
      // PAT 撤销/JWT 过期校验（10s 节流）。新附件只保存 PAT HMAC 或 JWT claims；
      // 旧版本 patToken 附件在首次活动时校验并原地迁移，避免在线升级强制中断会话。
      let uatt = ws.deserializeAttachment?.();
      let identity = uatt && uatt.auth;
      if (!identity && uatt && uatt.patToken) {
        const migrated = await authIdentityByToken(uatt.patToken, this.env);
        if (!migrated) {
          try { ws.close(1008, 'unauthorized'); } catch { /* ignore */ }
          return;
        }
        const { patToken: _discard, ...safe } = uatt;
        safe.auth = migrated.identity;
        ws.serializeAttachment(safe);
        uatt = safe;
        identity = safe.auth;
      }
      if (identity) {
        const nowP = Date.now();
        if (!sess.lastAuthCheck || nowP - sess.lastAuthCheck >= PAT_CHECK_INTERVAL_MS) {
          sess.lastAuthCheck = nowP;
          const u = await authUserByIdentity(identity, this.env);
          if (!u) {
            try { ws.close(1008, 'unauthorized'); } catch { /* ignore */ }
            return;
          }
        }
      }
      // 浏览器 → DO
      // 文件写操作审计（zip/rename/delete + write 首块）：记入 audit_logs，失败不影响透传。
      // 文件会话与终端共用本通道，仅文件指令携带 path 字段，据此区分。
      const fileAudit = async (j) => {
        if (!j || !j.path) return;
        if (!(j.type === 'zip' || j.type === 'rename' || j.type === 'delete' || (j.type === 'write' && Number(j.offset) === 0))) return;
        let detail = String(j.path).slice(0, 200);
        if (j.type === 'rename') detail += ` → ${String(j.new_name || '').slice(0, 100)}`;
        try {
          await this.env.DB.prepare('INSERT INTO audit_logs (user_id, username, client_ip, action, target_server_id, detail) VALUES (?,?,?,?,?,?)')
            .bind(sess.creatorUserId, sess.creatorUser || '', sess.clientIp || '', `file.${j.type}`, sess.serverId, detail)
            .run();
        } catch (e) { console.error('file audit failed:', e); }
      };
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
          await fileAudit(j);
        } catch {
          /* 不是 JSON，当普通输入透传 */
        }
      } else {
        // Binary 混合帧（生产上传路径）：JSON 头 + '\n' + 原始字节——审计须在此覆盖，
        // 否则面板文件管理器上传（api.js 混合帧）无 file.write 审计（Text JSON 分支覆盖不到）
        try {
          const bytes = message instanceof ArrayBuffer
            ? new Uint8Array(message)
            : new Uint8Array(message.buffer || message, message.byteOffset || 0, message.byteLength || 0);
          let nl = -1;
          const headMax = Math.min(bytes.length, 512); // JSON 头很短，只扫前 512 字节
          for (let i = 0; i < headMax; i++) {
            if (bytes[i] === 10) { nl = i; break; }
          }
          if (nl > 0) {
            const j = JSON.parse(new TextDecoder().decode(bytes.slice(0, nl)));
            await fileAudit(j);
          }
        } catch {
          /* 纯二进制（非混合帧）不审计 */
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
        // 会话数据流断开 → 仅清理该会话的 open_terminal/open_file 待确认（数据流已不可用）
        const r = this.pendingOpen.get(sid);
        if (r && r.timer) clearTimeout(r.timer);
        this.pendingOpen.delete(sid);
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
        for (const [sid, r] of [...this.pendingOpen]) {
          if (r.serverId === serverId) {
            if (r.timer) clearTimeout(r.timer);
            this.pendingOpen.delete(sid);
          }
        }
        // 未完成的 MCP exec 一并失败返回（Promise resolve 幂等，超时定时器已清）
        for (const [execId, r] of [...this.pendingExec]) {
          if (r.serverId === serverId) {
            if (r.timer) clearTimeout(r.timer);
            this.pendingExec.delete(execId);
            r.resolve({ error: 'agent disconnected' });
          }
        }
        // 更新成功会先回 agent_update_result 再主动退出；若结果未到就断线则明确失败，
        // 不让 Worker 请求悬挂到 180s 定时器。
        for (const [updateId, r] of [...this.pendingUpdate]) {
          if (r.serverId === serverId) {
            if (r.timer) clearTimeout(r.timer);
            this.pendingUpdate.delete(updateId);
            r.resolve({ ok: false, error: 'agent disconnected during update' });
          }
        }
      }
    }
  }
}
