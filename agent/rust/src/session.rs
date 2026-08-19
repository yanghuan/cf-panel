// 会话：终端 PTY（双向透传 + resize + 进程组清理）与文件管理（JSON 行协议）
use crate::{Config, log};
use futures_util::{SinkExt, StreamExt};
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use std::io::{Read, Write};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

const FILE_LIMIT: u64 = 500 * 1024 * 1024; // 单文件总上限 500MB
// 服务端固定内部缓冲（与客户端分块解耦）：
// - READ_BLOCK：单次 read 最多读取并返回的字节（前端按返回的 got 累加续传，自动适配任意值）。
//   512KB 块 + 1MB 上限：混合帧下原始字节直传，帧大小 = JSON 头 + 数据（块 ≤512KB 时帧 < 1MB）
const READ_BLOCK: usize = 1024 * 1024;
// 文件 WS 入站消息大小上限（防恶意超大 data 整包占内存；正常前端 512KB 分块远小于此）
const WS_MSG_LIMIT: usize = 8 * 1024 * 1024;
// 终端入站消息上限 1MB（正常输入单帧极小，异常/恶意超大帧直接断开，与文件通道对齐）
const TERM_MSG_LIMIT: usize = 1024 * 1024;
// 终端输出合帧：聚合 TERM_BATCH_MS 或 TERM_BATCH_BYTES 后合并为一条 WS 帧。
// 刷屏场景（pty 每 8KB 一帧）DO 计费消息数从 N 帧降到约 1 帧/16ms（约 −60%~75%）；
// 交互延迟 ≤16ms 人眼无感；顺序保持（同批内按到达序拼接）。
const TERM_BATCH_MS: u64 = 16;
const TERM_BATCH_BYTES: usize = 32 * 1024;
// 数据面（终端/文件 WS）空闲超时与保活：数据面连接无服务端心跳（服务端仅对控制通道
// 发 30s ping），半开连接（NAT 静默丢链，无 FIN/RST）下入站永远安静、出站静默失败
// 不报错——纯入站空闲计时是唯一可靠的检测手段。保活 ping 解决误杀：挂机 tail -f
//（出站流动、入站全空）的会话靠服务端按 RFC 6455 自动回 Pong 构成入站活动。
const DATA_IDLE_TIMEOUT_S: u64 = 900; // 15min 无任何入站（含 pong）判定半开，断开清理
const DATA_PING_S: u64 = 60; // 空闲时每 60s 发 Ping 维持 pong 回路

fn err_json(msg: &str) -> String {
    serde_json::json!({ "type": "error", "ok": false, "message": msg }).to_string()
}

// ---------------- 终端会话 ----------------
pub struct TermSession {
    pub sid: String,
    master: Arc<Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
    // Option：run_terminal_inner 启动时 take 交给专用写线程（阻塞写不占 async worker，
    // 见 run_terminal_inner 注释）；此后本结构不再持有 writer
    writer: Arc<Mutex<Option<Box<dyn Write + Send>>>>,
    child: Arc<Mutex<Option<Box<dyn portable_pty::Child + Send + Sync>>>>,
    child_pid: u32,
    cleaned: std::sync::atomic::AtomicBool, // cleanup 幂等（防双调用 kill 后 PID 复用误杀）
    alive: std::sync::atomic::AtomicBool,   // 会话是否仍活跃（僵尸会话不再回执 ready，而是重建）
}

