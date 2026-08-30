// ============================================================
// 单元测试：内部纯函数（JWT/哈希/告警模板/分片路由/权限等）
// 运行：node --test test/unit.test.js
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import { __internals as I } from '../src/index.js';
import { makeEnv } from './helpers.js';

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
  // 有冒号但用户名为空（":pass"）→ 丢弃（旧行为）
  assert.deepEqual(I.parsePanelUsers({ PANEL_USERS: ':pass,ok:go' }), [{ username: 'ok', password: 'go' }]);
  // fail closed：无冒号的非空条目（密码/用户名含逗号的典型症状）→ 抛错暴露配置错误，
  // 不再静默截断（如 alice:pass,1 旧实现会把密码截成 pass 且真实密码永远登录失败）
  assert.throws(() => I.parsePanelUsers({ PANEL_USERS: 'a:p,bad' }), /无冒号/);
  assert.throws(() => I.parsePanelUsers({ PANEL_USERS: 'alice:pass,1' }), /无冒号/);
});

// ---------------- 哈希 ----------------
test('hashSecret 确定性且随输入/密钥变化', async () => {
  const h1 = await I.hashSecret('key1', env);
  assert.equal(h1, await I.hashSecret('key1', env));
  assert.equal(h1.length, 64);
  assert.notEqual(h1, await I.hashSecret('key2', env));
  assert.notEqual(h1, await I.hashSecret('key1', { JWT_SECRET: 'other' }));
});

test('verifySecretHash 使用 HMAC verify 校验且拒绝畸形哈希', async () => {
  const hash = await I.hashSecret('agent-key', env);
  assert.equal(await I.verifySecretHash('agent-key', hash, env), true);
  assert.equal(await I.verifySecretHash('wrong-key', hash, env), false);
  assert.equal(await I.verifySecretHash('agent-key', 'not-hex', env), false);
  assert.equal(await I.verifySecretHash('agent-key', '00', env), false);
});

test('WebSocket 安全身份：PAT 只保留 HMAC，JWT 只保留已验证 claims', async () => {
  const dbEnv = makeEnv();
  const pat = 'cfp_' + 'a'.repeat(64);
  const tokenHash = await I.hashSecret(pat, dbEnv);
  await dbEnv.DB.prepare('INSERT INTO api_tokens (user_id, name, token_hash, scopes) VALUES (?,?,?,?)')
    .bind(9, 'ws', tokenHash, JSON.stringify(['server:read'])).run();
  const patAuth = await I.authIdentityByToken(pat, dbEnv);
  assert.equal(patAuth.identity.kind, 'pat');
  assert.equal(patAuth.identity.tokenHash, tokenHash);
  assert.equal(JSON.stringify(patAuth.identity).includes(pat), false);
  assert.equal((await I.authUserByIdentity(patAuth.identity, dbEnv)).id, 9);

  const exp = Math.floor(Date.now() / 1000) + 60;
  const jwt = await I.signJwt({ uid: 7, username: 'alice', exp }, dbEnv);
  const jwtAuth = await I.authIdentityByToken(jwt, dbEnv);
  assert.deepEqual(jwtAuth.identity, { kind: 'jwt', id: 7, username: 'alice', role: 1, exp });
  assert.equal(JSON.stringify(jwtAuth.identity).includes(jwt), false);
});

test('上传签名使用 HMAC verify 并拒绝篡改', async () => {
  const signed = await I.signUploadToken(7, '/tmp/a.txt', false, env);
  assert.deepEqual(await I.verifyUploadToken(signed.token, 7, '/tmp/a.txt', false, env), { ok: true });
  assert.equal((await I.verifyUploadToken(signed.token, 8, '/tmp/a.txt', false, env)).ok, false);
  assert.equal((await I.verifyUploadToken(`${signed.token}x`, 7, '/tmp/a.txt', false, env)).ok, false);
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
  assert.deepEqual(I.sanitizeAlerts(null), {});
  assert.deepEqual(I.sanitizeAlerts('x'), {});
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

  // 非法 method 被丢弃；坏 headers JSON 被丢弃；PUT 在白名单内保留
  assert.equal(I.sanitizeAlerts({ method: 'DELETE' }).method, undefined);
  assert.equal(I.sanitizeAlerts({ headers: '{{{' }).headers, undefined);
  assert.equal(I.sanitizeAlerts({ method: 'put' }).method, 'PUT'); // 大小写归一 + PUT 允许
});

