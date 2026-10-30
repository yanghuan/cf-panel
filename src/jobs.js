// cf-panel — 异步任务（operation_jobs）：创建 / 读取 / 条件更新 / 过期收敛
//
// 为什么落在 D1 而不是 DO storage：
//   GET /api/jobs/:id 由 Worker 直接查库，不激活 DO。若任务存在 DO 里，每次轮询都会
//   请求 DO（打断 hibernation、与 agent 上报争用单线程），等于把刚拆掉的耦合装回去。
//   DO 只负责「下发指令」和「收到结果后条件更新 D1」，两条路径都是短请求。
//
// 并发约定：
//   - 状态流转全部用条件更新（WHERE id=? AND status IN (...)），靠 meta.changes 判断是否命中；
//     重复回执、过期后迟到的结果都不会覆盖终态。
//   - agent_update 独占一台服务器；exec 之间、exec 与 upload 之间不互斥（保持既有语义）。
import {
  JOB_TTL_S, EXEC_JOB_GRACE_S, JOB_POLL_AFTER_MS, JOB_TERMINAL_STATES,
  UPLOAD_JOB_UPLOAD_WINDOW_S, UPLOAD_JOB_AGENT_WINDOW_S, UPLOAD_JOB_GRACE_S,
  UPDATE_JOB_TIMEOUT_S, UPDATE_JOB_GRACE_S, UPLOAD_R2_PREFIX,
} from './config.js';

const ACTIVE_STATES = ['queued', 'awaiting_upload', 'staging', 'staged', 'waiting_agent', 'running'];

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}

// job_ + 128bit 随机 hex：不可枚举（轮询接口靠它做能力凭证），且符合 Agent 临时文件 ID 白名单
export function newJobId() {
  return `job_${crypto.randomUUID().replace(/-/g, '')}`;
}

export async function getJob(env, id) {
  if (!id) return null;
  return env.DB.prepare('SELECT * FROM operation_jobs WHERE id = ?').bind(id).first();
}

// 清理过期任务行（机会式，每次创建任务时顺手做一次）。
// 正式清理由 stage D 的 cron 负责；这里只是防止「没有 cron 时 D1 无限增长」。
export async function purgeExpired(env) {
  try {
    await env.DB.prepare('DELETE FROM operation_jobs WHERE expires_at < ?').bind(nowSec()).run();
  } catch { /* 清理失败不影响主流程 */ }
}

// 创建 exec 任务。返回 { job, reused }：reused=true 表示命中 idempotency_key，返回已有任务。
//
// 命中幂等键时必须校验「是不是同一件事」：同一用户在同一 TTL（24h）内复用同一个 key 去
// 跑**另一台机器/另一条命令**时，直接返回旧任务会让调用方拿到完全不相干的结果（甚至以为
// 命令已执行）。server 或 command 不一致 → 拒绝（409），让调用方换 key，而不是静默串台。
function assertSameIdempotentJob(dup, { serverId, command }) {
  if (Number(dup.server_id) === Number(serverId) && String(dup.command || '') === String(command)) return;
  const e = new Error(
    'idempotency_key already used for a different exec request (server/command mismatch); use a new key'
  );
  e.code = 'IDEMPOTENCY_CONFLICT';
  throw e;
}