impl TermSession {
    pub async fn spawn(sid: &str) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let sid = sid.to_string();
        // openpty + spawn_command 为同步 fork/exec：内存紧张时 fork 可达几十 ms，
        // 直接在 async 上下文执行会阻塞 worker 与控制读循环 → 放 blocking 线程（信号量限并发）
        match crate::blocking::run_blocking(10, move || TermSession::spawn_sync(&sid)).await {
            Some(r) => r,
            None => Err("terminal spawn timeout".into()),
        }
    }

    fn spawn_sync(sid: &str) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let pty = native_pty_system();
        let pair = pty.openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        // shell 探测 $SHELL → /bin/bash → /bin/sh（busybox/Alpine/OpenWrt 无 bash 时终端仍可用；
        // 显式声明 xterm-256color：systemd 环境无 TERM 时 TUI 程序检测不到终端类型会输出一屏立即退出）
        let shell = std::env::var("SHELL")
            .ok()
            .filter(|s| !s.is_empty() && std::path::Path::new(s).exists())
            .unwrap_or_else(|| {
                // Alpine/busybox/OpenWrt 无 bash：/bin/sh 即 ash（busybox applet），绝对路径避免 PATH 依赖
                if std::path::Path::new("/bin/bash").exists() {
                    "/bin/bash".to_string()
                } else if std::path::Path::new("/bin/sh").exists() {
                    "/bin/sh".to_string()
                } else {
                    "sh".to_string()
                }
            });
        let mut cmd = CommandBuilder::new(&shell);
        cmd.arg("-i");
        cmd.env("TERM", "xterm-256color");
        let child = pair.slave.spawn_command(cmd)?;
        let child_pid = child.process_id().unwrap_or(0);
        drop(pair.slave);
        let writer = pair.master.take_writer()?;
        Ok(TermSession {
            sid: sid.to_string(),
            master: Arc::new(Mutex::new(pair.master)),
            writer: Arc::new(Mutex::new(Some(writer))),
            child: Arc::new(Mutex::new(Some(child))),
            child_pid,
            cleaned: std::sync::atomic::AtomicBool::new(false),
            alive: std::sync::atomic::AtomicBool::new(true),
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

    // 会话结束清理：kill 进程组（bash 由 portable-pty setsid 启动，负 PID 即整组）。
    // 幂等：首调 kill 后 PID 即释放，双调用再 kill(-pid) 可能命中被复用的进程组——
    // 用 AtomicBool 保证 cleanup 只执行一次
    pub async fn cleanup(&self) {
        if self.cleaned.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        self.alive.store(false, std::sync::atomic::Ordering::SeqCst); // 会话结束标记
        #[cfg(unix)]
        if self.child_pid > 0 {
            unsafe {
                libc::kill(-(self.child_pid as i32), libc::SIGHUP);
            }
        }
        let mut child = self.child.lock().await;
        if let Some(c) = child.take() {
            // kill+wait 是阻塞调用：D 状态子进程收不到信号、wait 会永久挂住，
            // 直接执行会阻塞 async worker 与 shutdown 顺序清理流程 → blocking 线程 + 短超时
            let _ = crate::blocking::run_blocking(5, move || {
                let mut c = c;
                let _ = c.kill();
                let _ = c.wait(); // kill 后 wait 收集僵尸，避免 PID 复用
            })
            .await;
        }
        log(format!("terminal {} cleaned up", self.sid));
    }

    // 会话是否仍活跃（false = 数据面已结束/僵尸，ready 分支据此决定重建）
    pub fn is_alive(&self) -> bool {
        self.alive.load(std::sync::atomic::Ordering::SeqCst)
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
        if let Some(cur) = map.get(&term.sid)
            && Arc::ptr_eq(cur, &term)
        {
            map.remove(&term.sid);
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
    // key 含非法 header 字符时友好退出而非 panic
    let Ok(key) = cfg
        .key
        .parse::<tokio_tungstenite::tungstenite::http::HeaderValue>()
    else {
        log(format!("terminal {} bad agent key", term.sid));
        return;
    };
    req.headers_mut().insert("X-Agent-Key", key);
    // 终端入站限制 1MB（与文件通道对齐，防恶意超大帧占内存）。
    // tungstenite 0.24+ WebSocketConfig 为 non_exhaustive：default() 后逐字段赋值
    let mut cfg_ws = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default();
    cfg_ws.max_message_size = Some(TERM_MSG_LIMIT);
    let (ws, _) = match tokio_tungstenite::connect_async_with_config(req, Some(cfg_ws), false).await
    {
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
    // pty 输入：写路径与读路径对称——专用 OS 线程执行阻塞 write。
    // PTY 内核缓冲有限（XOFF 流控 Ctrl+S / TUI 停读时 write_all 阻塞到子进程消费为止，
    // 单帧最大 1MB 的大粘贴足以挂住 async worker 数秒；多会话并发即饥饿整个 runtime）。
    // channel 容量 64 + try_send：写线程阻塞时输入满即丢弃（XOFF 恢复后剩余缓冲仍写入），
    // 绝不反向阻塞主循环；写线程退出（pty 关闭）由 send_task 的 reader EOF 兜底关闭会话
    let (in_tx, in_rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(64);
    {
        let writer = term.writer.lock().await.take();
        if let Some(mut w) = writer {
            let _ = std::thread::Builder::new()
                .name(format!("term-w-{}", term.sid))
                .spawn(move || {
                    for buf in in_rx {
                        if w.write_all(&buf).is_err() || w.flush().is_err() {
                            break; // pty 已关闭
                        }
                    }
                });
        }
    }

    let mut send_task = tokio::spawn(async move {
        // 合帧发送：聚合约 16ms 或 32KB 合并一条 WS 帧（降 DO 计费消息数，见 TERM_BATCH_* 注释）
        let mut batch: Vec<u8> = Vec::with_capacity(TERM_BATCH_BYTES);
        // 空闲保活：数据方向安静时每 60s 发 Ping，服务端按 RFC 6455 自动回 Pong 构成入站
        // 活动——挂机/tail -f（出站流动、入站全空）的会话不会被主循环的入站空闲计时误杀；
        // 半开连接下 pong 永不到达，空闲超时可靠兜底。Skip：刷屏合帧期间错过 tick 不补发
        let mut ping = tokio::time::interval(Duration::from_secs(DATA_PING_S));
        ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                m = rx.recv() => {
                    let Some(bytes) = m else { break };
                    batch.extend_from_slice(&bytes);
                    loop {
                        if batch.len() >= TERM_BATCH_BYTES {
                            if write
                                .send(Message::Binary(std::mem::take(&mut batch).into()))
                                .await
                                .is_err()
                            {
                                return;
                            }
                            // take 后容量归零，预 reserve 避免每帧反复 realloc
                            batch.reserve(TERM_BATCH_BYTES);
                            break;
                        }
                        match tokio::time::timeout(Duration::from_millis(TERM_BATCH_MS), rx.recv()).await {
                            Ok(Some(more)) => batch.extend_from_slice(&more),
                            _ => {
                                // 窗口到期或通道关闭：flush 剩余
                                if !batch.is_empty()
                                    && write
                                        .send(Message::Binary(std::mem::take(&mut batch).into()))
                                        .await
                                        .is_err()
                                {
                                    return;
                                }
                                batch.reserve(TERM_BATCH_BYTES);
                                break;
                            }
                        }
                    }
                }
                _ = ping.tick() => {
                    if write.send(Message::Ping(Vec::new().into())).await.is_err() {
                        return;
                    }
                }
            }
        }
        if !batch.is_empty() {
            let _ = write.send(Message::Binary(batch.into())).await;
        }
    });

    // WS → pty 输入；pty 消亡（bash 退出 → reader EOF → send_task 结束）时主动结束会话，
    // 不再等会话 TTL 回收（bash 自然退出后终端立即关闭而非挂死）。
    // 入站空闲超时（DATA_IDLE_TIMEOUT_S）：半开连接（NAT 静默丢链，无 FIN/RST）下
    // 读不到 EOF、出站静默失败不报错——15min 无任何入站（含保活 ping 的 pong）即断开，
    // 防 PTY fd/子进程/sessions 条目/读写线程只增不减（idle shell 恰是终端最常见状态）
    loop {
        tokio::select! {
            _ = &mut send_task => break,
            r = tokio::time::timeout(Duration::from_secs(DATA_IDLE_TIMEOUT_S), read.next()) => {
                let msg = match r {
                    Ok(Some(Ok(m))) => m,
                    Ok(_) => break, // 服务端关闭或协议错误
                    Err(_) => {
                        log(format!("terminal {} idle timeout (half-open)", term.sid));
                        break;
                    }
                };
                match msg {
                    Message::Text(t) => {
                        let _ = in_tx.try_send(t.as_str().as_bytes().to_vec());
                    }
                    Message::Binary(b) => {
                        let _ = in_tx.try_send(b.to_vec());
                    }
                    // Ping/Pong 由 tungstenite 协议层处理；入站活动本身已重置空闲计时
                    _ => {}
                }
            }
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
    // key 含非法 header 字符时友好退出而非 panic
    let Ok(key) = cfg
        .key
        .parse::<tokio_tungstenite::tungstenite::http::HeaderValue>()
    else {
        log(format!("file {sid} bad agent key"));
        return;
    };
    req.headers_mut().insert("X-Agent-Key", key);
    // 限制入站消息大小，防恶意超大 data 整包占内存
    let mut cfg_ws = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default();
    cfg_ws.max_message_size = Some(WS_MSG_LIMIT);
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
    // 入站空闲超时 + 空闲保活 ping（与终端数据面同策略，见 DATA_IDLE_TIMEOUT_S 注释）：
    // 半开连接下 15min 无任何入站（含 pong）即断开清理，防会话条目/临时文件句柄泄漏
    let mut ping = tokio::time::interval(Duration::from_secs(DATA_PING_S));
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            r = tokio::time::timeout(Duration::from_secs(DATA_IDLE_TIMEOUT_S), read.next()) => {
                let msg = match r {
                    Ok(Some(Ok(m))) => m,
                    Ok(_) => break, // 服务端关闭或协议错误
                    Err(_) => {
                        log(format!("file {sid} idle timeout (half-open)"));
                        break;
                    }
                };
                // 混合帧协议：Text 为无数据命令（list/read/abort）；Binary 为 write 混合帧
                //（JSON 头 + '\n' + 原始字节）。响应按内容区分 Text/Binary
                let reply = match msg {
                    Message::Text(t) => handle_file_cmd(t.as_str(), &sid, &cfg.tmp_dir).await,
                    Message::Binary(b) => {
                        handle_file_cmd_binary(b.to_vec(), created.clone()).await
                    }
                    _ => continue, // Ping/Pong 协议层处理，入站活动已重置空闲计时
                };
                let sent = match reply {
                    FileReply::Text(s) => write.send(Message::Text(s.into())).await,
                    FileReply::Binary(b) => write.send(Message::Binary(b.into())).await,
                };
                if sent.is_err() {
                    break;
                }
            }
            _ = ping.tick() => {
                if write.send(Message::Ping(Vec::new().into())).await.is_err() {
                    break;
                }
            }
        }
    }
    // 断线/会话结束：清理本会话创建的临时文件（.upload.{id} + 目录打包 dl-{sid}.zip）
    let _ = std::fs::remove_file(format!(
        "{}/dl-{sid}.zip",
        cfg.tmp_dir.trim_end_matches('/')
    ));
    // Mutex poison 容忍
    if let Ok(tmp) = created.lock() {
        for p in tmp.iter() {
            let _ = std::fs::remove_file(p);
        }
    }
    log(format!("file session {sid} ended"));
}

// ---- 系统路径安全检查：写/删/改名/打包拒绝系统目录（防误操作破坏系统）----
// 定位：文件管理器从严屏蔽；操作系统目录的特殊需求走终端 shell 完成。
// 分两层：词法层（is_system_path，纯内存零 IO，async 上下文安全）与真实路径层
//（is_system_path_resolved，防符号链接写穿，含文件系统调用，仅限 blocking 上下文）。
const SYSTEM_PATHS: &[&str] = &[
    "/proc",
    "/sys",
    "/dev",
    "/etc",
    "/usr",
    "/var",
    "/boot",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/efi",  // Arch/openSUSE 惯例：EFI 独立挂载（/boot/efi 已被 /boot 前缀覆盖）
    "/snap", // Ubuntu snap 系统
    "/root",
    "/run",
    "/lost+found",
    // 注：/opt /srv 不拦——第三方软件部署目录（自编译服务/手动安装二进制的常规位置），
    // 删错顶多重装软件不毁系统；拦截会挡住"上传可执行软件部署"的正常流程。
    // 恶意场景（传二进制+执行）走终端 shell 本就可行，拦截不增加安全性（防误操作威胁模型）
];

// 词法归一化：要求绝对路径；折叠重复 /；解析 . 与 .. 组件。
// 返回 None 表示无法归一（相对路径、.. 越过根）——调用方一律 fail closed 拒绝，
// 否则 "//etc/x"、"/home/../etc/x"、"etc/x"（agent cwd=/ 时）均可词法绕过黑名单
fn normalize_abs(path: &str) -> Option<String> {
    if !path.starts_with('/') {
        return None;
    }
    let mut parts: Vec<&str> = Vec::new();
    for seg in path.split('/') {
        match seg {
            "" | "." => {} // 折叠 // 与当前目录组件
            ".." => {
                parts.pop()?; // 越过根（.. 回到 / 之上）→ None 拒绝
            }
            _ => parts.push(seg),
        }
    }
    if parts.is_empty() {
        return Some(String::new()); // 根 /
    }
    Some(format!("/{}", parts.join("/")))
}

// 系统路径拦截统一提示（前端 toast 直接展示该文本）
pub const SYSTEM_PATH_ERR: &str =
    "system path is protected (安全拦截：系统目录受保护，如需操作请使用终端 Shell)";

fn lexical_system_hit(norm: &str) -> bool {
    if norm.is_empty() {
        return true; // 根目录
    }
    SYSTEM_PATHS
        .iter()
        .any(|s| norm == *s || norm.starts_with(&format!("{s}/")))
}

pub fn is_system_path(path: &str) -> bool {
    match normalize_abs(path) {
        Some(n) => lexical_system_hit(&n),
        None => true, // 相对路径 / 越根 → fail closed
    }
}

// 真实路径解析后的系统目录判定（防静态符号链接写穿：用户目录内 ln -s /etc link 后，
// 经 link/x 的写/删等价操作 /etc/x）。从目标向上找最近可 canonicalize 的祖先
//（新建多级路径时父级可能尚不存在），拼上剩余组件做词法判定；全链无法解析 → 拒绝。
// 含文件系统调用（挂死 NFS 上可能阻塞），仅限 blocking 上下文使用
pub fn is_system_path_resolved(path: &str) -> bool {
    let Some(norm) = normalize_abs(path) else {
        return true;
    };
    if lexical_system_hit(&norm) {
        return true;
    }
    let mut cur = std::path::PathBuf::from(&norm);
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    loop {
        if let Ok(real) = std::fs::canonicalize(&cur) {
            let mut full = real;
            for t in tail.iter().rev() {
                full.push(t);
            }
            return is_system_path(&full.to_string_lossy());
        }
        match cur.file_name() {
            Some(f) => {
                tail.push(f.to_os_string());
                match cur.parent() {
                    Some(p) => cur = p.to_path_buf(),
                    None => return true, // 走到根仍无法解析 → fail closed
                }
            }
            None => return true,
        }
    }
}

// ---- CRC32（zip STORED 条目校验和）----
// feed/finish 分离：流式打包逐块增量计算，无需物化整个文件（一次 read 全量 + 全量 CRC
// 的旧实现是 zip 峰值内存 ≈ 目录大小 × 2 的主因之一）
fn crc32_feed(c: u32, data: &[u8]) -> u32 {
    static TABLE: std::sync::OnceLock<[u32; 256]> = std::sync::OnceLock::new();
    let t = TABLE.get_or_init(|| {
        let mut t = [0u32; 256];
        for i in 0..256u32 {
            let mut c = i;
            for _ in 0..8 {
                c = if c & 1 != 0 {
                    0xEDB88320 ^ (c >> 1)
                } else {
                    c >> 1
                };
            }
            t[i as usize] = c;
        }
        t
    });
    let mut c = c;
    for &b in data {
        c = t[((c ^ b as u32) & 0xFF) as usize] ^ (c >> 8);
    }
    c
}
// 整块便捷封装（测试与语义对账用；打包主路径走 feed 增量）
#[cfg(test)]
fn crc32(data: &[u8]) -> u32 {
    !crc32_feed(0xFFFFFFFF, data)
}

// EOCD 条目数字段为 u16（最大 65,535），超限必须显式报错而非截断
const ZIP_MAX_ENTRIES: usize = 65_535;

// 递归收集目录条目（相对路径，目录带尾 /）。
// 符号链接一律跳过（不跟随、不打包）：否则 walk_dir_size（metadata 不跟随链接）与打包时
// fs::read（跟随链接）口径不一致——指向大文件的 symlink 可绕过大小预检导致 OOM；
// 且 symlink→dir 会被 file_type 当作普通文件，fs::read(目录) 报 Is a directory 使整个打包失败。
fn collect_zip_entries(
    dir: &std::path::Path,
    prefix: &str,
    out: &mut Vec<(String, bool)>,
) -> std::io::Result<()> {
    for e in std::fs::read_dir(dir)? {
        let e = e?;
        let name = e.file_name().to_string_lossy().into_owned();
        let rel = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        let ft = e.file_type()?; // 不跟随符号链接
        if ft.is_symlink() {
            continue; // 跳过符号链接
        }
        if out.len() >= ZIP_MAX_ENTRIES {
            return Err(std::io::Error::other("too many entries (zip limit 65535)"));
        }
        if ft.is_dir() {
            out.push((format!("{rel}/"), true));
            collect_zip_entries(&e.path(), &rel, out)?;
        } else {
            out.push((rel, false));
        }
    }
    Ok(())
}

// 目录 → zip（STORED 无压缩，手写格式；UTF-8 文件名标志；条目为相对路径）。
// 流式写出（&mut dyn Write，不物化整个 zip 进内存）：local header 的 CRC/大小字段
// 后置到 data descriptor（通用标志 bit 3，RFC 6455 流式 zip 标准做法，主流解压器
// 均支持），CRC 逐块增量计算——内存占用从 O(目录大小) 降为 O(central directory)。
// 返回写入的总字节数。
fn zip_directory(dir: &std::path::Path, out: &mut dyn Write) -> std::io::Result<u64> {
    let mut entries: Vec<(String, bool)> = Vec::new();
    collect_zip_entries(dir, "", &mut entries)?;
    // EOCD 条目数为 u16，超 65,535 明确报错（而非截断产生非法 zip）
    if entries.len() > ZIP_MAX_ENTRIES {
        return Err(std::io::Error::other("too many entries (zip limit 65535)"));
    }
    let mut central: Vec<u8> = Vec::new();
    let mut offset: u64 = 0;
    for (rel, is_dir) in &entries {
        let name_bytes = rel.as_bytes();
        // local header：flags 0x0808 = UTF-8 名（bit 11）+ data descriptor（bit 3），
        // CRC/大小占位为 0，真实值由数据后的 data descriptor 补充
        let mut lh = Vec::with_capacity(30 + name_bytes.len());
        lh.extend_from_slice(&0x04034b50u32.to_le_bytes()); // local header signature
        lh.extend_from_slice(&20u16.to_le_bytes()); // version needed
        lh.extend_from_slice(&0x0808u16.to_le_bytes()); // flags: UTF-8 + data descriptor
        lh.extend_from_slice(&0u16.to_le_bytes()); // method STORED
        lh.extend_from_slice(&0u16.to_le_bytes()); // mod time
        lh.extend_from_slice(&0x21u16.to_le_bytes()); // mod date (1980-01-01)
        lh.extend_from_slice(&0u32.to_le_bytes()); // crc 占位（data descriptor 补）
        lh.extend_from_slice(&0u32.to_le_bytes()); // compressed size 占位
        lh.extend_from_slice(&0u32.to_le_bytes()); // uncompressed size 占位
        lh.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        lh.extend_from_slice(&0u16.to_le_bytes()); // extra len
        lh.extend_from_slice(name_bytes);
        out.write_all(&lh)?;
        // 数据流式复制：64KB 块边写边算 CRC，累计字节数中途硬校验
        //（预检之外的兜底，防任何口径差异导致的 OOM/超限）
        let mut crc = 0xFFFFFFFFu32;
        let mut size: u64 = 0;
        if !*is_dir {
            let mut f = std::fs::File::open(dir.join(rel))?;
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                let n = f.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                crc = crc32_feed(crc, &buf[..n]);
                out.write_all(&buf[..n])?;
                size += n as u64;
                if offset + size > FILE_LIMIT {
                    return Err(std::io::Error::other(
                        "directory too large for zip (>500MB)",
                    ));
                }
            }
        }
        let crc = !crc;
        // data descriptor：签名 + CRC + 压缩大小 + 原始大小（STORED 下两者相等）
        out.write_all(&0x08074b50u32.to_le_bytes())?;
        out.write_all(&crc.to_le_bytes())?;
        out.write_all(&(size as u32).to_le_bytes())?;
        out.write_all(&(size as u32).to_le_bytes())?;
        // central directory 记录真实 CRC/大小（条目名级别，内存可忽略）
        let mut ch = Vec::new();
        ch.extend_from_slice(&0x02014b50u32.to_le_bytes()); // central signature
        ch.extend_from_slice(&20u16.to_le_bytes()); // version made by
        ch.extend_from_slice(&20u16.to_le_bytes()); // version needed
        ch.extend_from_slice(&0x0808u16.to_le_bytes()); // flags: UTF-8 + data descriptor
        ch.extend_from_slice(&0u16.to_le_bytes()); // method
        ch.extend_from_slice(&0u16.to_le_bytes()); // mod time
        ch.extend_from_slice(&0x21u16.to_le_bytes()); // mod date
        ch.extend_from_slice(&crc.to_le_bytes());
        ch.extend_from_slice(&(size as u32).to_le_bytes());
        ch.extend_from_slice(&(size as u32).to_le_bytes());
        ch.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        ch.extend_from_slice(&0u16.to_le_bytes()); // extra len
        ch.extend_from_slice(&0u16.to_le_bytes()); // comment len
        ch.extend_from_slice(&0u16.to_le_bytes()); // disk number
        ch.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
        ch.extend_from_slice(&0u32.to_le_bytes()); // external attrs
        ch.extend_from_slice(&(offset as u32).to_le_bytes()); // local header offset
        ch.extend_from_slice(name_bytes);
        central.extend_from_slice(&ch);
        offset += lh.len() as u64 + size + 16; // header + 数据 + data descriptor
        // offset 超 u32 上限（4GB zip）明确报错（500MB 预检已先挡，双保险）
        if offset > u32::MAX as u64 {
            return Err(std::io::Error::other("zip too large (>4GB)"));
        }
    }
    out.write_all(&central)?;
    // EOCD
    out.write_all(&0x06054b50u32.to_le_bytes())?;
    out.write_all(&0u16.to_le_bytes())?;
    out.write_all(&0u16.to_le_bytes())?;
    out.write_all(&(entries.len() as u16).to_le_bytes())?;
    out.write_all(&(entries.len() as u16).to_le_bytes())?;
    out.write_all(&(central.len() as u32).to_le_bytes())?;
    out.write_all(&(offset as u32).to_le_bytes())?; // EOCD offset 为 4 字节字段
    out.write_all(&0u16.to_le_bytes())?; // comment len
    Ok(offset + central.len() as u64 + 22)
}

// 目录打包 zip（STORED）到临时文件，返回 (zip 路径, 字节数)；前端分段下载后发 delete 清理。
// 系统路径拦截见 blocking 闭包处注释（zip 只读，允许系统目录下载）
async fn file_zip(path: &str, sid: &str, tmp_dir: &str) -> Result<(String, u64), String> {
    if is_system_path(path) && normalize_abs(path).as_deref() == Some("") {
        return Err(SYSTEM_PATH_ERR.into()); // 仅拒绝根目录 /（打包整盘无意义且必超限）
    }
    let meta = std::fs::metadata(path).map_err(|_| "path not found")?;
    if !meta.is_dir() {
        return Err("not a directory".into());
    }
    // 目录大小上限使用 FILE_LIMIT（500 MB），防止 OOM。
    // 与 collect_zip_entries 同口径：符号链接跳过（M3——此前 metadata() 不跟随链接，
    // 预检通过后打包 fs::read 跟随链接读取大文件，可绕过 500MB 上限导致 OOM）
    fn walk_dir_size(path: &std::path::Path) -> Result<u64, std::io::Error> {
        let mut size: u64 = 0;
        for entry in std::fs::read_dir(path)? {
            let entry = entry?;
            let ft = entry.file_type()?; // 不跟随符号链接
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                size += walk_dir_size(&entry.path())?;
            } else {
                size += entry.metadata()?.len();
            }
        }
        Ok(size)
    }
    let total_size = walk_dir_size(std::path::Path::new(&path))
        .map_err(|e| format!("failed to read directory: {}", e))?;
    if total_size > FILE_LIMIT {
        return Err(format!(
            "directory too large ({:.1} MB > {:.1} MB limit)",
            total_size as f64 / 1_048_576.0,
            FILE_LIMIT as f64 / 1_048_576.0
        ));
    }
    let zip_path = format!("{}/dl-{sid}.zip", tmp_dir.trim_end_matches('/'));
    let path = path.to_string();
    // zip 为只读打包（供下载），允许系统目录——与前端一致：系统路径保留"下载"，
    // 仅写操作（write/rename/delete）被拒；symlink 由 zip 内部跳过（不跟随）
    // 流式写文件（BufWriter）：内存占用 O(1)（旧实现整包物化 Vec<u8>，峰值 ≈ 目录 × 2，
    // 512MB 内存的 VPS 打包 300MB 目录即可能触发 OOM killer，连带杀掉全部终端会话）
    let r = crate::blocking::file_blocking(120, move || -> Result<(String, u64), String> {
        let mut f = std::fs::File::create(&zip_path).map_err(|e| e.to_string())?;
        let mut w = std::io::BufWriter::with_capacity(64 * 1024, &mut f);
        let size = match zip_directory(std::path::Path::new(&path), &mut w) {
            Ok(s) => s,
            Err(e) => {
                // 失败清理半成品（流式写已产生部分文件；超时场景由会话结束清理兜底）
                let _ = w.flush();
                drop(w);
                let _ = std::fs::remove_file(&zip_path);
                return Err(e.to_string());
            }
        };
        w.flush().map_err(|e| e.to_string())?;
        Ok((zip_path, size))
    })
    .await;
    r.ok_or_else(|| "zip timeout".to_string())?
}

// 重命名（仅改名，不允许跨目录移动）；new_name 不含路径分隔符
async fn file_rename(path: &str, new_name: &str) -> String {
    if is_system_path(path) {
        return err_json(SYSTEM_PATH_ERR);
    }
    let new_name = new_name.trim();
    if new_name.is_empty() || new_name.contains('/') || new_name == "." || new_name == ".." {
        return err_json("bad new name");
    }
    let path = path.to_string();
    let new_name = new_name.to_string();
    let r = crate::blocking::file_blocking(10, move || -> Result<String, String> {
        if is_system_path_resolved(&path) {
            return Err(SYSTEM_PATH_ERR.into());
        }
        if !std::path::Path::new(&path).exists() {
            return Err("path not found".into());
        }
        let parent = std::path::Path::new(&path)
            .parent()
            .unwrap_or(std::path::Path::new("/"));
        let target = parent.join(new_name);
        if target.exists() {
            return Err("target already exists".into());
        }
        std::fs::rename(path, &target).map_err(|e| format!("rename failed: {e}"))?;
        Ok(target.to_string_lossy().into_owned())
    })
    .await;
    match r {
        Some(Ok(t)) => {
            serde_json::json!({ "type": "rename_result", "ok": true, "path": t }).to_string()
        }
        Some(Err(e)) => err_json(&e),
        None => err_json("rename timeout"),
    }
}

// 删除（文件或目录递归）；系统路径拒绝
async fn file_delete(path: &str) -> String {
    if is_system_path(path) {
        return err_json(SYSTEM_PATH_ERR);
    }
    let path = path.to_string();
    let r = crate::blocking::file_blocking(60, move || -> Result<(), String> {
        if is_system_path_resolved(&path) {
            return Err(SYSTEM_PATH_ERR.into());
        }
        let meta = std::fs::metadata(&path).map_err(|_| "path not found")?;
        if meta.is_dir() {
            std::fs::remove_dir_all(&path).map_err(|e| e.to_string())
        } else {
            std::fs::remove_file(&path).map_err(|e| e.to_string())
        }
    })
    .await;
    match r {
        Some(Ok(())) => serde_json::json!({ "type": "delete_result", "ok": true }).to_string(),
        Some(Err(e)) => err_json(&e),
        None => err_json("delete timeout"),
    }
}

// 新建目录（mkdir -p 语义：父目录不存在则一并创建）；已存在报错
async fn file_mkdir(path: &str) -> String {
    if is_system_path(path) {
        return err_json(SYSTEM_PATH_ERR);
    }
    let path = path.to_string();
    let r = crate::blocking::file_blocking(10, move || -> Result<(), String> {
        if is_system_path_resolved(&path) {
            return Err(SYSTEM_PATH_ERR.into());
        }
        if std::path::Path::new(&path).exists() {
            return Err("already exists".into());
        }
        std::fs::create_dir_all(&path).map_err(|e| e.to_string())
    })
    .await;
    match r {
        Some(Ok(())) => serde_json::json!({ "type": "mkdir_result", "ok": true }).to_string(),
        Some(Err(e)) => err_json(&e),
        None => err_json("mkdir timeout"),
    }
}

// 新建空文件（create_new：已存在报错，绝不覆盖）
async fn file_touch(path: &str) -> String {
    if is_system_path(path) {
        return err_json(SYSTEM_PATH_ERR);
    }
    let path = path.to_string();
    let r = crate::blocking::file_blocking(10, move || -> Result<(), String> {
        if is_system_path_resolved(&path) {
            return Err(SYSTEM_PATH_ERR.into());
        }
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map(|_| ())
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::AlreadyExists {
                    "already exists".to_string()
                } else {
                    e.to_string()
                }
            })
    })
    .await;
    match r {
        Some(Ok(())) => serde_json::json!({ "type": "touch_result", "ok": true }).to_string(),
        Some(Err(e)) => err_json(&e),
        None => err_json("touch timeout"),
    }
}

