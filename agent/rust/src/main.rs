// cf-panel agent（Rust 版）——纯 Shell agent.sh 的对等实现
// 功能：控制通道（断线重连）→ 监控上报 + 终端 PTY + 文件管理；信号清理
mod metrics;
mod session;

use std::error::Error;
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::sync::{Mutex, Notify};
use tokio::time::sleep;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
type Sink = futures_util::stream::SplitSink<WsStream, Message>;

// ---------------- 配置 ----------------
#[derive(Clone)]
pub struct Config {
    pub wss: String,
    pub key: String,
    pub report_interval: u64,
    pub disable_exec: bool,
    pub probes: String,
    pub custom_metrics: String,
    pub tmp_dir: String,
    pub log_file: String,
    pub log_max: u64,
}

pub static CONFIG: OnceLock<Config> = OnceLock::new();

fn read_config() -> Config {
    let key = std::env::var("AGENT_KEY").unwrap_or_default();
    let slug: String = key.chars().take(8).collect();
    Config {
        wss: std::env::var("AGENT_WSS_URL").unwrap_or_default(),
        key,
        // 与 set_report_interval 指令同路径校验下限/上限（防操作员误设 0 触发采集紧循环）
        report_interval: parse_report_interval(std::env::var("REPORT_INTERVAL").ok()),
        disable_exec: std::env::var("DISABLE_EXEC").unwrap_or_default() == "1",
        probes: std::env::var("PROBES").unwrap_or_default(),
        custom_metrics: std::env::var("CUSTOM_METRICS").unwrap_or_default(),
        tmp_dir: std::env::var("AGENT_TMPDIR").unwrap_or_else(|_| format!("/tmp/cfpanel-{slug}")),
        log_file: std::env::var("AGENT_LOG")
            .unwrap_or_else(|_| format!("/tmp/cfpanel-{slug}-agent.log")),
        log_max: std::env::var("AGENT_LOG_MAX")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(262144),
    }
}

// 校验控制通道 URL scheme——远程必须 wss://，明文 ws:// 仅限本地回环或 ALLOW_INSECURE_WS=1
fn validate_wss(wss: &str) -> Result<(), String> {
    if wss.starts_with("wss://") {
        return Ok(());
    }
    if wss.starts_with("ws://") {
        let allow = std::env::var("ALLOW_INSECURE_WS")
            .map(|v| v == "1")
            .unwrap_or(false);
        if allow {
            return Ok(());
        }
        // 正式解析 authority（防 userinfo 风格绕过，如 ws://127.0.0.1:9999@evil.com/...）：
        // authority = strip 协议后到第一个 '/' 前；host:port 取 @ 后、剥离端口/方括号。
        let authority = wss
            .strip_prefix("ws://")
            .unwrap_or("")
            .split('/')
            .next()
            .unwrap_or("");
        // 去掉 userinfo（'@' 前的部分）——防 userinfo 里伪装 loopback
        let host_port = authority.rsplit('@').next().unwrap_or(authority);
        // 处理 host:port、IPv6 [::1]:port 与裸 IPv6（::1，无端口时冒号多于 1 个）
        let host = if let Some(rest) = host_port.strip_prefix('[') {
            rest.split(']').next().unwrap_or("")
        } else if host_port.matches(':').count() > 1 {
            host_port
        } else {
            host_port.split(':').next().unwrap_or(host_port)
        };
        if host == "127.0.0.1" || host == "localhost" || host == "::1" {
            return Ok(()); // 本地回环调试/E2E
        }
        return Err(
            "AGENT_WSS_URL 使用明文 ws://，仅允许本地回环（127.0.0.1/localhost/::1）或显式 ALLOW_INSECURE_WS=1；远程连接必须使用 wss://（防 Agent key 被窃听）".to_string(),
        );
    }
    Err("AGENT_WSS_URL 必须以 wss:// 或 ws:// 开头".to_string())
}