// ---------------- 上报 sanitize：磁盘 IO 白名单 ----------------
test('sanitizeReportPayload 磁盘 IO 嵌套对象白名单归一化', () => {
  // 合法上报：字符串数字归一化，未知键剔除
  const out = I.sanitizeReportPayload({
    serverId: 1,
    extra: {
      disk_io: { read_kbs: '12.4', write_kbs: 3.1, r_iops: '12', w_iops: 33, util_pct: 2.3, evil: 'x' },
    },
  });
  assert.deepEqual(out.extra.disk_io, {
    read_kbs: 12.4, write_kbs: 3.1, r_iops: 12, w_iops: 33, util_pct: 2.3,
  });
  // 恶意/坏数据：对象/多元素数组/'abc'/NaN → null；全无效时整个 disk_io 丢弃
  // （与既有 numOrNull 语义一致：单元素数组 [1]→1、null→0 会保留）
  const bad = I.sanitizeReportPayload({
    serverId: 1,
    extra: {
      disk_io: { read_kbs: {}, write_kbs: 'abc', r_iops: [1, 2], w_iops: NaN, util_pct: 'x' },
    },
  });
  assert.equal(bad.extra.disk_io, undefined);
  // 单元素数组按既有语义归一化为数字
  const arr = I.sanitizeReportPayload({
    serverId: 1,
    extra: { disk_io: { r_iops: [7], util_pct: null } },
  });
  assert.deepEqual(arr.extra.disk_io, { r_iops: 7, util_pct: 0 });
  // 非对象类型（数组/字符串）直接丢弃
  assert.equal(I.sanitizeReportPayload({ serverId: 1, extra: { disk_io: [1, 2] } }).extra.disk_io, undefined);
  assert.equal(I.sanitizeReportPayload({ serverId: 1, extra: { disk_io: 'x' } }).extra.disk_io, undefined);
});

// ---------------- 前端工具：系统路径 / 二进制扩展名 ----------------
// utils.js 是浏览器全局脚本（window.CfUtils，无 ES export），mock 最小 DOM 环境后 eval 加载
function loadI18nFirst() {
  for (const f of ['public/i18n.js', 'public/lang/zh-CN.js']) {
    (0, eval)(nodeFs.readFileSync(nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), '..', f), 'utf8'));
  }
}
function loadCfUtils() {
  globalThis.window = globalThis;
  // navigator 用 Node 内置只读全局即可（detectFlagEmoji 不依赖 UA，canvas ctx 为 null 走 catch）
  globalThis.document = { createElement: () => ({ getContext: () => null, width: 0, height: 0 }) };
  globalThis.HTMLElement = class HTMLElement { }; // utils.js IdleGuard 的 instanceof 引用
  globalThis.customElements = { define() { } }; // utils.js 顶部 customElements.define 调用
  loadI18nFirst();
  const src = nodeFs.readFileSync(nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), '../public/utils.js'), 'utf8');
  (0, eval)(src); // 间接 eval：全局作用域执行，挂载 window.CfUtils
  return globalThis.CfUtils;
}
const CfUtils = loadCfUtils();

function loadCfApi() {
  loadI18nFirst();

  const src = nodeFs.readFileSync(nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), '../public/api.js'), 'utf8');
  (0, eval)(src);
  return globalThis.CfApi;
}
const CfApi = loadCfApi();

test('FileSession.open 丢弃关闭后响应和并发乱序响应', async () => {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const originalLocation = globalThis.location;
  const pending = [];
  const sockets = [];
  globalThis.fetch = () => new Promise((resolve) => pending.push(resolve));
  globalThis.location = { protocol: 'https:', host: 'panel.test' };
  globalThis.WebSocket = class MockWebSocket {
    constructor(url) { this.url = url; this.readyState = 0; this.closed = false; sockets.push(this); }
    close() { this.closed = true; this.readyState = 3; }
    send() { }
  };
  const response = (sessionId) => ({ ok: true, json: async () => ({ session_id: sessionId }) });
  try {
    const session = new CfApi.FileSession();
    const first = session.open(1, '/one');
    const second = session.open(2, '/two');
    pending[1](response('new-session'));
    await second;
    pending[0](response('stale-session'));
    await first;
    assert.equal(sockets.length, 1, '乱序旧响应不得创建 WebSocket');
    assert.match(sockets[0].url, /\/ws\/file\/new-session$/);
    assert.equal(session.serverId, 2);

    const closedBeforeResponse = session.open(3, '/three');
    session.close();
    pending[2](response('closed-session'));
    await closedBeforeResponse;
    assert.equal(sockets.length, 1, '关闭后的迟到响应不得创建 WebSocket');
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
    globalThis.location = originalLocation;
  }
});