// 移动（跨目录）：源与目标都必须在允许区域。同分区 fs::rename 原子完成；
// 跨分区（EXDEV）仅文件回退 copy + delete（目录跨分区需递归复制，提示走终端）；
// 目标已存在拒绝（防覆盖，与 rename 语义一致）
async fn file_move(path: &str, dest: &str) -> String {
    if is_system_path(path) || is_system_path(dest) {
        return err_json(SYSTEM_PATH_ERR);
    }
    let path = path.to_string();
    let dest = dest.to_string();
    let r = crate::blocking::file_blocking(60, move || -> Result<String, String> {
        if is_system_path_resolved(&path) || is_system_path_resolved(&dest) {
            return Err(SYSTEM_PATH_ERR.into());
        }
        let meta = std::fs::metadata(&path).map_err(|_| "path not found")?;
        if std::path::Path::new(&dest).exists() {
            return Err("target already exists".into());
        }
        if let Some(parent) = std::path::Path::new(&dest).parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("create target parent: {e}"))?;
        }
        match std::fs::rename(&path, &dest) {
            Ok(()) => Ok(dest.clone()),
            Err(e) if e.raw_os_error() == Some(libc::EXDEV) => {
                // 跨分区：仅文件回退 copy+delete（大小上限同 zip/upload）
                if meta.is_dir() {
                    return Err(
                        "cross-device move of directory not supported (use terminal)".into(),
                    );
                }
                if meta.len() > FILE_LIMIT {
                    return Err(format!(
                        "file too large ({:.1} MB > {:.1} MB limit)",
                        meta.len() as f64 / 1_048_576.0,
                        FILE_LIMIT as f64 / 1_048_576.0
                    ));
                }
                std::fs::copy(&path, &dest).map_err(|e| format!("copy: {e}"))?;
                std::fs::remove_file(&path).map_err(|e| format!("remove src: {e}"))?;
                Ok(dest.clone())
            }
            Err(e) => Err(format!("rename failed: {e}")),
        }
    })
    .await;
    match r {
        Some(Ok(t)) => {
            serde_json::json!({ "type": "move_result", "ok": true, "path": t }).to_string()
        }
        Some(Err(e)) => err_json(&e),
        None => err_json("move timeout"),
    }
}

