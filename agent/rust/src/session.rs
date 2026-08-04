// 会话：终端 PTY（双向透传 + resize + 进程组清理）与文件管理（JSON 行协议）
use crate::{log, Config};
use futures_util::{SinkExt, StreamExt};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

const FILE_LIMIT: u64 = 500 * 1024 * 1024; // 单文件总上限 500MB
// 服务端固定内部缓冲（与客户端分块解耦）：
// - READ_BLOCK：单次 read 最多读取并返回的字节（前端按返回的 got 累加续传，自动适配任意值）
// - WRITE_BUF：写路径流式 base64 解码的缓冲（边解边写，内存不随块大小增长）
const READ_BLOCK: usize = 512 * 1024;
const WRITE_BUF: usize = 64 * 1024;
// 文件 WS 入站消息大小上限（防恶意超大 data 整包占内存；正常前端 1MB 分块远小于此）
const WS_MSG_LIMIT: usize = 8 * 1024 * 1024;

fn b64e(data: &[u8]) -> String {
    base64::Engine::encode(&base64::engine::general_purpose::STANDARD, data)
}
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
        let pair = pty.openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })?;
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
            let _ = m.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
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
    sessions.lock().await.remove(&term.sid);
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
    req.headers_mut().insert("X-Agent-Key", cfg.key.parse().unwrap());
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
        while let Some(bytes) = rx.recv().await {
            if write.send(Message::Binary(bytes)).await.is_err() {
                break;
            }
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
    req.headers_mut().insert("X-Agent-Key", cfg.key.parse().unwrap());
    // 限制入站消息大小，防恶意超大 data 整包占内存
    let cfg_ws = tokio_tungstenite::tungstenite::protocol::WebSocketConfig {
        max_message_size: Some(WS_MSG_LIMIT),
        ..Default::default()
    };
    let (ws, _) = match tokio_tungstenite::connect_async_with_config(req, Some(cfg_ws), false).await {
        Ok(x) => x,
        Err(e) => {
            log(format!("file {sid} connect failed: {e}"));
            return;
        }
    };
    let (mut write, mut read) = ws.split();
    while let Some(msg) = read.next().await {
        let msg = match msg {
            Ok(m) => m,
            Err(_) => break,
        };
        let line = match msg {
            Message::Text(t) => t,
            _ => continue,
        };
        let reply = handle_file_cmd(&line).await;
        if write.send(Message::Text(reply)).await.is_err() {
            break;
        }
    }
    log(format!("file session {sid} ended"));
}

async fn handle_file_cmd(line: &str) -> String {
    let v: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return err_json("bad json"),
    };
    let ty = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
    let path = v.get("path").and_then(|x| x.as_str()).unwrap_or("").to_string();
    match ty {
        "list" => file_list(path).await,
        "read" => {
            let offset = v.get("offset").and_then(|x| x.as_u64()).unwrap_or(0);
            let limit = v.get("limit").and_then(|x| x.as_u64()).unwrap_or(0);
            file_read(path, offset, limit).await
        }
        "write" => {
            let offset = v.get("offset").and_then(|x| x.as_u64()).unwrap_or(0);
            let data = v.get("data").and_then(|x| x.as_str()).unwrap_or("").to_string();
            file_write(path, offset, data).await
        }
        _ => err_json("unknown cmd"),
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

async fn file_list(path: String) -> String {
    match blocking_with_timeout(10, move || {
        let mut entries = Vec::new();
        if let Ok(rd) = std::fs::read_dir(&path) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                let meta = e.metadata();
                let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
                let size = if is_dir { 0 } else { meta.as_ref().map(|m| m.len()).unwrap_or(0) };
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
        serde_json::json!({ "type": "list_result", "ok": true, "path": path, "entries": entries }).to_string()
    })
    .await
    {
        Some(v) => v,
        None => err_json("list timeout"),
    }
}

async fn file_read(path: String, offset: u64, limit: u64) -> String {
    match blocking_with_timeout(30, move || {
        use std::io::{Read, Seek, SeekFrom};
        let meta = match std::fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => return err_json("not a file or unreadable"),
        };
        let size = meta.len();
        if size > FILE_LIMIT {
            return err_json("file exceeds 500MB limit");
        }
        if !meta.is_file() {
            return err_json("not a file or unreadable");
        }
        // 单次读取上限 READ_BLOCK：服务端固定 512KB 内部缓冲，与前端分块解耦。
        // 即使 limit=0（读全文件），也最多返回 READ_BLOCK，前端按返回的 got 累加 offset 续传，自动适配任意块大小。
        let want = if limit == 0 { size } else { limit.min(size.saturating_sub(offset)) };
        let read_len = (want as usize).min(READ_BLOCK) as u64;
        let mut f = match std::fs::File::open(&path) {
            Ok(f) => f,
            Err(_) => return err_json("not a file or unreadable"),
        };
        if f.seek(SeekFrom::Start(offset)).is_err() {
            return err_json("read failed");
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
        serde_json::json!({
            "type": "read_result", "ok": true, "path": path,
            "offset": offset, "data": b64e(&buf[..got]), "got": got, "size": size,
        })
        .to_string()
    })
    .await
    {
        Some(v) => v,
        None => err_json("read timeout"),
    }
}

async fn file_write(path: String, offset: u64, data: String) -> String {
    match blocking_with_timeout(30, move || {
        use std::io::{Seek, SeekFrom};
        if let Some(parent) = std::path::Path::new(&path).parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let mut f = match std::fs::OpenOptions::new().create(true).write(true).open(&path) {
            Ok(f) => f,
            Err(_) => return err_json("write failed"),
        };
        if offset == 0 {
            if f.set_len(0).is_err() || f.seek(SeekFrom::Start(0)).is_err() {
                return err_json("write failed");
            }
        } else if f.seek(SeekFrom::Start(offset)).is_err() {
            return err_json("write failed");
        }
        // 流式 base64 解码：边解边写，内部缓冲固定 WRITE_BUF，内存不随入站块大小增长。
        // 入站消息大小已由 WS_MSG_LIMIT 兜底，不再做块大小硬校验。
        let mut dec = base64::read::DecoderReader::new(
            std::io::Cursor::new(data.into_bytes()),
            &base64::engine::general_purpose::STANDARD,
        );
        let mut buf = vec![0u8; WRITE_BUF];
        loop {
            match dec.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if f.write_all(&buf[..n]).is_err() {
                        return err_json("write failed");
                    }
                }
                Err(_) => return err_json("write failed"),
            }
        }
        let cur = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        if cur > FILE_LIMIT {
            let _ = std::fs::remove_file(&path);
            return err_json("file exceeds 500MB limit, aborted");
        }
        serde_json::json!({ "type": "write_result", "ok": true, "path": path, "offset": offset }).to_string()
    })
    .await
    {
        Some(v) => v,
        None => err_json("write timeout"),
    }
}
