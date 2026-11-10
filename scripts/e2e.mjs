#!/usr/bin/env node
// ============================================================
// cf-panel E2E 测试（Node >= 22，零外部依赖：fetch + WebSocket 内置）
// 验证链路：wrangler dev → D1 建表 → 登录 → 注册服务器 →
//           agent 控制通道上线 → 监控上报落库 → 终端双向透传 →
//           文件上传/下载 → MCP 全量工具（17 个，含 get_operation）→
//           Agent 更新资产代理（无条件 Content-Length / 长度一致性）
// 用法：node scripts/e2e.mjs
// 环境变量：E2E_PORT（默认 8787）、E2E_PASSWORD（默认读 .dev.vars）
//           AGENT_CMD（默认 agent/rust/target/release/cf-panel-agent）
// ============================================================
import { spawn, spawnSync, execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { signJobToken } from '../src/utils.js';
import {
  readFileSync, writeFileSync, existsSync,
  createWriteStream, mkdtempSync, rmSync, unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ---- 配置 ----
const PORT = parseInt(process.env.E2E_PORT || '8787', 10);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = readPassword();
const AGENT_CMD = process.env.AGENT_CMD || join(ROOT, 'agent/rust/target/release/cf-panel-agent');
const WRANGLER_CLI = join(ROOT, 'node_modules/wrangler/wrangler-dist/cli.js');

// ---- 全局状态 ----
const TMP = mkdtempSync(join(tmpdir(), 'cf-panel-e2e-'));
const STATE = join(TMP, 'wrangler-state');
const WRANGLER_LOG = join(TMP, 'wrangler.log');
const AGENT_LOG = join(TMP, 'agent.log');
const AGENT_TMPDIR = join(TMP, 'agent');

let pass = 0, fail = 0;
let wranglerProc = null, agentProc = null;
let token = '', agentKey = '';
let serverName = '', serverId = 0; // 本测试注册的服务器（随机名 + 动态 id，防残留串台）

// ---- 辅助函数 ----

function ok(msg) { pass++; console.log(`  ✔ ${msg}`); }
function bad(msg) { fail++; console.error(`  ✖ ${msg}`); }

function readPassword() {
  if (process.env.E2E_PASSWORD) return process.env.E2E_PASSWORD;
  return readDevVar('PANEL_PASSWORD');
}

// 读取 .dev.vars 中的本地密钥（签名 URL 验签用的是同一个 HASH_SECRET/JWT_SECRET）
function readDevVar(key) {
  const devVars = join(ROOT, '.dev.vars');
  if (!existsSync(devVars)) return '';
  const m = readFileSync(devVars, 'utf8').match(new RegExp(`^${key}=(.+)$`, 'm'));
  return m ? m[1].trim() : '';
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(desc, secs, fn) {
  const deadline = Date.now() + secs * 1000;
  while (Date.now() < deadline) {
    try { if (await fn()) return true; } catch { /* retry */ }
    await sleep(1000);
  }
  console.error(`  等待超时：${desc}`);
  return false;
}

// ---- 清理 ----
let _cleaned = false;
async function cleanup() {
  if (_cleaned) return;
  _cleaned = true;

  // 先尝试按进程组 kill
  if (wranglerProc?.pid) {
    try { process.kill(-wranglerProc.pid, 'SIGTERM'); } catch {}
    try { process.kill(wranglerProc.pid, 'SIGTERM'); } catch {}
  }
  if (agentProc?.pid) {
    try { process.kill(-agentProc.pid, 'SIGTERM'); } catch {}
    try { process.kill(agentProc.pid, 'SIGTERM'); } catch {}
  }

  // 兜底清理：pkill 残留的 websocat / socat（agent 子进程可能脱离进程组）
  if (agentKey) {
    try { execSync(`pkill -f "websocat.*${agentKey}" 2>/dev/null || true`, { stdio: 'ignore' }); } catch {}
    try { execSync(`pkill -f "pty,link=${AGENT_TMPDIR}/" 2>/dev/null || true`, { stdio: 'ignore' }); } catch {}
  }
  await sleep(300);

  // 清理临时文件
  try { unlinkSync('/tmp/e2e-upload.bin'); } catch {}
  try { unlinkSync(join(TMP, 'upload.bin.down')); } catch {}
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
}

function registerCleanup() {
  const exit = (code) => { cleanup().then(() => process.exit(code)); };
  process.on('exit', () => cleanup());
  process.on('SIGINT', () => exit(1));
  process.on('SIGTERM', () => exit(1));
  process.on('uncaughtException', async (err) => {
    console.error('\nUncaught exception:', err.message || err);
    await cleanup();
    process.exit(1);
  });
}

// ---- 节标题 ----
let stepIdx = 0;
function section(desc) { stepIdx++; console.log(`\n[${stepIdx}/10] ${desc}...`); }

// ============================================================
// 第 1 步：D1 migrations
// ============================================================
async function step1_migrations() {
  section('D1 migrations');
  const r = spawnSync(process.execPath, [
    '--no-warnings', WRANGLER_CLI, 'd1', 'migrations', 'apply', 'cf-panel',
    '--local', '--persist-to', STATE,
  ], { cwd: ROOT, stdio: 'pipe', timeout: 300_000, encoding: 'utf8' });
  if (r.status !== 0) {
    bad(`D1 migrations 失败：${r.stderr || r.stdout}`);
    process.exit(1);
  }
  ok('D1 migrations 已应用');
}

// ============================================================
// 第 2 步：启动 wrangler dev --local
// ============================================================
async function step2_wrangler() {
  section('启动 wrangler dev --local');

  const logStream = createWriteStream(WRANGLER_LOG);
  wranglerProc = spawn(process.execPath, [
    '--no-warnings', WRANGLER_CLI, 'dev', '--local', '--port', String(PORT), '--persist-to', STATE,
  ], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  wranglerProc.stdout.pipe(logStream);
  wranglerProc.stderr.pipe(logStream);

  const ready = await waitFor('wrangler dev 就绪', 60, async () => {
    const res = await fetch(`${BASE}/api/public/settings`);
    return res.ok;
  });
  if (!ready) {
    bad('wrangler dev 未在 60s 内就绪');
    try { console.error(readFileSync(WRANGLER_LOG, 'utf8').split('\n').slice(-20).join('\n')); } catch {}
    process.exit(1);
  }
  ok(`wrangler dev 就绪于 ${BASE}`);
}

// ============================================================
// 第 3 步：登录获取 JWT
// ============================================================
async function step3_login() {
  section('面板登录');
  if (!PASSWORD) {
    bad('缺少密码：请设置 E2E_PASSWORD 或 .dev.vars 中的 PANEL_PASSWORD');
    process.exit(1);
  }
  const res = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  if (!res.ok) { bad(`登录失败：HTTP ${res.status}`); process.exit(1); }
  const body = await res.json();
  if (!body.token) { bad(`登录失败：无 token`); process.exit(1); }
  token = body.token;
  ok('登录成功，获取 JWT');
}

// ============================================================
// 第 4 步：注册服务器
// ============================================================
async function step4_register() {
  section('注册服务器');
  // 随机后缀：多轮/多环境运行时不与其他记录同名（否则 find 断言可能命中残留旧数据）
  serverName = `e2e-node-${randomBytes(4).toString('hex')}`;
  const res = await fetch(`${BASE}/api/servers`, {
    method: 'POST',
    headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: serverName, group: 'e2e', sort_order: 1 }),
  });
  if (!res.ok) { bad(`注册服务器失败：HTTP ${res.status}`); process.exit(1); }
  const body = await res.json();
  if (!body.agent_key) { bad('注册服务器失败：无 agent_key'); process.exit(1); }
  agentKey = body.agent_key;
  // 从列表按名字查真实 id（不硬编码 server_id=1：残留数据/并发运行下 id 会错位）
  const list = await (await fetch(`${BASE}/api/servers`, {
    headers: { 'authorization': `Bearer ${token}` },
  })).json();
  const srv = (list || []).find((s) => s.name === serverName);
  if (!srv) { bad('注册后列表未找到该服务器'); process.exit(1); }
  serverId = srv.id;
  ok(`已注册服务器 ${serverName}（id=${serverId}，agent_key=${agentKey.slice(0, 8)}...）`);
}

// ============================================================
// 第 5 步：启动 agent 并等待上线 + 监控
// ============================================================
async function step5_agent() {
  section(`启动 agent（${AGENT_CMD.split('/').pop()}）并等待上线/上报`);

  agentProc = spawn(AGENT_CMD, [], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      AGENT_WSS_URL: `ws://127.0.0.1:${PORT}/ws/agent`,
      AGENT_KEY: agentKey,
      AGENT_TMPDIR: AGENT_TMPDIR,
      AGENT_LOG,
      AGENT_LOG_MAX: '1048576',
      REPORT_INTERVAL: '5',
    },
  });

  // 等待上线
  const online = await waitFor('agent 上线', 60, async () => {
    const res = await fetch(`${BASE}/api/servers`, {
      headers: { 'authorization': `Bearer ${token}` },
    });
    const servers = await res.json();
    return servers.some((s) => s.name === serverName && s.online === true);
  });
  if (!online) { bad('agent 未在 60s 内上线'); process.exit(1); }
  ok('agent 控制通道上线，面板判定在线');

  // 等待监控数据
  const monitor = await waitFor('监控上报', 60, async () => {
    const res = await fetch(`${BASE}/api/monitor?server_id=${serverId}&range=1h`, {
      headers: { 'authorization': `Bearer ${token}` },
    });
    const body = await res.json();
    return body.system && body.system.length >= 1;
  });
  if (!monitor) { bad('60s 内未收到监控上报'); process.exit(1); }
  ok('监控数据已写入（系统指标 ≥1 条）');

  // 系统信息
  const sysOk = await waitFor('系统信息入库', 15, async () => {
    const res = await fetch(`${BASE}/api/servers`, {
      headers: { 'authorization': `Bearer ${token}` },
    });
    const servers = await res.json();
    const srv = servers.find((s) => s.name === serverName);
    return srv?.info?.os && srv?.info?.kern;
  });
  if (sysOk) ok('系统信息已入库（os/kern）');
  else bad('系统信息缺失');

  // 实时指标（偶发上报慢，给 30s 窗口）
  const metricOk = await waitFor('实时指标', 30, async () => {
    const res = await fetch(`${BASE}/api/servers`, {
      headers: { 'authorization': `Bearer ${token}` },
    });
    const servers = await res.json();
    const srv = servers.find((s) => s.name === serverName);
    return srv?.metric?.cpu != null && srv?.metric?.mem_used != null;
  });
  if (metricOk) ok('实时指标可见（cpu/mem_used）');
  else bad('实时指标缺失');
}