// ---------------- 日志（mpsc + 专用写线程，async 侧零阻塞） ----------------
// stdout 接管道且对端不消费时 write_all 会永久阻塞 worker 线程；改有界 mpsc 队列 +
// 专用 OS 写线程，async 侧 try_send 失败（队列满）即丢弃降级，采集/会话路径永不因日志挂起。
fn log_sender() -> &'static std::sync::mpsc::SyncSender<String> {
    static TX: OnceLock<std::sync::mpsc::SyncSender<String>> = OnceLock::new();
    TX.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::sync_channel::<String>(1024);
        std::thread::Builder::new()
            .name("log-writer".to_string())
            .spawn(move || {
                let cfg = CONFIG.get().unwrap();
                let mut f = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&cfg.log_file)
                    .unwrap_or_else(|_| std::fs::File::create(&cfg.log_file).unwrap());
                while let Ok(line) = rx.recv() {
                    // 轮转：文件超上限直接截断（原写入前检查逻辑移入写线程）
                    if f.metadata().map(|m| m.len()).unwrap_or(0) > cfg.log_max {
                        let _ = f.set_len(0);
                    }
                    let _ = f.write_all(line.as_bytes());
                    let _ = std::io::stdout().write_all(line.as_bytes());
                }
            })
            .expect("spawn log writer thread");
        tx
    })
}
pub fn log(msg: impl AsRef<str>) {
    let line = format!("[cf-panel] {}\n", msg.as_ref());
    // 队列满（写线程积压、对端不消费）时丢弃而非阻塞
    let _ = log_sender().try_send(line);
}

// ---------------- 控制通道（断线重连 + 指令分发 + 上报） ----------------
// 重连退避：连续失败指数退避 3s→6s→...→300s 封顶（加抖动，防多 agent 重连风暴）；
// 鉴权失败（401，key 失效/服务器已删除）直接使用长退避，避免每 3 秒打满 Worker/D1
// （28,800 → ~288 请求/天，静默成本降约 99%）。正常断开（服务端关闭/网络抖动）重置回 3s 快速恢复。
const RETRY_INITIAL_SECS: u64 = 3;
const RETRY_MAX_SECS: u64 = 300;
const AUTH_FAIL_SECS: u64 = 300;
const MIN_UPTIME_RESET_SECS: u64 = 10; // 存活 ≥10s 才算"健康连接"，才重置退避（防秒断风暴）
const CONTROL_READ_TIMEOUT_S: u64 = 180; // 读循环超时：180s 无任何消息判定半开（健康连接有 30s 心跳）
const CTRL_MSG_LIMIT: usize = 64 * 1024; // 控制通道入站消息上限 64KB（指令/心跳远小于此）

async fn run_control(
    cfg: &Config,
    sessions: &Arc<Mutex<std::collections::HashMap<String, Arc<session::TermSession>>>>,
    file_sessions: &Arc<Mutex<std::collections::HashSet<String>>>,
) {
    let mut backoff = RETRY_INITIAL_SECS;
    loop {
        let started = std::time::Instant::now();
        match control_conn(cfg, sessions, file_sessions).await {
            Ok(_) => {
                log("control channel closed");
                // 存活 <10s 的"成功连接"（服务端立即关闭/反代错误/服务端 bug）
                // 同样指数退避，防秒断时每 ~3s 重连风暴（28,800 次/天放大 Worker/D1）
                if started.elapsed().as_secs() < MIN_UPTIME_RESET_SECS {
                    backoff = (backoff * 2).min(RETRY_MAX_SECS);
                } else {
                    backoff = RETRY_INITIAL_SECS;
                }
            }
            Err(e) => {
                log(format!("control channel error: {e}"));
                if is_auth_error(e.as_ref()) {
                    log("auth failed (401): retrying slowly");
                    backoff = AUTH_FAIL_SECS;
                } else {
                    backoff = (backoff * 2).min(RETRY_MAX_SECS);
                }
            }
        }
        // 抖动 0~50%：避免多 agent 同时失败后同步重连形成请求尖峰
        let ns = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0) as u64;
        let jitter = ns % (backoff / 2 + 1);
        sleep(Duration::from_secs(backoff + jitter)).await;
    }
}

