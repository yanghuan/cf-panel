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
import { JOB_TTL_S, EXEC_JOB_GRACE_S, JOB_POLL_AFTER_MS, JOB_TERMINAL_STATES } from './config.js';

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

// 下发前失败（Agent 离线、更新中、发送异常）：queued/running -> failed。
// 允许从 running 回退，是为了覆盖「先置 running 再发送、发送抛错」的窗口。
export async function failJob(env, id, error) {
  const now = nowSec();
  const res = await env.DB.prepare(
    `UPDATE operation_jobs
        SET status = 'failed', error = ?, finished_at = ?,
            duration_ms = CASE WHEN started_at IS NULL THEN NULL ELSE (? - started_at) * 1000 END
      WHERE id = ? AND status IN ('queued','running')`
  ).bind(String(error || 'failed'), now, now, id).run();
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
  return res.meta.changes ? getJob(env, job.id) : job;
}

// 互斥：该服务器是否有进行中的 agent update（更新会重启 Agent，禁止与 exec 交错）
export async function hasActiveAgentUpdate(env, serverId) {
  const row = await env.DB.prepare(
    "SELECT 1 AS x FROM operation_jobs WHERE server_id = ? AND kind = 'agent_update' AND status IN ('queued','waiting_agent','running') LIMIT 1"
  ).bind(serverId).first();
  return !!row;
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
  } else {
    view.result = {
      ok: job.status === 'succeeded',
      error: job.error || null,
      size_bytes: job.size_bytes ?? null,
      build_id: job.build_id ?? null,
    };
  }
  return view;
}
