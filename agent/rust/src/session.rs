// 会话：终端 PTY（双向透传 + resize + 进程组清理）与文件管理（JSON 行协议）
use crate::{log, Config};
use futures_util::{SinkExt, StreamExt};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

const FILE_LIMIT: u64 = 500 * 1024 * 1024; // 单文件总上限 500MB
                                           // 服务端固定内部缓冲（与客户端分块解耦）：
                                           // - READ_BLOCK：单次 read 最多读取并返回的字节（前端按返回的 got 累加续传，自动适配任意值）。
                                           //   512KB 块 + 1MB 上限：混合帧下原始字节直传，帧大小 = JSON 头 + 数据（块 ≤512KB 时帧 < 1MB）
const READ_BLOCK: usize = 1024 * 1024;
// 文件 WS 入站消息大小上限（防恶意超大 data 整包占内存；正常前端 512KB 分块远小于此）
const WS_MSG_LIMIT: usize = 8 * 1024 * 1024;
// 终端输出合帧：聚合 TERM_BATCH_MS 或 TERM_BATCH_BYTES 后合并为一条 WS 帧。
// 刷屏场景（pty 每 8KB 一帧）DO 计费消息数从 N 帧降到约 1 帧/16ms（约 −60%~75%）；
// 交互延迟 ≤16ms 人眼无感；顺序保持（同批内按到达序拼接）。
const TERM_BATCH_MS: u64 = 16;
const TERM_BATCH_BYTES: usize = 32 * 1024;

fn err_json(msg: &str) -> String {
    serde_json::json!({ "type": "error", "ok": false, "message": msg }).to_string()
}

// ---------------- 终端会话 ----------------
pub struct TermSession {
    pub sid: String,
    master: Arc<Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Arc<Mutex<Option<Box<dyn portable_pty::Child + Send + Sync>>>>,
    child_pid: u32,
}

impl TermSession {
    pub async fn spawn(sid: &str) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let pty = native_pty_system();
        let pair = pty.openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        let mut cmd = CommandBuilder::new("bash");
        cmd.arg("-i");
        let child = pair.slave.spawn_command(cmd)?;
        let child_pid = child.process_id().unwrap_or(0);
        drop(pair.slave);
        let writer = pair.master.take_writer()?;
        Ok(TermSession {
            sid: sid.to_string(),
            master: Arc::new(Mutex::new(pair.master)),
            writer: Arc::new(Mutex::new(writer)),
            child: Arc::new(Mutex::new(Some(child))),
            child_pid,
        })
    }

    pub fn resize(&self, rows: u16, cols: u16) {
        if let Ok(m) = self.master.try_lock() {
            let _ = m.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            });
        }
    }

    // 会话结束清理：kill 进程组（bash 由 portable-pty setsid 启动，负 PID 即整组）
    pub async fn cleanup(&self) {
        #[cfg(unix)]
        if self.child_pid > 0 {
            unsafe {
                libc::kill(-(self.child_pid as i32), libc::SIGHUP);
            }
        }
        let mut child = self.child.lock().await;
        if let Some(c) = child.as_mut() {
            let _ = c.kill();
        }
        *child = None;
        log(format!("terminal {} cleaned up", self.sid));
    }
}

// 终端数据流：连 /ws/agent/terminal?sid= （X-Agent-Key），双向透传
// 无论成功/失败，退出时一律 cleanup（杀 bash 进程组）+ 从 sessions map 移除（防 fd/内存泄露）
pub async fn run_terminal(
    cfg: &Config,
    term: Arc<TermSession>,
    sessions: &Arc<Mutex<std::collections::HashMap<String, Arc<TermSession>>>>,
) {
    run_terminal_inner(cfg, &term).await;
    term.cleanup().await;
    // 仅当 Map 中仍指向本会话时才移除：防确认重发导致新旧并存时，旧任务结束误删新会话项
    {
        let mut map = sessions.lock().await;
        if let Some(cur) = map.get(&term.sid) {
            if Arc::ptr_eq(cur, &term) {
                map.remove(&term.sid);
            }
        }
    }
    log(format!("terminal {} ended", term.sid));
}