// 文件命令响应：Text（list_result/write_result/error 等无数据）或 Binary（read_result 混合帧）
enum FileReply {
    Text(String),
    Binary(Vec<u8>),
}

async fn handle_file_cmd(line: &str, sid: &str, tmp_dir: &str) -> FileReply {
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
        // 目录打包 zip：返回临时 zip 路径与大小，前端分段下载后发 delete 清理
        "zip" => match file_zip(&path, sid, tmp_dir).await {
            Ok((zip_path, size)) => FileReply::Text(
                serde_json::json!({ "type": "zip_result", "ok": true, "path": zip_path, "size": size })
                    .to_string(),
            ),
            Err(e) => FileReply::Text(err_json(&e)),
        },
        "rename" => {
            let new_name = v.get("new_name").and_then(|x| x.as_str()).unwrap_or("");
            FileReply::Text(file_rename(&path, new_name).await)
        }
        "delete" => FileReply::Text(file_delete(&path).await),
        "mkdir" => FileReply::Text(file_mkdir(&path).await),
        "touch" => FileReply::Text(file_touch(&path).await),
        "move" => {
            let dest = v.get("dest").and_then(|x| x.as_str()).unwrap_or("");
            FileReply::Text(file_move(&path, dest).await)
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
    match crate::blocking::file_blocking(30, move || {
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
        // 与 /api/file_upload 路径（main.rs）语义对齐——首块且目标已存在且未显式
        // overwrite=true → 拒绝（防文件管理 WS 上传静默覆盖同名文件导致数据丢失）
        let overwrite = v
            .get("overwrite")
            .and_then(|x| x.as_bool())
            .unwrap_or(false);
        if offset == 0 && !overwrite && std::path::Path::new(&path).exists() {
            return err_json("target already exists (use overwrite=1)");
        }
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

// spawn_blocking 封装（超时 + 信号量 + 文件操作熔断）已统一收敛至 blocking.rs
//（此前 metrics.rs run_blocking 与本文件 blocking_with_timeout 是两套重复实现、
// 两个独立 4-permit 信号量，注释与实际并发模型不符——见 2026-08-19 review L9/M3）

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
    match crate::blocking::file_blocking(10, move || {
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
                if let Some(m) = &matcher
                    && !wildcard_match(m, &name.to_ascii_lowercase())
                {
                    continue;
                }
                if entries.len() >= FILE_LIST_MAX {
                    truncated = true;
                    break;
                }
                // 先用 file_type（readdir 已带类型，无需完整 stat），仅文件再取 len/mtime
                let ft = match e.file_type() {
                    Ok(t) => t,
                    Err(_) => continue,
                };
                let is_dir = ft.is_dir();
                let size = if is_dir {
                    0
                } else {
                    e.metadata().map(|m| m.len()).unwrap_or(0)
                };
                let mtime = if is_dir {
                    0
                } else {
                    e.metadata()
                        .ok()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0)
                };
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
    match crate::blocking::file_blocking(30, move || {
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
pub fn write_bytes(
    path: &str,
    offset: u64,
    data: &[u8],
    commit: bool,
    upload_id: &str,
    created: &Arc<std::sync::Mutex<Vec<String>>>,
) -> String {
    use std::io::{Seek, SeekFrom, Write};
    // upload_id 字符白名单（深度防御，path 已任意，防异常 upload_id 注入临时文件名）
    if !upload_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return err_json("bad upload_id");
    }
    // 系统路径最终防线（真实路径解析，防符号链接写穿）：WS write 与 REST 上传（main.rs）
    // 两条写入路径都汇聚到 write_bytes，在此统一拦截；调用方各自还有词法层快速预检。
    // 本函数在 blocking 闭包内执行，canonicalize 阻塞由外层超时兜底
    if is_system_path_resolved(path) {
        return err_json(SYSTEM_PATH_ERR);
    }
    let tmp = format!("{}.upload.{}", path, upload_id);
    if let Some(parent) = std::path::Path::new(path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // 记录本会话创建的临时文件（会话结束/断线时清理）；contains 去重防重复 push
    if let Ok(mut c) = created.lock()
        && !c.contains(&tmp)
    {
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
    match crate::blocking::file_blocking(10, move || {
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
    fn system_path_check() {
        // 系统目录及其子路径拒绝
        assert!(is_system_path("/"));
        assert!(is_system_path("/proc"));
        assert!(is_system_path("/etc/passwd"));
        assert!(is_system_path("/usr/local/bin"));
        assert!(is_system_path("/var/log"));
        assert!(is_system_path("/root"));
        assert!(is_system_path("/efi/loader")); // EFI 独立挂载
        assert!(is_system_path("/snap/bin")); // Ubuntu snap
        // 用户目录/挂载点允许
        assert!(!is_system_path("/home/user"));
        assert!(!is_system_path("/tmp"));
        assert!(!is_system_path("/mnt/data"));
        assert!(!is_system_path("/home/user/dir"));
        // 软件部署目录放行（上传可执行软件的常规位置）
        assert!(!is_system_path("/opt"));
        assert!(!is_system_path("/opt/myapp/bin/run"));
        assert!(!is_system_path("/srv/www"));
        // 词法绕过全部拒绝（fail closed）：重复斜杠 / .. 回溯 / 相对路径 / 尾斜杠
        assert!(is_system_path("//etc/passwd"));
        assert!(is_system_path("/home/../etc/passwd"));
        assert!(is_system_path("/var/../etc/x"));
        assert!(is_system_path("etc/passwd")); // 相对路径（agent cwd=/ 时等价 /etc/passwd）
        assert!(is_system_path("/etc/")); // 尾斜杠
        assert!(is_system_path("/..")); // 越根
        assert!(is_system_path("/a/../../etc"));
        // 归一化后非系统路径仍放行
        assert!(!is_system_path("/home//a/../b"));
        assert!(!is_system_path("/mnt/data/./x"));
    }

    #[test]
    fn system_path_resolved_blocks_symlink_traversal() {
        // 静态符号链接写穿：用户目录内 link -> /etc，经 link/x 操作等价 /etc/x → 拒绝
        let tmp = std::env::temp_dir().join(format!("cfp-symtest-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let link = tmp.join("link");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink("/etc", &link).unwrap();
        assert!(is_system_path_resolved(
            link.join("passwd").to_str().unwrap()
        ));
        assert!(is_system_path_resolved(
            link.join("notexist").to_str().unwrap()
        )); // 新建也拦
        assert!(!is_system_path_resolved(
            tmp.join("normal").to_str().unwrap()
        )); // 正常用户路径放行
        // 词法层用例对 resolved 同样成立
        assert!(is_system_path_resolved("//etc/passwd"));
        assert!(is_system_path_resolved("etc/passwd"));
        assert!(is_system_path_resolved("/home/../etc/x"));
        let _ = std::fs::remove_file(&link);
        let _ = std::fs::remove_dir(&tmp);
    }

    #[test]
    fn write_bytes_rejects_system_path() {
        let created = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        // 词法层：直接系统路径
        let r = write_bytes("/etc/cfp-test", 0, b"x", true, "id1", &created);
        assert!(
            r.contains("system path is protected"),
            "直接系统路径拒绝: {r}"
        );
        // 词法层：绕过形态
        let r = write_bytes("//etc/cfp-test", 0, b"x", true, "id2", &created);
        assert!(
            r.contains("system path is protected"),
            "重复斜杠绕过拒绝: {r}"
        );
        // 真实路径层：symlink 写穿（tmp/link -> /etc）
        let tmp = std::env::temp_dir().join(format!("cfp-wtest-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let link = tmp.join("lnk");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink("/etc", &link).unwrap();
        let via = link.join("cfp-test");
        let r = write_bytes(via.to_str().unwrap(), 0, b"x", true, "id3", &created);
        assert!(
            r.contains("system path is protected"),
            "symlink 写穿拒绝: {r}"
        );
        let _ = std::fs::remove_file(&link);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn crc32_known_vector() {
        // 标准测试向量：CRC32("123456789") = 0xCBF43926
        assert_eq!(crc32(b"123456789"), 0xCBF43926);
        assert_eq!(crc32(b""), 0);
    }

    #[test]
    fn zip_directory_packs_entries() {
        let tmp = std::env::temp_dir().join(format!("cfp-zip-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("sub")).unwrap();
        std::fs::write(tmp.join("a.txt"), b"hello").unwrap();
        std::fs::write(tmp.join("sub/b.txt"), b"world").unwrap();
        let mut buf = Vec::new();
        let size = zip_directory(&tmp, &mut buf).unwrap();
        // 流式返回的总字节数与实际写出一致
        assert_eq!(size as usize, buf.len());
        // 校验 zip 结构：local header 签名、EOCD 签名、条目名出现
        assert!(
            buf.starts_with(&0x04034b50u32.to_le_bytes()),
            "local header"
        );
        assert_eq!(
            &buf[buf.len() - 22..buf.len() - 18],
            &0x06054b50u32.to_le_bytes(),
            "EOCD"
        );
        let text = String::from_utf8_lossy(&buf);
        assert!(text.contains("a.txt"), "条目 a.txt");
        assert!(text.contains("sub/b.txt"), "嵌套条目");
        assert!(text.contains("sub/"), "目录条目");
        // 流式格式（data descriptor，flags bit 3）正确性：解析 EOCD → central directory
        // → 逐条目校验 CRC/大小/偏移与源文件一致（流式重构的核心风险是格式拼装错误）
        let eocd = &buf[buf.len() - 22..];
        let entries = u16::from_le_bytes([eocd[10], eocd[11]]) as usize;
        let cd_offset = u32::from_le_bytes([eocd[16], eocd[17], eocd[18], eocd[19]]) as usize;
        assert_eq!(entries, 3, "a.txt + sub/ + sub/b.txt");
        let mut pos = cd_offset;
        let mut checked = 0;
        for _ in 0..entries {
            assert_eq!(&buf[pos..pos + 4], &0x02014b50u32.to_le_bytes(), "cd 签名");
            let crc = u32::from_le_bytes(buf[pos + 16..pos + 20].try_into().unwrap());
            let usize_ = u32::from_le_bytes(buf[pos + 24..pos + 28].try_into().unwrap());
            let lh_offset =
                u32::from_le_bytes(buf[pos + 42..pos + 46].try_into().unwrap()) as usize;
            let name_len = u16::from_le_bytes([buf[pos + 28], buf[pos + 29]]) as usize;
            let name = String::from_utf8_lossy(&buf[pos + 46..pos + 46 + name_len]).into_owned();
            // local header（flags bit 3）后逐字段定位数据与 data descriptor
            assert_eq!(&buf[lh_offset..lh_offset + 4], &0x04034b50u32.to_le_bytes());
            let flags = u16::from_le_bytes([buf[lh_offset + 6], buf[lh_offset + 7]]);
            assert!(flags & 0x0008 != 0, "data descriptor 标志（bit 3）");
            let lh_name_len =
                u16::from_le_bytes([buf[lh_offset + 26], buf[lh_offset + 27]]) as usize;
            let data_start = lh_offset + 30 + lh_name_len;
            let data = &buf[data_start..data_start + usize_ as usize];
            let dd = &buf[data_start + usize_ as usize..];
            assert_eq!(&dd[0..4], &0x08074b50u32.to_le_bytes(), "dd 签名");
            let dd_crc = u32::from_le_bytes(dd[4..8].try_into().unwrap());
            assert_eq!(dd_crc, crc, "data descriptor CRC 与 central 一致");
            // 内容与 CRC 对账（目录条目 size=0/CRC=0 跳过内容校验）
            if usize_ > 0 {
                assert_eq!(crc, crc32(data), "{name} CRC 与内容一致");
                let src = std::fs::read(tmp.join(&name)).unwrap();
                assert_eq!(data, &src[..], "{name} 数据与源文件一致");
            }
            checked += 1;
            pos += 46 + name_len;
        }
        assert_eq!(checked, entries);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn rename_delete_rejects_system_path() {
        assert!(
            file_rename("/etc/passwd", "x")
                .await
                .contains("system path is protected")
        );
        assert!(
            file_delete("/usr")
                .await
                .contains("system path is protected")
        );
        assert!(file_delete("/").await.contains("system path is protected"));
        // mkdir/touch/move 同样拦截系统路径（词法 + resolved 双层在函数内）
        assert!(
            file_mkdir("/etc/newdir")
                .await
                .contains("system path is protected")
        );
        assert!(
            file_touch("/etc/newfile")
                .await
                .contains("system path is protected")
        );
        assert!(
            file_move("/home/a", "/etc/b")
                .await
                .contains("system path is protected")
        );
        assert!(
            file_move("/etc/a", "/home/b")
                .await
                .contains("system path is protected")
        );
    }

    #[tokio::test]
    async fn mkdir_touch_move_workflows() {
        let base = std::env::temp_dir().join(format!("cfp-mtf-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        // mkdir：父目录不存在时一并创建；重复创建报错
        let d1 = base.join("a/b/c");
        assert!(
            file_mkdir(d1.to_str().unwrap())
                .await
                .contains("\"ok\":true")
        );
        assert!(
            file_mkdir(d1.to_str().unwrap())
                .await
                .contains("already exists")
        );
        // touch：新建空文件；已存在拒绝且不覆盖（内容保持）
        let f1 = base.join("a/f.txt");
        assert!(
            file_touch(f1.to_str().unwrap())
                .await
                .contains("\"ok\":true")
        );
        std::fs::write(&f1, b"data").unwrap();
        assert!(
            file_touch(f1.to_str().unwrap())
                .await
                .contains("already exists")
        );
        assert_eq!(std::fs::read(&f1).unwrap(), b"data", "已存在时内容不被清空");
        // move（同分区）：目标已存在拒绝；成功后源消失
        let d2 = base.join("a/b2");
        let f2 = d2.join("f.txt");
        assert!(
            file_move(f1.to_str().unwrap(), f2.to_str().unwrap())
                .await
                .contains("\"ok\":true")
        );
        assert!(!f1.exists(), "源已移走");
        assert_eq!(std::fs::read(&f2).unwrap(), b"data");
        assert!(
            file_move(f2.to_str().unwrap(), f2.to_str().unwrap())
                .await
                .contains("already exists")
        );
        let _ = std::fs::remove_dir_all(&base);
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