test('isSystemPath 词法归一化与黑名单（与 agent 同规则）', () => {
  assert.equal(CfUtils.isSystemPath('/etc/passwd'), true);
  assert.equal(CfUtils.isSystemPath('//etc/passwd'), true);
  assert.equal(CfUtils.isSystemPath('/home/../etc/x'), true);
  assert.equal(CfUtils.isSystemPath('etc/passwd'), true); // 相对路径 fail closed
  assert.equal(CfUtils.isSystemPath('/opt/app/bin'), false); // 部署目录放行
  assert.equal(CfUtils.isSystemPath('/srv/www'), false);
  assert.equal(CfUtils.isSystemPath('/home/u/dir'), false);
});

test('normalizeFileEntry 收口恶意 Agent 文件条目', () => {
  assert.deepEqual(CfUtils.normalizeFileEntry({
    name: 'x"><img src=x onerror=alert(1)>',
    type: '\"><img src=x onerror=alert(1)>',
    size: 'not-a-number',
    mtime: -1,
    mode: 'not-a-number', // 权限位同样来自 Agent，必须走数值收口
    path: { evil: 'object' }, // find 结果才有的字段：非字符串必须被收口为空串，不得进 HTML 属性
  }), {
    name: 'x"><img src=x onerror=alert(1)>',
    path: '',
    type: 'file',
    size: 0,
    mtime: 0,
    mode: 0,
  });
  assert.deepEqual(CfUtils.normalizeFileEntry({ name: 'dir', type: 'dir', size: '12', mtime: '34', mode: 0o755 }), {
    name: 'dir', path: '', type: 'dir', size: 12, mtime: 34, mode: 0o755,
  });
  // 递归搜索返回绝对路径：原样保留（渲染时再转相对路径 + escapeHtml）
  assert.equal(CfUtils.normalizeFileEntry({ name: 'a.log', path: '/var/log/a.log' }).path, '/var/log/a.log');
  // 数组/对象的 toString 会把内容拼出来——若用 String(v) 强转，下面这条会把
  // 完整 <img onerror> 原样带进收口结果（下游 escapeHtml 之外就再也拦不住了）
  assert.equal(
    CfUtils.normalizeFileEntry({ name: ['<img src=x onerror=alert(1)>'], path: ['<img src=x onerror=alert(1)>'] }).name,
    '',
    '非字符串字段必须收口为空串，不得 String() 强转',
  );
  assert.equal(CfUtils.normalizeFileEntry({ name: 123, path: 456 }).name, '');
  assert.equal(CfUtils.normalizeFileEntry({ name: 'x'.repeat(5000) }).name.length, 4096);
  const root = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), '..');
  const app = nodeFs.readFileSync(nodePath.join(root, 'public/app.js'), 'utf8');
  assert.match(app, /\.map\(normalizeFileEntry\)/, '文件列表渲染前必须统一收口');
  assert.doesNotMatch(app, /data-(?:type|size)="\$\{e\.(?:type|size)\}"/, '属性禁止直接插入 Agent 字段');
  // 权限位同样来自 Agent：必须走收口后的数值，不得原样插进属性
  assert.doesNotMatch(app, /data-mode="\$\{e\.mode\}"/, '权限位禁止直接插入 Agent 字段');
});

test('modeText：权限位格式化（rwxr-xr-x + 八进制）', () => {
  assert.equal(CfUtils.modeText(0o755), 'rwxr-xr-x (755)');
  assert.equal(CfUtils.modeText(0o644), 'rw-r--r-- (644)');
  assert.equal(CfUtils.modeText(0o600), 'rw------- (600)');
  assert.equal(CfUtils.modeText(0), '', '未知权限不显示，避免误导');
  assert.equal(CfUtils.modeText(undefined), '');
  // Windows 由 agent 把只读位折算为 0444/0666 上报，此处按 Unix 口径展示（近似）
  assert.equal(CfUtils.modeText(0o444), 'r--r--r-- (444)');
});