// 判断是否 401 鉴权失败（tungstenite 对非 101 升级响应返回 Error::Http）
fn is_auth_error(e: &(dyn Error + Send + Sync + 'static)) -> bool {
    if let Some(tokio_tungstenite::tungstenite::Error::Http(resp)) =
        e.downcast_ref::<tokio_tungstenite::tungstenite::Error>()
    {
        return resp.status().as_u16() == 401;
    }
    false
}

async fn control_conn(
    cfg: &Config,
    sessions: &Arc<Mutex<std::collections::HashMap<String, Arc<session::TermSession>>>>,
    file_sessions: &Arc<Mutex<std::collections::HashSet<String>>>,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    let url = format!("{}/control", cfg.wss);
    let mut req = url.into_client_request()?;
    req.headers_mut().insert("X-Agent-Key", cfg.key.parse()?);
    // 控制通道入站限制 64KB，防恶意超大消息整包占内存（异常帧读循环报错即重连）
    let cfg_ws = tokio_tungstenite::tungstenite::protocol::WebSocketConfig {
        max_message_size: Some(CTRL_MSG_LIMIT),
        ..Default::default()
    };
    let (ws, _) = tokio_tungstenite::connect_async_with_config(req, Some(cfg_ws), false).await?;
    log("control channel connected");
    let (write, mut read) = ws.split();
    let write = Arc::new(Mutex::new(write));

    // 上报任务（动态间隔，分段等待，间隔变更 ≤5s 生效）。
    // 持有句柄：读循环退出（正常关闭/错误/半开超时）时 abort，防僵尸任务累积
    let interval = Arc::new(AtomicU64::new(cfg.report_interval));
    let note = Arc::new(Notify::new());
    let report_task = {
        let write = write.clone();
        let cfg2 = cfg.clone();
        let interval = interval.clone();
        let note = note.clone();
        tokio::spawn(async move {
            report_loop(&cfg2, &write, &interval, &note).await;
        })
    };

    // 读循环：指令分发（180s 无任何消息判定半开连接，断开触发重连——
    // NAT/防火墙静默断链不再依赖 TCP keepalive 2h 才发现；健康连接有服务端 30s 心跳必有下行）
    let result: Result<(), Box<dyn Error + Send + Sync>> = loop {
        let msg =
            match tokio::time::timeout(Duration::from_secs(CONTROL_READ_TIMEOUT_S), read.next())
                .await
            {
                Ok(Some(Ok(m))) => m,
                Ok(Some(Err(e))) => break Err(Box::new(e)),
                Ok(None) => break Ok(()), // 服务端正常关闭
                Err(_) => break Err("control read timeout (half-open connection)".into()),
            };
        if let Message::Text(t) = msg {
            if let Err(e) =
                dispatch(cfg, sessions, file_sessions, &write, &interval, &note, &t).await
            {
                break Err(e);
            }
        }
    };
    // 读循环退出（任何路径）：终止上报任务，防僵尸累积
    report_task.abort();
    result
}

// 上报间隔下限/上限校验（防异常/恶意 interval=0 导致采集紧循环打满 CPU）
fn clamp_report_interval(iv: u64) -> u64 {
    iv.clamp(1, 3600)
}

// 环境变量 REPORT_INTERVAL 解析，与指令路径同走 clamp（防操作员误设 0/超上限）
fn parse_report_interval(raw: Option<String>) -> u64 {
    clamp_report_interval(raw.and_then(|v| v.parse().ok()).unwrap_or(120))
}

async fn dispatch(
    cfg: &Config,
    sessions: &Arc<Mutex<std::collections::HashMap<String, Arc<session::TermSession>>>>,
    file_sessions: &Arc<Mutex<std::collections::HashSet<String>>>,
    write: &Arc<Mutex<Sink>>,
    interval: &Arc<AtomicU64>,
    note: &Arc<Notify>,
    text: &str,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    let v: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return Ok(()),
    };
    let ty = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
    match ty {
        "ping" => {} // 心跳保活，忽略
        "set_report_interval" => {
            if let Some(iv) = v.get("interval").and_then(|x| x.as_u64()) {
                interval.store(clamp_report_interval(iv), Ordering::Relaxed);
                note.notify_waiters();
            }
        }
        "open_terminal" => {
            if cfg.disable_exec {
                return Ok(());
            }
            let sid = v
                .get("stream_id")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            if sid.is_empty() {
                return Ok(());
            }
            // 幂等：同 SID 会话已存在且仍活跃（DO 确认重发场景）则不重复 spawn，仅回执 ready。
            // 旧会话已死（数据面结束但未移出 map 的僵尸）则先移除再重建，回执才有意义
            {
                let mut map = sessions.lock().await;
                if let Some(existing) = map.get(&sid) {
                    if existing.is_alive() {
                        let mut w = write.lock().await;
                        let _ = w
                            .send(Message::Text(format!(
                                r#"{{"type":"terminal_ready","stream_id":"{sid}"}}"#
                            )))
                            .await;
                        return Ok(());
                    }
                    map.remove(&sid); // 僵尸会话：移除，走重建
                }
            }
            log(format!("open_terminal sid={sid}"));
            let term = match session::TermSession::spawn(&sid).await {
                Ok(t) => t,
                Err(e) => {
                    log(format!("terminal spawn failed: {e}"));
                    return Ok(());
                }
            };
            let term = Arc::new(term);
            sessions.lock().await.insert(sid.clone(), term.clone());
            // 回执 terminal_ready：停止 DO 的 open_terminal 确认重发
            let mut w = write.lock().await;
            let _ = w
                .send(Message::Text(format!(
                    r#"{{"type":"terminal_ready","stream_id":"{sid}"}}"#
                )))
                .await;
            drop(w);
            // 启动数据流（独立任务；结束时自动 cleanup + 从 sessions 移除）
            let cfg2 = cfg.clone();
            let sessions2 = sessions.clone();
            tokio::spawn(async move {
                session::run_terminal(&cfg2, term, &sessions2).await;
            });
        }
        "open_file" => {
            if cfg.disable_exec {
                return Ok(());
            }
            let sid = v
                .get("stream_id")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            if sid.is_empty() {
                return Ok(());
            }
            // 幂等——确认重发场景（回执在重连窗口丢失导致 DO 重发）已存在则不重复启动
            if !file_sessions.lock().await.insert(sid.clone()) {
                let mut w = write.lock().await;
                let _ = w
                    .send(Message::Text(format!(
                        r#"{{"type":"file_ready","stream_id":"{sid}"}}"#
                    )))
                    .await;
                return Ok(());
            }
            log(format!("open_file sid={sid}"));
            // 回执 file_ready，停止 DO 的 open_file 确认重发
            let mut w = write.lock().await;
            let _ = w
                .send(Message::Text(format!(
                    r#"{{"type":"file_ready","stream_id":"{sid}"}}"#
                )))
                .await;
            drop(w);
            let cfg2 = cfg.clone();
            let fs2 = file_sessions.clone();
            tokio::spawn(async move {
                session::run_file_session(cfg2, sid.clone()).await;
                fs2.lock().await.remove(&sid); // 会话结束释放槽位
            });
        }
        "resize" => {
            let sid = v
                .get("stream_id")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            // clamp 1..=500，防异常超大值截断为 0（rows=65536 as u16 → 0）
            let rows = v
                .get("rows")
                .and_then(|x| x.as_u64())
                .unwrap_or(24)
                .clamp(1, 500);
            let cols = v
                .get("cols")
                .and_then(|x| x.as_u64())
                .unwrap_or(80)
                .clamp(1, 500);
            if let Some(term) = sessions.lock().await.get(&sid).cloned() {
                term.resize(rows as u16, cols as u16);
            }
        }
        "exec" => {
            // MCP 一次性命令执行：sh -c 跑命令，收集 stdout/stderr/exit_code 经控制通道回执
            let exec_id = v
                .get("exec_id")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let command = v
                .get("command")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            if exec_id.is_empty() || command.is_empty() {
                return Ok(());
            }
            // clamp 1..=60：服务端上限 25s，双端钳制防异常值
            let timeout_s = v
                .get("timeout_s")
                .and_then(|x| x.as_u64())
                .unwrap_or(25)
                .clamp(1, 60);
            let write = write.clone();
            let cfg2 = cfg.clone();
            tokio::spawn(async move {
                // DISABLE_EXEC=1：立即回执错误，不等 DO 侧 25s 超时（避免误导性超时提示）
                if cfg2.disable_exec {
                    let mut w = write.lock().await;
                    let _ = w
                        .send(Message::Text(
                            serde_json::json!({
                                "type": "exec_result",
                                "exec_id": exec_id,
                                "stdout": "",
                                "stderr": "",
                                "exit_code": null,
                                "timed_out": false,
                                "error": "exec disabled (DISABLE_EXEC=1)",
                            })
                            .to_string(),
                        ))
                        .await;
                    return;
                }
                log(format!("exec {exec_id}: {command}"));
                // agent 用原始 timeout_s 执行；DO 兜底定时器比这晚 5s（EXEC_TIMEOUT_GRACE_MS），
                // 正常路径 agent 先回执（超时=无输出：output() 超时分支的缓冲区随 future drop
                // 丢弃，不存在"部分输出"），DO 定时器仅防悬挂。
                // 防孤儿：process_group(0) 让子进程成为新进程组组长，超时后 kill(-pid) 连同
                // 孙进程一并清理（与终端会话 cleanup 的进程组语义一致，见 session.rs）。
                let mut child = match tokio::process::Command::new("sh")
                    .arg("-c")
                    .arg(&command)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .process_group(0)
                    .spawn()
                {
                    Ok(c) => c,
                    Err(e) => {
                        // spawn 失败（如 fork 资源不足）：立即回执，无需等待
                        let msg = serde_json::json!({
                            "type": "exec_result",
                            "exec_id": exec_id,
                            "stdout": "",
                            "stderr": format!("spawn failed: {e}"),
                            "exit_code": -1,
                            "timed_out": false,
                        });
                        let mut w = write.lock().await;
                        let _ = w.send(Message::Text(msg.to_string())).await;
                        return;
                    }
                };
                let pid = child.id().unwrap_or(0);
                // 手动收集 stdout/stderr（timeout 到期时随 future drop 丢弃，无部分输出语义）
                let mut out_pipe = child.stdout.take();
                let mut err_pipe = child.stderr.take();
                let out = tokio::time::timeout(Duration::from_secs(timeout_s), async {
                    let (o, e) = tokio::join!(
                        async {
                            let mut buf = Vec::new();
                            if let Some(r) = out_pipe.as_mut() {
                                let _ = tokio::io::AsyncReadExt::read_to_end(r, &mut buf).await;
                            }
                            buf
                        },
                        async {
                            let mut buf = Vec::new();
                            if let Some(r) = err_pipe.as_mut() {
                                let _ = tokio::io::AsyncReadExt::read_to_end(r, &mut buf).await;
                            }
                            buf
                        },
                    );
                    let status = child.wait().await;
                    (o, e, status)
                })
                .await;
                let (stdout, stderr, exit_code, timed_out) = match out {
                    Ok((o, e, Ok(status))) => (
                        String::from_utf8_lossy(&o).into_owned(),
                        String::from_utf8_lossy(&e).into_owned(),
                        status.code().unwrap_or(-1),
                        false,
                    ),
                    Ok((o, _e, Err(w))) => (
                        String::from_utf8_lossy(&o).into_owned(),
                        format!("wait failed: {w}"),
                        -1,
                        false,
                    ),
                    Err(_) => {
                        // 超时：kill 整个进程组（SIGKILL 不可忽略，孙进程一并清理），再 wait 回收防僵尸
                        if pid > 0 {
                            unsafe {
                                libc::kill(-(pid as i32), libc::SIGKILL);
                            }
                        }
                        let _ = child.wait().await;
                        (
                            String::new(),
                            format!("timed out after {timeout_s}s"),
                            -1,
                            true,
                        )
                    }
                };
                // 截断：控制通道对端（DO）入站 64KB，stdout 为主通道
                let stdout = truncate_utf8(&stdout, 44 * 1024);
                let stderr = truncate_utf8(&stderr, 12 * 1024);
                let msg = serde_json::json!({
                    "type": "exec_result",
                    "exec_id": exec_id,
                    "stdout": stdout,
                    "stderr": stderr,
                    "exit_code": exit_code,
                    "timed_out": timed_out,
                });
                let mut w = write.lock().await;
                let _ = w.send(Message::Text(msg.to_string())).await;
            });
        }
        _ => {}
    }
    Ok(())
}