async fn run_terminal_inner(cfg: &Config, term: &Arc<TermSession>) {
    let url = format!("{}/terminal?sid={}", cfg.wss, term.sid);
    let mut req = match url.into_client_request() {
        Ok(r) => r,
        Err(e) => {
            log(format!("terminal {}/req error: {e}", term.sid));
            return;
        }
    };
    req.headers_mut()
        .insert("X-Agent-Key", cfg.key.parse().unwrap());
    let (ws, _) = match tokio_tungstenite::connect_async(req).await {
        Ok(x) => x,
        Err(e) => {
            log(format!("terminal {} connect failed: {e}", term.sid));
            return;
        }
    };
    let (mut write, mut read) = ws.split();

    // pty 输出 → WS（阻塞读放独立线程，经 channel 送发送任务）
    let mut reader = match term.master.lock().await.try_clone_reader() {
        Ok(r) => r,
        Err(e) => {
            log(format!("terminal {} no reader: {e}", term.sid));
            return;
        }
    };
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(64);
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let send_task = tokio::spawn(async move {
        // 合帧发送：聚合约 16ms 或 32KB 合并一条 WS 帧（降 DO 计费消息数，见 TERM_BATCH_* 注释）
        let mut batch: Vec<u8> = Vec::with_capacity(TERM_BATCH_BYTES);
        while let Some(bytes) = rx.recv().await {
            batch.extend_from_slice(&bytes);
            loop {
                if batch.len() >= TERM_BATCH_BYTES {
                    if write
                        .send(Message::Binary(std::mem::take(&mut batch)))
                        .await
                        .is_err()
                    {
                        return;
                    }
                    break;
                }
                match tokio::time::timeout(Duration::from_millis(TERM_BATCH_MS), rx.recv()).await {
                    Ok(Some(more)) => batch.extend_from_slice(&more),
                    _ => {
                        // 窗口到期或通道关闭：flush 剩余
                        if !batch.is_empty()
                            && write
                                .send(Message::Binary(std::mem::take(&mut batch)))
                                .await
                                .is_err()
                        {
                            return;
                        }
                        break;
                    }
                }
            }
        }
        if !batch.is_empty() {
            let _ = write.send(Message::Binary(batch)).await;
        }
    });

    // WS → pty 输入
    while let Some(msg) = read.next().await {
        let msg = match msg {
            Ok(m) => m,
            Err(_) => break,
        };
        match msg {
            Message::Text(t) => {
                let mut w = term.writer.lock().await;
                let _ = w.write_all(t.as_bytes());
                let _ = w.flush();
            }
            Message::Binary(b) => {
                let mut w = term.writer.lock().await;
                let _ = w.write_all(&b);
                let _ = w.flush();
            }
            _ => {}
        }
    }
    send_task.abort();
}

// ---------------- 文件管理会话 ----------------
pub async fn run_file_session(cfg: Config, sid: String) {
    let url = format!("{}/file?sid={}", cfg.wss, sid);
    let mut req = match url.into_client_request() {
        Ok(r) => r,
        Err(e) => {
            log(format!("file {sid} req error: {e}"));
            return;
        }
    };
    req.headers_mut()
        .insert("X-Agent-Key", cfg.key.parse().unwrap());
    // 限制入站消息大小，防恶意超大 data 整包占内存
    let cfg_ws = tokio_tungstenite::tungstenite::protocol::WebSocketConfig {
        max_message_size: Some(WS_MSG_LIMIT),
        ..Default::default()
    };
    let (ws, _) = match tokio_tungstenite::connect_async_with_config(req, Some(cfg_ws), false).await
    {
        Ok(x) => x,
        Err(e) => {
            log(format!("file {sid} connect failed: {e}"));
            return;
        }
    };
    let (mut write, mut read) = ws.split();
    // 会话创建的临时文件（.upload.{id}）：断线/结束时清理残留
    let created: Arc<std::sync::Mutex<Vec<String>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
    while let Some(msg) = read.next().await {
        let msg = match msg {
            Ok(m) => m,
            Err(_) => break,
        };
        // 混合帧协议：Text 为无数据命令（list/read/abort）；Binary 为 write 混合帧
        //（JSON 头 + '\n' + 原始字节）。响应按内容区分 Text/Binary
        let reply = match msg {
            Message::Text(t) => handle_file_cmd(&t).await,
            Message::Binary(b) => handle_file_cmd_binary(b, created.clone()).await,
            _ => continue,
        };
        let sent = match reply {
            FileReply::Text(s) => write.send(Message::Text(s)).await,
            FileReply::Binary(b) => write.send(Message::Binary(b)).await,
        };
        if sent.is_err() {
            break;
        }
    }
    // 断线/会话结束：清理本会话创建的临时文件（防止 .upload.{id} 残留累积）
    {
        let tmp = created.lock().unwrap();
        for p in tmp.iter() {
            let _ = std::fs::remove_file(p);
        }
    }
    log(format!("file session {sid} ended"));
}

