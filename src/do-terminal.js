// cf-panel — Durable Object：WebSocket 中转核心（分片实例 TerminalDO）
import { json, err, doPanel, sha256Hex, verifySecretHash, signJobToken } from './utils.js';
import { EXEC_CMD_MAX_BYTES, execCommandBytes, execTooLongError, JOB_URL_TTL_S } from './config.js';
import { authIdentityByToken, authUserByIdentity, isAdmin, canExec } from './auth.js';
import { handleReport } from './report.js';
import {
  markJobRunning, failJob, finishExecJob, hasActiveAgentUpdate,
  markUploadWaitingAgent, markUploadRunning, listWaitingUploads, requeueOrphanUploads, finishUploadJob, finishUpdateJob, markUpdateRunning, getJob,
} from './jobs.js';

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
const EXEC_ROUNDTRIP_TTL_MS = 900 * 1000; // exec 判据：窗口内有过成功往返（exec_result 或 probe 的 pong）就信任连接。
// probe 受 PROBE_REFRESH_MS 节流且只在 report 到达时发：慢采 120s → 实际落在 t=0,360,720…（间隔 360s），
// 窗口取 900s 才能容忍丢一次 pong（720s）仍不误判。超过窗口视为链路不可信 → 立即 503 让调用方重试
//（命令尚未下发，重试绝对安全）。若日后把 REPORT_SLOW_INTERVAL_S 调大，需同步放大本窗口。
const PROBE_REFRESH_MS = 300 * 1000; // 上报顺带 probe 的最小间隔。
// 注意：每条 probe 都会让 agent 回一个 pong，而 pong 是入站 WS 消息 = 一次 DO 请求。
// 60s 会让每台机每小时多 60 次请求（约等于上报量翻倍），所以按 5 分钟一次足够维持 exec 判据。
// 上传/更新的体积与超时上限不在这里定义：同步上传路径已删除，上传走 upload_jobs
// （大小上限 uploadMaxBytesOf(env) 在 routes.js，任务窗口在 config.js 的 UPLOAD_JOB_*），
// 更新走 agent_update 任务（体积校验在 routes.js 的 AGENT_UPDATE_MAX_BYTES，超时在
// config.js 的 UPDATE_JOB_TIMEOUT_S/GRACE_S）。本类只负责下发指令与接收回执，不再转发字节。
// 慢路径埋点（定位「DO 唤醒后单条消息为什么贵」）：正常单条处理后端各段都是毫秒级，
// 超过阈值才输出一行 JSON；每实例每小时限量，避免埋点自己吃掉可观测性额度。
const SLOW_REPORT_MS = 1000; // 单条上报（消息到达 → D1 + 转发 MetricsDO 完成）阈值
const SLOW_CONN_MS = 1000; // agent 控制通道握手（D1 反查 → 101）阈值
const SLOW_LOG_BUDGET_PER_HOUR = 20; // 每实例每小时上限。实例包含 TerminalDO/PanelDO/MetricsDO，
// 且 evict 会清零计数，冷启动频繁时全局上限高于 20×实例数；埋点日志仍只在千条/天量级，可接受。
// open_terminal/open_file 未确认的重发间隔（3 次 → 9s 窗口，原为 5s×3 = 15s）。
// setTimeout 会让 DO 在窗口内失去 hibernation 资格并持续计 duration，故缩短窗口；
// 控制通道重连间隙通常 3~6s，3s 间隔仍能覆盖，3 次后放弃（前端另有自愈兜底）。
const OPEN_ACK_RETRY_MS = 3 * 1000;

