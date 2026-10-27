// ============================================================
// cf-panel — Cloudflare Worker 主入口（模块化后为聚合层）
// 路由分发 + Durable Object 类导出 + 测试辅助导出（__internals）
// 功能模块：config（常量）、utils（工具）、db（数据访问）、auth（鉴权）、
//           report（上报落库）、routes（REST/MCP/WS 路由）、do-*（三个 DO 类）
// ============================================================
import {
  handleApi, handleMcp, handleWs, loginFails, apiCounts, clearAgentManifestCache, __clearAuditThrottle,
} from './routes.js';
import { sanitizeReportPayload } from './report.js';
import { TerminalDO } from './do-terminal.js';
import { MetricsDO } from './do-metrics.js';
import { PanelDO } from './do-panel.js';
import { parsePanelUsers, dayIndexOf, dayStartTs, statsTzOffsetSec, JOB_TTL_S, UPLOAD_R2_PREFIX } from './config.js';
import { settleExpiredAll, purgeExpiredJobs } from './jobs.js';
import {
  json, err, secret, b64u, b64uDecode, bytesToHex, hexToBytes, hmacSha256, verifyHmacSha256,
  signJwt, verifyJwt, randomHex, sha256Hex, parseRangeHours, safeJson,
  sanitizeAlerts, sanitizeAlertOverride, hashSecret, verifySecretHash, signUploadToken, verifyUploadToken,
  signJobToken, verifyJobToken,
  renderTemplate, parseHeaders, validateWebhookUrl, sendWebhookRaw, sendWebhook,
  shardForServerId, makeStreamId, shardFromStreamId,
} from './utils.js';
import {
  authIdentityByToken, authUserByIdentity, authUserByPatHash,
  isAdmin, canAccessServer, canExec, serverListCache, __clearGraceCache, __clearTokenUsedCache,
} from './auth.js';
import { SETTINGS_CACHE, queryMonitorRows, queryCustomMetrics } from './db.js';
import {
  handleReport, lastSeenWrite, LAST_SEEN_THROTTLE_S, customWritten,
  serverRowCache, reportBatch, setReportFlushAt,
} from './report.js';

// ---------------- Worker 入口 ----------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/ws/')) return handleWs(request, env);
    // /mcp 前缀：JSON-RPC 端点 + /mcp/file_upload 上传通道（签名 URL 直传需绕过 CF Access 放行区）
    if (url.pathname.startsWith('/mcp')) return handleMcp(request, env);
    return handleApi(request, env);
  },

  // 定时清理（阶段 D，wrangler.toml 的 crons 触发，每小时一次）：
  //   1. 非终态且过 deadline 的任务 → expired（Agent 失联/回执丢失的兜底）
  //   2. 过 TTL 的任务行删除；顺带删其 R2 staging 对象（否则对象会随 10GB 额度慢慢堆积）
  //   3. 扫 upload-jobs/ 前缀下超期孤儿对象（代码清理失败时的双保险，R2 lifecycle 是第三层）
  // 每轮有批次上限，未清完下一轮继续——避免单次 cron 超时。
  async scheduled(event, env) {
    try { await runJobMaintenance(env); } catch (e) { console.error('scheduled maintenance failed:', e); }
  },
};

// cron 主体（导出供测试直接调用，避免依赖 triggers 的实际调度）
export async function runJobMaintenance(env, now = Math.floor(Date.now() / 1000)) {
  const result = { expired: 0, deletedRows: 0, deletedObjects: 0 };
  result.expired = await settleExpiredAll(env, now);
  const { deleted, r2Keys } = await purgeExpiredJobs(env, now);
  result.deletedRows = deleted;
  for (const key of r2Keys) {
    try { await env.UPLOADS?.delete(key); result.deletedObjects += 1; } catch { /* ignore */ }
  }
  // 孤儿对象：行已不在（或行被手工删了）但 R2 还留着。按前缀扫一遍，超过 TTL 即删。
  if (env.UPLOADS) {
    try {
      const listed = await env.UPLOADS.list({ prefix: UPLOAD_R2_PREFIX });
      for (const obj of listed.objects || []) {
        const uploaded = obj.uploaded instanceof Date ? Math.floor(obj.uploaded.getTime() / 1000) : 0;
        // uploaded 缺失时按"未知"处理：保守跳过，避免误删刚写入的对象
        if (!uploaded) continue;
        if (now - uploaded > JOB_TTL_S) {
          await env.UPLOADS.delete(obj.key);
          result.deletedObjects += 1;
        }
      }
    } catch { /* R2 不可用：跳过，下一轮再试 */ }
  }
  return result;
}

export { TerminalDO, MetricsDO, PanelDO };

// ============================================================
// 测试辅助导出（不参与线上路由，仅供 test/ 目录单元测试使用）
// ============================================================
export const __internals = {
  parsePanelUsers, dayIndexOf, dayStartTs, statsTzOffsetSec, json, err, secret,
  b64u, b64uDecode, bytesToHex, hexToBytes, hmacSha256, verifyHmacSha256,
  signJwt, verifyJwt, randomHex, sha256Hex,
  parseRangeHours, safeJson, sanitizeAlerts, sanitizeAlertOverride, hashSecret, verifySecretHash, signUploadToken, verifyUploadToken,
  signJobToken, verifyJobToken,
  renderTemplate, parseHeaders, validateWebhookUrl, sendWebhookRaw, sendWebhook, sanitizeReportPayload,
  shardForServerId, makeStreamId, shardFromStreamId,
  authIdentityByToken, authUserByIdentity, authUserByPatHash,
  isAdmin, canAccessServer, canExec, handleReport,
  queryMonitorRows, queryCustomMetrics, // 监控查询（步长对齐降采样桶的回归测试用）
  lastSeenWrite, LAST_SEEN_THROTTLE_S, customWritten, serverListCache, apiCounts, serverRowCache, reportBatch,
  // 重置模块级可变状态（设置缓存），保证测试间隔离
  // 注：告警冷却/探活去重状态在 MetricsDO 实例内存，由各测试实例自行隔离
  setReportFlushAt, // let 原始值无法经对象属性赋值，测试用 setter 操纵 flush 时刻
  __reset() {
    SETTINGS_CACHE.clear();
    loginFails.clear();
    lastSeenWrite.clear();
    customWritten.clear();
    serverListCache.clear();
    apiCounts.clear();
    clearAgentManifestCache();
    serverRowCache.clear();
    reportBatch.clear();
    __clearGraceCache(); // 宽限期缓存（模块级静态，测试间 mock 不同需隔离）
    __clearAuditThrottle(); // 审计节流表（登录失败/鉴权失败按 IP 的 60s 节流，跨测试需隔离）
    __clearTokenUsedCache(); // PAT last_used_at 回写节流
    setReportFlushAt(0);
  },
};
