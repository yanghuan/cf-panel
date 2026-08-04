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

type WsStream = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
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
        report_interval: std::env::var("REPORT_INTERVAL").ok().and_then(|v| v.parse().ok()).unwrap_or(120),
        disable_exec: std::env::var("DISABLE_EXEC").unwrap_or_default() == "1",
        probes: std::env::var("PROBES").unwrap_or_default(),
        custom_metrics: std::env::var("CUSTOM_METRICS").unwrap_or_default(),
        tmp_dir: std::env::var("AGENT_TMPDIR").unwrap_or_else(|_| format!("/tmp/cfpanel-{slug}")),
        log_file: std::env::var("AGENT_LOG").unwrap_or_else(|_| format!("/tmp/cfpanel-{slug}-agent.log")),
        log_max: std::env::var("AGENT_LOG_MAX").ok().and_then(|v| v.parse().ok()).unwrap_or(262144),
    }
}

// ---------------- 日志（追加 + 轮转） ----------------
fn log_file() -> &'static std::sync::Mutex<std::fs::File> {
    static F: OnceLock<std::sync::Mutex<std::fs::File>> = OnceLock::new();
    F.get_or_init(|| {
        let cfg = CONFIG.get().unwrap();
        let f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&cfg.log_file)
            .unwrap_or_else(|_| std::fs::File::create(&cfg.log_file).unwrap());
        std::sync::Mutex::new(f)
    })
}
pub fn log(msg: impl AsRef<str>) {
    let line = format!("[cf-panel] {}\n", msg.as_ref());
    if let Ok(mut f) = log_file().lock() {
        if f.metadata().map(|m| m.len()).unwrap_or(0) > CONFIG.get().unwrap().log_max {
            let _ = f.set_len(0);
        }
        let _ = f.write_all(line.as_bytes());
    }
    let _ = std::io::stdout().write_all(line.as_bytes());
}

// ---------------- 控制通道（断线重连 + 指令分发 + 上报） ----------------
async fn run_control(cfg: &Config, sessions: &Arc<Mutex<std::collections::HashMap<String, Arc<session::TermSession>>>>) {
    loop {
        match control_conn(cfg, sessions).await {
            Ok(_) => log("control channel closed"),
            Err(e) => log(format!("control channel error: {e}")),
        }
        sleep(Duration::from_secs(3)).await;
    }
}

async fn control_conn(
    cfg: &Config,
    sessions: &Arc<Mutex<std::collections::HashMap<String, Arc<session::TermSession>>>>,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    let url = format!("{}/control", cfg.wss);
    let mut req = url.into_client_request()?;
    req.headers_mut().insert("X-Agent-Key", cfg.key.parse()?);
    let (ws, _) = tokio_tungstenite::connect_async(req).await?;
    log("control channel connected");
    let (write, mut read) = ws.split();
    let write = Arc::new(Mutex::new(write));

    // 上报任务（动态间隔，分段等待，间隔变更 ≤5s 生效）
    let interval = Arc::new(AtomicU64::new(cfg.report_interval));
    let note = Arc::new(Notify::new());
    {
        let write = write.clone();
        let cfg2 = cfg.clone();
        let interval = interval.clone();
        let note = note.clone();
        tokio::spawn(async move {
            report_loop(&cfg2, &write, &interval, &note).await;
        });
    }

    // 读循环：指令分发
    while let Some(msg) = read.next().await {
        let msg = msg?;
        if let Message::Text(t) = msg {
            dispatch(cfg, sessions, &write, &interval, &note, &t).await?;
        }
    }
    Ok(())
}