// 按 UTF-8 字符边界截断字符串到 max_bytes，超长追加截断标记
// （防截断到多字节字符中间产生非法 UTF-8，导致 JSON 序列化/解析失败）
fn truncate_utf8(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    let mut out = s[..end].to_string();
    out.push_str("...[truncated]");
    out
}

// 上报循环：立即上报 + 分段等待（每 5s 重读间隔，interval 变更立即生效）
async fn report_loop(
    cfg: &Config,
    write: &Arc<Mutex<Sink>>,
    interval: &Arc<AtomicU64>,
    note: &Arc<Notify>,
) {
    loop {
        if let Some(r) = metrics::collect_report(cfg).await {
            let mut w = write.lock().await;
            if w.send(Message::Text(r)).await.is_err() {
                log("report send failed, control channel closed");
                return;
            }
        } else {
            log("report collect failed");
        }
        let mut waited: u64 = 0;
        loop {
            let iv = interval.load(Ordering::Relaxed);
            if waited >= iv {
                break;
            }
            let step = (iv - waited).min(5);
            tokio::select! {
                _ = note.notified() => break,
                _ = sleep(Duration::from_secs(step)) => {}
            }
            waited += step;
        }
    }
}

// ---------------- 入口 ----------------
// 版本号：优先取构建时注入的 AGENT_BUILD_TS（格式 2026.08.08-2000，CI 编译时传入），
// 未注入时回退 Cargo.toml 的 [package] version（本地调试可见）。
// pub：metrics::collect_info 将其写入系统信息上报，前端节点 tooltip 展示
pub const VERSION: &str = match option_env!("AGENT_BUILD_TS") {
    Some(ts) if !ts.is_empty() => ts,
    _ => env!("CARGO_PKG_VERSION"),
};

