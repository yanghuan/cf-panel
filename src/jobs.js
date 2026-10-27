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
    if (dup) return { job: dup, reused: true };
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
    // 并发同 key：唯一索引兜底，回查已存在的那一条，语义仍是幂等
    if (/UNIQUE constraint failed: operation_jobs\.(id|user_id)/.test(String(e && e.message))) {
      const dup = await env.DB
        .prepare("SELECT * FROM operation_jobs WHERE user_id = ? AND kind = 'exec' AND idempotency_key = ?")
        .bind(user.id, idempotencyKey)
        .first();
      if (dup) return { job: dup, reused: true };
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
export async function finishExecJob(env, id, { exitCode = null, stdout = '', stderr = '', timedOut = false, error = null }) {
  const now = nowSec();
  const status = timedOut ? 'timed_out' : (error ? 'failed' : 'succeeded');
  const res = await env.DB.prepare(
    `UPDATE operation_jobs
        SET status = ?, exit_code = ?, stdout = ?, stderr = ?, timed_out = ?, error = ?,
            finished_at = ?, duration_ms = CASE WHEN started_at IS NULL THEN NULL ELSE (? - started_at) * 1000 END
      WHERE id = ? AND status IN ('queued','running')`
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
  // 过期即删 staging 对象：不能等 cron 的 24h TTL——一次 Agent 掉线的 100MB 上传
  // 会在额度里白躺一天，几十次就顶满 10GB。此处在判定过期的同一路径上清掉。
  await deleteStagingObject(env, job);
  return getJob(env, job.id);
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

// 互斥：该服务器是否有进行中的 agent update（更新会重启 Agent，禁止与 exec 交错）
export async function hasActiveAgentUpdate(env, serverId) {
  const row = await env.DB.prepare(
    "SELECT 1 AS x FROM operation_jobs WHERE server_id = ? AND kind = 'agent_update' AND status IN ('queued','waiting_agent','running') LIMIT 1"
  ).bind(serverId).first();
  return !!row;
}

// ---- upload 任务 ----

// 创建 upload 任务（awaiting_upload）。同一服务器已有非终态 upload 时抛 UPLOAD_BUSY。
// 有效期分两段：先给客户端 10 分钟上传字节；落 R2 后再给 Agent 120s 拉取，
// 两段窗口互不复用（上传慢不该挤掉 Agent 的时间）。
export async function createUploadJob(env, { user, serverId, targetPath, overwrite, maxBytes, clientIp }) {
  await purgeExpired(env);
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
export async function listWaitingUploads(env, serverId) {
  const rows = await env.DB.prepare(
    `SELECT id, target_path, overwrite, size_bytes, r2_key, deadline_at
       FROM operation_jobs
      WHERE server_id = ? AND kind = 'upload' AND status = 'waiting_agent'
      ORDER BY created_at LIMIT 20`
  ).bind(serverId).all();
  return rows.results || [];
}

// 重连时把 running 的 upload 退回 waiting_agent（连接断了，Agent 那侧不会再有回执），
// 已过 deadline 的直接判 timed_out。返回被退回的条数。
export async function requeueOrphanUploads(env, serverId, now = nowSec()) {
  const back = await env.DB.prepare(
    `UPDATE operation_jobs SET status = 'waiting_agent'
      WHERE server_id = ? AND kind = 'upload' AND status = 'running' AND deadline_at > ?`
  ).bind(serverId, now).run();
  const dead = await env.DB.prepare(
    `UPDATE operation_jobs SET status = 'timed_out', error = 'agent disconnected before completion',
            finished_at = ?, duration_ms = CASE WHEN started_at IS NULL THEN NULL ELSE (? - started_at) * 1000 END
      WHERE server_id = ? AND kind = 'upload' AND status = 'running' AND deadline_at <= ?`
  ).bind(now, now, serverId, now).run();
  return (back.meta.changes || 0) + (dead.meta.changes || 0);
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
export async function finishUploadJob(env, id, { ok, error = null }) {
  const now = nowSec();
  const res = await env.DB.prepare(
    `UPDATE operation_jobs
        SET status = ?, error = ?, finished_at = ?,
            duration_ms = CASE WHEN started_at IS NULL THEN NULL ELSE (? - started_at) * 1000 END
      WHERE id = ? AND status IN ('awaiting_upload','staging','staged','waiting_agent','running')`
  ).bind(ok ? 'succeeded' : 'failed', error, now, now, id).run();
  if (!res.meta.changes) return null;
  return env.DB.prepare('SELECT * FROM operation_jobs WHERE id = ?').bind(id).first();
}

// ---- agent update 任务 ----

export async function createAgentUpdateJob(env, {
  user, serverId, buildId, fromVersion, platform, sizeBytes, sha256, assetUrl, clientIp,
}) {
  await purgeExpired(env);
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

export async function finishUpdateJob(env, id, { ok, error = null, timedOut = false }) {
  const now = nowSec();
  const status = timedOut ? 'timed_out' : (ok ? 'succeeded' : 'failed');
  const res = await env.DB.prepare(
    `UPDATE operation_jobs
        SET status = ?, error = ?, finished_at = ?,
            duration_ms = CASE WHEN started_at IS NULL THEN NULL ELSE (? - started_at) * 1000 END
      WHERE id = ? AND status IN ('queued','running')`
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
    `SELECT id, kind, r2_key FROM operation_jobs
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
    await deleteStagingObject(env, job);
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