async fn dispatch(
    cfg: &Config,
    sessions: &Arc<Mutex<std::collections::HashMap<String, Arc<session::TermSession>>>>,
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
                interval.store(iv, Ordering::Relaxed);
                note.notify_waiters();
            }
        }
        "open_terminal" => {
            if cfg.disable_exec {
                return Ok(());
            }
            let sid = v.get("stream_id").and_then(|x| x.as_str()).unwrap_or("").to_string();
            if sid.is_empty() {
                return Ok(());
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
            let _ = w.send(Message::Text(format!(r#"{{"type":"terminal_ready","stream_id":"{sid}"}}"#))).await;
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
            let sid = v.get("stream_id").and_then(|x| x.as_str()).unwrap_or("").to_string();
            if sid.is_empty() {
                return Ok(());
            }
            log(format!("open_file sid={sid}"));
            let cfg2 = cfg.clone();
            tokio::spawn(async move {
                session::run_file_session(cfg2, sid).await;
            });
        }
        "resize" => {
            let sid = v.get("stream_id").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let rows = v.get("rows").and_then(|x| x.as_u64()).unwrap_or(24);
            let cols = v.get("cols").and_then(|x| x.as_u64()).unwrap_or(80);
            if let Some(term) = sessions.lock().await.get(&sid).cloned() {
                term.resize(rows as u16, cols as u16);
            }
        }
        _ => {}
    }
    Ok(())
}

// 上报循环：立即上报 + 分段等待（每 5s 重读间隔，interval 变更立即生效）
async fn report_loop(cfg: &Config, write: &Arc<Mutex<Sink>>, interval: &Arc<AtomicU64>, note: &Arc<Notify>) {
    loop {
        if let Some(r) = metrics::collect_report(cfg).await {
            let mut w = write.lock().await;
            if w.send(Message::Text(r)).await.is_err() {
                return;
            }
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
fn print_help() {
    println!("cf-panel agent（Rust 版）——与 agent.sh 同协议的对等实现");
    println!("用法：AGENT_WSS_URL=wss://<面板>/ws/agent AGENT_KEY=<key> ./cf-panel-agent [--help]");
    println!();
    println!("可配置环境变量：");
    println!("  AGENT_WSS_URL     必填  面板 agent WebSocket 地址（wss://<域名>/ws/agent）");
    println!("  AGENT_KEY         必填  agent 身份 + 凭证（面板「添加服务器」时生成）");
    println!("  REPORT_INTERVAL   默认 120   默认上报间隔（秒）；有观看者时服务端动态下发 3s");
    println!("  DISABLE_EXEC      默认 0     设为 1 禁用终端/文件管理（仅保留监控）");
    println!("  PROBES            默认 空    服务探活：\"name:http:URL,name:tcp:host:port,...\"");
    println!("  CUSTOM_METRICS    默认 空    自定义指标 JSON：[{{\"name\":\"x\",\"cmd\":\"命令\"}}]");
    println!("  AGENT_TMPDIR      默认 /tmp/cfpanel-<key前8位>   临时目录");
    println!("  AGENT_LOG         默认 /tmp/cfpanel-<key前8位>-agent.log   日志文件");
    println!("  AGENT_LOG_MAX     默认 262144   日志轮转上限（字节）");
}

#[tokio::main]
async fn main() {
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
    let _ = CONFIG.set(cfg.clone());
    // 保留 AGENT_TMPDIR 环境变量兼容（Rust 版不依赖临时目录，pty/文件均由进程内管理）
    let _ = std::fs::create_dir_all(&cfg.tmp_dir);
    log(format!("agent starting (wss={})", cfg.wss));

    let sessions: Arc<Mutex<std::collections::HashMap<String, Arc<session::TermSession>>>> = Arc::new(Mutex::new(Default::default()));

    // 信号：SIGTERM/SIGINT → 清理退出
    let shutdown = Arc::new(Notify::new());
    {
        let shutdown = shutdown.clone();
        tokio::spawn(async move {
            let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("sigterm");
            let mut sigint = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt()).expect("sigint");
            tokio::select! {
                _ = sigterm.recv() => {}
                _ = sigint.recv() => {}
            }
            log("shutdown signal received");
            shutdown.notify_waiters();
        });
    }

    tokio::select! {
        _ = run_control(&cfg, &sessions) => {}
        _ = shutdown.notified() => {}
    }

    // 清理：关闭所有终端会话（kill 进程组）
    let guards = sessions.lock().await;
    for t in guards.values() {
        t.cleanup().await;
    }
    log("agent exiting");
}