test('isBinaryExt 扩展名黑名单判定（集合带点，比较补点）', () => {
  // 命中黑名单：不显示编辑入口
  assert.equal(CfUtils.isBinaryExt('a.jpg'), true);
  assert.equal(CfUtils.isBinaryExt('photo.jpeg'), true);
  assert.equal(CfUtils.isBinaryExt('backup.tar.gz'), true); // 取最后扩展名 gz
  assert.equal(CfUtils.isBinaryExt('A.JPG'), true); // 大小写不敏感
  assert.equal(CfUtils.isBinaryExt('lib.so'), true);
  assert.equal(CfUtils.isBinaryExt('data.sqlite'), true);
  assert.equal(CfUtils.isBinaryExt('font.woff2'), true);
  // 文本/无扩展名：可编辑
  assert.equal(CfUtils.isBinaryExt('nginx.conf'), false);
  assert.equal(CfUtils.isBinaryExt('run.sh'), false);
  assert.equal(CfUtils.isBinaryExt('Makefile'), false);
  assert.equal(CfUtils.isBinaryExt('app.js'), false);
  assert.equal(CfUtils.isBinaryExt('README'), false);
  assert.equal(CfUtils.isBinaryExt(''), false);
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

test('sendWebhook：目标校验、禁重定向且日志不泄露 URL 凭证', async () => {
  const origFetch = globalThis.fetch;
  const origErr = console.error;
  const errs = [];
  console.error = (m) => errs.push(String(m));
  const cfg = { webhook_url: 'https://hooks.example.com/secret-path?access_token=query-secret', enabled: true };
  try {
    // 非 2xx → false + 错误日志，但不记录带凭证的完整 URL
    globalThis.fetch = async () => new Response('err', { status: 500 });
    assert.equal(await I.sendWebhook(cfg, { event: 'alert' }), false, '500 返回 false');
    assert.equal(errs.length, 1, '记录错误日志');
    assert.match(errs[0], /webhook failed.*500/);
    assert.doesNotMatch(errs[0], /secret-path|query-secret/);

    // 网络异常中的 URL 同样脱敏
    globalThis.fetch = async () => { throw new Error('net down at https://hooks.example.com/secret-path?access_token=query-secret'); };
    assert.equal(await I.sendWebhook(cfg, { event: 'probe_down' }), false, '网络异常返回 false');
    assert.equal(errs.length, 2, '记录网络错误日志');
    assert.match(errs[1], /webhook error.*net down.*\[redacted-url\]/);
    assert.doesNotMatch(errs[1], /secret-path|query-secret/);

    // 2xx → true，不记日志
    globalThis.fetch = async () => new Response('ok');
    assert.equal(await I.sendWebhook(cfg, { event: 'alert' }), true, '2xx 返回 true');
    assert.equal(errs.length, 2, '成功不记日志');

    // PUT 方法透传，GET 无 body，所有请求禁止自动跟随重定向
    let lastInit = null;
    globalThis.fetch = async (url, init) => { lastInit = init; return new Response('ok'); };
    await I.sendWebhook({ webhook_url: 'https://x/hook', enabled: true, method: 'PUT' }, { event: 'alert' });
    assert.equal(lastInit.method, 'PUT', 'PUT 透传');
    assert.ok(lastInit.body, 'PUT 携带 body');
    assert.equal(lastInit.redirect, 'error', '禁止跟随重定向');
    await I.sendWebhook({ webhook_url: 'https://x/hook', enabled: true, method: 'GET' }, { event: 'alert' });
    assert.equal(lastInit.method, 'GET', 'GET 透传');
    assert.equal(lastInit.body, undefined, 'GET 无 body');
    await I.sendWebhook({ webhook_url: 'https://x/hook', enabled: true, method: 'bogus' }, { event: 'alert' });
    assert.equal(lastInit.method, 'POST', '非法方法回退 POST');

    // 未启用/无 URL → false
    assert.equal(await I.sendWebhook({ enabled: false }, { event: 'alert' }), false);
    assert.equal(await I.sendWebhook({ enabled: true }, { event: 'alert' }), false);

    // 协议、URL 凭据及私网/保留地址在 fetch 前拒绝
    assert.equal(I.validateWebhookUrl('https://hooks.example.com/a').ok, true);
    for (const target of [
      'file:///etc/passwd', 'not a url', 'https://user:pass@example.com/hook',
      'http://localhost/hook', 'http://localhost./hook', 'http://127.0.0.1/hook', 'http://2130706433/hook',
      'http://10.0.0.1/hook', 'http://169.254.169.254/latest', 'http://[::1]/hook',
      'http://[fc00::1]/hook',
    ]) {
      assert.equal(I.validateWebhookUrl(target).ok, false, `应拒绝 ${target}`);
    }
  } finally {
    globalThis.fetch = origFetch;
    console.error = origErr;
  }
});

test('静态资源通过 _headers 下发完整 CSP', () => {
  const root = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), '..');
  const headers = nodeFs.readFileSync(nodePath.join(root, 'public/_headers'), 'utf8');
  const html = nodeFs.readFileSync(nodePath.join(root, 'public/index.html'), 'utf8');
  assert.match(headers, /Content-Security-Policy:/);
  assert.match(headers, /frame-ancestors 'none'/);
  assert.match(headers, /object-src 'none'/);
  assert.match(headers, /style-src 'self' https:\/\/cdnjs\.cloudflare\.com;/);
  assert.match(headers, /style-src-attr 'unsafe-inline'/);
  // style-src-elem 必须显式放开：xterm.js 在运行时把整张主题样式表注入 <style> 元素——
  // ANSI 调色板类 .xterm-fg-N/.xterm-bg-N、font-size/font-family、光标配色与闪烁 keyframes
  // 全在里面（静态 xterm.min.css 不含这些，仅布局）。仅放开 style-src-attr 时该元素被 CSP
  // 拦截，终端丢失全部调色板色与字号/等宽字体；真彩色转义因走内联 style 属性仍能显示，
  // 症状易被误判为「只是没颜色」。nonce/hash 不可用：内容由主题在运行时拼出，静态资源
  // 也无法逐请求注入 nonce。
  // style-src-elem 需放开 'unsafe-inline'，但必须连同 'self' + cdnjs 一起写全：
  // 该指令一旦显式设置，就是 <style> 元素**与 <link rel=stylesheet>** 的权威来源列表，
  // 不再回退 style-src——只写 'unsafe-inline' 会把 /style.css 等外部样式表一并拦掉
  //（整站样式失效）。style-src-attr 只管辖 style="..." 属性、无外部来源概念，不受影响。
  assert.match(
    headers,
    /style-src-elem 'self' https:\/\/cdnjs\.cloudflare\.com 'unsafe-inline'/,
    'style-src-elem 放开内联且保留外部样式表来源',
  );
  // 反向锁定：style-src 本身仍不得含 'unsafe-inline'（外部样式表来源仍限 'self' + cdnjs）。
  // 注意 style-src-elem/-attr 以连字符接续，不匹配下方 /style-src / 的空格形式。
  assert.doesNotMatch(headers, /style-src [^;]*'unsafe-inline'/, 'style-src 本身仍不含 unsafe-inline');
  // Web Analytics（手动嵌入）：脚本域与 RUM 上报端点按域放行；token 走 data-cf-beacon
  // 属性（不受 script-src 管辖），故无需 'unsafe-inline'/hash——这也是弃用 Automatic Setup
  // 自动注入的原因（自动注入塞内联启动代码，与严格 script-src 天然冲突）。
  assert.match(headers, /script-src 'self' https:\/\/cdnjs\.cloudflare\.com https:\/\/static\.cloudflareinsights\.com;/);
  assert.match(headers, /connect-src [^;]*https:\/\/cloudflareinsights\.com/, 'RUM 上报端点已放行');
  // 反向锁定：script-src 绝不带 'unsafe-inline'（XSS 第二层防线，任何内联脚本不得执行）。
  assert.doesNotMatch(headers, /script-src [^;]*'unsafe-inline'/, 'script-src 不得含 unsafe-inline');
  // 手动嵌入的 beacon 存在且为纯外链（无内联代码）
  assert.match(html, /https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js/, 'beacon 已手动嵌入');
  assert.doesNotMatch(html, /http-equiv="Content-Security-Policy"/i, 'CSP 只维护一份响应头配置');
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

test('sanitizeAlertOverride：只保留合法维度，load 允许 0（关闭该维度）', () => {
  // mem_pct:0 无意义（阈值 0 = 永远告警）→ 丢弃；load:0 是"关闭负载告警"的显式值 → 保留
  assert.deepEqual(I.sanitizeAlertOverride({ cpu_pct: 80, mem_pct: 0, load: 0, bogus: 1 }),
    { cpu_pct: 80, load: 0 });
  assert.deepEqual(I.sanitizeAlertOverride({ cpu_pct: 95, mem_pct: 90, disk_pct: 85, offline_after_s: 600 }),
    { cpu_pct: 95, mem_pct: 90, disk_pct: 85, offline_after_s: 600 });
  // 全非法 → null（不存噪音，走全局阈值）
  assert.equal(I.sanitizeAlertOverride({ cpu_pct: -5 }), null);
  assert.equal(I.sanitizeAlertOverride({}), null);
  assert.equal(I.sanitizeAlertOverride(null), null);
  assert.equal(I.sanitizeAlertOverride([]), null, '数组不接受（typeof [] === "object"）');
});

test('sanitizeAlerts：mute_until 仅接受正数（0/负数/非法不落库）', () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  assert.equal(I.sanitizeAlerts({ mute_until: future }).mute_until, future);
  assert.equal(I.sanitizeAlerts({ mute_until: 0 }).mute_until, undefined);
  assert.equal(I.sanitizeAlerts({ mute_until: -1 }).mute_until, undefined);
  assert.equal(I.sanitizeAlerts({ mute_until: 'abc' }).mute_until, undefined);
});

test('按天统计时间工具：天序号与起始时间戳可互相还原', () => {
  const ts = 1767225600; // 任意 UTC 时刻
  for (const offset of [0, 8 * 3600, -5 * 3600]) {
    const day = I.dayIndexOf(ts, offset);
    const start = I.dayStartTs(day, offset);
    assert.ok(start <= ts && ts - start < 86400, '天起始时间应落在同一天内');
    assert.equal(I.dayIndexOf(start, offset), day, '起始时间的天序号应还原为同一天');
  }
});

// ---------------- 国际化（i18n） ----------------
// i18n.js 同为浏览器全局脚本（window.CfI18n，无 ES export），mock 最小环境后 eval 加载。
// 目前仅内置 zh-CN，但结构与 API 按多语言设计——以下断言锁定"结构可用"，而非"只有中文"。
function loadCfI18n() {
  globalThis.window = globalThis;
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  // 不 mock navigator：Node 21+ 的 globalThis.navigator 是只读 getter，赋值会抛错；
  // i18n.js 的 detectLocale 用 try/catch 包裹，读不到浏览器语言时安全回退默认语言。
  globalThis.document = { documentElement: {}, querySelectorAll: () => [] };
  // 与 index.html 的脚本顺序一致：先框架后语言包（语言包加载时向框架注册）
  const root = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), '..');
  for (const f of ['public/i18n.js', 'public/lang/zh-CN.js']) {
    const src = nodeFs.readFileSync(nodePath.join(root, f), 'utf8');
    (0, eval)(src); // 间接 eval：全局作用域执行，挂载 window.CfI18n
  }
  return globalThis.CfI18n;
}

