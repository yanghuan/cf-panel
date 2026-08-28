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
function loadCfUtils() {
  globalThis.window = globalThis;
  // navigator 用 Node 内置只读全局即可（detectFlagEmoji 不依赖 UA，canvas ctx 为 null 走 catch）
  globalThis.document = { createElement: () => ({ getContext: () => null, width: 0, height: 0 }) };
  globalThis.HTMLElement = class HTMLElement { }; // utils.js IdleGuard 的 instanceof 引用
  globalThis.customElements = { define() { } }; // utils.js 顶部 customElements.define 调用
  const src = nodeFs.readFileSync(nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), '../public/utils.js'), 'utf8');
  (0, eval)(src); // 间接 eval：全局作用域执行，挂载 window.CfUtils
  return globalThis.CfUtils;
}
const CfUtils = loadCfUtils();

function loadCfApi() {
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
  }), {
    name: 'x"><img src=x onerror=alert(1)>',
    type: 'file',
    size: 0,
    mtime: 0,
  });
  assert.deepEqual(CfUtils.normalizeFileEntry({ name: 'dir', type: 'dir', size: '12', mtime: '34' }), {
    name: 'dir', type: 'dir', size: 12, mtime: 34,
  });
  assert.equal(CfUtils.normalizeFileEntry({ name: 'x'.repeat(5000) }).name.length, 4096);
  const root = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), '..');
  const app = nodeFs.readFileSync(nodePath.join(root, 'public/app.js'), 'utf8');
  assert.match(app, /\.map\(normalizeFileEntry\)/, '文件列表渲染前必须统一收口');
  assert.doesNotMatch(app, /data-(?:type|size)="\$\{e\.(?:type|size)\}"/, '属性禁止直接插入 Agent 字段');
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
  assert.match(headers, /X-Frame-Options: DENY/);
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