// 文件命令响应：Text（list_result/write_result/error 等无数据）或 Binary（read_result 混合帧）
enum FileReply {
    Text(String),
    Binary(Vec<u8>),
}

async fn handle_file_cmd(line: &str) -> FileReply {
    let v: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return FileReply::Text(err_json("bad json")),
    };
    let ty = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
    let path = v
        .get("path")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    match ty {
        "list" => {
            // 可选通配符过滤规则（由前端输入框传递；过滤在 agent 端完成，避免大目录
            // 截断（FILE_LIST_MAX=1000）后前端只拿到截断区间子集而遗漏匹配文件）
            let pattern = v.get("pattern").and_then(|x| x.as_str()).map(String::from);
            FileReply::Text(file_list(path, pattern).await)
        }
        "read" => {
            let offset = v.get("offset").and_then(|x| x.as_u64()).unwrap_or(0);
            let limit = v.get("limit").and_then(|x| x.as_u64()).unwrap_or(0);
            match file_read(path, offset, limit).await {
                Ok(frame) => FileReply::Binary(frame),
                Err(e) => FileReply::Text(err_json(&e)),
            }
        }

        "abort" => {
            let upload_id = v
                .get("upload_id")
                .and_then(|x| x.as_str())
                .unwrap_or("default")
                .to_string();
            FileReply::Text(file_abort(path, upload_id).await)
        }
        _ => FileReply::Text(err_json("unknown cmd")),
    }
}

// Binary 混合帧：'\n' 前为 JSON 元数据（write 命令），'\n' 后为原始文件字节
// Binary 混合帧（owned Vec，直接来自 tungstenite 分配）：'\n' 前 JSON 头，后为原始文件字节。
// 拆分与写入都在 spawn_blocking 闭包内完成，数据切片直接写、无二次拷贝——
// 内存 = 入站帧本身（512KB 块 + JSON 头），不随块大小额外放大
async fn handle_file_cmd_binary(
    frame: Vec<u8>,
    created: Arc<std::sync::Mutex<Vec<String>>>,
) -> FileReply {
    match blocking_with_timeout(30, move || {
        let Some(nl) = frame.iter().position(|&b| b == b'\n') else {
            return err_json("bad frame (no json header)");
        };
        let v: serde_json::Value = match serde_json::from_slice(&frame[..nl]) {
            Ok(v) => v,
            Err(_) => return err_json("bad json"),
        };
        let ty = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        if ty != "write" {
            return err_json("unknown cmd");
        }
        let path = v
            .get("path")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let offset = v.get("offset").and_then(|x| x.as_u64()).unwrap_or(0);
        let commit = v.get("commit").and_then(|x| x.as_bool()).unwrap_or(false);
        let upload_id = v
            .get("upload_id")
            .and_then(|x| x.as_str())
            .unwrap_or("default")
            .to_string();
        write_bytes(
            &path,
            offset,
            &frame[nl + 1..],
            commit,
            &upload_id,
            &created,
        )
    })
    .await
    {
        Some(v) => FileReply::Text(v),
        None => FileReply::Text(err_json("write timeout")),
    }
}

// spawn_blocking + 超时：防止挂死的挂载点（NFS 等）永久占用 blocking 线程
async fn blocking_with_timeout<F, T>(secs: u64, f: F) -> Option<T>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    let join = tokio::task::spawn_blocking(f);
    match tokio::time::timeout(std::time::Duration::from_secs(secs), join).await {
        Ok(Ok(v)) => Some(v),
        _ => None,
    }
}