test('i18n：t() 翻译与插值，缺失 key 原样返回', () => {
  const i18n = loadCfI18n();
  assert.equal(i18n.t('common.save'), '保存');
  assert.equal(i18n.t('server.selected', { n: 3 }), '已选 3 台');
  // 缺失回退：返回 key 本身——开发期一眼看出未翻译项，线上也不会出现"界面空白"这种更糟形态
  assert.equal(i18n.t('does.not.exist'), 'does.not.exist');
  assert.equal(i18n.t(''), '');
  // 占位符无对应变量时保留原样（不静默吞掉，便于发现漏传参数）
  assert.equal(i18n.t('server.updateFailed', {}), 'Agent 更新失败：{err}');
});

test('i18n：多语言结构可用——注册语言包即生效，setLocale 广播订阅者', () => {
  const i18n = loadCfI18n();
  // 语言包已外置到 public/lang/*.js，加载器只装了 zh-CN
  assert.deepEqual(i18n.supported().map((l) => l.code), ['zh-CN']);
  // 注册一个新语言包并切换 → t() 立即走新包
  i18n.register('en-US', { 'common.save': 'Save', 'server.selected': '{n} selected' });
  // 显式回到中文起点：Node 的 navigator 语言不确定，detectLocale 可能已直接落在
  // en-US（浏览器语言自动检测是产品预期行为），不回起点的话下面的切换会因幂等不广播
  assert.equal(i18n.setLocale('zh-CN'), true);
  let notified = 0;
  const off = i18n.onChange(() => notified += 1);
  assert.equal(i18n.setLocale('en-US'), true);
  assert.equal(i18n.locale, 'en-US');
  assert.equal(i18n.t('common.save'), 'Save');
  assert.equal(i18n.t('server.selected', { n: 2 }), '2 selected');
  assert.equal(notified, 1, '切换应广播订阅者（界面刷新依赖它）');
  // 同语言重复设置幂等：不写存储、不广播（避免无意义的全界面重渲染）
  assert.equal(i18n.setLocale('en-US'), true);
  assert.equal(notified, 1, '幂等切换不得重复广播');
  off();
  // 未登记（无语言包）的语言不得选中：避免落到"半翻译"状态
  assert.equal(i18n.setLocale('fr-FR'), false);
  assert.equal(i18n.locale, 'en-US');
  i18n.__reset();
});

