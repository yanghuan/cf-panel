// cf-panel API 层：请求封装 + token 管理 + 文件会话（连接/协议/上传下载状态机）
// 普通 script（IIFE），挂 window.CfApi；app.js 开头解构所需
// 依赖：utils.js 须先加载（FileSession 用到 fileJoin）
(() => {
  'use strict';

  const t = (k, v) => (window.CfI18n ? window.CfI18n.t(k, v) : k); // i18n 缺席时回退显示 key（顺序由 index.html 保证，此处兜底） // i18n：协议层用户可见文案

  // 文件协议常量（文件会话专用）
  const FILE_CHUNK = 512 * 1024;       // 分段传输块大小 512KB（Binary 混合帧直传无 base64；
  // 512KB 远小于 workerd WS 1MB 消息限制与 agent 侧 READ_BLOCK/WS_MSG_LIMIT）
  const FILE_MAX = 500 * 1024 * 1024;  // 单文件大小上限 500MB

  // ---------- token 管理（app.js 注册 getter，token 本体仍由 app.js 持有） ----------
  let tokenGetter = () => '';
  function setTokenGetter(fn) { tokenGetter = fn; }

  // ---------- 请求封装 ----------
  async function api(path, opts = {}) {
    const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
    const tk = tokenGetter();
    if (tk) headers.authorization = `Bearer ${tk}`;
    const resp = await fetch(path, { ...opts, headers });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    return data;
  }

  // ---------- 文件会话：连接 + 协议（Text/Binary 混合帧）+ 上传/下载状态机 ----------
  // 零 DOM 依赖：UI 通过构造注入的 handlers 回调（onList/onUpload*/onDownload*/onError/onDisconnected）
  // 注意：状态属性用 uploadState/downloadState（与 upload()/download() 方法名区分）
  class FileSession {
    constructor(handlers = {}) {
      this.h = handlers;
      this.ws = null;
      this.serverId = 0;
      this.cwd = '/';
      this._generation = 0;      // open/close 代际：丢弃乱序 API 响应与旧 WebSocket 事件
      this.uploadState = null;   // { file, size, sent, acked, uploadId, path, reader }
      this.downloadState = null; // { path, size, parts, received }
    }
    get connected() { return this.ws && this.ws.readyState === 1; }

    // 建会话 + WS + auth + 初始列表。代际守卫覆盖 await 响应乱序、关闭弹窗和旧 WS 迟到事件。
    async open(serverId, cwd = '/') {
      this.close(); // 同时使此前 pending open 失效
      const generation = this._generation;
      this.serverId = serverId;
      this.cwd = cwd;
      try {
        const res = await api('/api/file/open', { method: 'POST', body: JSON.stringify({ server_id: serverId }) });
        if (generation !== this._generation) return;
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        // token 不放 URL（避免进访问日志/浏览器历史），连接后首帧发送鉴权
        const ws = new WebSocket(`${proto}://${location.host}/ws/file/${res.session_id}`);
        if (generation !== this._generation) { try { ws.close(); } catch { /* ignore */ } return; }
        this.ws = ws;
        ws.onopen = () => {
          if (generation !== this._generation || this.ws !== ws) { try { ws.close(); } catch { /* ignore */ } return; }
          this.send({ type: 'auth', token: tokenGetter() });
          this.list(this.cwd, '');
        };
        ws.onmessage = (ev) => {
          if (generation === this._generation && this.ws === ws) this._onMessage(ev);
        };
        ws.onclose = () => {
          if (generation !== this._generation || this.ws !== ws) return;
          this.ws = null;
          if (this.h.onDisconnected) this.h.onDisconnected();
        };
        ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
      } catch (e) {
        if (generation === this._generation && this.h.onError) this.h.onError(e.message);
      }
    }
    // 断线重连（保留 serverId/cwd）
    reconnect() { return this.open(this.serverId, this.cwd); }
    // 关闭会话：中断进行中的传输并复位状态——否则重开弹窗后被残留状态挡住
    //（「已有上传/下载进行中」而取消按钮已随弹窗关闭不可达，永久卡死直到刷新）。
    // 上传先发 abort（连接还在时）通知 agent 删临时文件；断开时 agent 会话结束清理兜底
    close() {
      this._generation += 1; // 取消尚未返回的 open() 及旧 WebSocket 的迟到事件
      if (this.uploadState) {
        this.send({ type: 'abort', path: this.uploadState.path, upload_id: this.uploadState.uploadId });
        this.uploadState = null;
      }
      this.downloadState = null;
      this.editState = null;
      if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } this.ws = null; }
    }
    send(obj) { if (this.connected) this.ws.send(JSON.stringify(obj)); }

    // 列表（Everything 风格：无通配符纯文本按子串匹配 *文本*）
    list(path, pattern) {
      let p = String(pattern || '').trim();
      if (p && !/[*?]/.test(p)) p = `*${p}*`;
      const body = { type: 'list', path };
      if (p) body.pattern = p;
      this.send(body);
    }

    // 递归搜索（find）：从 path 起下钻匹配文件名通配符，结果经 onFindDone 回调。
    // 与 list 的差别：list 只看当前目录，find 递归——大目录树里定位文件靠它。
    find(path, pattern) { this.send({ type: 'find', path, pattern: String(pattern || '').trim() }); }

    _onMessage(ev) {
      if (typeof ev.data !== 'string') {
        // Binary 混合帧：read_result（JSON 头\n + 原始字节）
        const p = ev.data instanceof ArrayBuffer
          ? Promise.resolve(new Uint8Array(ev.data))
          : ev.data.arrayBuffer().then((b) => new Uint8Array(b));
        p.then((buf) => {
          const nl = buf.indexOf(10);
          if (nl < 0) return;
          let j; try { j = JSON.parse(new TextDecoder().decode(buf.subarray(0, nl))); } catch { return; }
          if (j.type === 'read_result' && j.ok) this._onReadResult(j, buf.subarray(nl + 1));
        }).catch(() => { /* ignore */ });
        return;
      }
      let j; try { j = JSON.parse(ev.data); } catch { return; }
      if (j.type === 'list_result' && j.ok) {
        if (this.h.onList) this.h.onList(j.entries, !!j.truncated, j.path);
      } else if (j.type === 'write_result' && j.ok) {
        this._onWriteResult(j);
      } else if (j.type === 'zip_result' && j.ok) {
        this._startZipDownload(j.path, j.size);
      } else if (j.type === 'rename_result' && j.ok) {
        if (this.h.onRenameDone) this.h.onRenameDone(j.path);
      } else if (j.type === 'mkdir_result' && j.ok) {
        if (this.h.onMkdirDone) this.h.onMkdirDone();
      } else if (j.type === 'touch_result' && j.ok) {
        if (this.h.onTouchDone) this.h.onTouchDone();
      } else if (j.type === 'move_result' && j.ok) {
        if (this.h.onMoveDone) this.h.onMoveDone(j.path);
      } else if (j.type === 'copy_result' && j.ok) {
        if (this.h.onCopyDone) this.h.onCopyDone(j.path);
      } else if (j.type === 'chmod_result' && j.ok) {
        if (this.h.onChmodDone) this.h.onChmodDone(j.mode);
      } else if (j.type === 'find_result' && j.ok) {
        if (this.h.onFindDone) this.h.onFindDone(j.hits, !!j.truncated, j.scanned);
      } else if (j.type === 'delete_result' && j.ok) {
        // zip 下载完成的临时文件清理（silent 标志，不触发 UI 刷新）
        if (this._zipCleanup) this._zipCleanup = false;
        else if (this.h.onDeleteDone) this.h.onDeleteDone();
      } else if (j.type === 'error') {
        // 失败复位全部传输状态——否则残留状态让下次上传/下载被"已有传输进行中"挡住
        // （取消按钮已可见但实际无传输，用户需额外操作才能重试）；editState 同理
        const wasUploading = !!this.uploadState;
        const wasDownloading = !!this.downloadState;
        if (this.editState) this.editState = null;
        this.uploadState = null;
        this.downloadState = null;
        // 通知 UI 隐藏取消按钮（复用 canceled 回调路径，语义为"传输已终止"）
        if (wasUploading && this.h.onUploadCanceled) this.h.onUploadCanceled();
        if (wasDownloading && this.h.onDownloadCanceled) this.h.onDownloadCanceled();
        if (this.h.onError) this.h.onError(j.message);
      }
    }

    // ---------- 上传状态机（stop-and-wait：等 write_result 确认才发下一块） ----------
    // opts.path：显式目标绝对路径（在线编辑器保存用，避免编辑期间 cwd 变化写错位置）
    upload(file, opts) {
      if (this.uploadState) { if (this.h.onError) this.h.onError(t('file.errUpBusy')); return; }
      if (file.size > FILE_MAX) { if (this.h.onError) this.h.onError(t('file.errFileMax')); return; }
      const uploadId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(36).slice(2);
      // overwrite：目标已存在时是否覆盖（默认 false，服务端首块强制校验，与签名上传路径语义一致）
      const path = (opts && opts.path) || CfUtils.fileJoin(this.cwd, file.name);
      this.uploadState = { file, size: file.size, sent: 0, acked: 0, uploadId, path, reader: new FileReader(), overwrite: !!(opts && opts.overwrite) };
      this._sendNextUpload();
    }
    _sendNextUpload() {
      const u = this.uploadState;
      if (!u || u.sent >= u.size) return;
      const chunk = u.file.slice(u.sent, Math.min(u.sent + FILE_CHUNK, u.size));
      u.reader.onload = () => {
        if (!this.uploadState) return; // 已取消（reader 异步完成）
        const commit = u.sent + chunk.size >= u.size;
        // 混合帧：JSON 头 + '\n' + 原始字节（Binary 帧，无 base64 膨胀）
        const head = new TextEncoder().encode(JSON.stringify({ type: 'write', path: u.path, offset: u.sent, commit, upload_id: u.uploadId, overwrite: u.overwrite }) + '\n');
        const data = new Uint8Array(u.reader.result);
        const frame = new Uint8Array(head.length + data.length);
        frame.set(head, 0);
        frame.set(data, head.length);
        if (this.connected) this.ws.send(frame.buffer);
        u.sent += chunk.size; // 下一块在 write_result 确认后发送
      };
      u.reader.readAsArrayBuffer(chunk);
    }
    cancelUpload() {
      if (!this.uploadState) return;
      this.send({ type: 'abort', path: this.uploadState.path, upload_id: this.uploadState.uploadId });
      this.uploadState = null;
      if (this.h.onUploadCanceled) this.h.onUploadCanceled();
    }
    _onWriteResult(j) {
      const u = this.uploadState;
      if (!u) return;
      u.acked += j.written || 0;
      if (u.acked >= u.size) {
        const path = u.path;
        this.uploadState = null;
        if (this.h.onUploadDone) this.h.onUploadDone(path);
      } else {
        if (this.h.onUploadProgress) this.h.onUploadProgress(Math.min(100, Math.round((u.acked / u.size) * 100)));
        this._sendNextUpload();
      }
    }

    // ---------- 下载状态机（分段拉取，Blob 直引 parts） ----------
    download(path, size) {
      if (this.downloadState) { if (this.h.onError) this.h.onError(t('file.errDlBusy')); return; } // 并发防护
      if (size > FILE_MAX) { if (this.h.onError) this.h.onError(t('file.errFileMax')); return; }
      if (size <= 0) { if (this.h.onError) this.h.onError(t('file.errEmpty')); return; }
      this.downloadState = { path, size, parts: [], received: 0 };
      if (this.h.onDownloadProgress) this.h.onDownloadProgress(0);
      this.send({ type: 'read', path, offset: 0, limit: FILE_CHUNK });
    }
    cancelDownload() {
      if (!this.downloadState) return;
      this.downloadState = null;
      if (this.h.onDownloadCanceled) this.h.onDownloadCanceled();
    }
    // 目录打包 zip 下载：agent 端生成临时 dl-{sid}.zip（zip_result 带 path/size），
    // 分段 read 拉取完成后发 delete 清理临时文件（文件名用目录名.zip）
    zipDownload(path) {
      if (this.downloadState) { if (this.h.onError) this.h.onError(t('file.errDlBusy')); return; }
      this._zipBaseName = (CfUtils.fileBase(path) || 'download') + '.zip';
      this.send({ type: 'zip', path });
    }
    _startZipDownload(zipPath, size) {
      if (size <= 0) { if (this.h.onError) this.h.onError(t('file.errZipEmpty')); return; }
      this.downloadState = { path: zipPath, size, parts: [], received: 0, isZip: true, dlName: this._zipBaseName };
      if (this.h.onDownloadProgress) this.h.onDownloadProgress(0);
      this.send({ type: 'read', path: zipPath, offset: 0, limit: FILE_CHUNK });
    }
    // 重命名（仅改名，不支持跨目录；newName 不含 /）
    rename(path, newName) { this.send({ type: 'rename', path, new_name: newName }); }
    // 删除（文件或目录递归；系统路径 agent 端拒绝）
    delete(path) { this._zipCleanup = false; this.send({ type: 'delete', path }); }
    // 新建目录（mkdir -p 语义，父目录一并创建；已存在报错）
    mkdir(path) { this.send({ type: 'mkdir', path }); }
    // 新建空文件（已存在拒绝且不覆盖）
    touch(path) { this.send({ type: 'touch', path }); }
    // 移动（跨目录，同分区原子 rename；跨分区仅文件回退 copy+delete；目标已存在拒绝）
    move(path, dest) { this.send({ type: 'move', path, dest }); }
    // 复制（文件 / 目录递归，保留原件；目标已存在由 agent 拒绝，复制到自身子目录同样拒绝）
    copy(path, dest) { this.send({ type: 'copy', path, dest }); }
    // 权限修改：Unix 传 mode（如 0o755），Windows 传 readonly 布尔（无 POSIX mode）
    chmod(path, mode, readonly) { this.send({ type: 'chmod', path, mode, readonly }); }
    // 在线编辑：分段拉取全文（≤1MB 由调用方限制），onEditLoaded(path, text) 回调。
    // 已有读取进行中：同文件视为重复点击静默忽略；不同文件顶替重开（旧读取的迟到响应
    // 会因 editState.path 不匹配而落到下载分支被丢弃，无副作用）
    editText(path, size) {
      if (this.editState) {
        // 同文件且连接正常 → 重复点击忽略；否则（读取失败残留/断线残留/换文件）顶替重开
        if (this.editState.path === path && this.connected) return;
        this.editState = null;
      }
      this.editState = { path, size, parts: [], received: 0 };
      this.send({ type: 'read', path, offset: 0, limit: FILE_CHUNK });
    }
    cancelEditText() { this.editState = null; }

    _onReadResult(j, data) {
      // 编辑器全文读取（优先于下载状态机：editState 独立，完成即回调文本）
      const ed = this.editState;
      if (ed && j.path === ed.path) {
        // 空文件（size=0，agent 首读即 got=0）直接当空文本打开，不算失败
        if (j.got === 0 && ed.size === 0) {
          this.editState = null;
          if (this.h.onEditLoaded) this.h.onEditLoaded(ed.path, '');
          return;
        }
        if (j.got === 0 || !data) {
          this.editState = null;
          if (this.h.onError) this.h.onError(t('file.errReadFail'));
          return;
        }
        ed.parts.push(data);
        ed.received += j.got;
        if (ed.received >= ed.size) {
          // 解码校验：UTF-8 替换字符占比 >1% 判定二进制（扩展名黑名单外的漏网：无扩展名/罕见类型）——
          // 编辑保存会因替换字符永久损坏二进制，宁可不打开
          let all = new Uint8Array(ed.parts.reduce((n, p) => n + p.length, 0));
          let o = 0;
          for (const p of ed.parts) { all.set(p, o); o += p.length; }
          const text = new TextDecoder().decode(all);
          const fffd = (text.match(/\uFFFD/g) || []).length;
          if (fffd > 0 && fffd / Math.max(all.length, 1) > 0.01) {
            this.editState = null;
            if (this.h.onError) this.h.onError(t('file.errBinary'));
            return;
          }
          this.editState = null;
          if (this.h.onEditLoaded) this.h.onEditLoaded(ed.path, text);
        } else {
          this.send({ type: 'read', path: ed.path, offset: ed.received, limit: FILE_CHUNK });
        }
        return;
      }
      const d = this.downloadState;
      if (!d || j.path !== d.path) return; // 取消后的迟到响应：静默丢弃
      if (j.got === 0) {
        // EOF 未达预期 size → 文件已缩短/被替换，中止（zip 临时文件同步清理）
        if (d.isZip) { this._zipCleanup = true; this.send({ type: 'delete', path: d.path }); }
        const msg = t('file.errShrunk', { done: d.received, size: d.size });
        this.downloadState = null;
        if (this.h.onDownloadCanceled) this.h.onDownloadCanceled();
        if (this.h.onError) this.h.onError(msg);
        return;
      }
      if (!data) return;
      d.parts.push(data);
      d.received += j.got;
      if (d.received >= d.size) {
        const { path, parts, isZip, dlName } = d;
        this.downloadState = null;
        // zip 下载完成：清理 agent 端临时文件（silent，不触发 onDeleteDone 刷新）
        if (isZip) { this._zipCleanup = true; this.send({ type: 'delete', path }); }
        if (this.h.onDownloadDone) this.h.onDownloadDone(path, parts, dlName);
      } else {
        if (this.h.onDownloadProgress) this.h.onDownloadProgress(Math.min(100, Math.round((d.received / d.size) * 100)));
        this.send({ type: 'read', path: j.path, offset: d.received, limit: FILE_CHUNK });
      }
    }
  }

  // ---------- 终端会话（TermSession）：WS 连接 + 重连 + 无响应自愈，渲染走注入的 xterm ----------
  const TERM_RETRY_MAX = 3; // 终端断线自动重连次数

  class TermSession {
    constructor(term, fit, handlers = {}) {
      this.term = term;   // xterm 实例（渲染输出）
      this.fit = fit;     // FitAddon（尺寸）
      this.h = handlers;  // { onAuthFail }
      this.serverId = 0;
      this.ws = null;
      this.closed = false;
      this.retries = 0;
      this.noDataTimer = null; // 连接后无数据超时（open_terminal 可能丢失）
      this.rebuilding = false; // 无响应重建中，避免与 onclose 重连重复
    }
    get connected() { return this.ws && this.ws.readyState === 1; }

    // 建会话 + WS + auth + fit + resize + noData 自愈
    open(serverId) {
      this.serverId = serverId;
      api('/api/terminal', { method: 'POST', body: JSON.stringify({ server_id: serverId }) })
        .then((res) => {
          if (this.closed) return;
          const proto = location.protocol === 'https:' ? 'wss' : 'ws';
          // token 不放 URL（避免进访问日志/浏览器历史），连接后首帧发送鉴权
          const w = new WebSocket(`${proto}://${location.host}/ws/terminal/${res.session_id}`);
          this.ws = w;
          w.binaryType = 'arraybuffer';
          w.onopen = () => this._onOpen(w);
          w.onmessage = (ev) => this._onMessage(ev);
          w.onclose = (ev) => this._onClose(ev);
          w.onerror = () => { try { w.close(); } catch { /* ignore */ } };
        })
        .catch((e) => {
          if (this.closed) return;
          if (this.retries < TERM_RETRY_MAX) {
            this.retries += 1;
            this.term.write(`\r\n${t('term.createFailedRetry', { err: e.message, n: this.retries })}\r\n`);
            setTimeout(() => this.open(this.serverId), this.retries * 1000);
          } else {
            this.term.write(`\r\n${t('term.createFailed', { err: e.message })}\r\n`);
          }
        });
    }
    _onOpen(w) {
      this.retries = 0;
      this.rebuilding = false;
      this.term.focus();
      // 必须先发 auth（服务端首帧鉴权），再调用会触发 onResize 发 resize 帧的 fit.fit()，
      // 否则 resize 抢在 auth 前被当作未鉴权拒绝（表现为首次"连接断开"，重连才成功）
      try { w.send(JSON.stringify({ type: 'auth', token: tokenGetter() })); } catch { /* ignore */ }
      this.fit.fit();
      w.send(JSON.stringify({ type: 'resize', cols: this.term.cols, rows: this.term.rows }));
      // 自愈：连接后长时间无数据（open_terminal 在 agent 重连窗口丢失）→ 重建会话
      if (this.noDataTimer) clearTimeout(this.noDataTimer);
      this.noDataTimer = setTimeout(() => {
        this.noDataTimer = null;
        if (this.closed || this.rebuilding) return;
        this.term.write(`\r\n${t('term.rebuilding')}\x1b[0m\r\n`);
        this.rebuilding = true;
        try { w.close(); } catch { /* ignore */ }
        this.open(this.serverId);
      }, 8000);
    }
    _onMessage(ev) {
      if (this.noDataTimer) { clearTimeout(this.noDataTimer); this.noDataTimer = null; } // 有数据即会话正常
      if (typeof ev.data === 'string') this.term.write(ev.data);
      else this.term.write(new Uint8Array(ev.data));
    }
    _onClose(ev) {
      if (this.closed) return;
      if (this.rebuilding) return; // 重建已由无响应分支的 open() 接管
      if (this.noDataTimer) { clearTimeout(this.noDataTimer); this.noDataTimer = null; }
      if (ev && ev.code === 1008) {
        // 鉴权已失效（PAT 撤销/服务端拒绝）：关闭会话并回登录页，不再重连
        this.closed = true;
        this.term.write(`\r\n${t('term.authExpired')}\x1b[0m\r\n`);
        if (this.h.onAuthFail) this.h.onAuthFail();
        return;
      }
      if (this.retries < TERM_RETRY_MAX) {
        this.retries += 1;
        this.term.write(`\r\n\x1b[90m${t('term.connecting', { n: this.retries })}\x1b[0m\r\n`);
        setTimeout(() => this.open(this.serverId), this.retries * 1000);
      } else {
        this.term.write(`\r\n${t('term.closed')}\x1b[0m\r\n`);
      }
    }
    send(data) { if (this.connected) this.ws.send(data); }
    resize(cols, rows) { if (this.connected) this.ws.send(JSON.stringify({ type: 'resize', cols, rows })); }
    close() {
      if (this.closed) return;
      this.closed = true;
      if (this.noDataTimer) { clearTimeout(this.noDataTimer); this.noDataTimer = null; }
      try { this.ws && this.ws.close(); } catch { /* ignore */ }
      this.term.dispose();
    }
  }

  // ---------- 实时推送（PushSession）：/ws/push 常驻连接 + 重连，数据经回调交给 UI ----------
  class PushSession {
    constructor(handlers = {}) {
      this.h = handlers; // { onOpen, onData(list), onAuthFail, onLongRetry }
      this.ws = null;
      this.closed = true;
      this.retries = 0;
    }
    get connected() { return this.ws && this.ws.readyState === 1; }

    open() {
      this.closed = false;
      this.retries = 0;
      if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) return;
      this._connect();
    }
    _connect() {
      if (this.closed || !tokenGetter()) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      // token 不放 URL（避免进访问日志/浏览器历史），连接后首帧发送鉴权
      const ws = new WebSocket(`${proto}://${location.host}/ws/push`);
      this.ws = ws;
      ws.onopen = () => {
        this.retries = 0;
        try { ws.send(JSON.stringify({ type: 'auth', token: tokenGetter() })); } catch { /* ignore */ }
        if (this.h.onOpen) this.h.onOpen();
      };
      ws.onmessage = (ev) => {
        try {
          const list = JSON.parse(ev.data);
          if (Array.isArray(list) && this.h.onData) this.h.onData(list);
        } catch { /* 忽略非 JSON 帧 */ }
      };
      ws.onclose = (ev) => {
        if (this.ws !== ws) return; // 已被主动关闭/新连接替换
        this.ws = null;
        if (this.closed) return; // 主动关闭不再重连
        if (!tokenGetter()) return;
        if (ev && ev.code === 1008) {
          // 鉴权已失效（PAT 撤销/连接被服务端拒绝）：清除登录态回登录页，避免重连死循环
          this.closed = true;
          if (this.h.onAuthFail) this.h.onAuthFail();
          return;
        }
        if (this.retries < 5) {
          this.retries += 1;
          setTimeout(() => this._connect(), 3000);
        } else {
          // 重连耗尽后 30s 兜底重试（服务恢复后自动连回，无需手动刷新）
          if (this.h.onLongRetry) this.h.onLongRetry();
          setTimeout(() => this._connect(), 30000);
        }
      };
      ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
    }
    // 主动关闭（idle 暂停/后台隐藏/登出），不再重连
    close() {
      this.closed = true;
      if (this.ws) { const w = this.ws; this.ws = null; try { w.close(); } catch { /* ignore */ } }
    }
    sync() { if (this.connected) this.ws.send('sync'); } // 拉最新列表
  }

  window.CfApi = { api, setTokenGetter, FileSession, TermSession, PushSession };
})();
