// ============================================================
// 单元测试：内部纯函数（JWT/哈希/告警模板/分片路由/权限等）
// 运行：node --test test/unit.test.js
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { __internals as I } from '../src/index.js';

const env = { JWT_SECRET: 'unit-secret' };

test.beforeEach(() => I.__reset());

// ---------------- 编码 / JWT ----------------
test('b64u / b64uDecode 往返一致', () => {
  const s = 'hello 世界 🚀';
  assert.equal(new TextDecoder().decode(I.b64uDecode(I.b64u(s))), s);
  // 标准向量：{"a":1}
  assert.equal(I.b64u(JSON.stringify({ a: 1 })), 'eyJhIjoxfQ');
});

test('signJwt / verifyJwt 正常签发与验证', async () => {
  const token = await I.signJwt({ uid: 1, username: 'admin', role: 1, exp: Math.floor(Date.now() / 1000) + 3600 }, env);
  const payload = await I.verifyJwt(token, env);
  assert.equal(payload.uid, 1);
  assert.equal(payload.username, 'admin');
  assert.equal(payload.role, 1);
});

test('verifyJwt 拒绝篡改 / 错误密钥 / 畸形 token', async () => {
  const token = await I.signJwt({ uid: 1 }, env);
  const [h, , s] = token.split('.');
  // payload 被改成 uid=2
  const tampered = `${h}.${I.b64u(JSON.stringify({ uid: 2 }))}.${s}`;
  assert.equal(await I.verifyJwt(tampered, env), null);
  // 换密钥
  assert.equal(await I.verifyJwt(token, { JWT_SECRET: 'other-secret' }), null);
  // 畸形
  assert.equal(await I.verifyJwt('a.b', env), null);
  assert.equal(await I.verifyJwt('', env), null);
  assert.equal(await I.verifyJwt('a.b.c.d', env), null);
});

test('verifyJwt 拒绝过期 token', async () => {
  const token = await I.signJwt({ uid: 1, exp: Math.floor(Date.now() / 1000) - 10 }, env);
  assert.equal(await I.verifyJwt(token, env), null);
});

test('secret 缺失或为空时拒绝启动鉴权，不使用固定默认值', async () => {
  assert.throws(() => I.secret({}), /JWT_SECRET not set/);
  assert.throws(() => I.secret({ JWT_SECRET: '   ' }), /JWT_SECRET not set/);
  assert.equal(I.secret({ JWT_SECRET: 'x' }), 'x');
  await assert.rejects(() => I.signJwt({ uid: 1 }, {}), /JWT_SECRET not set/);
  assert.equal(await I.verifyJwt('a.b.c', {}), null);
});

// ---------------- 用户解析 ----------------
test('parsePanelUsers', () => {
  assert.deepEqual(I.parsePanelUsers({}), []);
  assert.deepEqual(I.parsePanelUsers({ PANEL_PASSWORD: 'p' }), [{ username: 'admin', password: 'p' }]);
  assert.deepEqual(I.parsePanelUsers({ PANEL_USERS: 'alice:pass1,bob:pass2' }), [
    { username: 'alice', password: 'pass1' },
    { username: 'bob', password: 'pass2' },
  ]);
  // 密码可含 ':'（按第一个冒号分割）
  assert.deepEqual(I.parsePanelUsers({ PANEL_USERS: 'a:x:y,b:z' }), [
    { username: 'a', password: 'x:y' },
    { username: 'b', password: 'z' },
  ]);
  // 空项被过滤
  assert.deepEqual(I.parsePanelUsers({ PANEL_USERS: 'a:p,,' }), [{ username: 'a', password: 'p' }]);
  // 边界：无冒号条目（旧实现会截断末字符成 "ba"/"bad"）、空用户名条目均被丢弃
  assert.deepEqual(I.parsePanelUsers({ PANEL_USERS: 'a:p,bad,:' }), [{ username: 'a', password: 'p' }]);
  assert.deepEqual(I.parsePanelUsers({ PANEL_USERS: ':pass,ok:go' }), [{ username: 'ok', password: 'go' }]);
});

// ---------------- 哈希 ----------------
test('hashSecret 确定性且随输入/密钥变化', async () => {
  const h1 = await I.hashSecret('key1', env);
  assert.equal(h1, await I.hashSecret('key1', env));
  assert.equal(h1.length, 64);
  assert.notEqual(h1, await I.hashSecret('key2', env));
  assert.notEqual(h1, await I.hashSecret('key1', { JWT_SECRET: 'other' }));
});

test('hashSecret：未配置 HASH_SECRET 时回退 JWT_SECRET（平滑迁移）', async () => {
  // 只有 JWT_SECRET，无 HASH_SECRET → 用 JWT_SECRET 作为哈希密钥
  const noHash = await I.hashSecret('key1', env);
  assert.equal(noHash, await I.hashSecret('key1', { JWT_SECRET: 'unit-secret' }));
  // 与直接回退逻辑等价
  assert.equal(noHash, await I.hashSecret('key1', { JWT_SECRET: 'unit-secret', HASH_SECRET: undefined }));
});

