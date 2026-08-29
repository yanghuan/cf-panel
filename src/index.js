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
import { parsePanelUsers, dayIndexOf, dayStartTs, statsTzOffsetSec } from './config.js';
import {
  json, err, secret, b64u, b64uDecode, bytesToHex, hexToBytes, hmacSha256, verifyHmacSha256,
  signJwt, verifyJwt, randomHex, sha256Hex, parseRangeHours, safeJson,
  sanitizeAlerts, sanitizeAlertOverride, hashSecret, verifySecretHash, signUploadToken, verifyUploadToken,
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
};

export { TerminalDO, MetricsDO, PanelDO };

// ============================================================
// 测试辅助导出（不参与线上路由，仅供 test/ 目录单元测试使用）
// ============================================================
export const __internals = {
  parsePanelUsers, dayIndexOf, dayStartTs, statsTzOffsetSec, json, err, secret,
  b64u, b64uDecode, bytesToHex, hexToBytes, hmacSha256, verifyHmacSha256,
  signJwt, verifyJwt, randomHex, sha256Hex,
  parseRangeHours, safeJson, sanitizeAlerts, sanitizeAlertOverride, hashSecret, verifySecretHash, signUploadToken, verifyUploadToken,
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