export async function createExecJob(env, {
  user, serverId, command, timeoutS, clientIp, idempotencyKey = null,
}) {
  await purgeExpired(env);
  const now = nowSec();

  if (idempotencyKey) {
    const dup = await env.DB
      .prepare("SELECT * FROM operation_jobs WHERE user_id = ? AND kind = 'exec' AND idempotency_key = ? AND expires_at >= ?")
      .bind(user.id, idempotencyKey, now)
      .first();
    if (dup) {
      assertSameIdempotentJob(dup, { serverId, command });
      return { job: dup, reused: true };
    }
  }

  const job = {
    id: newJobId(),
    kind: 'exec',
    status: 'queued',
    user_id: user.id,
    username: user.username,
    client_ip: clientIp || '',
    server_id: serverId,
    command,
    timeout_s: timeoutS,
    idempotency_key: idempotencyKey,
    created_at: now,
    // 命令超时 + 宽限：逾期没有回执即判 expired（无回执 ≠ 命令超时，两者状态分开）
    deadline_at: now + timeoutS + EXEC_JOB_GRACE_S,
    expires_at: now + JOB_TTL_S,
  };
  try {
    await env.DB.prepare(
      `INSERT INTO operation_jobs
         (id, kind, status, user_id, username, client_ip, server_id, command, timeout_s,
          idempotency_key, created_at, deadline_at, expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      job.id, job.kind, job.status, job.user_id, job.username, job.client_ip, job.server_id,
      job.command, job.timeout_s, job.idempotency_key, job.created_at, job.deadline_at, job.expires_at
    ).run();
  } catch (e) {
    // 并发同 key：唯一索引兜底，回查已存在的那一条，语义仍是幂等。
    // 带 expires_at >= now，与上面的预查口径一致：并发的另一条若已过 TTL，
    // 回查会拿到一条「首查永远选不到」的行，语义就分叉了。
    if (/UNIQUE constraint failed: operation_jobs\.(id|user_id)/.test(String(e && e.message))) {
      const dup = await env.DB
        .prepare("SELECT * FROM operation_jobs WHERE user_id = ? AND kind = 'exec' AND idempotency_key = ? AND expires_at >= ?")
        .bind(user.id, idempotencyKey, now)
        .first();
      if (dup) {
        assertSameIdempotentJob(dup, { serverId, command });
        return { job: dup, reused: true };
      }
    }
    throw e;
  }
  return { job, reused: false };
}

// queued -> running（条件更新）。返回是否真正命中：未命中说明任务已被其它路径收敛。
export async function markJobRunning(env, id) {
  const res = await env.DB.prepare(
    "UPDATE operation_jobs SET status = 'running', started_at = ?, dispatch_attempts = dispatch_attempts + 1 WHERE id = ? AND status = 'queued'"
  ).bind(nowSec(), id).run();
  return !!res.meta.changes;
}

// 下发前失败（Agent 离线、更新中、发送异常）：非终态 -> failed。
// 覆盖**任意非终态**：exec 走 queued/running，upload 会先到 staged，agent_update 走 queued。
// 只放 queued/running 会让 upload 的下发失败留在 staged，客户端一直看到"等待 Agent"
// 直到 deadline（实测过，别改窄）。允许从 running 回退，是为了覆盖「先置 running 再发送、
// 发送抛错」的窗口。
export async function failJob(env, id, error) {
  const now = nowSec();
  const placeholders = ACTIVE_STATES.map(() => '?').join(',');
  const res = await env.DB.prepare(
    `UPDATE operation_jobs
        SET status = 'failed', error = ?, finished_at = ?,
            duration_ms = CASE WHEN started_at IS NULL THEN NULL ELSE (? - started_at) * 1000 END
      WHERE id = ? AND status IN (${placeholders})`
  ).bind(String(error || 'failed'), now, now, id, ...ACTIVE_STATES).run();
  return !!res.meta.changes;
}

// 终端回执写入终态。返回更新后的完整行（未命中返回 null：重复回执 / 已过期）。
// duration_ms 在 SQL 里算，避免「先读后写」的竞态。
// 同 finishUploadJob：接受 expired 的迟到回执（窗口 30s vs Agent 命令超时 25s，
// 倒置幅度小但同样存在）。exec 的迟到结果尤其重要——命令可能真的执行了。
export async function finishExecJob(env, id, { exitCode = null, stdout = '', stderr = '', timedOut = false, error = null }) {
  const now = nowSec();
  const status = timedOut ? 'timed_out' : (error ? 'failed' : 'succeeded');
  const res = await env.DB.prepare(
    `UPDATE operation_jobs
        SET status = ?, exit_code = ?, stdout = ?, stderr = ?, timed_out = ?, error = ?,
            finished_at = ?, duration_ms = CASE WHEN started_at IS NULL THEN NULL ELSE (? - started_at) * 1000 END
      WHERE id = ? AND status IN ('queued','running','expired')`
  ).bind(status, exitCode, stdout, stderr, timedOut ? 1 : 0, error, now, now, id).run();
  if (!res.meta.changes) return null;
  return getJob(env, id);
}

// 过期收敛（幂等）：非终态且已过 deadline → expired。返回最新的任务行。
// 由轮询接口与 cron 共同调用；不依赖 DO timer。
export async function settleExpired(env, job) {
  if (!job || JOB_TERMINAL_STATES.includes(job.status)) return job;
  const now = nowSec();
  if (now <= job.deadline_at) return job;
  const placeholders = ACTIVE_STATES.map(() => '?').join(',');
  const res = await env.DB.prepare(
    `UPDATE operation_jobs
        SET status = 'expired', error = ?, finished_at = ?,
            duration_ms = CASE WHEN started_at IS NULL THEN NULL ELSE (? - started_at) * 1000 END
      WHERE id = ? AND status IN (${placeholders})`
  ).bind(job.kind === 'exec' ? 'no result before deadline' : 'expired before completion', now, now, job.id, ...ACTIVE_STATES).run();
  if (!res.meta.changes) return job;
  // 回读一次：审计要 duration_ms，而传进来的 job 是 UPDATE **之前**的快照
  //（那时 finished_at 刚写、duration_ms 仍为 NULL，直接用它会让审计恒为 null）。
  const fresh = await getJob(env, job.id);
  // 过期即删 staging 对象：不能等 cron 的 24h TTL——一次 Agent 掉线的 100MB 上传
  // 会在额度里白躺一天，几十次就顶满 10GB。此处在判定过期的同一路径上清掉。
  await deleteStagingObject(env, fresh || job);
  // exec 超时同样要留痕：旧同步路径在超时会写一条 exec.command，
  // 异步化后若不补，这条路径就完全无审计（最高权限的写操作反而无痕）。
  if ((fresh || job).kind === 'exec') await auditExecFailed(env, fresh || job, 'no result before deadline');
  return fresh || job;
}

// exec 失败/超时的审计（exec.command.failed）。与 DO 内的 failExecJobWithAudit 同格式，
// 供 Worker 侧的过期收敛路径复用（那里没有 DO 实例方法可用）。
export async function auditExecFailed(env, job, reason) {
  if (!job || job.kind !== 'exec') return;
  const cmd = String(job.command || '');
  const commandTrunc = cmd.length > 180 ? `${cmd.slice(0, 180)}…` : cmd;
  // duration_ms 要现算：settleExpired / settleServerExpired / settleExpiredAll 传进来的是
  // UPDATE **之前**的行快照（那时 finished_at 刚写、duration_ms 还是 NULL），
  // 直接取 job.duration_ms 会恒为 null（实测：任务行 380000，审计 null）。
  const dur = job.duration_ms
    ?? (job.started_at && job.finished_at ? (job.finished_at - job.started_at) * 1000 : null);
  try {
    await env.DB.prepare(
      'INSERT INTO audit_logs (user_id, username, client_ip, action, target_server_id, detail, duration_ms, job_id) VALUES (?,?,?,?,?,?,?,?)'
    ).bind(
      job.user_id, job.username, job.client_ip || '', 'exec.command.failed', job.server_id,
      `exit=? (${reason}) ${commandTrunc}`,
      dur, job.id,
    ).run();
  } catch (e) { console.error('exec failed audit failed:', e); }
}

// 删除任务对应的 R2 暂存对象（仅 upload）。失败只记日志：
// 行仍会过期被删，孤儿对象由 cron 的 list 扫描与 R2 lifecycle 兜底。
export async function deleteStagingObject(env, job) {
  if (!job || job.kind !== 'upload' || !job.r2_key) return;
  try {
    await env.UPLOADS.delete(job.r2_key);
  } catch (e) {
    console.error('staging object delete failed:', e);
  }
}

// 互斥：该服务器是否有进行中的 agent update（更新会重启 Agent，禁止与 exec 交错）。
// 判据必须带 deadline_at：Agent 未回执且连接未断（更新内部挂住/进程未退出）时，任务会一直停在
// queued/waiting_agent/running；只看 status 的话，本机 exec/upload 会被 409 挡住最长到下一次
// cron（1h）——期间没有任何路径会收敛它（settleExpiredAll 每小时第 17 分才跑）。
// excludeJobId：排除「本次要下发的那个任务」——它自己当然是 active 的，
// 不排除会让 DO 在下发新更新时被自己刚创建的 D1 行挡住（旧更新挂住后重试的路径）。
// 只读：过期行的收敛交给 settleServerExpired（创建任务前按 server 收敛一次）。
// 不在这里顺手 UPDATE：本函数是 exec/upload/终端/更新下发的热路径判据（每次调用一条 SELECT
// 就够了），多一条 0 行 UPDATE 会在每次开终端时白付一次写语句；而占着唯一索引的过期行
// 只在「创建 agent_update」时才挡路，那条路径本来就会先 settleServerExpired。
export async function hasActiveAgentUpdate(env, serverId, excludeJobId = null) {
  const now = nowSec();
  const row = await env.DB.prepare(
    `SELECT 1 AS x FROM operation_jobs
      WHERE server_id = ? AND kind = 'agent_update'
        AND status IN ('queued','waiting_agent','running') AND deadline_at > ?
        AND id != ?
      LIMIT 1`
  ).bind(serverId, now, excludeJobId || '').first();
  return !!row;
}

// ---- upload 任务 ----

// 按 server 收敛该机已过 deadline 的非终态任务（创建任务前调用）。
//
// 不能用 settleExpiredAll：它是全表扫描（LIMIT 200），在创建任务的热路径里调会无谓扫 200 行。
// 这里只处理"这台机器"，把被过期任务占着的部分唯一索引让出来——否则
// awaiting_upload / update running 的任务过了 deadline 但没人轮询、cron 未跑到时，
// createUploadJob 仍会返回 UPLOAD_BUSY，最长挡到 expires_at（24h）。
//
// 只处理 upload / agent_update：只有这两类占单机串行唯一索引（schema.sql 的部分唯一索引）。
// 不加 kind 过滤时，一台机器积压的几十条过期 exec 会占满 LIMIT，真正挡路的那条 upload
// 反而选不到（SQL 无 ORDER BY 时不保证顺序）；ORDER BY deadline_at 保证最老的先收敛。
export async function settleServerExpired(env, serverId, now = nowSec(), kinds = ['upload', 'agent_update']) {
  const kindPlaceholders = kinds.map(() => '?').join(',');
  const rows = await env.DB.prepare(
    `SELECT id, kind, r2_key, user_id, username, client_ip, server_id, command, started_at, finished_at
       FROM operation_jobs
      WHERE server_id = ? AND deadline_at < ?
        AND kind IN (${kindPlaceholders})
        AND status IN ('queued','awaiting_upload','staging','staged','waiting_agent','running')
      ORDER BY deadline_at
      LIMIT 20`
  ).bind(serverId, now, ...kinds).all();
  for (const job of rows.results || []) {
    const placeholders = ACTIVE_STATES.map(() => '?').join(',');
    const res = await env.DB.prepare(
      `UPDATE operation_jobs
          SET status = 'expired', error = COALESCE(error, 'no result before deadline'), finished_at = ?,
              duration_ms = CASE WHEN started_at IS NULL THEN NULL ELSE (? - started_at) * 1000 END
        WHERE id = ? AND status IN (${placeholders})`
    ).bind(now, now, job.id, ...ACTIVE_STATES).run();
    if (!res.meta.changes) continue;
    // 回读拿 duration_ms（入参是 UPDATE 前的快照，见 settleExpired 注释）
    const fresh = (await getJob(env, job.id)) || job;
    await deleteStagingObject(env, fresh);
    if (fresh.kind === 'exec') await auditExecFailed(env, fresh, 'no result before deadline');
  }
}

// 创建 upload 任务（awaiting_upload）。同一服务器已有非终态 upload 时抛 UPLOAD_BUSY。
// 有效期分两段：先给客户端 10 分钟上传字节；落 R2 后再给 Agent 300s 拉取（+30s grace），
// 两段窗口互不复用（上传慢不该挤掉 Agent 的时间）。
export async function createUploadJob(env, { user, serverId, targetPath, overwrite, maxBytes, clientIp }) {
  await purgeExpired(env);
  // 先让出被"已过期但无人轮询"的任务占着的单机串行锁（见 settleServerExpired 注释）
  await settleServerExpired(env, serverId);
  const now = nowSec();
  const jobId = newJobId();
  const job = {
    id: jobId,
    kind: 'upload',
    status: 'awaiting_upload',
    user_id: user.id,
    username: user.username,
    client_ip: clientIp || '',
    server_id: serverId,
    target_path: targetPath,
    overwrite: overwrite ? 1 : 0,
    size_bytes: maxBytes, // 暂存上限，落盘后覆盖为实际大小
    created_at: now,
    deadline_at: now + UPLOAD_JOB_UPLOAD_WINDOW_S,
    expires_at: now + JOB_TTL_S,
    r2_key: `${UPLOAD_R2_PREFIX}${jobId}`,
  };
  try {
    await env.DB.prepare(
      `INSERT INTO operation_jobs
         (id, kind, status, user_id, username, client_ip, server_id, target_path, overwrite,
          size_bytes, r2_key, created_at, deadline_at, expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      job.id, job.kind, job.status, job.user_id, job.username, job.client_ip, job.server_id,
      job.target_path, job.overwrite, job.size_bytes, job.r2_key, job.created_at, job.deadline_at, job.expires_at
    ).run();
  } catch (e) {
    // 部分唯一索引命中：该服务器已有进行中的 upload。语义上不是错误输入，而是"忙"。
    if (/UNIQUE constraint failed: operation_jobs\.server_id/.test(String(e && e.message))) {
      const err = new Error('another upload is in progress for this server');
      err.code = 'UPLOAD_BUSY';
      throw err;
    }
    throw e;
  }
  return env.DB.prepare('SELECT * FROM operation_jobs WHERE id = ?').bind(job.id).first();
}

// awaiting_upload -> staging（抢占上传权）。返回是否命中：未命中说明已被并发上传或已过期。
export async function claimUploadStaging(env, id, expectServerId) {
  const now = nowSec();
  const res = await env.DB.prepare(
    `UPDATE operation_jobs SET status = 'staging', started_at = ?
      WHERE id = ? AND server_id = ? AND status = 'awaiting_upload' AND deadline_at >= ?`
  ).bind(now, id, expectServerId, now).run();
  return !!res.meta.changes;
}

// staging -> staged：字节已完整写入 R2。size 用实测值（不信任 Content-Length）。
// deadline 重置为 Agent 拉取窗口——上传窗口已消耗完，不能沿用它。
export async function markUploadStaged(env, id, { sizeBytes }) {
  const now = nowSec();
  const res = await env.DB.prepare(
    `UPDATE operation_jobs
        SET status = 'staged', size_bytes = ?, deadline_at = ?, started_at = COALESCE(started_at, ?)
      WHERE id = ? AND status = 'staging'`
  ).bind(sizeBytes, now + UPLOAD_JOB_AGENT_WINDOW_S + UPLOAD_JOB_GRACE_S, now, id).run();
  return !!res.meta.changes;
}

// staged -> waiting_agent -> running：DO 下发 upload_fetch 前后各一次。
export async function markUploadWaitingAgent(env, id) {
  const res = await env.DB.prepare(
    "UPDATE operation_jobs SET status = 'waiting_agent' WHERE id = ? AND status = 'staged'"
  ).bind(id).run();
  return !!res.meta.changes;
}

// 重连重发（文档 §9）：Agent 重连后，把该服务器停在 waiting_agent 的 upload 任务捞出来重新下发。
// 限量 20 条：异常时（大量任务堆积）不能让一次重连触发无界查询与下发。
// 只捞"还没过期"的 waiting_agent。
//
// 不过滤 deadline 的后果远不止"多发一次"：markUploadRunning 会把 deadline_at 重置成
// now+330，于是一份几小时前的旧暂存包会被投递到目标机、覆盖 /opt/app/app.tar.gz ——
// 这是"延迟生效的写"，比超时难排查得多，而且用户早已认为该任务过期。
export async function listWaitingUploads(env, serverId, now = nowSec()) {
  const rows = await env.DB.prepare(
    `SELECT id, target_path, overwrite, size_bytes, r2_key, deadline_at
       FROM operation_jobs
      WHERE server_id = ? AND kind = 'upload' AND status = 'waiting_agent'
        AND deadline_at > ?
      ORDER BY created_at LIMIT 20`
  ).bind(serverId, now).all();
  return rows.results || [];
}

// 重连时把 running 的 upload 退回 waiting_agent（连接断了，Agent 那侧不会再有回执），
// 已过 deadline 的直接判 timed_out。返回被退回的条数。
export async function requeueOrphanUploads(env, serverId, now = nowSec()) {
  const back = await env.DB.prepare(
    `UPDATE operation_jobs SET status = 'waiting_agent'
      WHERE server_id = ? AND kind = 'upload' AND status = 'running' AND deadline_at > ?`
  ).bind(serverId, now).run();
  // 已过 deadline 的：先查出 r2_key 再逐条判死。纯 UPDATE 拿不到受影响行，
  // 会让暂存对象白躺到 expires_at（24h）——正是 settleExpiredAll 注释里点出的坑。
  const stale = await env.DB.prepare(
    `SELECT id, kind, r2_key FROM operation_jobs
      WHERE server_id = ? AND kind = 'upload' AND status = 'running' AND deadline_at <= ?`
  ).bind(serverId, now).all();
  let dead = 0;
  for (const job of stale.results || []) {
    const res = await env.DB.prepare(
      `UPDATE operation_jobs SET status = 'timed_out', error = 'agent disconnected before completion',
              finished_at = ?, duration_ms = CASE WHEN started_at IS NULL THEN NULL ELSE (? - started_at) * 1000 END
        WHERE id = ? AND status = 'running'`
    ).bind(now, now, job.id).run();
    if (!res.meta.changes) continue;
    dead += 1;
    await deleteStagingObject(env, job);
  }
  return (back.meta.changes || 0) + dead;
}

export async function markUploadRunning(env, id) {
  const now = nowSec();
  const res = await env.DB.prepare(
    `UPDATE operation_jobs
        SET status = 'running', started_at = COALESCE(started_at, ?), deadline_at = ?,
            dispatch_attempts = dispatch_attempts + 1
      WHERE id = ? AND status = 'waiting_agent'`
  ).bind(now, now + UPLOAD_JOB_AGENT_WINDOW_S + UPLOAD_JOB_GRACE_S, id).run();
  return !!res.meta.changes;
}

// upload 终态。成功（Agent 已 commit）与失败共用；R2 对象由调用方决定是否删除。
// 终态回执写入。返回更新后的行；未命中返回 null（重复回执 / 已被其它路径收敛）。
//
// **允许 expired → succeeded/failed 的"迟到回执"**（值 `late=1` 记在 error 里）：
// 服务端窗口只有 330s，而 Agent 兜底超时 360s —— 慢链路下会出现"服务端已判 expired，
// Agent 随后真的把文件落盘了"。此时若丢弃回执：
//   · 用户轮询永远看到 expired，可文件实际已经在了（状态与磁盘不一致）；
//   · 这次上传在审计里完全消失（settleUploadJob 拿到 null 直接 return，走不到审计）。
// 让回执把状态纠正为真实结果，并保留原判过期的事实，比"终态绝对不可变"更准确。
// 注意：只接受 expired，不接受 succeeded/failed（真正的终态仍不可覆盖，防重复回执）。
export async function finishUploadJob(env, id, { ok, error = null }) {
  const now = nowSec();
  const res = await env.DB.prepare(
    `UPDATE operation_jobs
        SET status = ?, error = ?, finished_at = ?,
            duration_ms = CASE WHEN started_at IS NULL THEN NULL ELSE (? - started_at) * 1000 END
      WHERE id = ? AND status IN ('awaiting_upload','staging','staged','waiting_agent','running','expired')`
  ).bind(ok ? 'succeeded' : 'failed', error, now, now, id).run();
  if (!res.meta.changes) return null;
  return env.DB.prepare('SELECT * FROM operation_jobs WHERE id = ?').bind(id).first();
}

// ---- agent update 任务 ----

export async function createAgentUpdateJob(env, {
  user, serverId, buildId, fromVersion, platform, sizeBytes, sha256, assetUrl, clientIp,
}) {
  await purgeExpired(env);
  await settleServerExpired(env, serverId);
  const now = nowSec();
  const id = newJobId();
  try {
    await env.DB.prepare(
      `INSERT INTO operation_jobs
         (id, kind, status, user_id, username, client_ip, server_id, build_id, from_version, to_version,
          platform, size_bytes, sha256, asset_url, created_at, deadline_at, expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      id, 'agent_update', 'queued', user.id, user.username, clientIp || '', serverId,
      buildId, fromVersion, buildId, platform, sizeBytes, sha256, assetUrl,
      now, now + UPDATE_JOB_TIMEOUT_S + UPDATE_JOB_GRACE_S, now + JOB_TTL_S
    ).run();
  } catch (e) {
    if (/UNIQUE constraint failed: operation_jobs\.server_id/.test(String(e && e.message))) {
      const err = new Error('an agent update is already in progress for this server');
      err.code = 'UPDATE_BUSY';
      throw err;
    }
    throw e;
  }
  return env.DB.prepare('SELECT * FROM operation_jobs WHERE id = ?').bind(id).first();
}

export async function markUpdateRunning(env, id) {
  const now = nowSec();
  const res = await env.DB.prepare(
    `UPDATE operation_jobs
        SET status = 'running', started_at = ?, dispatch_attempts = dispatch_attempts + 1
      WHERE id = ? AND status = 'queued'`
  ).bind(now, id).run();
  return !!res.meta.changes;
}

// 同 finishUploadJob：接受 expired 的迟到回执（update 窗口 210s vs 下载超时 360s）。
export async function finishUpdateJob(env, id, { ok, error = null, timedOut = false }) {
  const now = nowSec();
  const status = timedOut ? 'timed_out' : (ok ? 'succeeded' : 'failed');
  const res = await env.DB.prepare(
    `UPDATE operation_jobs
        SET status = ?, error = ?, finished_at = ?,
            duration_ms = CASE WHEN started_at IS NULL THEN NULL ELSE (? - started_at) * 1000 END
      WHERE id = ? AND status IN ('queued','running','expired')`
  ).bind(status, error, now, now, id).run();
  if (!res.meta.changes) return null;
  return env.DB.prepare('SELECT * FROM operation_jobs WHERE id = ?').bind(id).first();
}

// 对外视图：未终态不返回输出（stdout/stderr 可能含敏感内容，且此时还没有值）
export function jobView(job, { pollAfterMs = JOB_POLL_AFTER_MS } = {}) {
  const view = {
    id: job.id,
    kind: job.kind,
    status: job.status,
    server_id: job.server_id,
    created_at: job.created_at,
    started_at: job.started_at ?? null,
    deadline_at: job.deadline_at,
    poll_after_ms: pollAfterMs,
  };
  if (!JOB_TERMINAL_STATES.includes(job.status)) return view;
  view.finished_at = job.finished_at ?? null;
  view.duration_ms = job.duration_ms ?? null;
  if (job.kind === 'exec') {
    view.result = {
      exit_code: job.exit_code ?? null,
      stdout: job.stdout || '',
      stderr: job.stderr || '',
      timed_out: !!job.timed_out,
      error: job.error || null,
    };
  } else if (job.kind === 'upload') {
    view.result = {
      ok: job.status === 'succeeded',
      error: job.error || null,
      path: job.target_path || null,
      size_bytes: job.size_bytes ?? null,
    };
  } else {
    view.result = {
      ok: job.status === 'succeeded',
      error: job.error || null,
      build_id: job.build_id ?? null,
      from_version: job.from_version ?? null,
      size_bytes: job.size_bytes ?? null,
    };
  }
  return view;
}

// 清理：非终态且过 deadline → expired（exec 的收敛在 settleExpired，这里补 upload/update）。
// 必须先查后改：纯 UPDATE 拿不到受影响行的 r2_key，upload 的暂存件就只能等 TTL，
// 而 TTL 是 24h——一次 Agent 掉线的 100MB 上传会白占额度一整天。
// 返回本次收敛的行数，供 cron 观测。
export async function settleExpiredAll(env, now = nowSec()) {
  const rows = await env.DB.prepare(
    `SELECT id, kind, r2_key, user_id, username, client_ip, server_id, command, started_at, finished_at
       FROM operation_jobs
      WHERE status IN ('queued','awaiting_upload','staging','staged','waiting_agent','running')
        AND deadline_at < ?
      LIMIT 200`
  ).bind(now).all();
  const list = rows.results || [];
  if (!list.length) return 0;
  const placeholders = ACTIVE_STATES.map(() => '?').join(',');
  let changed = 0;
  for (const job of list) {
    const res = await env.DB.prepare(
      `UPDATE operation_jobs
          SET status = 'expired', error = COALESCE(error, 'no result before deadline'), finished_at = ?,
              duration_ms = CASE WHEN started_at IS NULL THEN NULL ELSE (? - started_at) * 1000 END
        WHERE id = ? AND status IN (${placeholders})`
    ).bind(now, now, job.id, ...ACTIVE_STATES).run();
    if (!res.meta.changes) continue; // 竞态：已被其它路径收敛
    changed += 1;
    const fresh = (await getJob(env, job.id)) || job;
    await deleteStagingObject(env, fresh);
    if (fresh.kind === 'exec') await auditExecFailed(env, fresh, 'no result before deadline');
  }
  return changed;
}

// cron：删除已过 TTL 的行，返回被删行数与被删中 r2_key 非空的 key（供 cron 顺带清 R2）。
export async function purgeExpiredJobs(env, now = nowSec()) {
  const rows = await env.DB.prepare(
    'SELECT id, r2_key FROM operation_jobs WHERE expires_at < ? LIMIT 500'
  ).bind(now).all();
  const list = rows.results || [];
  if (!list.length) return { deleted: 0, r2Keys: [] };
  const placeholders = list.map(() => '?').join(',');
  await env.DB.prepare(`DELETE FROM operation_jobs WHERE id IN (${placeholders})`)
    .bind(...list.map((r) => r.id)).run();
  return { deleted: list.length, r2Keys: list.map((r) => r.r2_key).filter(Boolean) };
}
