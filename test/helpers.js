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

// R2 内存 mock：覆盖生产用到的 API 子集（put/get/head/delete/list）。
// 不连真实 R2：测试必须可离线运行，且 R2 的最终一致性与计费行为不参与断言。
// put 支持 string / ArrayBuffer / Uint8Array / ReadableStream / Request.body（流式写入）。
export function makeR2() {
  const objects = new Map(); // key -> { data, size, uploaded, customMetadata, httpMetadata }
  const ops = []; // 调用序列，供"是否写入/是否删除"类断言使用

  async function toBytes(value) {
    if (value == null) return new Uint8Array(0);
    if (typeof value === 'string') return new TextEncoder().encode(value);
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (typeof value.getReader === 'function') {
      // ReadableStream（Request.body 或手工构造）→ 累积
      const reader = value.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        chunks.push(u8);
        total += u8.byteLength;
      }
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.byteLength; }
      return out;
    }
    if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
    throw new TypeError('unsupported R2 put value');
  }

  return {
    objects,
    ops,
    async put(key, value, opts = {}) {
      const data = await toBytes(value);
      objects.set(key, {
        data,
        size: data.byteLength,
        uploaded: new Date(),
        customMetadata: opts.customMetadata || {},
        httpMetadata: opts.httpMetadata || {},
      });
      ops.push({ op: 'put', key, size: data.byteLength });
      return { key, size: data.byteLength };
    },
    async get(key) {
      ops.push({ op: 'get', key });
      const obj = objects.get(key);
      if (!obj) return null;
      return {
        key,
        size: obj.size,
        customMetadata: obj.customMetadata,
        httpMetadata: obj.httpMetadata,
        body: new Blob([obj.data]).stream(),
        async arrayBuffer() {
          return obj.data.buffer.slice(obj.data.byteOffset, obj.data.byteOffset + obj.data.byteLength);
        },
        async text() { return new TextDecoder().decode(obj.data); },
      };
    },
    async head(key) {
      ops.push({ op: 'head', key });
      const obj = objects.get(key);
      if (!obj) return null;
      return { key, size: obj.size, customMetadata: obj.customMetadata, httpMetadata: obj.httpMetadata, uploaded: obj.uploaded };
    },
    async delete(key) {
      ops.push({ op: 'delete', key });
      return objects.delete(key);
    },
    async list(opts = {}) {
      ops.push({ op: 'list', prefix: opts.prefix });
      const prefix = opts.prefix || '';
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      return {
        objects: keys.map((k) => ({ key: k, size: objects.get(k).size, uploaded: objects.get(k).uploaded })),
        truncated: false,
      };
    },
  };
}

// ---- 构造最小 env（测试覆盖时用 overrides 替换） ----
export function makeEnv(overrides = {}) {
  return {
    DB: makeD1(),
    UPLOADS: makeR2(),
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