test('i18n：zh-CN 与 en-US 语言包 key 结构完全同构', () => {
  const root = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), '..');
  const keys = (f) => new Set([...nodeFs.readFileSync(nodePath.join(root, f), 'utf8')
    .matchAll(/'([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)':/g)].map((m) => m[1]));
  const zh = keys('public/lang/zh-CN.js');
  const en = keys('public/lang/en-US.js');
  assert.ok(zh.size > 300, `中文包应覆盖全部 key（当前 ${zh.size}）`);
  const onlyZh = [...zh].filter((k) => !en.has(k));
  const onlyEn = [...en].filter((k) => !zh.has(k));
  assert.deepEqual(onlyZh, [], `以下 key 缺英文翻译：${onlyZh.join(', ')}`);
  assert.deepEqual(onlyEn, [], `以下 key 中文包没有（疑似拼写不一致）：${onlyEn.join(', ')}`);
});

test('i18n：index.html 引用的 data-i18n key 必须都在语言包中定义', () => {
  const i18n = loadCfI18n();
  const root = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), '..');
  const html = nodeFs.readFileSync(nodePath.join(root, 'public/index.html'), 'utf8');
  const keys = [...html.matchAll(/data-i18n(?:-html|-ph|-title|-aria)?="([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)"/g)]
    .map((m) => m[1]);
  assert.ok(keys.length > 50, `静态文本应已接入 i18n（当前 ${keys.length} 处）`);
  // 缺失 key 会被原样显示成 "server.xxx"，是肉眼可见的界面故障——在此提前拦住
  const broken = keys.filter((k) => i18n.t(k) === k);
  assert.deepEqual(broken, [], `以下 key 未在语言包定义：${broken.join(', ')}`);
});