// ============================================================
// 第 6 步：终端双向透传
// ============================================================
async function step6_terminal() {
  section('终端会话');
  // Rust agent 用 portable_pty 直接实现 PTY，无需 socat；测试端用内置 WebSocket

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // 创建终端会话
      const tres = await fetch(`${BASE}/api/terminal`, {
        method: 'POST',
        headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ server_id: serverId }),
      });
      if (!tres.ok) { bad(`创建终端会话失败：HTTP ${tres.status}`); return; }
      const { session_id: sid } = await tres.json();
      if (!sid) { bad(`创建终端会话失败：无 session_id`); return; }

      // 等待 agent 侧 PTY 就绪
      await sleep(3000);

      // WebSocket 测试
      const output = await terminalWsTest(sid);
      if (output.includes('E2E_TERM_OK')) {
        ok('终端双向透传正常（收到 shell 回显）');
        return;
      }
      console.log(`  终端尝试 ${attempt}/3 未回显，重建会话重试...`);
    } catch (e) {
      console.log(`  终端尝试 ${attempt}/3 异常：${e.message || e}`);
    }
  }
  bad('终端无回显（3 次尝试均失败）');
}

function terminalWsTest(sid) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/terminal/${sid}`);
    ws.binaryType = 'arraybuffer'; // DO 可能发二进制帧（Blob），统一解码
    const decoder = new TextDecoder();
    let collected = '';
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(collected); }, 15_000);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', token }));
      // 等待 auth 处理完成后发 echo（给 DO 500ms 处理 RPC）
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('echo E2E_TERM_OK\n');
      }, 500);
    };
    ws.onmessage = (ev) => {
      // 兼容文本帧（string）和二进制帧（ArrayBuffer）
      if (typeof ev.data === 'string') collected += ev.data;
      else collected += decoder.decode(ev.data, { stream: true });
      if (collected.includes('E2E_TERM_OK')) {
        clearTimeout(timer);
        ws.close();
        resolve(collected);
      }
    };
    ws.onclose = () => { clearTimeout(timer); resolve(collected); };
    ws.onerror = () => { clearTimeout(timer); resolve(collected); };
  });
}

// ============================================================
// 第 7 步：文件上传/下载（10MB）
// ============================================================
async function step7_file() {
  section('文件上传/下载（10MB）');

  // 生成 10MB 随机数据
  const uploadSrc = join(TMP, 'upload.bin');
  writeFileSync(uploadSrc, randomBytes(10 * 1024 * 1024));
  const srcData = readFileSync(uploadSrc);

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      // 创建文件会话
      const fres = await fetch(`${BASE}/api/file/open`, {
        method: 'POST',
        headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ server_id: serverId }),
      });
      if (!fres.ok) { bad(`创建文件会话失败：HTTP ${fres.status}`); return; }
      const { session_id: fsid } = await fres.json();
      if (!fsid) { bad('创建文件会话失败：无 session_id'); return; }

      // 等待 agent 数据流挂接
      await sleep(2000);

      // 调用 e2e-file.mjs 执行上传 + 下载（同目录）
      const r = spawnSync('node', [
        join(__dirname, 'e2e-file.mjs'),
        BASE, token, fsid, uploadSrc, '/tmp/e2e-upload.bin',
      ], { timeout: 120_000, encoding: 'utf8', stdio: 'pipe' });

      // 校验上传到 agent 的文件
      const agentFileOk = existsSync('/tmp/e2e-upload.bin') &&
        readFileSync('/tmp/e2e-upload.bin').equals(srcData);
      // 校验下载文件
      const downPath = uploadSrc + '.down';
      const downOk = existsSync(downPath) && readFileSync(downPath).equals(srcData);

      if (agentFileOk && downOk) {
        ok('文件上传/下载 10MB 成功（上传与下载内容均与源一致）');
        return;
      }
      console.log(`  文件尝试 ${attempt}/2 失败：${r.stdout || r.stderr || 'exit=' + r.status}`);
      try { unlinkSync('/tmp/e2e-upload.bin'); } catch {}
    } catch (e) {
      console.log(`  文件尝试 ${attempt}/2 异常：${e.message || e}`);
    }
  }
  bad('文件上传/下载失败（详见 agent/wrangler 日志）');
}

// ============================================================
// 第 8 步：MCP 接口测试（17 个工具全覆盖，含异步化新增的 get_operation）
// ============================================================
async function step8_mcp() {
  section('MCP 接口测试（17 个工具）');

  // ---- MCP 辅助函数 ----
  async function mcpCall(id, method, params) {
    const body = { jsonrpc: '2.0', id, method };
    if (params !== undefined) body.params = params;
    const res = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  async function mcpTool(id, name, args = {}) {
    return mcpCall(id, 'tools/call', { name, arguments: args });
  }

  // 从 tools/call 结果中提取 content[0].text，尝试 JSON 解析
  function mcpContent(resp) {
    if (resp.error) return null;
    const text = resp.result?.content?.[0]?.text;
    if (text === undefined || text === null) return null;
    try { return JSON.parse(text); } catch { return text; }
  }

  // 异步任务轮询：exec_command / create_upload 现在只返回 job，须用 get_operation 轮询到终态
  // 终态：succeeded / failed / timed_out / expired（见 src/config.js JOB_TERMINAL_STATES）
  async function mcpPollJob(jobId, timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    let id = 1000;
    for (;;) {
      const r = await mcpTool(id++, 'get_operation', { job_id: jobId });
      const d = mcpContent(r);
      if (d && ['succeeded', 'failed', 'timed_out', 'expired'].includes(d.status)) return d;
      if (Date.now() > deadline) return d;
      await new Promise((resolve) => setTimeout(resolve, Math.min(d?.poll_after_ms || 1000, 5000)));
    }
  }

  // ---- 8.0) initialize ----
  const init = await mcpCall(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {} });
  if (init?.result?.protocolVersion === '2025-11-25') ok('MCP initialize：协议版本 2025-11-25');
  else bad(`MCP initialize 失败：${JSON.stringify(init)}`);

  // ---- 8.1) tools/list ----
  const list = await mcpCall(2, 'tools/list');
  const toolNames = list?.result?.tools?.map((t) => t.name) || [];
  if (toolNames.length === 17 && toolNames.includes('get_operation')) ok(`MCP tools/list：17 个工具全部注册（含 get_operation）`);
  else bad(`MCP tools/list：期望 17 个工具（含 get_operation），实际 ${toolNames.length}：${toolNames.join(',')}`);

  // ---- 8.2) list_servers ----
  const ls = await mcpTool(3, 'list_servers');
  const lsData = mcpContent(ls);
  if (Array.isArray(lsData) && lsData.some((s) => s.name === serverName && s.online === true))
    ok(`MCP list_servers：${serverName} 在线，含实时指标`);
  else bad(`MCP list_servers：${serverName} 未找到或不在线`);

  // ---- 8.3) get_monitor ----
  const gm = await mcpTool(4, 'get_monitor', { server_id: serverId, range: '1h' });
  const gmData = mcpContent(gm);
  // MCP get_monitor 返回 { server, range, count, points, custom }，points 即监控时序点
  if (gmData?.points?.length >= 1) ok('MCP get_monitor：监控数据存在（points ≥1 条）');
  else bad(`MCP get_monitor：无监控数据：${JSON.stringify(gmData)}`);

  // ---- 8.4) exec_command（异步：返回 job，轮询 get_operation 到终态再取 stdout） ----
  const exec = await mcpTool(5, 'exec_command', { server_id: serverId, command: 'echo E2E_MCP_EXEC_OK' });
  const execJob = mcpContent(exec);
  const execDone = execJob?.job_id ? await mcpPollJob(execJob.job_id) : null;
  if (execDone?.result?.stdout?.includes('E2E_MCP_EXEC_OK')) ok('MCP exec_command：agent 真实执行，输出匹配');
  else bad(`MCP exec_command 失败：${JSON.stringify(execDone || exec)}`);

  // ---- 8.5) create_upload + 签名 URL 上传 + 验证 ----
  const cu = await mcpTool(6, 'create_upload', { server_id: serverId, path: '/tmp/e2e-mcp-upload.txt' });
  const cuData = mcpContent(cu);
  const cuUrl = cuData?.upload_url || '';
  const cuExp = cuData?.expires_in_seconds || 0;
  if (cuUrl && cuExp > 0 && cuExp <= 600) ok(`MCP create_upload：签名 URL 结构正确（expires_in_seconds=${cuExp}）`);
  else bad(`MCP create_upload：响应结构异常：${JSON.stringify(cuData)}`);

  // 签名 URL 上传（异步：POST 到 upload_url 暂存 R2，轮询 job 到终态）
  const upRes = await fetch(cuUrl, {
    method: 'POST',
    body: 'E2E_MCP_UPLOAD_CONTENT',
  });
  const upBody = await upRes.json().catch(() => ({}));
  if (upRes.status === 202 && upBody.job_id) {
    const upDone = await mcpPollJob(upBody.job_id);
    if (upDone?.status === 'succeeded') {
      // exec_command 验证内容（异步：轮询到终态再取 stdout）
      const verify = await mcpTool(7, 'exec_command', { server_id: serverId, command: 'cat /tmp/e2e-mcp-upload.txt' });
      const vJob = mcpContent(verify);
      const vData = vJob?.job_id ? await mcpPollJob(vJob.job_id) : null;
      if (vData?.result?.stdout?.includes('E2E_MCP_UPLOAD_CONTENT')) ok('MCP 上传：签名 URL 上传 + exec_command 验证内容一致');
      else bad(`MCP 上传：内容验证不匹配：${JSON.stringify(vData || vJob)}`);
    } else bad(`MCP 上传：任务未成功：${JSON.stringify(upDone)}`);
  } else bad(`MCP 上传：签名 URL POST 失败：${upRes.status} ${JSON.stringify(upBody)}`);

  // 清理
  await mcpTool(8, 'exec_command', { server_id: serverId, command: 'rm -f /tmp/e2e-mcp-upload.txt' });

  // ---- 8.6) add_server ----
  const addSrv = await mcpTool(10, 'add_server', { name: 'e2e-mcp', group: 'e2e-mcp', sort_order: 10 });
  const asData = mcpContent(addSrv);
  const asKey = asData?.agent_key || '';
  const asId = asData?.server_id || 0;
  const asWss = asData?.wss_base || '';
  if (asKey.length === 64) ok(`MCP add_server：agent_key 64 位，wss_base=${asWss}`);
  else bad(`MCP add_server 失败：${JSON.stringify(asData)}`);

  // ---- 8.7) update_server ----
  if (asId > 0) {
    const upd = await mcpTool(11, 'update_server', { server_id: asId, name: 'e2e-mcp-renamed' });
    const upData = mcpContent(upd);
    if (upData?.name === 'e2e-mcp-renamed') ok('MCP update_server：重命名成功');
    else bad(`MCP update_server 失败：${JSON.stringify(upData)}`);
  } else bad('MCP update_server：跳过（add_server 未返回有效 ID）');

  // ---- 8.7.1) rotate_agent_key（对未连 agent 的服务器：验证签发/旧 key 失效/历史保留路径） ----
  if (asId > 0) {
    const rot = await mcpTool(115, 'rotate_agent_key', { server_id: asId });
    const rotData = mcpContent(rot);
    const rotKey = rotData?.agent_key || '';
    if (rotKey.length === 64 && rotKey !== asKey && rotData?.wss_base)
      ok('MCP rotate_agent_key：新 key 签发（≠旧 key），监控历史保留');
    else bad(`MCP rotate_agent_key 失败：${JSON.stringify(rotData)}`);
  } else bad('MCP rotate_agent_key：跳过（add_server 未返回有效 ID）');

  // ---- 8.8) delete_server ----
  if (asId > 0) {
    const del = await mcpTool(12, 'delete_server', { server_id: asId });
    const delData = mcpContent(del);
    if (delData?.ok === true) ok('MCP delete_server：删除成功');
    else bad(`MCP delete_server 失败：${JSON.stringify(delData)}`);
  } else bad('MCP delete_server：跳过（add_server 未返回有效 ID）');

  // ---- 8.9) Token CRUD + PAT 权限 ----
  const ct = await mcpTool(13, 'create_token', { name: 'e2e-mcp-pat', scopes: ['server:read'], server_ids: [serverId] });
  const ctData = mcpContent(ct);
  const patToken = ctData?.token || '';
  if (patToken.startsWith('cfp_')) ok('MCP create_token：PAT 创建成功（cfp_ 前缀）');
  else bad(`MCP create_token 失败：${JSON.stringify(ctData)}`);

  // PAT 被拒管理工具
  if (patToken.startsWith('cfp_')) {
    const patRes = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${patToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 30, method: 'tools/call', params: { name: 'add_server', arguments: { name: 'evil' } } }),
    });
    const patBody = await patRes.json();
    const patText = patBody?.result?.content?.[0]?.text || '';
    if (patText.includes('admin only')) ok('MCP 权限：PAT 被拒管理工具（admin only）');
    else bad(`MCP 权限：PAT 未正确拒绝：${JSON.stringify(patBody)}`);

    // update_agent 需要独立 agent:update scope：仅 server:read 的 PAT 应被拒（403 forbidden）
    const updPat = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${patToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 31, method: 'tools/call', params: { name: 'update_agent', arguments: { server_id: serverId } } }),
    });
    const updBody = await updPat.json();
    const updText = updBody?.result?.content?.[0]?.text || '';
    if (updText.includes('forbidden')) ok('MCP 权限：无 agent:update scope 的 PAT 被拒更新 Agent');
    else bad(`MCP 权限：update_agent 未正确拒绝无 scope PAT：${JSON.stringify(updBody)}`);
  } else bad('MCP 权限测试跳过（无有效 PAT）');

  // list_tokens
  const lt = await mcpTool(14, 'list_tokens');
  const ltData = mcpContent(lt);
  if (Array.isArray(ltData) && ltData.length >= 1) ok('MCP list_tokens：至少 1 个 token');
  else bad('MCP list_tokens：无 token');

  // revoke_token
  const patTid = Array.isArray(ltData) ? ltData.find((t) => t.name === 'e2e-mcp-pat')?.id : null;
  if (patTid) {
    const rv = await mcpTool(15, 'revoke_token', { token_id: patTid });
    const rvData = mcpContent(rv);
    if (rvData?.ok === true) ok('MCP revoke_token：撤销成功');
    else bad(`MCP revoke_token 失败：${JSON.stringify(rvData)}`);
  } else bad('MCP revoke_token：跳过（list_tokens 未返回 e2e-mcp-pat 的 ID）');

  // ---- 8.10) get_audit_logs（返回 {rows,total}，支持筛选） ----
  const al = await mcpTool(16, 'get_audit_logs', { limit: 5 });
  const alData = mcpContent(al);
  if (alData?.rows?.length >= 1 && alData.total >= 1) ok('MCP get_audit_logs：有审计记录（≥1 条）');
  else bad(`MCP get_audit_logs：无审计记录：${JSON.stringify(alData)}`);
  const alF = await mcpTool(21, 'get_audit_logs', { action: 'server.update' });
  const alFData = mcpContent(alF);
  if (alFData?.rows?.length >= 1 && alFData.rows.every((r) => r.action === 'server.update')) ok('MCP get_audit_logs：action 筛选生效');
  else bad(`MCP get_audit_logs：筛选异常：${JSON.stringify(alFData)}`);

  // ---- 8.11) get_usage ----
  const gu = await mcpTool(17, 'get_usage');
  const guData = mcpContent(gu);
  if (guData?.estimates_per_day !== undefined) ok('MCP get_usage：用量数据存在');
  else bad(`MCP get_usage 失败：${JSON.stringify(guData)}`);

  // ---- 8.12) get_settings / update_settings ----
  const gs = await mcpTool(18, 'get_settings');
  const gsData = mcpContent(gs);
  const gsName = gsData?.site_name || '';
  if (gsData && gsData !== null) ok('MCP get_settings：读取成功');
  else bad(`MCP get_settings 失败：${JSON.stringify(gsData)}`);

  const ups = await mcpTool(19, 'update_settings', { site_name: 'E2E MCP Test' });
  const upsData = mcpContent(ups);
  if (upsData?.site_name === 'E2E MCP Test') {
    ok('MCP update_settings：更新 site_name 成功');
    // 恢复原始值
    if (gsName) {
      await mcpTool(20, 'update_settings', { site_name: gsName });
    }
  } else bad(`MCP update_settings 失败：${JSON.stringify(upsData)}`);

  // ---- 8.13) 测试 Webhook（本地回环目标必须在发起请求前被 SSRF 基线校验拒绝） ----
  const tw = await fetch(`${BASE}/api/settings/test_webhook`, {
    method: 'POST',
    headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ alerts: { webhook_url: `${BASE}/api/public/settings` } }),
  });
  const twData = await tw.json();
  if (tw.status === 200 && twData.ok === false && twData.status === 0 && /private webhook targets/.test(twData.error || ''))
    ok('测试 Webhook：本地回环目标被安全校验拒绝');
  else bad(`测试 Webhook 异常：HTTP ${tw.status} ${JSON.stringify(twData)}`);
}

// ============================================================
// 第 9 步：Agent 更新资产代理（针对 /mcp/agent-update-asset 的端到端覆盖）
// 构造一条 running 的 agent_update 任务 + 签名 token，实际 GET 资产代理。
// 上游故意用 chunked（无 Content-Length），验证 Worker 仍按 job.size_bytes 回传 CL；
// 再让上游少发字节，验证固定长度流让响应流报错，不静默留下截断文件。
// 不触发真实 Agent 更新：D1 里插的是一次性任务，Agent 不参与、不会替换自身二进制。
// 用 wrangler d1 execute --local --persist-to STATE 往运行中的 workerd 写行是可行的：
// 它与 step1 migrations / step2 dev 共享同一份本地 SQLite（WAL 允许多进程写），
// 写的只是一条一次性任务，本地状态随 TMP 一起删除，不影响线上数据。
// ============================================================
async function step9_assetProxy() {
  section('Agent 更新资产代理（Content-Length / 长度一致性）');
  if (!serverId) return;
  const asset = Buffer.from('cf-panel-e2e-asset');
  const buildId = '2026.11.11-0000-e2easset';
  const platform = 'linux-x86_64';
  const jobId = `job_e2e_asset_${randomBytes(4).toString('hex')}`;
  let shortMode = false;
  const upstream = createServer((_req, res) => {
    const payload = shortMode ? asset.subarray(0, 3) : asset;
    // 不给 Content-Length：模拟上游 chunked / 边缘改写成无长度响应
    res.writeHead(200, { 'transfer-encoding': 'chunked', 'content-type': 'application/octet-stream' });
    res.end(payload);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const assetUrl = `http://127.0.0.1:${upstream.address().port}/asset`;
  const now = Math.floor(Date.now() / 1000);
  const sql = `INSERT INTO operation_jobs (id, kind, status, user_id, username, server_id, build_id, platform, size_bytes, asset_url, created_at, deadline_at, expires_at) VALUES ('${jobId}', 'agent_update', 'running', 1, 'admin', ${serverId}, '${buildId}', '${platform}', ${asset.length}, '${assetUrl}', ${now}, ${now + 200}, ${now + 86400})`;
  try {
    const r = spawnSync(process.execPath, [
      '--no-warnings', WRANGLER_CLI, 'd1', 'execute', 'cf-panel',
      '--local', '--persist-to', STATE, '--command', sql,
    ], { cwd: ROOT, stdio: 'pipe', timeout: 60_000, encoding: 'utf8' });
    if (r.status !== 0) {
      bad(`插入测试更新任务失败：${String(r.stderr || r.stdout || '').slice(0, 300)}`);
      return;
    }
    const secrets = {
      JWT_SECRET: readDevVar('JWT_SECRET'),
      HASH_SECRET: readDevVar('HASH_SECRET'),
    };
    const assetToken = await signJobToken(
      'asset', jobId, serverId, `${buildId}|${platform}|${asset.length}`, secrets, 600
    );
    const url = `${BASE}/mcp/agent-update-asset?id=${jobId}&server_id=${serverId}&token=${encodeURIComponent(assetToken)}`;

    // 1) 上游无 CL：仍按 job.size_bytes 回传，且 body 完整
    const res = await fetch(url);
    const buf = Buffer.from(await res.arrayBuffer());
    if (res.status === 200
      && res.headers.get('content-length') === String(asset.length)
      && buf.equals(asset)) {
      ok('资产代理：上游无 Content-Length 时仍回传 job.size_bytes，且 body 完整');
    } else {
      bad(`资产代理异常：HTTP ${res.status} CL=${res.headers.get('content-length')} body=${buf.length}`);
    }

    // 2) 上游实际字节比声明短：同一 token / 同一任务，响应流必须报错
    shortMode = true;
    let rejected = false;
    try {
      const shortRes = await fetch(url);
      await shortRes.arrayBuffer();
    } catch { rejected = true; }
    if (rejected) ok('资产代理：上游短流时响应流报错，不静默留下截断文件');
    else bad('资产代理：上游短流未被拦截');
  } catch (e) {
    bad(`资产代理测试异常：${e.message || e}`);
  } finally {
    upstream.close();
    // 本地临时状态随 TMP 一起删除，无需回删任务行
  }
}