// 通配符匹配：* 匹配任意（含空），? 匹配单字符（大小写由调用方归一）
fn wildcard_match(pattern: &str, name: &str) -> bool {
    let p = pattern.as_bytes();
    let n = name.as_bytes();
    let (mut pi, mut ni) = (0usize, 0usize);
    let mut star_p = None; // 最近一次 * 的位置（用于回溯）
    let mut star_n = 0;
    while ni < n.len() {
        if pi < p.len() && (p[pi] == n[ni] || p[pi] == b'?') {
            pi += 1;
            ni += 1;
        } else if pi < p.len() && p[pi] == b'*' {
            star_p = Some(pi);
            star_n = ni;
            pi += 1;
        } else if let Some(sp) = star_p {
            pi = sp + 1;
            star_n += 1;
            ni = star_n;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == b'*' {
        pi += 1;
    }
    pi == p.len()
}

async fn file_list(path: String, pattern: Option<String>) -> String {
    match blocking_with_timeout(10, move || {
        // 目录列表最大条目数，防超大目录物化全部条目/生成巨型 JSON。
        // 通配符过滤先于截断：确保大目录下匹配的文件都在结果中（前端只过滤会遗漏截断区间）
        const FILE_LIST_MAX: usize = 1000;
        let matcher = pattern
            .as_deref()
            .filter(|p| !p.is_empty())
            .map(|p| p.to_ascii_lowercase());
        let mut entries = Vec::new();
        let mut truncated = false;
        if let Ok(rd) = std::fs::read_dir(&path) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                if let Some(m) = &matcher {
                    if !wildcard_match(m, &name.to_ascii_lowercase()) {
                        continue;
                    }
                }
                if entries.len() >= FILE_LIST_MAX {
                    truncated = true;
                    break;
                }
                let meta = e.metadata();
                let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
                let size = if is_dir {
                    0
                } else {
                    meta.as_ref().map(|m| m.len()).unwrap_or(0)
                };
                let mtime = meta
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                entries.push(serde_json::json!({
                    "name": name,
                    "type": if is_dir { "dir" } else { "file" },
                    "size": size,
                    "mtime": mtime,
                }));
            }
        }
        serde_json::json!({
            "type": "list_result", "ok": true, "path": path,
            "entries": entries, "truncated": truncated,
        })
        .to_string()
    })
    .await
    {
        Some(v) => v,
        None => err_json("list timeout"),
    }
}

// 读取返回混合帧（JSON 头 + '\n' + 原始字节，无 base64 膨胀）。
// 块上限仍由 READ_BLOCK 约束（与前端 512KB 分块一致），错误返回 Err(描述)
async fn file_read(path: String, offset: u64, limit: u64) -> Result<Vec<u8>, String> {
    match blocking_with_timeout(30, move || {
        use std::io::{Read, Seek, SeekFrom};
        let meta = match std::fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => return Err("not a file or unreadable".to_string()),
        };
        let size = meta.len();
        if size > FILE_LIMIT {
            return Err("file exceeds 500MB limit".to_string());
        }
        if !meta.is_file() {
            return Err("not a file or unreadable".to_string());
        }
        // 单次读取上限 READ_BLOCK：服务端固定 512KB 内部缓冲，与前端分块解耦。
        // 即使 limit=0（读全文件），也最多返回 READ_BLOCK，前端按返回的 got 累加 offset 续传，自动适配任意块大小。
        let want = if limit == 0 {
            size
        } else {
            limit.min(size.saturating_sub(offset))
        };
        let read_len = (want as usize).min(READ_BLOCK) as u64;
        let mut f = match std::fs::File::open(&path) {
            Ok(f) => f,
            Err(_) => return Err("not a file or unreadable".to_string()),
        };
        if f.seek(SeekFrom::Start(offset)).is_err() {
            return Err("read failed".to_string());
        }
        let mut buf = vec![0u8; read_len as usize];
        let mut got = 0usize;
        while got < buf.len() {
            match f.read(&mut buf[got..]) {
                Ok(0) => break,
                Ok(n) => got += n,
                Err(_) => break,
            }
        }
        // 混合帧：JSON 头 + '\n' + 原始字节
        let head = serde_json::json!({
            "type": "read_result", "ok": true, "path": path,
            "offset": offset, "got": got, "size": size,
        })
        .to_string();
        let mut frame = head.into_bytes();
        frame.push(b'\n');
        frame.extend_from_slice(&buf[..got]);
        Ok(frame)
    })
    .await
    {
        Some(v) => v,
        None => Err("read timeout".to_string()),
    }
}