test('i18n：app.js 面向用户的提示不得残留中文字面量', () => {
  const root = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), '..');
  const app = nodeFs.readFileSync(nodePath.join(root, 'public/app.js'), 'utf8');
  // 残留中文 = 新语言加了也不生效。注意只校验"面向用户"的输出，
  // 代码注释里的中文不在 i18n 范围内（注释是给维护者看的）。
  assert.doesNotMatch(app, /toast\('[^']*[一-龥]/, '单引号 toast 文案须走 t()');
  assert.doesNotMatch(app, /toast\(`[^`]*[一-龥]/, '模板 toast 文案须走 t()');
  assert.match(app, /const \{ t \} = CfI18n/, 'app.js 须解构 t()');
  assert.match(app, /CfI18n\.applyDom\(\)/, '启动时须填充静态 DOM 文案');
});

test('终端多标签：会话表取代单例，关闭时三类资源都要释放（静态断言）', () => {
  const root = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), '..');
  const app = nodeFs.readFileSync(nodePath.join(root, 'public/app.js'), 'utf8');
  // 单例残留会让主题切换/渲染器切换只作用于某一个标签（多标签下必现的错乱）
  assert.doesNotMatch(app, /\bactiveTerm\b/, 'activeTerm 单例须由 termSessions 会话表取代');
  assert.doesNotMatch(app, /\bactiveWebglAddon\b/, 'WebGL addon 改为每标签独立持有');
  assert.doesNotMatch(app, /\bactiveTermFit\b/);
  // 会话表与并发上限（浏览器每页 WebGL 上下文约 8~16 个）
  assert.match(app, /const termSessions = new Map\(\)/);
  assert.match(app, /TERM_MAX_TABS/);
  // 关闭标签要释放三样东西，漏一个都会累积泄漏
  assert.match(app, /s\.sess\.close\(\)/, '关闭 WS 会话（含 dispose 与定时器清理）');
  assert.match(app, /window\.removeEventListener\('resize', s\.onResize\)/, '移除 resize 监听');
  assert.match(app, /detachWebglAddonOf\(s\)/, '显式释放 WebGL 上下文（每页数量有硬上限）');
  // 切回标签必须重新测量：隐藏期间 pane 尺寸为 0，行列数不会自动更新
  assert.match(app, /cur\.fit\.fit\(\)/);
  // 同服务器复用既有标签：否则每次点「终端」都会新开一个，误开一堆同机终端
  assert.match(app, /s\.serverId === Number\(serverId\)/, '同服务器复用既有标签');
  // 主题切换要覆盖所有标签，不能只管当前那个
  assert.match(app, /for \(const s of termSessions\.values\(\)\) s\.term\.options\.theme/);
});