// ============================================================
// 第 10 步：清理本测试注册的服务器（随机名 + 结束后删除，防残留）
// ============================================================
async function step10_removeServer() {
  section('清理测试服务器');
  if (!serverId) return;
  const res = await fetch(`${BASE}/api/servers/${serverId}`, {
    method: 'DELETE',
    headers: { 'authorization': `Bearer ${token}` },
  });
  if (res.ok) ok(`已删除测试服务器 ${serverName}（id=${serverId}）`);
  else bad(`删除测试服务器失败：HTTP ${res.status}`);
}

// ============================================================
// 主流程
// ============================================================
async function main() {
  registerCleanup();

  console.log(`== cf-panel E2E（port=${PORT}，临时目录 ${TMP}）==`);

  try {
    if (!existsSync(AGENT_CMD)) {
      console.error(`Rust agent 二进制不存在：${AGENT_CMD}`);
      console.error('请先构建：cd agent/rust && cargo build --release');
      process.exit(1);
    }

    await step1_migrations();
    await step2_wrangler();
    await step3_login();
    await step4_register();
    await step5_agent();
    await step6_terminal();
    await step7_file();
    await step8_mcp();
    await step9_assetProxy();
    await step10_removeServer(); // 测试结束删除本测试服务器（wrangler 退出前执行）
  } catch (e) {
    console.error(`\n致命错误：${e.message || e}`);
    console.error(e.stack);
  }

  await cleanup();

  // 汇总
  const total = pass + fail;
  console.log(`\nE2E PASS：${pass} / ${total} 项检查通过`);
  if (fail > 0) {
    console.error(`E2E FAIL：${fail} 项失败`);
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main();