export class TerminalDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // streamId -> {streamId, serverId, creatorUserId, createdAt, userWs, agentWs}
    this.agents = new Map(); // serverId -> 控制 WS
    this.agentInterval = new Map(); // serverId -> 当前下发的上报间隔（秒），避免重复下发
    this.pendingOpen = new Map(); // streamId -> {tries, timer, type} open_terminal/open_file 确认重发
    this.lastProbeAt = new Map(); // serverId -> 上次发出 probe 帧的时间（上报顺风车节流，防每帧都发）
    // serverId -> 进行中更新的 jobId（与上传/更新互斥，防 Binary 帧交错）。
    // 用 Map 而非 Set：必须能区分「遗留的旧标记」与「本次要下发的任务」——
    // 旧更新挂住（D1 已判过期）后，新的更新任务会被自己的 D1 行挡住直到实例 evict；
    // 且旧任务的迟到回执不得清掉新任务的标记（否则两者会交错）。
    this.updating = new Map();
    this.lastPingAt = new Map(); // serverId -> 上次心跳时间（控制通道保活，防健康连接被 read -t 180 误判半开）
    this.lastRoundTripAt = new Map(); // serverId -> 上次确认双向可达时间（exec_result/pong），exec 据此信任连接
    this.probeCapable = new Set(); // serverId -> agent 已回 pong（支持 exec 前探活）；未支持则 exec 直接下发（向后兼容旧 agent）
    this.rebuilt = false; // 本实例是否已按附件重建过索引（唤醒后只重建一次，见 rebuildIndex）
    this.slowLogAt = 0; // 埋点日志的小时窗口起点（ms）
    this.slowLogCount = 0; // 本窗口已输出条数（每实例独立）
  }

  // 内存互斥可能因 Agent 挂住（不回执、连接仍在）而永不释放——D1 的 deadline 才是权威。
  // 标记存在但 D1 已无未过期更新时清掉本地标记，避免过期更新继续挡 exec / upload /
  // 新更新 / 终端会话，直到实例 evict。
  // 注意：这里只是「读判据 + 清本地缓存」，不收敛 D1 行（早期版本会顺手 UPDATE 成
  // expired，现由 settleServerExpired 在创建 upload/update 前统一收敛）。
  // forJobId：调用方正在下发的更新任务 id。它自己当然算 active，必须排除，
  // 否则「上一次更新挂住 → D1 判过期 → 用户重试」的第二条任务会被自己挡住。
  async isUpdating(serverId, forJobId = null) {
    const marked = this.updating.get(serverId);
    if (marked != null && forJobId && marked === forJobId) return false; // 就是本次要下发的任务
    // 无论本地有没有标记都要问 D1：evict 后本地 Map 为空，但另一实例（或 evict 前）下发的
    // 更新仍在跑——只看本地标记会让 exec/upload 与 self-replace 交错（原实现就是「本地标记
    // 或 D1 任务」双轨判定，不能因短路本地标记而丢掉 D1 这一轨）。
    let active;
    try {
      active = await hasActiveAgentUpdate(this.env, serverId, forJobId);
    } catch {
      // D1 暂不可用：有本地标记时保守拦截，避免与 self-replace 交错；无标记时无法判定，
      // 但任务本身也要写 D1（刚还可用），按未更新放行由后续帧兜底
      return marked != null;
    }
    if (active) return true;
    // D1 里已没有「其它」未过期更新：本地标记属于已过期/已收敛的任务，清掉
    if (marked != null) this.updating.delete(serverId);
    return false;
  }

  // 慢路径埋点：只在超过阈值时输出一行 JSON，且每实例每小时限量。
  // 把「单条消息为什么贵」拆成可核对的数字（冷启动重建 / D1 行读 / D1 写 / DO 间 fetch / 建连），
  // 避免继续靠推断定位。正常一天只有几十条，不挤占观测额度（wrangler.toml 只保留 console 日志）。
  logSlow(kind, data) {
    const now = Date.now();
    if (now - this.slowLogAt >= 3600_000) {
      this.slowLogAt = now;
      this.slowLogCount = 0;
    }
    if (this.slowLogCount >= SLOW_LOG_BUDGET_PER_HOUR) return;
    this.slowLogCount += 1;
    try { console.error(`[slow-${kind}] ${JSON.stringify(data)}`); } catch { /* ignore */ }
  }

  async fetch(request) {
    // await：maybeSweep 内部有 storage 删除/arm，不等它结束就会留下未完成 I/O，
    // 阻止对象回到 hibernateable 状态（空闲期持续计 duration）。
    await this.maybeSweep();
    this.rebuildIndex(); // 休眠唤醒后内存索引可能已丢，先从存活的 WS 附件重建
    const url = new URL(request.url);
    const path = url.pathname;

    // 内部 RPC：观看者数变化事件（0→1 快采 / 1→0 慢采），更新本分片全部 agent 上报间隔
    if (path === '/rpc/set_viewers' && request.method === 'POST') {
      const body = await request.json();
      const want = (Number(body.count) || 0) > 0 ? REPORT_FAST_INTERVAL_S : REPORT_SLOW_INTERVAL_S;
      for (const [serverId, w] of this.agents) {
        if (this.agentInterval.get(serverId) !== want) this.applyAgentInterval(w, serverId, want);
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
        await this.state.storage.delete('sess:' + sid).catch(() => {}); // 清理持久化会话（await：不留未完成 I/O）
      }
      // 服务器已删：间隔/往返/探活索引一并作废。servers.id 是 AUTOINCREMENT、不复用，
      // 留着也不会被新服务器命中，但清理清单与 cleanup 保持一致，避免规则半途而废。
      this.agentInterval.delete(serverId);
      this.lastRoundTripAt.delete(serverId);
      this.lastProbeAt.delete(serverId);
      this.probeCapable.delete(serverId);
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
        if (await this.isUpdating(body.serverId)) return json({ error: 'agent update in progress' }, 409);
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

    // 内部 RPC：异步 exec 下发（阶段 A）。只负责「把指令发出去 + 落 D1 running」：
    // 不设内存等待、不设 setTimeout、不等结果——结果由 agent 的 exec_result 唤醒 DO 后落库。
    if (path === '/rpc/exec/submit' && request.method === 'POST') {
      const body = await request.json();
      const jobId = String(body.jobId || '');
      const serverId = Number(body.serverId) || 0;
      const command = String(body.command || '');
      const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || EXEC_DEFAULT_TIMEOUT_MS, 1000), EXEC_MAX_TIMEOUT_MS);
      if (!jobId || !serverId || !command) return err('bad request', 400);
      const cmdBytes = execCommandBytes(command);
      if (cmdBytes > EXEC_CMD_MAX_BYTES) return err(execTooLongError(cmdBytes), 413);

      // 互斥：内存里的同步更新标记 + D1 里的异步更新任务（双轨期两者都要看）。
      // exec 之间、exec 与 upload 之间不互斥——保持与旧路径一致的并发语义。
      if (await this.isUpdating(serverId)) {
        await this.failExecJobWithAudit(this.env, jobId, 'agent update in progress');
        return json({ error: 'agent update in progress' }, 409);
      }
      const agentWs = this.agents.get(serverId);
      if (!agentWs) {
        await this.failExecJobWithAudit(this.env, jobId, 'agent offline');
        return json({ error: 'agent offline', code: 'AGENT_OFFLINE' }, 503);
      }
      // 链路可信度（仅对声明 probe_proto 的 agent）：往返时间由「上报顺风车 probe」的 pong 维持。
      // 窗口内命中 → 直接下发（零等待）；窗口外说明 pong 已连续丢失 → 判不可信，立即让调用方重试
      //（命令尚未下发，重试绝对安全），同时补发一帧 probe 让下一次调用恢复。
      // 关键：这里不再当场等回执，因此没有 setTimeout，DO 不会因此失去 hibernation 资格。
      if (this.probeCapable.has(serverId)) {
        const lastRtt = this.lastRoundTripAt.get(serverId) || 0;
        // 冷启动（内存与附件都没有 rtt）必须乐观放行：evict 不会断开 WS（连接由 hibernation 托管），
        // 能走到这里说明该连接仍登记在本实例上；真正的半开会由 agent 侧读超时触发重连 → cleanup 清记录。
        // 若这里一票否决，冷启动后的第一条 exec 必然 503（原语义是当场等 pong 最多 1s 再下发）。
        const rttFresh = !lastRtt || Date.now() - lastRtt < EXEC_ROUNDTRIP_TTL_MS;
        if (!rttFresh) {
          // 记一次发送时间：不记会绕过顺风车节流，下一帧 report 立刻再补一帧 probe
          this.lastProbeAt.set(serverId, Date.now());
          try { agentWs.send(JSON.stringify({ type: 'probe', id: `p-${crypto.randomUUID()}` })); } catch { /* ignore */ }
          await this.failExecJobWithAudit(this.env, jobId, 'agent link not verified');
          return json({ error: 'agent link not verified, please retry', code: 'AGENT_OFFLINE' }, 503);
        }
      }
      // queued -> running 是条件更新：未命中说明任务已被其它路径收敛（过期/取消），不再下发
      if (!(await markJobRunning(this.env, jobId))) return json({ error: 'job not runnable' }, 409);
      try {
        agentWs.send(JSON.stringify({ type: 'exec', exec_id: jobId, command, timeout_s: Math.floor(timeoutMs / 1000) }));
      } catch {
        // 发送失败不能留下「running 但命令没发出去」
        await this.failExecJobWithAudit(this.env, jobId, 'failed to send exec command');
        return json({ error: 'failed to send exec command' }, 502);
      }
      return json({ ok: true, job_id: jobId, status: 'running' });
    }

    // 内部 RPC：异步 upload 下发（阶段 B）。
    // 只下发元数据与短期下载 URL，不读文件、不等待 Agent 落盘——字节走 R2/Worker，
    // DO 在这条链路上只承担「告诉 Agent 去哪拉」。
    if (path === '/rpc/upload/submit' && request.method === 'POST') {
      const body = await request.json();
      const jobId = String(body.jobId || '');
      const serverId = Number(body.serverId) || 0;
      const targetPath = String(body.path || '');
      const downloadUrl = String(body.downloadUrl || '');
      const size = Number(body.size) || 0;
      if (!jobId || !serverId || !targetPath || !downloadUrl) return err('bad request', 400);
      if (await this.isUpdating(serverId)) {
        await failJob(this.env, jobId, 'agent update in progress');
        return json({ error: 'agent update in progress' }, 409);
      }
      const agentWs = this.agents.get(serverId);
      if (!agentWs) {
        // 离线不停在失败态（文档 §9）：置 waiting_agent，Agent 重连时自动重发。
        // 这里不需要生成 download URL——重连重发时会重新签发（短期 URL 会过期）。
        if (!(await markUploadWaitingAgent(this.env, jobId))) {
          return json({ error: 'job not runnable' }, 409);
        }
        return json({ ok: true, job_id: jobId, status: 'waiting_agent' }, 202);
      }
      // Agent 必须支持异步拉取；旧 Agent 没有 upload_fetch_proto 时直接失败 AGENT_UPGRADE_REQUIRED（同步旧路径已删除，不再回落）
      if (!this.supportsFetch(agentWs, 'upload')) {
        await failJob(this.env, jobId, 'agent does not support async upload (upgrade required)');
        return json({ error: 'agent does not support async upload', code: 'AGENT_UPGRADE_REQUIRED' }, 409);
      }
      // staged -> waiting_agent -> running：markUploadRunning 的前置是 waiting_agent
      //（两步分开是为了让"已下发但 Agent 未响应"有独立的可观测状态）。
      if (!(await markUploadWaitingAgent(this.env, jobId))) return json({ error: 'job not runnable' }, 409);
      if (!(await markUploadRunning(this.env, jobId))) {
        await failJob(this.env, jobId, 'job not runnable');
        return json({ error: 'job not runnable' }, 409);
      }
      try {
        agentWs.send(JSON.stringify({
          type: 'upload_fetch', job_id: jobId, upload_id: jobId,
          path: targetPath, overwrite: !!body.overwrite, size, url: downloadUrl,
        }));
      } catch {
        await failJob(this.env, jobId, 'failed to send upload_fetch');
        return json({ error: 'failed to send upload_fetch' }, 502);
      }
      return json({ ok: true, job_id: jobId, status: 'running' });
    }

    // 内部 RPC：异步 agent update 下发（阶段 C）。只下发元数据 + 短期资产 URL，
    // Worker 不再在 DO 里下载并流式转发二进制。
    if (path === '/rpc/agent_update/submit' && request.method === 'POST') {
      const body = await request.json();
      const jobId = String(body.jobId || '');
      const serverId = Number(body.serverId) || 0;
      const downloadUrl = String(body.downloadUrl || '');
      if (!jobId || !serverId || !downloadUrl) return err('bad request', 400);
      // 排除本任务自身：它刚落库（queued）且未过期，不排除会被 D1 判成「另一个更新」
      if (await this.isUpdating(serverId, jobId)) {
        await failJob(this.env, jobId, 'agent update already in progress');
        return json({ error: 'agent update in progress' }, 409);
      }
      const agentWs = this.agents.get(serverId);
      if (!agentWs) {
        await failJob(this.env, jobId, 'agent offline');
        return json({ error: 'agent offline', code: 'AGENT_OFFLINE' }, 503);
      }
      if (!this.supportsFetch(agentWs, 'update')) {
        await failJob(this.env, jobId, 'agent does not support async update (upgrade required)');
        return json({ error: 'agent does not support async update', code: 'AGENT_UPGRADE_REQUIRED' }, 409);
      }
      if (!(await markUpdateRunning(this.env, jobId))) return json({ error: 'job not runnable' }, 409);
      // 内存互斥只覆盖本次更新窗口；跨实例/evict 的互斥由 D1 的部分唯一索引保证
      this.updating.set(serverId, jobId);
      try {
        agentWs.send(JSON.stringify({
          type: 'agent_update_fetch', job_id: jobId, update_id: jobId,
          url: downloadUrl, build_id: String(body.buildId || ''),
          platform: String(body.platform || ''), size: Number(body.size) || 0,
          sha256: String(body.sha256 || ''),
        }));
      } catch {
        if (this.updating.get(serverId) === jobId) this.updating.delete(serverId);
        await failJob(this.env, jobId, 'failed to send agent_update_fetch');
        return json({ error: 'failed to send agent_update_fetch' }, 502);
      }
      return json({ ok: true, job_id: jobId, status: 'running' });
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
      const tConn = Date.now(); // 埋点：握手总耗时（D1 反查 + HMAC + 建 WS + viewers 反查）
      const key = request.headers.get('x-agent-key') || '';
      if (!key) return new Response('missing agent key', { status: 401 });
      const keyId = await sha256Hex(key);
      const server = await this.env.DB.prepare('SELECT * FROM servers WHERE agent_key_id = ?').bind(keyId).first();
      if (!server) return new Response('unknown agent', { status: 401 });
      if (!(await verifySecretHash(key, server.agent_key_hash, this.env))) {
        return new Response('bad key', { status: 401 });
      }
      const tAuth = Date.now();
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
      // 附件随连接持久化：休眠唤醒后靠它重建 agents index（role 区分控制通道与会话流）
      pair[1].serializeAttachment({ role: 'control', serverId: server.id, ts: Date.now() });
      // Agent 重连 → 重发停在 waiting_agent 的 upload（文档 §9）。不等待，避免拖慢握手：
      // 先把断开期间中断的 running 退回 waiting_agent，再逐条重新签发短期 URL 下发。
      // 公网 origin 只能来自 Worker 注入的 query：这里的 url 已被 handleWs 改写成
      // https://do.internal，拿它拼下载 URL 会让 Agent 去连内网地址（DNS 必失败）。
      const panelOrigin = url.searchParams.get('panel_origin') || '';
      if (panelOrigin) {
        // await：不留下未完成的 promise（未完成 I/O 会让对象失去 hibernation 资格、持续计 duration）。
        // 代价：101 会晚于原 fire-and-forget 返回——常态 waiting 为空时是 4 次带索引 D1（几十毫秒）；
        // 队列非空时每条 job 再加一次 markUploadRunning，重连握手最坏慢到几百毫秒。可接受。
        try { await this.resendWaitingUploads(server.id, pair[1], panelOrigin); } catch { /* 失败不阻塞连接 */ }
      }
      // T1 能力来源：不在此处探活——建连时能力未知，探活失败无法安全处理（分不清旧 agent 与真断链）。
      // 改为由 agent 在上报里自声明（info.probe_proto，见 report 分支）；声明后 exec 前探活失败
      // 即可安全 close(4002)，旧 agent 不声明 → 永不探活、永不误关。
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
      const tSetup = Date.now();
      try {
        const vResp = await doPanel(this.env).fetch('https://do.internal/viewers');
        const v = await vResp.json();
        const iv = (v.count || 0) > 0 ? REPORT_FAST_INTERVAL_S : REPORT_SLOW_INTERVAL_S;
        this.applyAgentInterval(pair[1], server.id, iv);
      } catch { /* 查询失败则 agent 用自身默认间隔 */ }
      const connMs = Date.now() - tConn;
      if (connMs >= SLOW_CONN_MS) {
        this.logSlow('agent-conn', {
          sid: server.id,
          ms: connMs,
          auth: tAuth - tConn, // D1 反查 servers + HMAC 校验
          setup: tSetup - tAuth, // acceptWebSocket + 两次 D1 UPDATE（wan_ip / last_seen）
          viewers: connMs - (tSetup - tConn), // 兜底查 PanelDO /viewers
        });
      }
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
        await this.state.storage.delete('sess:' + sid).catch(() => {}); // 清理持久化会话（await：不留未完成 I/O）
        continue;
      }
      if (sess.userWs || sess.agentWs) {
        // 活跃会话也按绝对 TTL 排 alarm：确保 4h 到期时准时回收，不依赖后续 fetch/alarm 偶发触发
        next = Math.min(next, sess.createdAt + SESSION_ABS_MS);
        continue;
      }
      if (now - sess.createdAt > SESSION_TTL_MS) {
        this.sessions.delete(sid);
        await this.state.storage.delete('sess:' + sid).catch(() => {}); // 清理持久化会话（await：不留未完成 I/O）
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

  // open_terminal/open_file 确认重发：下发后 OPEN_ACK_RETRY_MS（3s）未收到 agent 的 *_ready 则重发，最多 3 次
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
      if (r.tries < 3) r.timer = setTimeout(retry, OPEN_ACK_RETRY_MS);
      else this.pendingOpen.delete(streamId); // 3 次后放弃（前端有自愈兜底）
    };
    rec.timer = setTimeout(retry, OPEN_ACK_RETRY_MS);
  }

  // Hibernation：DO 实例空闲冻结后，WebSocket 连接由 workerd 托管持久，但本类
  // 实例的 sessions/agents 内存 Map 会随冻结全部丢失。附件（serializeAttachment）
  // 随连接持久化，唤醒后据此重建索引，避免误判 "agent offline" / "session not found"。
  // 本实例只在唤醒后重建一次（this.rebuilt）：既避免每次消息 O(N) 遍历，也不会因
  // 「某个 Map 恰好为空」而反复重建——后者会把已 close（半开残留）的会话/控制连接从
  // 附件里复活（如 drop_server 后 sessions 已清、socket 仍在 getWebSockets 的窗口）。
  // 运行期索引由各 handler 维护；死连接由入站消息（A）覆盖、同 serverId 多余连接在此关闭。
  rebuildIndex() {
    if (this.rebuilt) return;
    this.rebuilt = true;
    const socks = this.state.getWebSockets?.() || [];
    for (const ws of socks) {
      const att = ws.deserializeAttachment();
      if (att === null || att === undefined) continue;
      if (typeof att === 'string') {
        // 兼容旧格式：控制通道附件为 String(server.id)
        const serverId = Number(att);
        if (Number.isInteger(serverId) && serverId > 0) {
          const prev = this.agents.get(serverId);
          if (prev && prev !== ws) { try { prev.close(4001, 'superseded on rebuild'); } catch { /* ignore */ } }
          this.agents.set(serverId, ws);
        }
        continue;
      }
      if (typeof att !== 'object') continue;
      if (att.role === 'control') {
        const sid = Number(att.serverId);
        if (sid > 0) {
          // caps 随连接附件恢复：supportsFetch 读的就是它，漏恢复会让 evict 后的异步任务被判
          // "不支持异步"而永久失败（agent 明明支持）。
          // 同 serverId 多条控制连接（冻结唤醒后旧半开连接与新连接并存）：保留最新（ts 最大）
          // 者、关闭其余，收敛到「一服务器一活连接」，避免 exec/更新发往死连接。
          const prev = this.agents.get(sid);
          if (prev && prev !== ws && this.wsAttTs(prev) > (Number(att.ts) || 0)) {
            try { ws.close(4001, 'superseded on rebuild'); } catch { /* ignore */ }
          } else {
            if (prev && prev !== ws) { try { prev.close(4001, 'superseded on rebuild'); } catch { /* ignore */ } }
            this.agents.set(sid, ws);
            // 上报间隔随附件恢复，且只跟随胜出的连接：旧半开连接的旧值不能覆盖新连接，
            // 否则 evict 后会按错误间隔上报（快慢采错档直接放大或浪费配额）。
            if (att.interval === REPORT_FAST_INTERVAL_S || att.interval === REPORT_SLOW_INTERVAL_S) {
              this.agentInterval.set(sid, att.interval);
            } else {
              // 与 probe 同理，必须主动撤销：前面遍历到的旧连接可能已 set 过快采 5s，
              // 而 syncAgentInterval 以「内存已有」为短路条件，残留值会一直生效（请求放大 24 倍）
              // 且永远不会自我修正，直到该控制连接断开。
              this.agentInterval.delete(sid);
            }
            // 最近一次往返时间也随附件恢复：冷启动后 exec 判据能拿到真实时间戳，
            // 而不是落进"无记录"分支（那会退化成无条件信任）。胜出连接没有记录时同样撤销，
            // 否则会拿旧连接的时间戳判「有过期记录 → 503」，而乐观放行才是对的。
            if (att.rtt) this.lastRoundTripAt.set(sid, Number(att.rtt) || 0);
            else this.lastRoundTripAt.delete(sid);
            // 探活能力同样只跟随胜出连接，且必须双向同步：旧半开连接的 probe=true 不能复活能力
            // （agent 回滚到不支持 probe 的版本后，会被持续发探测帧、pong 不回，rtt 过期 → exec 误 503）；
            // 胜出连接没有 probe 标记时还要主动撤销，否则上一轮 add 的结果会残留。
            if (att.probe) this.probeCapable.add(sid);
            else this.probeCapable.delete(sid);
          }
        }
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
    const att = ws.deserializeAttachment?.();
    if (att === null || att === undefined) return 0;
    if (typeof att === 'string') return Number(att) || 0;
    if (typeof att === 'object') return Number(att.serverId) || 0;
    return 0;
  }

  // 控制连接附件的建立时间戳：唤醒重建时同 serverId 多条连接取最新者（旧格式无 ts 记 0）
  wsAttTs(ws) {
    try {
      const att = ws.deserializeAttachment?.();
      if (att && typeof att === 'object') return Number(att.ts) || 0;
    } catch { /* ignore */ }
    return 0;
  }

  // 记录一次有效往返（pong / exec_result），并把时间戳写进连接附件。
  // 内存 Map 会随 evict 丢失、附件不会——这样冷启动后 exec 判据仍能拿到"最近一次往返时间"，
  // 而不是只能靠"无记录即乐观放行"兜底。
  markRoundTrip(ws, serverId) {
    const now = Date.now();
    this.lastRoundTripAt.set(serverId, now);
    try {
      const a = ws.deserializeAttachment?.();
      if (a && typeof a === 'object' && a.role === 'control') {
        ws.serializeAttachment({ ...a, rtt: now });
      }
    } catch { /* 附件写失败退化为纯内存，冷启动走乐观放行 */ }
  }

  // 标记该 serverId 支持探活，并把能力写进连接附件：唤醒重建时据此恢复 probeCapable
  // （serializeAttachment 为本地序列化，零网络/存储开销）。能力来源：agent 自声明（report 的
  // info.probe_proto）或探活成功（pong）。
  markProbeCapable(ws, serverId) {
    this.probeCapable.add(serverId);
    try {
      const a = ws.deserializeAttachment?.();
      // 已标过就跳过：pong 路径紧邻 markRoundTrip（附件刚写过一次），
      // 常态下只需一次序列化，仅首次 pong 走两次。
      if (a && typeof a === 'object' && a.role === 'control' && a.probe !== true) {
        ws.serializeAttachment({ ...a, probe: true });
      }
    } catch { /* ignore */ }
  }

  // 清除探活能力（agent 降级/回滚后不再声明 probe_proto）：同时去掉附件标记，
  // 否则 evict 后 rebuildIndex 会从附件恢复能力 → 对旧 agent 探活 → 1s 超时 → 误关。
  clearProbeCapable(ws, serverId) {
    this.probeCapable.delete(serverId);
    this.lastRoundTripAt.delete(serverId);
    this.lastProbeAt.delete(serverId);
    try {
      const a = ws.deserializeAttachment?.();
      if (a && typeof a === 'object' && a.role === 'control' && (a.probe || a.rtt)) {
        const next = { ...a };
        delete next.probe;
        // 与内存一致：能力撤销即作废往返记录，否则 evict 后 rebuildIndex 会把陈旧 rtt 复活
        delete next.rtt;
        ws.serializeAttachment(next);
      }
    } catch { /* ignore */ }
  }

  // 记录异步拉取能力到连接附件（evict 后 rebuildIndex 据此恢复）。
  // 只在值变化时写，避免每帧上报都 serializeAttachment。
  markFetchCapable(ws, caps) {
    try {
      const a = ws.deserializeAttachment?.();
      if (!a || typeof a !== 'object' || a.role !== 'control') return;
      const cur = a.caps || {};
      if (Number(cur.upload_fetch_proto) === caps.upload_fetch_proto
        && Number(cur.update_fetch_proto) === caps.update_fetch_proto) return;
      ws.serializeAttachment({ ...a, caps });
    } catch { /* ignore */ }
  }

  // Hibernation：消息转发（双向对拷 + resize 走控制通道）
  async webSocketMessage(ws, message) {
    const coldStart = !this.rebuilt; // 本条消息是否触发实例冷重建（evict 后首条，成本最高）
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
          // A：入站即存活。控制通道来消息说明该连接仍活，用它刷新 agents 索引，天然淘汰
          // 「唤醒后可能被 rebuildIndex 选中的半开死连接」（0 额外消息/请求）。
          // 仅认控制附件，避免会话流失配时把数据流 WS 误登记为控制通道。
          if (att && (typeof att === 'string' || att.role === 'control')) {
            const cid = this.wsServerId(ws);
            if (cid) this.agents.set(cid, ws);
          }
          // 探活回执：证明该控制连接双向可用（与 exec_result 同等效力）。
          // 不再按 id 关联 Promise（已无等待方）——无条件按连接归属刷新，供 exec 判据使用。
          if (j && j.type === 'pong') {
            const sid = this.wsServerId(ws);
            if (sid) {
              this.markRoundTrip(ws, sid); // 同时写附件：evict 后 exec 判据仍拿得到时间戳
              this.markProbeCapable(ws, sid);
            }
            return;
          }
          if (j && (j.type === 'terminal_ready' || j.type === 'file_ready')) {
            // agent 已收到 open_terminal/open_file 并开始启动 → 停止确认重发（file_ready 补齐）
            const r = this.pendingOpen.get(j.stream_id);
            if (r && r.timer) clearTimeout(r.timer);
            this.pendingOpen.delete(j.stream_id);
            return;
          }
          if (j && j.type === 'exec_result') {
            // 成功回执即最强双向存活证明 → 刷新往返时间，使后续 exec 走快路径（零新增延迟）
            const esid = this.wsServerId(ws);
            if (esid) this.markRoundTrip(ws, esid);
            // 异步路径：终态落 D1 + 写审计。本条消息可能唤醒的是一台刚 evict 的 DO，
            // 状态全部来自 D1/job 行，不依赖内存 Map——这正是异步化的核心验收点。
            if (String(j.exec_id || '').startsWith('job_')) await this.settleExecJob(j.exec_id, j);
            return;
          }
          if (j && j.type === 'upload_result') {
            // 异步路径：job_ 前缀的 upload_id。只有 commit 回执才是"文件已落地"，
            // 非 commit 帧的 ok:true 只表示"该块已写入临时文件"，不能当终态。
            if (String(j.upload_id || '').startsWith('job_') && (j.commit === true || !j.ok)) {
              await this.settleUploadJob(j.upload_id, j);
            }
            return;
          }
          if (j && j.type === 'agent_update_result') {
            // 异步路径：job_ 前缀。回执到达即终态（成功=self-replace 完成）。
            if (String(j.update_id || '').startsWith('job_')) await this.settleUpdateJob(j.update_id, j);
            return;
          }
          if (j && j.type === 'report') {
            const serverId = this.wsServerId(ws);
            const tReport = Date.now(); // 埋点：整条上报耗时（消息到达 → 落库 + 转发完成）
            const timing = {};
            // ② 能力门控：agent 自声明支持探活（info.probe_proto，随上报免费到达）才启用 exec 前探活。
            // 旧 agent 不报该字段 → 永不探活、永不误关；声明后探活失败必为真断链 → 可安全 close(4002)。
            // 已登记则跳过（避免每帧都序列化附件）；evict 后由附件恢复，故仅在丢失时重写。
            // 反向：info 存在但不含 probe_proto（agent 降级/回滚）→ 主动清除，否则残留能力会在
            // evict 后从附件恢复，对不支持探活的旧 agent 发 probe → 1s 超时 → 误关。
            if (serverId && j.info) {
              const declared = Number(j.info.probe_proto) >= 1;
              if (declared && !this.probeCapable.has(serverId)) this.markProbeCapable(ws, serverId);
              else if (!declared && this.probeCapable.has(serverId)) this.clearProbeCapable(ws, serverId);
              // 异步拉取能力（阶段 B/C）：同样随上报到达，写进附件以便 evict 后恢复。
              // 旧 Agent 不声明 → supportsFetch 返回 false → 下发前明确拒绝（AGENT_UPGRADE_REQUIRED），
              // 不会出现"帧发出去但对方不认识，干等 deadline"。
              this.markFetchCapable(ws, {
                upload_fetch_proto: Number(j.info.upload_fetch_proto) || 0,
                update_fetch_proto: Number(j.info.update_fetch_proto) || 0,
              });
            }
            // E：保活心跳先于上报落库发送（30s 限频）。agent 端 read -t 180 只依赖下行流量，
            // 不能因 handleReport 抛错（D1 配额/写入失败）而连带停发心跳 → 误判半开 → 重连循环。
            if (serverId) {
              const nowP = Date.now();
              const lastP = this.lastPingAt.get(serverId) || 0;
              if (nowP - lastP > 30000) {
                this.lastPingAt.set(serverId, nowP);
                try { ws.send(JSON.stringify({ type: 'ping' })); } catch { /* ignore */ }
              }
              // 顺风车探活：report 本身只证明上行通，这里补一个下行探测帧（出站不计费），
              // agent 回 pong 后刷新 lastRoundTripAt —— exec 判据因此始终新鲜，无需当场等待回执。
              // 没有等待方，所以不需要 pending 表，也不产生 setTimeout。
              if (this.probeCapable.has(serverId) && nowP - (this.lastProbeAt.get(serverId) || 0) > PROBE_REFRESH_MS) {
                this.lastProbeAt.set(serverId, nowP);
                try { ws.send(JSON.stringify({ type: 'probe', id: `p-${crypto.randomUUID()}` })); } catch { /* ignore */ }
              }
            }
            try {
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
                }, timing);
                await this.syncAgentInterval(ws, serverId, timing);
              }
            } catch (e) { console.error('handleReport failed:', e); }
            // 慢上报埋点：把总耗时拆成 D1 行读 / D1 写 / DO 间转发 / 兜底查观看者数，
            // 用来区分「D1 慢」「MetricsDO 慢」「实例冷启动」三种完全不同的根因。
            const reportMs = Date.now() - tReport;
            if (serverId && reportMs >= SLOW_REPORT_MS) {
              this.logSlow('report', {
                sid: serverId,
                ms: reportMs,
                cold: coldStart ? 1 : 0, // 1 = 这条消息触发了实例重建（evict 后首条）
                row: timing.row ?? null, // D1 读 servers 行
                rowHit: timing.rowHit ?? null, // 1 = 行缓存命中，0 = 回查 D1
                d1: timing.d1 ?? null, // 其余 D1 写（探活/自定义指标/last_seen）
                fwd: timing.fwd ?? null, // DO→DO fetch 到 MetricsDO（/report）
                flushed: timing.flushed ?? 0, // 本条是否触发批量转发（5s 节流）
                viewers: timing.viewers ?? null, // 兜底查 PanelDO /viewers（agentInterval 缺失时）
              });
            }
          }
        } catch { /* 忽略非 JSON 的控制消息 */ }
      }
      return;
    }

    if (ws === sess.userWs) {
      if (sess.revoked) return; // 已判定失效：丢弃后续流量，等 cleanup 收尾
      if (this.authRecheckDue(sess) && (await this.revalidateOrRevoke(sess, ws))) return;
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
      if (sess.revoked) return; // 已判定失效：不再向浏览器投递
      // agent → DO → 浏览器（纯字节透传）
      // 输出方向同样重校验：降权/撤销后若用户不再发消息，只看输入方向就会让旧连接持续
      // 收到终端回显、文件读取结果等敏感内容（10s 节流，窗口内无额外查询）。
      if (sess.userWs) {
        if (this.authRecheckDue(sess) && (await this.revalidateOrRevoke(sess, sess.userWs))) return;
        sess.userWs.send(message);
      } else if (sess.userBuf && sess.userBuf.length < 128) {
        // 浏览器尚未鉴权挂接：缓冲首屏输出（如 bash 初始提示符），避免被丢弃
        sess.userBuf.push(message);
      }
    }
  }

  // Agent 重连后重发停在 waiting_agent 的上传（文档 §9）。
  // 短期 download URL 会过期，因此必须**重新签发**，不能复用建任务时的那条。
  // baseUrl 取自本次连接的请求 origin（DO 侧拿不到外部 host，由调用方传入）。
  // 传给 Agent 的 URL 必须是**公网**地址：Agent 侧会直接按 host 建连。
  // 内部改写后的 do.internal 不可达（DNS 解析失败），这里做一次显式拦截——
  // 静默发出错误 URL 的后果是"等到 deadline 超时"，排查成本极高。
  static isPublicOrigin(base) {
    try {
      const h = new URL(base).hostname;
      return h !== 'do.internal' && h !== 'localhost' && !h.endsWith('.internal');
    } catch {
      return false;
    }
  }

  // 把该服务器已过 deadline 的 waiting_agent 收敛为 expired 并删暂存件。
  // 这些任务既不该重发（旧包会延迟覆盖生产文件），也不该永久占着 waiting_agent。
  async settleExpiredWaitingUploads(serverId) {
    const now = Math.floor(Date.now() / 1000);
    const stale = await this.env.DB.prepare(
      `SELECT id, kind, r2_key FROM operation_jobs
        WHERE server_id = ? AND kind = 'upload' AND status = 'waiting_agent' AND deadline_at <= ?`
    ).bind(serverId, now).all();
    for (const job of stale.results || []) {
      const res = await this.env.DB.prepare(
        `UPDATE operation_jobs SET status = 'expired', error = COALESCE(error, 'no result before deadline'),
                finished_at = ?, duration_ms = CASE WHEN started_at IS NULL THEN NULL ELSE (? - started_at) * 1000 END
          WHERE id = ? AND status = 'waiting_agent'`
      ).bind(now, now, job.id).run();
      if (!res.meta.changes) continue;
      try {
        if (job.r2_key) await this.env.UPLOADS.delete(job.r2_key);
      } catch { /* 删除失败由 cron 兜底 */ }
    }
  }

  async resendWaitingUploads(serverId, ws, baseUrl) {
    if (!TerminalDO.isPublicOrigin(baseUrl)) {
      console.error(`resendWaitingUploads skipped: non-public origin "${baseUrl}"`);
      return;
    }
    // 更新期间不下发上传：Agent 正在 self-replace，此时发 upload_fetch 会与升级竞争。
    // 首次下发路径查了同样的互斥（/rpc/upload/submit），重发路径必须一致。
    // 任务留在 waiting_agent，更新结束后的下一次重连会再试。
    if (await this.isUpdating(serverId)) return;
    // 先收敛：断开期间处于 running 的 upload 不可能再收到回执
    await requeueOrphanUploads(this.env, serverId);
    // 已过 deadline 的 waiting_agent 不再重发（否则旧包会延迟覆盖生产文件），
    // 但也不能让它永远停在 waiting_agent —— 顺手收敛为 expired 并清暂存件。
    await this.settleExpiredWaitingUploads(serverId);
    const waiting = await listWaitingUploads(this.env, serverId);
    // 能力校验与首次下发同源：积压的旧 Agent 任务不能直接发 upload_fetch（对方不认识）
    const capable = this.supportsFetch(ws, 'upload');
    for (const job of waiting) {
      if (this.agents.get(serverId) !== ws) return; // 期间连接又被替换：交给新一轮处理
      if (!job.r2_key) {
        await failJob(this.env, job.id, 'staged object missing');
        continue;
      }
      if (!capable) {
        await failJob(this.env, job.id, 'agent does not support async upload (upgrade required)');
        continue;
      }
      if (!(await markUploadRunning(this.env, job.id))) continue; // 已被其它路径收敛
      const size = Number(job.size_bytes) || 0;
      const token = await signJobToken('download', job.id, serverId, String(size), this.env, JOB_URL_TTL_S);
      const url = `${baseUrl}/mcp/upload-jobs/download?id=${job.id}&server_id=${serverId}&size=${size}&token=${encodeURIComponent(token)}`;
      try {
        ws.send(JSON.stringify({
          type: 'upload_fetch', job_id: job.id, upload_id: job.id,
          path: job.target_path, overwrite: !!job.overwrite, size, url,
        }));
      } catch {
        await failJob(this.env, job.id, 'failed to resend upload_fetch');
      }
    }
  }

  // 省配额策略：观看者数变化由 PanelDO 事件驱动（/rpc/set_viewers 更新 agentInterval 并广播），
  // 上报时仅读内存（0 个 DO 调用）。内存丢失（实例 evict）时**先读连接附件**——附件随连接存活，
  // 读它零请求；只有附件也没有（升级前的老连接）才查 /viewers 兜底。
  async syncAgentInterval(ws, serverId, timing) {
    if (this.agentInterval.has(serverId)) return; // 事件驱动已维护
    const att = ws.deserializeAttachment?.();
    const cached = Number(att && typeof att === 'object' ? att.interval : 0);
    if (cached === REPORT_FAST_INTERVAL_S || cached === REPORT_SLOW_INTERVAL_S) {
      // 附件命中：agent 侧本来就知道这个间隔，无需重发，也不产生任何 DO 调用
      this.agentInterval.set(serverId, cached);
      return;
    }
    const tViewers = Date.now();
    let want = REPORT_SLOW_INTERVAL_S;
    try {
      const resp = await doPanel(this.env).fetch('https://do.internal/viewers');
      const v = await resp.json();
      want = (v.count || 0) > 0 ? REPORT_FAST_INTERVAL_S : REPORT_SLOW_INTERVAL_S;
    } catch { /* 兜底慢采 */ }
    if (timing) timing.viewers = Date.now() - tViewers;
    this.applyAgentInterval(ws, serverId, want);
  }

  // 下发上报间隔：更新内存 + 发帧 + 写进连接附件。
  // 附件随连接持久化，实例 evict 后内存 Map 清空也能零请求恢复（原实现每条消息都要
  // 查一次 PanelDO /viewers，实测占 PanelDO 请求的八成以上）。
  applyAgentInterval(ws, serverId, interval) {
    this.agentInterval.set(serverId, interval);
    try { ws.send(JSON.stringify({ type: 'set_report_interval', interval })); } catch { /* ignore */ }
    try {
      const a = ws.deserializeAttachment?.();
      if (a && typeof a === 'object' && a.role === 'control' && a.interval !== interval) {
        ws.serializeAttachment({ ...a, interval });
      }
    } catch { /* 附件写失败只影响 evict 后省下的那次查询 */ }
  }

  // Agent 能力查询：异步拉取能力由 report 的 info 携带（upload_fetch_proto / update_fetch_proto），
  // 与 probe_proto 同样的"能力随上报免费到达"范式。旧 Agent 不声明 → 明确拒绝而不是静默降级，
  // 否则会下发它不认识的帧，最终只能在 deadline 上超时。
  supportsFetch(ws, kind) {
    const att = ws.deserializeAttachment?.() || {};
    const cap = att.caps || {};
    if (kind === 'upload') return Number(cap.upload_fetch_proto) >= 1;
    if (kind === 'update') return Number(cap.update_fetch_proto) >= 1;
    return false;
  }

  // exec 的失败路径统一收口：标 failed + 写审计。
  // 旧同步路径在"Agent 离线/下发失败/断连/超时"时都会写一条 exec.command，
  // 异步化后只在 settleExecJob（收到 exec_result）写，其余路径全部无痕——
  // 对最高权限的写操作来说这是审计回退。这里补 exec.command.failed，
  // 保留"谁在何时试图在哪台机器跑什么"的痕迹（文档 §12.2 允许 *.failed 留痕）。
  async failExecJobWithAudit(env, jobId, reason) {
    // failJob 返回布尔（是否命中条件更新），不是行对象——这里必须自己回读一次才能拿到
    // command/user_id 等审计所需字段。
    const changed = await failJob(env, jobId, reason);
    if (!changed) return null;
    const job = await getJob(env, jobId);
    if (!job) return null;
    const cmd = String(job.command || '');
    const commandTrunc = cmd.length > 180 ? `${cmd.slice(0, 180)}…` : cmd;
    try {
      await env.DB.prepare(
        'INSERT INTO audit_logs (user_id, username, client_ip, action, target_server_id, detail, duration_ms, job_id) VALUES (?,?,?,?,?,?,?,?)'
      ).bind(
        job.user_id, job.username, job.client_ip || '', 'exec.command.failed', job.server_id,
        `exit=? (${reason}) ${commandTrunc}`,
        job.duration_ms ?? null, jobId,
      ).run();
    } catch (e) { console.error('exec failed audit failed:', e); }
    return job;
  }

  // upload_result → D1 终态 + 审计（异步路径）。
  // 成功即删 R2 staging 对象：任务已落地，暂存件没有保留价值（也避免占满 10GB 额度）。
  async settleUploadJob(jobId, j) {
    let ok = !!j.ok;
    let errMsg = j.error || null;
    // 回执 size 必须与 staged 时的实际字节一致：下载被截断（网络中断）时 Agent 侧
    // 若没拦住，会在目标位置留下短文件却报 ok。两道校验（Agent 侧 fetch + 这里）。
    const row = await getJob(this.env, jobId);
    if (ok && row && typeof j.size === 'number' && Number(row.size_bytes) > 0
        && j.size !== Number(row.size_bytes)) {
      ok = false;
      errMsg = `size mismatch: agent wrote ${j.size}, staged ${row.size_bytes}`;
    }
    // 迟到回执：任务此前已被判 expired，但 Agent 现在才回报结果。此时仍要落库——
    // 文件很可能真的落盘了，继续显示 expired 会与磁盘实际不符（用户看到失败，
    // 实际文件已经在那了）。保留"曾判过期"的事实到 error 里，便于排查。
    const wasExpired = !!row && row.status === 'expired';
    const finalErr = wasExpired
      ? `late result after expiry (expired at ${row.deadline_at}s, deadline passed without result)${errMsg ? `; ${errMsg}` : ''}`
      : errMsg;
    const job = await finishUploadJob(this.env, jobId, { ok, error: finalErr });
    if (!job) return;
    if (job.r2_key) {
      try { await this.env.UPLOADS.delete(job.r2_key); } catch { /* 删除失败由 cron 兜底 */ }
    }
    // file.upload 审计改在"Agent 成功 commit 后"写（旧实现在签发 URL 时就写，
    // 把"请求上传"当成了"文件已落地"）。请求阶段另有 file.upload.request。
    // 迟到回执同样要写审计——否则这次上传在审计里完全消失。
    try {
      await this.env.DB.prepare(
        'INSERT INTO audit_logs (user_id, username, client_ip, action, target_server_id, detail, duration_ms, job_id) VALUES (?,?,?,?,?,?,?,?)'
      ).bind(
        job.user_id, job.username, job.client_ip || '',
        ok ? 'file.upload' : 'file.upload.failed',
        job.server_id,
        `${String(job.target_path || '').slice(0, 180)}${wasExpired ? ' [late]' : ''}`,
        job.duration_ms ?? null, jobId,
      ).run();
    } catch (e) { console.error('upload audit failed:', e); }
  }

  // agent_update_result → D1 终态 + 审计（异步路径）
  async settleUpdateJob(jobId, j) {
    let ok = !!j.ok;
    let errMsg = j.error || null;
    // 回执校验（文档 §8.6.3）：乱序或伪造回执可能把错误资产标成成功。
    // build_id 必须与任务记录的 to_version 一致；声明了 size 时也必须一致。
    const row = await getJob(this.env, jobId);
    if (ok && row) {
      if (j.build_id && row.build_id && String(j.build_id) !== String(row.build_id)) {
        ok = false;
        errMsg = `build mismatch: agent reported ${j.build_id}, expected ${row.build_id}`;
      } else if (typeof j.size === 'number' && row.size_bytes && j.size !== Number(row.size_bytes)) {
        ok = false;
        errMsg = `size mismatch: agent reported ${j.size}, expected ${row.size_bytes}`;
      }
    }
    // 迟到回执：任务曾判 expired，Agent 现在才回报。纠正状态但保留"曾判过期"的痕迹，
    // 否则事后复理会以为是首次成功（与 settleUploadJob 同款处理）。
    const wasExpired = !!row && row.status === 'expired';
    const finalErr = wasExpired
      ? `late result after expiry (expired at ${row.deadline_at}s)${errMsg ? `; ${errMsg}` : ''}`
      : errMsg;
    const job = await finishUpdateJob(this.env, jobId, { ok, error: finalErr });
    // 无论成功失败都要释放内存互斥：updating 只在 send 抛错时清过，
    // 成功后不清会让这台机器在本 DO 实例存活期内再也无法 exec/upload（反复 409）。
    // 必须校验 jobId：旧任务（曾判过期）的迟到回执不能清掉新任务的标记，否则两者会交错。
    const sid = job ? job.server_id : (row ? row.server_id : 0);
    if (sid && this.updating.get(sid) === jobId) this.updating.delete(sid);
    if (!job) return;
    try {
      await this.env.DB.prepare(
        'INSERT INTO audit_logs (user_id, username, client_ip, action, target_server_id, detail, duration_ms, job_id) VALUES (?,?,?,?,?,?,?,?)'
      ).bind(
        // 与同步路径、前端映射表保持同一命名：agent.update.installed / .failed。
        // 少了 .installed 会在审计页显示成裸的 agent.update（前端无对应翻译 key）。
        job.user_id, job.username, job.client_ip || '', ok ? 'agent.update.installed' : 'agent.update.failed',
        job.server_id, `${job.from_version || '?'} → ${job.build_id || '?'}${wasExpired ? ' [late]' : ''}${ok ? '' : ` (${finalErr || 'failed'})`}`,
        job.duration_ms ?? null, jobId,
      ).run();
    } catch (e) { console.error('agent update audit failed:', e); }
  }

  // exec_result → D1 终态 + 审计（异步路径）。
  // 条件更新未命中说明是重复回执或任务已判过期：只记日志，不覆盖终态、不重复审计。
  async settleExecJob(jobId, j) {
    const row = await getJob(this.env, jobId);
    // 迟到回执尤其重要：命令可能真的执行了（systemctl restart 之类），报 expired 会
    // 让调用方误判为"没执行"而重试 → 重复执行。纠正状态，但用 [late] 留下曾判过期的痕迹，
    // 否则事后复理会以为首次就成功。
    const wasExpired = !!row && row.status === 'expired';
    // ⚠️ finishExecJob 用 `error ? 'failed' : 'succeeded'` 判状态，所以"迟到"这个纯标注
    // **不能**塞进 error —— 否则一次成功的迟到回执会被判成 failed。这里只把真实的
    // j.error 交给它决定状态，迟到信息写进 stderr（不参与状态判定、但会展示给调用方）。
    const realErr = j.error || null;
    const lateNote = wasExpired
      ? `[late] result arrived after the job was marked expired (deadline ${row.deadline_at}s)\n`
      : '';
    const job = await finishExecJob(this.env, jobId, {
      exitCode: typeof j.exit_code === 'number' ? j.exit_code : null,
      stdout: typeof j.stdout === 'string' ? j.stdout : '',
      stderr: `${lateNote}${typeof j.stderr === 'string' ? j.stderr : ''}`,
      timedOut: !!j.timed_out,
      error: realErr,
    });
    if (!job) return;
    // 审计与旧同步路径同格式（exit=.. + 截断命令），额外带 duration_ms / job_id 便于关联任务
    const cmd = String(job.command || '');
    const commandTrunc = cmd.length > 190 ? `${cmd.slice(0, 190)}…` : cmd;
    const lateTag = wasExpired ? ' [late]' : '';
    const failTag = job.status === 'failed' || job.status === 'timed_out' ? ` (${job.status})` : '';
    try {
      await this.env.DB.prepare(
        'INSERT INTO audit_logs (user_id, username, client_ip, action, target_server_id, detail, duration_ms, job_id) VALUES (?,?,?,?,?,?,?,?)'
      ).bind(
        job.user_id, job.username, job.client_ip || '', 'exec.command', job.server_id,
        `exit=${typeof job.exit_code === 'number' ? job.exit_code : '?'}${lateTag}${failTag} ${commandTrunc}`,
        job.duration_ms ?? null, jobId,
      ).run();
    } catch (e) { console.error('exec audit failed:', e); }
  }

  // 会话鉴权重校验的节流判据（10s）：窗口内为纯同步判断，不产生 D1 读
  authRecheckDue(sess) {
    return !sess.lastAuthCheck || Date.now() - sess.lastAuthCheck >= PAT_CHECK_INTERVAL_MS;
  }

  // 按「当前」身份重新授权已建会话。返回 true = 已失效（调用方须停止本轮转发）。
  // **双向**共用：只看浏览器→agent 方向是不够的——用户停手不发消息时，降权/撤销后的旧连接
  // 仍会持续收到 agent 输出（终端回显、文件读取结果），连接也不会被关闭。
  // 判据与建连同源（routes 的 /api/terminal、/api/file/open 都用 canExec）；管理员不查库。
  async revalidateOrRevoke(sess, ws) {
    if (sess.revoked) return true;
    let att = ws.deserializeAttachment?.();
    let identity = att && att.auth;
    // 旧版本 patToken 附件：首次活动时校验并原地迁移，避免在线升级强制中断会话
    if (!identity && att && att.patToken) {
      const migrated = await authIdentityByToken(att.patToken, this.env);
      if (!migrated) return this.revokeSession(sess, ws, 'unauthorized');
      const { patToken: _discard, ...safe } = att;
      safe.auth = migrated.identity;
      ws.serializeAttachment(safe);
      identity = safe.auth;
    }
    if (!identity) return false; // 无身份信息（升级前的旧会话）：沿用既有行为
    sess.lastAuthCheck = Date.now();
    const u = await authUserByIdentity(identity, this.env);
    if (!u) return this.revokeSession(sess, ws, 'unauthorized');
    // 降权/白名单收窄必须收回已建会话：撤掉 server:exec 或收窄 server_ids 后，
    // 旧连接不得再转发输入、也不得再接收输出（PATCH 只清了 PanelDO 缓存，管不到本 DO）。
    if (!isAdmin(u)) {
      const server = await this.env.DB
        .prepare('SELECT id, user_id FROM servers WHERE id = ?')
        .bind(sess.serverId)
        .first();
      if (!server || !canExec(u, server)) return this.revokeSession(sess, ws, 'permission revoked');
    }
    return false;
  }

  // 标记会话失效并关闭浏览器端连接：revoked 让后续双向流量立即短路（等 cleanup 收尾）
  revokeSession(sess, ws, reason) {
    sess.revoked = true;
    try { ws.close(1008, reason); } catch { /* ignore */ }
    return true;
  }

  async webSocketClose(ws) {
    this.rebuildIndex(); // 确保索引完整后再清理，否则休眠唤醒后的断连无法正确解除
    await this.cleanup(ws);
  }
  async webSocketError(ws) {
    this.rebuildIndex();
    await this.cleanup(ws);
  }

  // async：内部有 storage 删除与 D1 收敛，必须等它们结束——否则会留下未完成的 promise，
  // 让对象在断连后失去 hibernation 资格、持续计 duration。
  async cleanup(ws) {
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
        await this.state.storage.delete('sess:' + sid).catch(() => {}); // 清理持久化会话（await：不留未完成 I/O）
      }
    }
    // serverId 的定位不能只靠 map 值相等：重连时新连接会先把旧连接 close(4001) 再把
    // agents 指向新连接，而 webSocketClose 是异步到达的——届时 agents.get(sid) === ws2 ≠ ws1，
    // 整个分支被跳过，updating 永不释放（该机器在本实例存活期内永久 409）、
    // settleJobsOnDisconnect 也不执行（exec/update 要等 deadline 才收敛）。
    //
    // 兜底用连接附件里的 serverId，但**必须先限定 role**：cleanup 是所有 WS 关闭的统一入口，
    // 而会话流（role 'user'/'agent'）的附件同样带 serverId。不区分角色就会在用户关闭
    // 终端页时误清该机的 updating/probeCapable——实测后果是"更新期间能新建终端会话"，
    // 等于把 f81635d 修的互斥又开了一个口子。
    // typeof att === 'string' 那支要保留：rebuildIndex 兼容旧格式（附件直接存 serverId）。
    const att = ws.deserializeAttachment?.();
    const isControlAttachment = typeof att === 'string' || (att && att.role === 'control');
    const attServerId = isControlAttachment ? this.wsServerId(ws) : 0;
    const matched = [];
    for (const [serverId, w] of this.agents) {
      if (w === ws) matched.push(serverId);
    }
    // 被顶替的旧连接：agents 已指向新连接，只能靠附件认出"这个 ws 属于哪台服务器"
    if (!matched.length && attServerId) matched.push(attServerId);
    for (const serverId of matched) {
      const isCurrent = this.agents.get(serverId) === ws;
      // 被顶替的旧连接（isCurrent=false）不删 agents / agentInterval / lastRoundTripAt /
      // lastProbeAt / probeCapable：新连接正持有同一 serverId，这些值属于它。
      // 在途异步任务的状态全在 D1（不在内存 Promise 里），顶替连接不影响它们，
      // 不会让明明还在跑的请求收到假的"agent disconnected"。
      if (isCurrent) {
        this.agents.delete(serverId);
        // 断连即失效：新连接建连时会重新下发间隔并写进附件，旧值留着反而会让
        // 下一帧跳过 syncAgentInterval 而按过期档位上报（快慢采错档）。
        this.agentInterval.delete(serverId);
        // 控制连接已断 → 仅清理该 agent（serverId）的待确认，不影响其他服务器/会话
        for (const [sid, r] of [...this.pendingOpen]) {
          if (r.serverId === serverId) {
            if (r.timer) clearTimeout(r.timer);
            this.pendingOpen.delete(sid);
          }
        }
        // 连接级状态只在真正断开时清：被顶替说明新连接已接管，这些值属于新连接，
        // 无条件清会让刚登记的探活能力/往返记录丢失（退化为乐观放行，最长 120s 后才由下一帧 report 恢复）。
        this.lastRoundTripAt.delete(serverId);
        this.lastProbeAt.delete(serverId);
        this.probeCapable.delete(serverId);
      }
      // 更新互斥与连接无关：被顶替的旧连接也要释放，否则该机器在本实例存活期内一直 409
      //（更新进程已随连接丢失，D1 侧已终态，纯内存泄漏）
      this.updating.delete(serverId);
      // D1 收敛只对"真正的断开"做：被顶替的旧连接说明 Agent 已重连、任务还在新连接上跑，
      // 此时判 failed 会误杀正在进行的命令。upload 一律交给重连时的 requeueOrphanUploads。
      if (isCurrent) {
        // await：D1 收敛不留成未完成 promise（未完成 I/O 会阻止 hibernation）。
        // 只查一次带索引的 operation_jobs，失败仍由任务 deadline 兜底。
        await this.settleJobsOnDisconnect(serverId).catch(() => { /* 失败由 deadline 兜底 */ });
      }
    }
  }

  // 断线时的 D1 收敛（见文档 §9.1）。刻意**不含 upload**：它走重连重发，
  // 在这里判失败就没有恢复机会了。
  async settleJobsOnDisconnect(serverId) {
    const now = Math.floor(Date.now() / 1000);
    const placeholders = ['queued', 'running'].map(() => '?').join(',');
    try {
      // 先查后改：exec 的断连失败也要写审计（exec.command.failed），
      // 纯 UPDATE 拿不到受影响行，会让这条路径依然无痕。
      const rows = await this.env.DB.prepare(
        `SELECT id, kind FROM operation_jobs
          WHERE server_id = ? AND kind IN ('exec','agent_update') AND status IN (${placeholders})`
      ).bind(serverId, 'queued', 'running').all();
      for (const row of rows.results || []) {
        if (row.kind === 'exec') {
          await this.failExecJobWithAudit(this.env, row.id, 'agent disconnected');
        } else {
          await failJob(this.env, row.id, 'agent disconnected');
        }
      }
    } catch (e) {
      console.error('settleJobsOnDisconnect failed:', e);
    }
  }
}