test('Esc 关闭弹窗：按 data-close 属性识别关闭按钮，不取第一个 button.icon', () => {
  const root = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), '..');
  const app = nodeFs.readFileSync(nodePath.join(root, 'public/app.js'), 'utf8');
  // 终端 head 的渲染器切换与「＋」都是 button.icon 且排在 ✕ 之前——取第一个会把
  // Esc 变成"切换渲染器"，弹窗关不掉；按 title/文案匹配又会随语言切换失效。
  // data-close 属性与语言无关，是唯一可靠标识。
  assert.doesNotMatch(app, /open\.querySelector\('\.modal-head button\.icon'\)/);
  assert.doesNotMatch(app, /\/关闭\/\.test\(b\.title/, '不得按「关闭」文案匹配（切语言后失效）');
  assert.match(app, /hasAttribute\('data-close'\)/, '按 data-close 属性筛选');
  // index.html 的弹窗 ✕ 按钮必须都带 data-close（缺了该弹窗 Esc 关不掉）
  const html = nodeFs.readFileSync(nodePath.join(root, 'public/index.html'), 'utf8');
  const withClose = (html.match(/data-close aria-label="关闭/g) || []).length;
  assert.ok(withClose >= 10, `弹窗关闭按钮应都带 data-close（当前 ${withClose} 个）`);
});

test('PWA：manifest 声明与图标文件齐备（支持"添加到主屏幕"）', () => {
  const root = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), '..');
  const html = nodeFs.readFileSync(nodePath.join(root, 'public/index.html'), 'utf8');
  assert.match(html, /rel="manifest"/, 'index.html 必须声明 manifest 才具备可安装性');
  assert.match(html, /name="theme-color"/);

  const mf = JSON.parse(nodeFs.readFileSync(nodePath.join(root, 'public/manifest.webmanifest'), 'utf8'));
  assert.equal(mf.display, 'standalone');
  assert.ok(mf.icons && mf.icons.length >= 1);
  for (const ic of mf.icons) {
    // 图标必须是同源真实文件：data URI 在部分平台（尤其 iOS）不被识别为可安装图标
    assert.match(ic.src, /^\//, `图标 ${ic.src} 应为同源绝对路径`);
    assert.ok(nodeFs.existsSync(nodePath.join(root, 'public', ic.src)), `图标文件缺失：${ic.src}`);
  }
  // CSP 未显式声明 manifest-src → 回落 default-src 'self'，同源 manifest 与图标不受阻
  const headers = nodeFs.readFileSync(nodePath.join(root, 'public/_headers'), 'utf8');
  assert.doesNotMatch(headers, /manifest-src/, '未设 manifest-src 时回落 default-src（self 已覆盖同源）');
});
