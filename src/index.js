// ============================================================
// cf-panel — Cloudflare Worker 主入口（模块化后为聚合层）
// 路由分发 + Durable Object 类导出 + 测试辅助导出（__internals）
// 功能模块：config（常量）、utils（工具）、db（数据访问）、auth（鉴权）、
//           report（上报落库）、routes（REST/MCP/WS 路由）、do-*（三个 DO 类）
// ============================================================
import { handleApi, handleMcp, handleWs, loginFails, apiCounts } from './routes.js';
import { TerminalDO } from './do-terminal.js';
import { MetricsDO } from './do-metrics.js';
import { PanelDO } from './do-panel.js';
import { parsePanelUsers } from './config.js';
import {
  json, err, secret, b64u, b64uDecode, bytesToHex, hmacSha256,
  signJwt, verifyJwt, randomHex, sha256Hex, parseRangeHours, safeJson,
  sanitizeAlerts, hashSecret, renderTemplate, parseHeaders, sendWebhook,
  shardForServerId, makeStreamId, shardFromStreamId,
} from './utils.js';
import { isAdmin, canAccessServer, canExec, serverListCache } from './auth.js';
import { SETTINGS_CACHE } from './db.js';
import {
  handleReport, lastSeenWrite, LAST_SEEN_THROTTLE_S, customWritten,
  serverRowCache, reportBatch, setReportFlushAt,
} from './report.js';

// ---------------- Worker 入口 ----------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/ws/')) return handleWs(request, env);
    if (url.pathname === '/mcp') return handleMcp(request, env);
    return handleApi(request, env);
  },
};

export { TerminalDO, MetricsDO, PanelDO };

// ============================================================
// 测试辅助导出（不参与线上路由，仅供 test/ 目录单元测试使用）
// ============================================================
export const __internals = {
  parsePanelUsers, json, err, secret,
  b64u, b64uDecode, bytesToHex, hmacSha256,
  signJwt, verifyJwt, randomHex, sha256Hex,
  parseRangeHours, safeJson, sanitizeAlerts, hashSecret,
  renderTemplate, parseHeaders, sendWebhook,
  shardForServerId, makeStreamId, shardFromStreamId,
  isAdmin, canAccessServer, canExec, handleReport,
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
    serverRowCache.clear();
    reportBatch.clear();
    setReportFlushAt(0);
  },
};