test('hashSecret：HASH_SECRET 优先于 JWT_SECRET，两者独立', async () => {
  const e = { JWT_SECRET: 'jwt-secret', HASH_SECRET: 'hash-secret' };
  const withHash = await I.hashSecret('key1', e);
  // HASH_SECRET 生效 → 结果不等于仅用 JWT_SECRET 计算的值
  assert.notEqual(withHash, await I.hashSecret('key1', { JWT_SECRET: 'jwt-secret' }));
  // 确定性
  assert.equal(withHash, await I.hashSecret('key1', e));
  // 与直接用 HASH_SECRET 计算的值一致（确认哈希密钥取的是 HASH_SECRET）
  assert.equal(withHash, await I.hashSecret('key1', { HASH_SECRET: 'hash-secret' }));
});

test('sha256Hex 标准向量', async () => {
  assert.equal(await I.sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(await I.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('randomHex 长度与字符集', () => {
  const a = I.randomHex(32);
  assert.equal(a.length, 64);
  assert.match(a, /^[0-9a-f]+$/);
});

// ---------------- 时间范围 / JSON ----------------
test('parseRangeHours', () => {
  assert.equal(I.parseRangeHours('1h'), 1);
  assert.equal(I.parseRangeHours('12h'), 12);
  assert.equal(I.parseRangeHours('3d'), 72);
  assert.equal(I.parseRangeHours('7d'), 168);
  assert.equal(I.parseRangeHours('30d'), 720);
  assert.equal(I.parseRangeHours('bad'), 12);
  assert.equal(I.parseRangeHours(''), 12);
  assert.equal(I.parseRangeHours(undefined), 12);
  assert.equal(I.parseRangeHours(null), 12);
});

test('safeJson', () => {
  assert.deepEqual(I.safeJson('{"a":1}'), { a: 1 });
  assert.equal(I.safeJson('not json'), null);
  assert.equal(I.safeJson(null), null);
  assert.equal(I.safeJson(undefined), null);
});

// ---------------- 告警配置清洗 ----------------
test('sanitizeAlerts', () => {
  assert.equal(I.sanitizeAlerts(null), undefined);
  assert.equal(I.sanitizeAlerts('x'), undefined);
  assert.deepEqual(I.sanitizeAlerts({}), {});

  const out = I.sanitizeAlerts({
    webhook_url: ' https://example.com/hook ',
    webhook_token: 'tok',
    method: 'get',
    body_template: '{message}',
    content_type: 'text/plain',
    headers: '{"Authorization":"Bearer {token}"}',
    cpu_pct: 85,
    mem_pct: '0',
    disk_pct: -5,
    load: 2,
    cooldown_min: 10,
    offline_after_s: 120,
  });
  assert.equal(out.webhook_url, 'https://example.com/hook');
  assert.equal(out.webhook_token, 'tok');
  assert.equal(out.method, 'GET');
  assert.equal(out.body_template, '{message}');
  assert.equal(out.content_type, 'text/plain');
  assert.deepEqual(out.headers, { Authorization: 'Bearer {token}' });
  assert.equal(out.cpu_pct, 85);
  assert.equal(out.mem_pct, 90); // 0 → 默认
  assert.equal(out.disk_pct, 90); // 负数 → 默认
  assert.equal(out.load, 2);
  assert.equal(out.cooldown_min, 10);
  assert.equal(out.offline_after_s, 120);

  // 非法 method 被丢弃；坏 headers JSON 被丢弃
  assert.equal(I.sanitizeAlerts({ method: 'DELETE' }).method, undefined);
  assert.equal(I.sanitizeAlerts({ headers: '{{{' }).headers, undefined);
});

// ---------------- 模板渲染 / Headers ----------------
test('renderTemplate 占位符替换，缺失键替换为空', () => {
  const vars = { event: 'alert', title: 'T', token: 'tok' };
  assert.equal(I.renderTemplate('[{event}] {title} {missing}', vars), '[alert] T ');
  assert.equal(I.renderTemplate('', vars), '');
  assert.equal(I.renderTemplate(null, vars), '');
});

test('parseHeaders 支持对象与 JSON 字符串并做占位符替换', () => {
  const vars = { event: 'alert', token: 'tok' };
  assert.deepEqual(I.parseHeaders({ Authorization: 'Bearer {token}' }, vars), { Authorization: 'Bearer tok' });
  assert.deepEqual(I.parseHeaders('{"A":"{event}"}', vars), { A: 'alert' });
  assert.deepEqual(I.parseHeaders('{{', vars), {});
  assert.deepEqual(I.parseHeaders(null, vars), {});
  assert.deepEqual(I.parseHeaders(123, vars), {});
});

test('sendWebhook：非 2xx / 网络异常记错误日志并返回 false（M-08）', async () => {
  const origFetch = globalThis.fetch;
  const origErr = console.error;
  const errs = [];
  console.error = (m) => errs.push(String(m));
  const cfg = { webhook_url: 'https://x/hook', enabled: true };
  try {
    // 非 2xx → false + 错误日志（Cloudflare 后台 Worker 日志可见）
    globalThis.fetch = async () => new Response('err', { status: 500 });
    assert.equal(await I.sendWebhook(cfg, { event: 'alert' }), false, '500 返回 false');
    assert.equal(errs.length, 1, '记录错误日志');
    assert.match(errs[0], /webhook failed.*500/);

    // 网络异常 → false + 错误日志
    globalThis.fetch = async () => { throw new Error('net down'); };
    assert.equal(await I.sendWebhook(cfg, { event: 'probe_down' }), false, '网络异常返回 false');
    assert.equal(errs.length, 2, '记录网络错误日志');
    assert.match(errs[1], /webhook error.*net down/);

    // 2xx → true，不记日志
    globalThis.fetch = async () => new Response('ok');
    assert.equal(await I.sendWebhook(cfg, { event: 'alert' }), true, '2xx 返回 true');
    assert.equal(errs.length, 2, '成功不记日志');

    // M-09：PUT 方法透传，不再被改写成 POST；GET 无 body
    let lastInit = null;
    globalThis.fetch = async (url, init) => { lastInit = init; return new Response('ok'); };
    await I.sendWebhook({ webhook_url: 'https://x/hook', enabled: true, method: 'PUT' }, { event: 'alert' });
    assert.equal(lastInit.method, 'PUT', 'PUT 透传');
    assert.ok(lastInit.body, 'PUT 携带 body');
    await I.sendWebhook({ webhook_url: 'https://x/hook', enabled: true, method: 'GET' }, { event: 'alert' });
    assert.equal(lastInit.method, 'GET', 'GET 透传');
    assert.equal(lastInit.body, undefined, 'GET 无 body');
    await I.sendWebhook({ webhook_url: 'https://x/hook', enabled: true, method: 'bogus' }, { event: 'alert' });
    assert.equal(lastInit.method, 'POST', '非法方法回退 POST');

    // 未启用/无 URL → false
    assert.equal(await I.sendWebhook({ enabled: false }, { event: 'alert' }), false);
    assert.equal(await I.sendWebhook({ enabled: true }, { event: 'alert' }), false);
  } finally {
    globalThis.fetch = origFetch;
    console.error = origErr;
  }
});

// ---------------- 分片路由 ----------------
test('shard 路由：服务器 id → 分片，streamId 前缀带分片', () => {
  assert.equal(I.shardForServerId(0), 0);
  assert.equal(I.shardForServerId(4), 0);
  assert.equal(I.shardForServerId(5), 1);
  assert.equal(I.shardForServerId(7), 3);
  const id = I.makeStreamId(5);
  assert.match(id, /^1-[0-9a-f-]{36}$/);
  assert.equal(I.shardFromStreamId(id), 1);
  assert.equal(I.shardFromStreamId('3-abc'), 3);
  assert.equal(I.shardFromStreamId('zz'), 0);
  assert.equal(I.shardFromStreamId(''), 0);
});

// ---------------- 权限 ----------------
test('isAdmin / canAccessServer / canExec', () => {
  const admin = { id: 1, role: 1, pat: null };
  const member = { id: 2, role: 0, pat: null };
  const patRead = { id: 1, role: 0, pat: { scopes: ['server:read'], serverIDs: null } };
  const patExec = { id: 1, role: 0, pat: { scopes: ['server:exec'], serverIDs: null } };
  const patBoth = { id: 1, role: 0, pat: { scopes: ['server:read', 'server:exec'], serverIDs: [1] } };
  const s1 = { id: 1, user_id: 2 };
  const s2 = { id: 2, user_id: 3 };

  assert.equal(I.isAdmin(admin), true);
  assert.equal(I.isAdmin(member), false);
  assert.equal(I.isAdmin(patRead), false);

  // 管理员全量
  assert.equal(I.canAccessServer(admin, s1), true);
  assert.equal(I.canExec(admin, s1), true);
  // 普通成员只能访问自己的
  assert.equal(I.canAccessServer(member, s1), true);
  assert.equal(I.canAccessServer(member, s2), false);
  // PAT：读依赖 server:read，执行依赖 server:exec
  assert.equal(I.canAccessServer(patRead, s1), true);
  assert.equal(I.canExec(patRead, s1), false);
  assert.equal(I.canAccessServer(patExec, s1), false);
  assert.equal(I.canExec(patExec, s1), true);
  // PAT 白名单
  assert.equal(I.canAccessServer(patBoth, s1), true);
  assert.equal(I.canAccessServer(patBoth, s2), false);
  assert.equal(I.canExec(patBoth, s2), false);
  // 未登录
  assert.equal(I.canAccessServer(null, s1), false);
  assert.equal(I.canExec(null, s1), false);
});

// 注：告警触发/冷却/探活用例已随状态迁移至 MetricsDO（见 test/do.test.js），
// 通过 /report 顺风车路径验证，覆盖"单实例全局去重"。