fn print_version() {
    println!("cf-panel-agent {VERSION}");
}

fn print_help() {
    println!("cf-panel agent（Rust 版）——与 agent.sh 同协议的对等实现");
    println!("用法：AGENT_WSS_URL=wss://<面板>/ws/agent AGENT_KEY=<key> ./cf-panel-agent [--help]");
    println!("版本：./cf-panel-agent --version");
    println!();
    println!("可配置环境变量：");
    println!("  AGENT_WSS_URL     必填  面板 agent WebSocket 地址（wss://<域名>/ws/agent）");
    println!("  AGENT_KEY         必填  agent 身份 + 凭证（面板「添加服务器」时生成）");
    println!("  REPORT_INTERVAL   默认 120   默认上报间隔（秒）；有观看者时服务端动态下发 5s");
    println!("  DISABLE_EXEC      默认 0     设为 1 禁用终端/文件管理（仅保留监控）");
    println!("  PROBES            默认 空    服务探活：\"name:http:URL,name:tcp:host:port,...\"");
    println!(
        "  CUSTOM_METRICS    默认 空    自定义指标 JSON：[{{\"name\":\"x\",\"cmd\":\"命令\"}}]"
    );
    println!("  AGENT_TMPDIR      默认 /tmp/cfpanel-<key前8位>   临时目录");
    println!("  AGENT_LOG         默认 /tmp/cfpanel-<key前8位>-agent.log   日志文件");
    println!("  AGENT_LOG_MAX     默认 262144   日志轮转上限（字节）");
}

