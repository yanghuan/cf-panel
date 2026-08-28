// ============================================================
// 测试辅助：基于 node:sqlite 的 D1 内存实现 + DO 桩 + 请求助手
// 运行前提：Node >= 22（node:test / node:sqlite 为内置模块，零依赖）
// ============================================================
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

// ---- D1 兼容层：把 node:sqlite 的同步 API 包装成 D1 的异步 Promise API ----
export function makeD1() {
  const db = new DatabaseSync(':memory:');
  const schema = readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  db.exec(schema);

  const api = {
    prepare(sql) {
      const stmt = db.prepare(sql);
      const runner = (kind, args) => {
        // node:sqlite 不接受 undefined 绑定，归一化为 null（对齐 D1 宽松行为）
        const norm = args.map((a) => (a === undefined ? null : a));
        if (kind === 'first') {
          const r = stmt.get(...norm);
          return r === undefined ? null : r;
        }
        if (kind === 'all') return { results: stmt.all(...norm) };
        const r = stmt.run(...norm);
        return { meta: { changes: Number(r.changes) } };
      };
      return {
        bind(...args) {
          return {
            first: async () => runner('first', args),
            all: async () => runner('all', args),
            run: async () => runner('run', args),
          };
        },
        first: async () => runner('first', []),
        all: async () => runner('all', []),
        run: async () => runner('run', []),
      };
    },
    async batch(stmts) {
      const results = [];
      db.exec('BEGIN');
      try {
        for (const s of stmts) results.push(await s.run());
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      return results;
    },
    close() {
      db.close();
    },
  };
  return api;
}

// ---- DO 桩 ----
// MetricsDO 桩：记录调用并返回可配置结果
export function makeMetricsStub(opts = {}) {
  const calls = []; // {path, query, init}
  const stub = {
    calls,
    idFromName: () => 'metrics-main',
    get: () => ({
      fetch: async (url, init = {}) => {
        const u = new URL(url);
        calls.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), init });
        if (u.pathname === '/latest') return jsonResp(opts.latest ?? {});
        if (u.pathname === '/query') return jsonResp(opts.query ?? []);
        if (u.pathname === '/report') return jsonResp({ ok: true });
        return jsonResp({ error: 'not found' }, 404);
      },
    }),
  };
  return stub;
}

// TerminalDO 桩：按分片名记录 fetch 调用
export function makeTerminalStub() {
  const shards = new Map();
  const calls = []; // {shard, path, init}
  const stub = {
    calls,
    shards,
    idFromName: (name) => name,
    get(id) {
      if (!shards.has(id)) {
        shards.set(id, {
          fetch: async (url, init = {}) => {
            calls.push({ shard: id, path: new URL(url).pathname, init });
            return jsonResp({ ok: true });
          },
        });
      }
      return shards.get(id);
    },
  };
  return stub;
}

// PanelDO 桩：/viewers 返回可配置的观看者数
export function makePanelStub(opts = {}) {
  const calls = [];
  const stub = {
    calls,
    idFromName: () => 'panel-main',
    get: () => ({
      fetch: async (url) => {
        calls.push(String(url));
        return jsonResp({ count: opts.viewers ?? 0 });
      },
    }),
  };
  return stub;
}

// ---- 构造最小 env（测试覆盖时用 overrides 替换） ----
export function makeEnv(overrides = {}) {
  return {
    DB: makeD1(),
    TERMINAL: makeTerminalStub(),
    METRICS: makeMetricsStub(),
    PANEL: makePanelStub(),
    JWT_SECRET: 'test-jwt-secret-0123456789abcdef',
    HASH_SECRET: 'test-hash-secret-0123456789abcdef',
    PANEL_PASSWORD: 'admin123',
    ...overrides,
  };
}

// 通用请求助手：调用 worker.fetch，可带 token / body / 客户端 IP
export function requestBuilder(worker) {
  // base 可覆盖：协议随访问协议派生 wss_base 的断言需要在 http/https 两种入口下验证
  return async function call(env, { method = 'GET', path, token, body, headers = {}, ip, base = 'http://panel.local' }) {
    const h = { ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    if (body !== undefined) h['content-type'] = 'application/json';
    if (ip) h['cf-connecting-ip'] = ip;
    const req = new Request(`${base}${path}`, {
      method,
      headers: h,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return worker.fetch(req, env);
  };
}

// 捕获 globalThis.fetch（sendWebhook 等内部 fetch 调用）并原样返回 200
export function captureFetch() {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return jsonResp({ ok: true });
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}