// 同步原子写（供 spawn_blocking 闭包调用，避免 async 借用问题）：
// 临时文件 {path}.upload.{upload_id}（上传 ID 唯一，同路径并发上传互不冲突），
// commit（最后一块）时 fsync + rename 原子替换目标。失败/中断只留临时残留、不破坏目标。
// 严格 offset 校验：必须与临时文件当前长度一致（防丢块/乱序/并发块错写）。
fn write_bytes(
    path: &str,
    offset: u64,
    data: &[u8],
    commit: bool,
    upload_id: &str,
    created: &Arc<std::sync::Mutex<Vec<String>>>,
) -> String {
    use std::io::{Seek, SeekFrom, Write};
    let tmp = format!("{}.upload.{}", path, upload_id);
    if let Some(parent) = std::path::Path::new(path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // 记录本会话创建的临时文件（会话结束/断线时清理）
    if let Ok(mut c) = created.lock() {
        c.push(tmp.clone());
    }
    let cleanup = |tmp: &str| {
        let _ = std::fs::remove_file(tmp);
    };
    // offset 校验：期望 = 临时文件当前长度（首块为 0）
    let cur_len = std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
    if offset != cur_len {
        cleanup(&tmp);
        return err_json(&format!(
            "offset mismatch: got {offset}, expect {cur_len} (丢块或并发块错写)"
        ));
    }
    // 注意：create 时不 truncate（upload_id 唯一，首块 offset=0 天然从空文件开始）
    #[allow(clippy::suspicious_open_options)]
    let mut f = match std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .open(&tmp)
    {
        Ok(f) => f,
        Err(_) => return err_json("write failed"),
    };
    if f.seek(SeekFrom::Start(offset)).is_err() {
        cleanup(&tmp);
        return err_json("write failed");
    }
    // 原始字节直写（混合帧数据不再 base64）；数据切片直接来自入站帧，无额外拷贝
    let mut written = 0usize;
    while written < data.len() {
        match f.write(&data[written..]) {
            Ok(n) => written += n,
            Err(_) => {
                cleanup(&tmp);
                return err_json("write failed");
            }
        }
    }
    // 大小校验（针对临时文件）
    let cur = std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
    if cur > FILE_LIMIT {
        cleanup(&tmp);
        return err_json("file exceeds 500MB limit, aborted");
    }
    // commit：fsync + 原子 rename 覆盖目标文件
    if commit && (f.sync_all().is_err() || std::fs::rename(&tmp, path).is_err()) {
        cleanup(&tmp);
        return err_json("write failed");
    }
    serde_json::json!({
        "type": "write_result", "ok": true, "path": path,
        "offset": offset, "written": written, "commit": commit,
    })
    .to_string()
}

// abort：取消上传，删除对应临时文件（{path}.upload.{upload_id}）
async fn file_abort(path: String, upload_id: String) -> String {
    match blocking_with_timeout(10, move || {
        let tmp = format!("{}.upload.{}", path, upload_id);
        let _ = std::fs::remove_file(&tmp);
        serde_json::json!({ "type": "abort_result", "ok": true, "path": path }).to_string()
    })
    .await
    {
        Some(v) => v,
        None => err_json("abort timeout"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn err_json_shape() {
        let v: serde_json::Value = serde_json::from_str(&err_json("boom")).unwrap();
        assert_eq!(v["type"], "error");
        assert_eq!(v["ok"], false);
        assert_eq!(v["message"], "boom");
    }

    #[test]
    fn wildcard_match_basic() {
        // 大小写已由调用方 to_ascii_lowercase 归一，此处 pattern/name 均传小写
        assert!(wildcard_match("*.log", "app.log"));
        assert!(wildcard_match("*.log", "a.log"));
        assert!(!wildcard_match("*.log", "app.txt"));
        assert!(wildcard_match("a?.txt", "a1.txt"));
        assert!(!wildcard_match("a?.txt", "abc.txt"));
        assert!(wildcard_match("a*b*c", "axbyc"));
        assert!(!wildcard_match("a*b*c", "axby"));
        assert!(wildcard_match("src/*.rs", "src/main.rs"));
        assert!(wildcard_match("src/*.rs", "src/lib/main.rs")); // * 为贪婪匹配（file_list 只对 basename 匹配，无跨路径场景）
        assert!(wildcard_match("", ""));
        assert!(!wildcard_match("", "x"));
        assert!(wildcard_match("*", "anything"));
    }

    #[test]
    fn buffer_constants() {
        // 固定缓冲重构的常量约束（与前端分块解耦的服务端固定缓冲）
        assert_eq!(READ_BLOCK, 1024 * 1024, "READ_BLOCK 单次读取上限");
        assert_eq!(WS_MSG_LIMIT, 8 * 1024 * 1024);
        assert_eq!(FILE_LIMIT, 500 * 1024 * 1024);
        // 常量断言（编译期校验，避免运行时断言被 clippy 标记）
        const {
            assert!(TERM_BATCH_MS >= 8 && TERM_BATCH_MS <= 32);
        };
        const {
            assert!(TERM_BATCH_BYTES >= 16 * 1024 && TERM_BATCH_BYTES <= 64 * 1024);
        };
    }
}