#[tokio::main]
async fn main() {
    // --version：打印版本号（Release 标题/故障排查用）
    if std::env::args().any(|a| a == "--version" || a == "-V") {
        print_version();
        std::process::exit(0);
    }
    // --help：打印配置说明
    if std::env::args().any(|a| a == "--help" || a == "-h" || a == "help") {
        print_help();
        std::process::exit(0);
    }
    let cfg = read_config();
    if cfg.wss.is_empty() || cfg.key.is_empty() {
        eprintln!("AGENT_WSS_URL 与 AGENT_KEY 必须设置（./cf-panel-agent --help 查看全部配置）");
        std::process::exit(1);
    }
    // 明文 ws:// 仅允许本地回环（本地调试/E2E）或显式 ALLOW_INSECURE_WS=1；
    // 远程连接强制 wss://，防 Agent key 经明文链路被窃听
    if let Err(e) = validate_wss(&cfg.wss) {
        eprintln!("{e}");
        std::process::exit(1);
    }
    let _ = CONFIG.set(cfg.clone());
    // 保留 AGENT_TMPDIR 环境变量兼容（Rust 版不依赖临时目录，pty/文件均由进程内管理）
    let _ = std::fs::create_dir_all(&cfg.tmp_dir);
    log(format!("agent starting (wss={})", cfg.wss));

    let sessions: Arc<Mutex<std::collections::HashMap<String, Arc<session::TermSession>>>> =
        Arc::new(Mutex::new(Default::default()));
    // 文件会话注册表（open_file 确认重发场景幂等：重发时已存在仅回执，不重复启动）
    let file_sessions: Arc<Mutex<std::collections::HashSet<String>>> =
        Arc::new(Mutex::new(Default::default()));

    // 信号：SIGTERM/SIGINT → 清理退出
    let shutdown = Arc::new(Notify::new());
    {
        let shutdown = shutdown.clone();
        tokio::spawn(async move {
            let mut sigterm =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("sigterm");
            let mut sigint =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
                    .expect("sigint");
            tokio::select! {
                _ = sigterm.recv() => {}
                _ = sigint.recv() => {}
            }
            log("shutdown signal received");
            shutdown.notify_waiters();
        });
    }

    tokio::select! {
        _ = run_control(&cfg, &sessions, &file_sessions) => {}
        _ = shutdown.notified() => {}
    }

    // 清理：关闭所有终端会话（kill 进程组）
    let guards = sessions.lock().await;
    for t in guards.values() {
        t.cleanup().await;
    }
    log("agent exiting");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_wss_accepts_wss() {
        assert!(validate_wss("wss://panel.example.com/ws/agent").is_ok());
    }

    #[test]
    fn clamp_report_interval_bounds() {
        assert_eq!(
            clamp_report_interval(0),
            1,
            "interval=0 钳到下限，防采集紧循环"
        );
        assert_eq!(clamp_report_interval(3), 3, "正常值不变");
        assert_eq!(clamp_report_interval(120), 120);
        assert_eq!(clamp_report_interval(5000), 3600, "超上限钳到 3600");
    }

    #[test]
    fn parse_report_interval_env_clamps() {
        assert_eq!(parse_report_interval(None), 120, "缺省 120");
        assert_eq!(
            parse_report_interval(Some("0".into())),
            1,
            "env 误设 0 钳到下限"
        );
        assert_eq!(parse_report_interval(Some("5".into())), 5, "正常值不变");
        assert_eq!(
            parse_report_interval(Some("99999".into())),
            3600,
            "env 超上限钳到 3600"
        );
        assert_eq!(
            parse_report_interval(Some("abc".into())),
            120,
            "非法值回退默认"
        );
    }

    #[test]
    fn is_auth_error_detects_401_http() {
        use tokio_tungstenite::tungstenite::http::{Response, StatusCode};
        // HTTP 401（key 失效/服务器删除）→ 判为鉴权失败，走长退避
        let err: Box<dyn Error + Send + Sync> =
            Box::new(tokio_tungstenite::tungstenite::Error::Http(
                Response::builder()
                    .status(StatusCode::UNAUTHORIZED)
                    .body(None)
                    .unwrap(),
            ));
        assert!(is_auth_error(err.as_ref()));
        // 其他状态码（如 404 反代不存在）→ 非鉴权失败，走指数退避
        let err404: Box<dyn Error + Send + Sync> =
            Box::new(tokio_tungstenite::tungstenite::Error::Http(
                Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(None)
                    .unwrap(),
            ));
        assert!(!is_auth_error(err404.as_ref()));
        // 非 Http 错误 → 非鉴权失败
        let io_err: Box<dyn Error + Send + Sync> = Box::new(std::io::Error::new(
            std::io::ErrorKind::ConnectionRefused,
            "refused",
        ));
        assert!(!is_auth_error(io_err.as_ref()));
    }

    // env 操作集中在单个测试内顺序执行（Rust 测试并行，避免 ALLOW_INSECURE_WS 竞争）
    #[test]
    fn validate_wss_loopback_and_env_control() {
        std::env::remove_var("ALLOW_INSECURE_WS");
        assert!(validate_wss("ws://127.0.0.1:8787/ws/agent").is_ok());
        assert!(validate_wss("ws://localhost/ws/agent").is_ok());
        assert!(validate_wss("ws://::1/ws/agent").is_ok());
        assert!(validate_wss("ws://[::1]:8787/ws/agent").is_ok());
        assert!(
            validate_wss("ws://example.com/ws/agent").is_err(),
            "无 ALLOW_INSECURE_WS 时远程明文拒绝"
        );
        // userinfo 风格绕过：@ 前的 127.0.0.1:9999 是 userinfo，真实 host 是 evil.com，必须拒绝
        assert!(
            validate_wss("ws://127.0.0.1:9999@evil.com/ws/agent").is_err(),
            "userinfo 伪装 loopback 拒绝"
        );
        assert!(
            validate_wss("ws://user:pass@127.0.0.1/ws/agent").is_ok(),
            "userinfo@真实 loopback 放行（host 解析正确）"
        );
        std::env::set_var("ALLOW_INSECURE_WS", "1");
        assert!(
            validate_wss("ws://example.com/ws/agent").is_ok(),
            "显式 ALLOW_INSECURE_WS=1 放行"
        );
        std::env::remove_var("ALLOW_INSECURE_WS");
    }

    #[test]
    fn validate_wss_rejects_bad_scheme() {
        assert!(validate_wss("http://example.com/ws/agent").is_err());
        assert!(validate_wss("").is_err());
        assert!(validate_wss("wss").is_err());
    }
}
