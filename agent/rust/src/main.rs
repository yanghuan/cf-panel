// cf-panel agent（Rust 版）——纯 Shell agent.sh 的对等实现
// 功能：控制通道（断线重连）→ 监控上报 + 终端 PTY + 文件管理；信号清理
// 跨平台：Linux 原生 /proc 指标；Windows/macOS 经 sysinfo（见 metrics/ 子模块与 platform.rs）
mod blocking;
mod dns;
mod metrics;
mod platform;
mod session;
mod update;

use std::error::Error;
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{Mutex, Notify};
use tokio::time::sleep;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

// 连接建立统一封装（控制通道 + 终端/文件会话共用）：TCP connect、TLS 握手、HTTP 101 升级
// 三段都必须带超时。任一段静默丢包（IPv6 路径 MTU 黑洞、边缘接受 TCP 但不下发 101、
// 中间设备黑洞）时，裸 await 会永久挂起——无日志、无重试，进程看起来"活着"但彻底失联
//（2026-09-09 生产事故：残留 ESTAB 连接 + 日志静默 3 天）。
pub(crate) async fn connect_ws(
    req: tokio_tungstenite::tungstenite::handshake::client::Request,
    cfg: Option<tokio_tungstenite::tungstenite::protocol::WebSocketConfig>,
) -> Result<WsStream, Box<dyn Error + Send + Sync>> {
    connect_ws_within(req, cfg, Duration::from_secs(CONNECT_TIMEOUT_S)).await
}

// 超时可注入版本：生产统一 15s，测试用短超时验证"握手卡住必然返回错误"
async fn connect_ws_within(
    req: tokio_tungstenite::tungstenite::handshake::client::Request,
    cfg: Option<tokio_tungstenite::tungstenite::protocol::WebSocketConfig>,
    timeout: Duration,
) -> Result<WsStream, Box<dyn Error + Send + Sync>> {
    tokio::time::timeout(timeout, connect_ws_inner(req, cfg))
        .await
        .map_err(|_| "connect timeout (dns/tcp/tls/ws handshake)")?
}

// 解析路径。默认 Auto：先自建解析（成因见 dns.rs），任一步失败回落 libc；
// AGENT_DNS_MODE=udp 强制自建（失败不再回落，便于排障）、=system 强制 libc（一键退路）。
#[derive(Clone, Copy, PartialEq)]
enum DnsMode {
    Auto,
    Own,
    System,
}

fn dns_mode() -> DnsMode {
    static MODE: OnceLock<DnsMode> = OnceLock::new();
    *MODE.get_or_init(|| {
        match std::env::var("AGENT_DNS_MODE")
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "system" | "libc" => DnsMode::System,
            "udp" | "own" => DnsMode::Own,
            _ => DnsMode::Auto,
        }
    })
}

/// 服务探活用的解析：与连接同一套策略——自建优先、失败回落 libc；
/// `AGENT_DNS_MODE=system` 时直接用 libc。探活的域名此前只走 `lookup_host`，
/// 在"禁未连接 UDP"的环境里会持续误报 DOWN。
pub(crate) async fn resolve_host_for_probe(host: &str, port: u16) -> Option<std::net::SocketAddr> {
    if dns_mode() != DnsMode::System {
        if let Some(a) = dns::resolve(host, port).await {
            return Some(a);
        }
    }
    tokio::net::lookup_host((host, port)).await.ok()?.next()
}

async fn connect_ws_inner(
    req: tokio_tungstenite::tungstenite::handshake::client::Request,
    cfg: Option<tokio_tungstenite::tungstenite::protocol::WebSocketConfig>,
) -> Result<WsStream, Box<dyn Error + Send + Sync>> {
    let mode = dns_mode();
    if mode != DnsMode::System {
        // req 只在回退分支还要用；握手请求很小，克隆成本可忽略
        match connect_via_own_resolver(req.clone(), cfg).await {
            Ok(ws) => return Ok(ws),
            Err(e) => {
                if mode == DnsMode::Own {
                    return Err(e);
                }
                // 回落是常态路径（无 /etc/resolv.conf、无 A 记录、名字服务器不可达…），
                // 只记一行，避免每次重连刷屏
                log(format!(
                    "own resolver unavailable ({e}), using libc resolver"
                ));
            }
        }
    }
    let (ws, _resp) = tokio_tungstenite::connect_async_with_config(req, cfg, false).await?;
    Ok(ws)
}

/// 自建流建连：解析（或直接用 `AGENT_WSS_IP`）→ `TcpStream::connect(IP)` → 把已连好的流交给
/// tungstenite 完成 TLS + WS 握手。
///
/// 为什么这样能对齐 glibc 而绕开 musl 的问题：libc 的 `getaddrinfo` 只在第一步被用到，换成
/// dns.rs 的 `connect(名字服务器)+send()` 后，链路上再无"未连接 UDP 发包"。
/// TLS 的 SNI 与证书校验仍按 URL 里的域名（`client_async_tls_with_config` 从 request 取
/// domain），所以"连 IP"不削弱校验——只是把解析换掉了。
pub(crate) async fn connect_via_own_resolver(
    req: tokio_tungstenite::tungstenite::handshake::client::Request,
    cfg: Option<tokio_tungstenite::tungstenite::protocol::WebSocketConfig>,
) -> Result<WsStream, Box<dyn Error + Send + Sync>> {
    let pinned = std::env::var("AGENT_WSS_IP").unwrap_or_default();
    connect_via_own_resolver_with(req, cfg, &pinned).await
}

/// `pinned_ip` 非空时跳过 DNS 直连该 IP（`AGENT_WSS_IP` 的落地实现）。
/// 环境变量读取刻意放在外层：测试并行执行，改环境变量会互相污染
///（已实测：非法取值会让并发跑的其它用例一起失败），注入形参后测试无需碰环境。
async fn connect_via_own_resolver_with(
    req: tokio_tungstenite::tungstenite::handshake::client::Request,
    cfg: Option<tokio_tungstenite::tungstenite::protocol::WebSocketConfig>,
    pinned_ip: &str,
) -> Result<WsStream, Box<dyn Error + Send + Sync>> {
    let uri = req.uri().clone();
    let host = uri
        .host()
        .ok_or("url has no host")?
        .trim_end_matches('.')
        .to_string();
    let scheme = uri.scheme_str().unwrap_or_default().to_ascii_lowercase();
    let port = uri
        .port_u16()
        .unwrap_or(if scheme == "wss" { 443 } else { 80 });
    let addr = if pinned_ip.trim().is_empty() {
        dns::resolve(&host, port)
            .await
            .ok_or("dns resolve failed")?
    } else {
        // parse_ip 容忍方括号与空白（"[::1]" / "::1" / " 127.0.0.1 " 都收）
        let ip = dns::parse_ip(pinned_ip).ok_or("AGENT_WSS_IP must be a literal IP")?;
        std::net::SocketAddr::new(ip, port)
    };
    // 解析结果先落日志再连：连不上时也要能看出"域名解析成了什么"
    //（排查解析类问题全指望这一行；放在 connect 之后的话，连不上就什么都不剩）
    log(format!("resolve {host}:{port} -> {addr}"));
    let tcp = tokio::net::TcpStream::connect(addr).await?;
    if scheme == "wss" {
        let (ws, _resp) =
            tokio_tungstenite::client_async_tls_with_config(req, tcp, cfg, None).await?;
        Ok(ws)
    } else {
        // 明文 ws://（仅本地回环或 ALLOW_INSECURE_WS=1，启动时已校验）：手工包一层
        // MaybeTlsStream::Plain，使返回类型与 TLS 分支一致（WsStream 定义如此）
        let (ws, _resp) = tokio_tungstenite::client_async_with_config(
            req,
            tokio_tungstenite::MaybeTlsStream::Plain(tcp),
            cfg,
        )
        .await?;
        Ok(ws)
    }
}

// 控制通道出站消息：普通帧 + 显式排空屏障。
// 屏障用于 self-update：回执入队后紧跟一个屏障，写任务按序处理到屏障时，前面的回执
// 必然已经 send + flush 到 socket（进程随后清理 PTY 并退出，写任务会随之消失）。
// 不用 Notify 广播"队列排空"：Notify 的 permit 会跨时间残留（无等待者时 notify_one
// 存一个 permit，之后的 notified() 直接消费），而队列排空是常态事件——那样"等排空"
// 会在回执真正发出前就返回，语义形同虚设。
enum OutMsg {
    Frame(Message),
    Barrier(tokio::sync::oneshot::Sender<()>),
}

// 控制通道写任务：独占 Sink，从有界队列取消息，单帧发送带超时。
// 超时或错误即返回，读循环 select 到本任务结束就断开重连——因此"发不出去"的链路
// 不会把任何锁或队列永久占住。（此前 Arc<Mutex<Sink>> 跨 send().await 持锁：半开连接
// 下写侧卡死会让上报与指令回执全部永久排队，读循环一旦需要该锁也再无法回到
// read.next()，180s 半开检测被绕过。）
async fn control_writer<S>(
    mut write: S,
    mut rx: tokio::sync::mpsc::Receiver<OutMsg>,
    send_timeout: Duration,
) where
    S: futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    while let Some(msg) = rx.recv().await {
        match msg {
            OutMsg::Frame(m) => match tokio::time::timeout(send_timeout, write.send(m)).await {
                Ok(Ok(())) => {}
                Ok(Err(e)) => {
                    log(format!("control send failed: {e}"));
                    return;
                }
                Err(_) => {
                    log("control send timeout (half-open connection)");
                    return;
                }
            },
            // 屏障：再 flush 一次（send 本身已 flush，此处是"此前帧都已落到 socket"的显式确认），
            // 成功即回执；失败/超时与发送失败同语义——结束任务让读循环断开重连
            OutMsg::Barrier(ack) => match tokio::time::timeout(send_timeout, write.flush()).await {
                Ok(Ok(())) => {
                    let _ = ack.send(());
                }
                Ok(Err(e)) => {
                    log(format!("control flush failed: {e}"));
                    return;
                }
                Err(_) => {
                    log("control flush timeout (half-open connection)");
                    return;
                }
            },
        }
    }
}

// 控制通道入队（非阻塞）：队列满或写任务已退出时只记日志，不阻塞调用方。
// 回执丢失由 DO 侧超时兜底（open 确认重发 / exec·upload·update 等待超时）。
fn ctrl_enqueue(tx: &tokio::sync::mpsc::Sender<OutMsg>, msg: Message, what: &str) {
    if let Err(e) = tx.try_send(OutMsg::Frame(msg)) {
        log(format!("control enqueue {what} rejected: {e}"));
    }
}

// ---------------- 配置 ----------------
#[derive(Clone)]
pub struct Config {
    pub wss: String,
    pub key: String,
    pub report_interval: u64,
    pub disable_exec: bool,
    pub probes: String,
    pub custom_metrics: String,
    // 探活/自定义指标的采集间隔（秒）：与上报间隔解耦（见 metrics/mod.rs 缓存注释）。
    pub probe_interval_s: u64,
    pub custom_interval_s: u64,
    pub disk_fstype_include: String,
    pub tmp_dir: String,
    pub log_file: String,
    pub log_max: u64,
    pub allow_self_update: bool,
    pub self_restart_after_update: bool,
    pub executable: std::path::PathBuf,
}

pub static CONFIG: OnceLock<Config> = OnceLock::new();
static RESTART_AFTER_UPDATE: AtomicBool = AtomicBool::new(false);

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
        probe_interval_s: parse_collect_interval(std::env::var("PROBE_INTERVAL").ok(), 15),
        custom_interval_s: parse_collect_interval(std::env::var("CUSTOM_INTERVAL").ok(), 60),
        // 磁盘统计强制保留的 fstype（逗号分隔）：默认排除虚拟/内存与网络文件系统，
        // 如挂载 OneDrive 的 fuse.rclone 想计入统计则配置 DISK_FSTYPE_INCLUDE=fuse.rclone
        disk_fstype_include: std::env::var("DISK_FSTYPE_INCLUDE").unwrap_or_default(),
        // 平台临时目录基址：Linux 固定 /tmp（与 agent.sh 历史一致），
        // Windows 用 %TEMP%（C:\Users\<u>\AppData\Local\Temp）
        tmp_dir: std::env::var("AGENT_TMPDIR").unwrap_or_else(|_| {
            platform::tmp_base()
                .join(format!("cfpanel-{slug}"))
                .to_string_lossy()
                .into_owned()
        }),
        log_file: std::env::var("AGENT_LOG").unwrap_or_else(|_| {
            platform::tmp_base()
                .join(format!("cfpanel-{slug}-agent.log"))
                .to_string_lossy()
                .into_owned()
        }),
        log_max: std::env::var("AGENT_LOG_MAX")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(262144),
        // 自更新默认关闭：只有明确配置 supervisor 或 AGENT_SELF_RESTART、且安装目录
        // 对运行用户可写时才开启。更新成功后 agent 清理会话并退出。
        allow_self_update: std::env::var("ALLOW_SELF_UPDATE").unwrap_or_default() == "1",
        // 无 systemd/launchd/服务包装器时可显式设 1：替换成功并清理会话后由旧进程
        // 启动磁盘上的新版本。受 supervisor 托管时必须保持 0，防 supervisor 与自启重复拉起。
        self_restart_after_update: std::env::var("AGENT_SELF_RESTART").unwrap_or_default() == "1",
        // 更新前捕获安装路径：Unix self-replace 后 /proc/self/exe 可能变成 "... (deleted)"，
        // 不能在退出前重新 current_exe 再启动新版本。
        executable: std::env::current_exe().unwrap_or_default(),
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
        // 大小写不敏感（LOCALHOST 等价）+ 尾点剥离（"localhost." 是 DNS 等价的 FQDN）——
        // 否则合法回环调试会被误判为远程而拒绝明文；严格方向不变（仍只放行回环）
        let host = host.trim_end_matches('.');
        if host.eq_ignore_ascii_case("127.0.0.1")
            || host.eq_ignore_ascii_case("localhost")
            || host == "::1"
        {
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
fn open_log_file(path: &str) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
}

fn log_sender() -> &'static std::sync::mpsc::SyncSender<String> {
    static TX: OnceLock<std::sync::mpsc::SyncSender<String>> = OnceLock::new();
    TX.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::sync_channel::<String>(1024);
        // stdout 独立通道+线程：stdout 管道对端不消费（journalctl 停止、管道滞留）时
        // write 会永久阻塞——若在同一线程顺序执行，文件日志也会随之停摆；
        // 拆开后 stdout 阻塞只丢 stdout 日志，文件日志不受连坐
        let (out_tx, out_rx) = std::sync::mpsc::sync_channel::<String>(256);
        std::thread::Builder::new()
            .name("log-writer".to_string())
            .spawn(move || {
                let cfg = CONFIG.get().unwrap();
                let mut file = match open_log_file(&cfg.log_file) {
                    Ok(f) => Some(f),
                    Err(e) => {
                        // AGENT_LOG 不可写/指向目录时降级到 stdout；日志线程继续消费队列，
                        // 不能 panic 导致 rx 被关闭、后续所有 log() 静默丢失。
                        let _ = out_tx.try_send(format!(
                            "[cf-panel] log file unavailable ({}): {e}; stdout only\n",
                            cfg.log_file
                        ));
                        None
                    }
                };
                // 轮转判定用自累计字节数（append-only 单写者），替代每行一次 fstat。
                let mut written = file
                    .as_ref()
                    .and_then(|f| f.metadata().ok())
                    .map(|m| m.len())
                    .unwrap_or(0);
                while let Ok(line) = rx.recv() {
                    let mut disable_file = false;
                    if let Some(f) = file.as_mut() {
                        if written > cfg.log_max && f.set_len(0).is_ok() {
                            written = 0;
                        }
                        if let Err(e) = f.write_all(line.as_bytes()) {
                            let _ = out_tx.try_send(format!(
                                "[cf-panel] log file write failed: {e}; stdout only\n"
                            ));
                            disable_file = true;
                        } else {
                            written += line.len() as u64;
                        }
                    }
                    if disable_file {
                        file = None;
                    }
                    // 满即丢弃（stdout 线程积压）：文件日志与 stdout 互不连坐。
                    let _ = out_tx.try_send(line);
                }
            })
            .expect("spawn log writer thread");
        std::thread::Builder::new()
            .name("log-stdout".to_string())
            .spawn(move || {
                let mut out = std::io::stdout().lock();
                while let Ok(line) = out_rx.recv() {
                    let _ = out.write_all(line.as_bytes());
                }
            })
            .expect("spawn log stdout thread");
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
const SUPERSEDED_SECS: u64 = 300; // 被新连接替换（close 4001）：长退避，防双开互踢 ping-pong
const CLOSE_SUPERSEDED: u16 = 4001; // 面板替换语义的 close code（do-terminal.js 同步定义）
const INSTANCE_LOCK_WAIT_MS: u64 = 20_000; // 单实例锁交接窗口：self-restart 时老进程尚未退出
const MIN_UPTIME_RESET_SECS: u64 = 10; // 存活 ≥10s 才算"健康连接"，才重置退避（防秒断风暴）
const CONTROL_READ_TIMEOUT_S: u64 = 180; // 读循环超时：180s 无任何消息判定半开（健康连接有 30s 心跳）
const CTRL_MSG_LIMIT: usize = 64 * 1024; // 控制通道入站消息上限 64KB（指令/心跳远小于此）
const CONNECT_TIMEOUT_S: u64 = 15; // 连接建立（TCP+TLS+WS 升级）总超时，见 connect_ws 注释
const CTRL_SEND_TIMEOUT_S: u64 = 10; // 控制通道单帧发送超时：超时即判定链路故障 → 断开重连
const CTRL_SEND_QUEUE: usize = 256; // 控制通道出站队列：生产者只入队，写任务独占 Sink
const DISPATCH_TIMEOUT_S: u64 = 30; // 指令处理兜底：handler 卡住不能绕过半开检测（见读循环注释）
const UPLOAD_HANDLE_TIMEOUT_S: u64 = 45; // 上传帧处理兜底（内部 file_blocking 30s + 余量）

// 面板替换关闭（close 4001）：同 key 的另一实例连上时，DO 主动关闭旧通道。收到后
// 走长退避而非常规秒级重连——双开场景下立即重连会再次抢回连接、与新实例互踢，
// 形成 A 踢 B、B 重连踢 A 的 ping-pong 循环
#[derive(Debug)]
struct Superseded;
impl std::fmt::Display for Superseded {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "superseded by another agent instance (close 4001)")
    }
}
impl std::error::Error for Superseded {}

async fn run_control(
    cfg: &Config,
    sessions: &Arc<Mutex<std::collections::HashMap<String, Arc<session::TermSession>>>>,
    file_sessions: &Arc<Mutex<std::collections::HashSet<String>>>,
    shutdown: &Arc<Notify>,
) {
    let mut backoff = RETRY_INITIAL_SECS;
    loop {
        let started = std::time::Instant::now();
        match control_conn(cfg, sessions, file_sessions, shutdown).await {
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
                } else if e.downcast_ref::<Superseded>().is_some() {
                    log("superseded by another instance: retrying slowly");
                    backoff = SUPERSEDED_SECS;
                } else if started.elapsed().as_secs() >= MIN_UPTIME_RESET_SECS {
                    // 健康连接存活 ≥10s 后被重置（代理空闲超时/网络抖动）：连接本身没问题，
                    // 快速重连（不翻倍）；否则退避单调膨胀到 300s，表现为"长时间重连不上"
                    backoff = RETRY_INITIAL_SECS;
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
    shutdown: &Arc<Notify>,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    let url = format!("{}/control", cfg.wss);
    let mut req = url.into_client_request()?;
    req.headers_mut().insert("X-Agent-Key", cfg.key.parse()?);
    // 控制通道入站限制 64KB，防恶意超大消息整包占内存（异常帧读循环报错即重连）。
    // tungstenite 0.24+ WebSocketConfig 为 non_exhaustive：default() 后逐字段赋值
    let mut cfg_ws = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default();
    cfg_ws.max_message_size = Some(CTRL_MSG_LIMIT);
    let ws = connect_ws(req, Some(cfg_ws)).await?;
    log("control channel connected");
    let (write, mut read) = ws.split();

    // 出站单通道：所有生产者（上报/指令回执/上传·exec·更新结果）只往有界队列入队，
    // 由写任务独占 Sink 串行发送并带单帧超时（见 control_writer 注释）。
    let (tx, rx) = tokio::sync::mpsc::channel::<OutMsg>(CTRL_SEND_QUEUE);
    let mut writer_task = tokio::spawn(control_writer(
        write,
        rx,
        Duration::from_secs(CTRL_SEND_TIMEOUT_S),
    ));

    // 上报任务（动态间隔，分段等待，间隔变更 ≤5s 生效）。
    // 持有句柄：读循环退出（正常关闭/错误/半开超时）时 abort，防僵尸任务累积
    let interval = Arc::new(AtomicU64::new(cfg.report_interval));
    let note = Arc::new(Notify::new());
    let report_task = {
        let tx = tx.clone();
        let cfg2 = cfg.clone();
        let interval = interval.clone();
        let note = note.clone();
        tokio::spawn(async move {
            report_loop(&cfg2, &tx, &interval, &note).await;
        })
    };

    // 读循环：指令分发（180s 无任何消息判定半开连接，断开触发重连——
    // NAT/防火墙静默断链不再依赖 TCP keepalive 2h 才发现；健康连接有服务端 30s 心跳必有下行）
    // 三重退出条件：读侧超时/错误、写任务结束（发送失败或超时）、服务端 close。
    // 指令处理另加兜底超时：handler 卡住（挂死文件系统、异常 PTY spawn 等）时也必须
    // 能退回重连，否则 180s 半开检测形同虚设（读循环停在 handler 里就不会再走 read.next()）。
    // 控制连接级上传状态：本连接创建的 upload 临时文件（断开时清理）+ 已失败 upload（跳过后续帧）
    let created: Arc<std::sync::Mutex<Vec<String>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
    let failed_uploads: Arc<std::sync::Mutex<std::collections::HashSet<String>>> =
        Arc::new(std::sync::Mutex::new(std::collections::HashSet::new()));
    // 自更新状态仅属于当前控制连接；断连时 abort 清 staging，重连后从头开始（offset=0）。
    let update_manager = Arc::new(update::UpdateManager::new());
    let result: Result<(), Box<dyn Error + Send + Sync>> = loop {
        let msg = tokio::select! {
            // 写任务结束 = 链路发不出去（发送超时/错误）：立刻断开重连，不等读侧超时
            _ = &mut writer_task => {
                break Err("control writer stopped (send failed/timeout)".into());
            }
            r = tokio::time::timeout(Duration::from_secs(CONTROL_READ_TIMEOUT_S), read.next()) => {
                match r {
                    Ok(Some(Ok(m))) => m,
                    Ok(Some(Err(e))) => break Err(Box::new(e)),
                    Ok(None) => break Ok(()), // 服务端正常关闭
                    Err(_) => break Err("control read timeout (half-open connection)".into()),
                }
            }
        };
        match msg {
            Message::Text(t) => {
                // 注意：timeout 只能在 await 点抢占——dispatch 内部的同步段
                //（PTY spawn、JSON 解析、纯计算）不受此超时保护，仅用于兜住会挂起的 await
                let handled = tokio::time::timeout(
                    Duration::from_secs(DISPATCH_TIMEOUT_S),
                    dispatch(
                        cfg,
                        sessions,
                        file_sessions,
                        &tx,
                        &interval,
                        &note,
                        t.as_str(),
                    ),
                )
                .await;
                match handled {
                    Ok(Ok(())) => {}
                    Ok(Err(e)) => break Err(e),
                    Err(_) => break Err("control dispatch timeout".into()),
                }
            }
            // Binary 混合帧：普通文件上传或专用 Agent 更新（JSON 头 type 区分）。
            // 更新必须独立协议，禁止借普通 upload 任意覆盖当前可执行文件。
            Message::Binary(b) => {
                // 两条分支都直接移交帧载荷（Bytes，零拷贝）：帧本体即 tungstenite 的分配
                let handled = if update::is_update_frame(&b) {
                    // self-update 不套外层超时：staging 大文件最长 120s（file_blocking 内已有界）
                    handle_update_frame(cfg, b, &update_manager, &tx, shutdown).await
                } else {
                    match tokio::time::timeout(
                        Duration::from_secs(UPLOAD_HANDLE_TIMEOUT_S),
                        handle_upload_frame(cfg, b, &created, &failed_uploads, &tx),
                    )
                    .await
                    {
                        Ok(r) => r,
                        Err(_) => Err("upload handling timeout".into()),
                    }
                };
                if let Err(e) = handled {
                    break Err(e);
                }
            }
            Message::Close(frame) => {
                // 面板替换关闭：同 key 新控制通道到达时 DO 主动踢旧连接（4001 superseded）。
                // 按专用错误上报走长退避（防互踢 ping-pong）；其余 close 与流结束同语义，
                // 按正常关闭处理
                if frame.as_ref().map(|f| u16::from(f.code)).unwrap_or(0) == CLOSE_SUPERSEDED {
                    break Err(Box::new(Superseded));
                }
                break Ok(());
            }
            _ => {}
        }
    };
    // 读循环退出（任何路径）：终止写/上报任务 + 清理本连接创建的上传临时文件（防中断残留），防僵尸累积
    writer_task.abort();
    report_task.abort();
    if let Ok(tmps) = created.lock() {
        for p in tmps.iter() {
            let _ = std::fs::remove_file(p);
        }
    }
    update_manager.abort();
    result
}

// Agent 自更新帧：staging/校验/替换全部在线程池执行；commit 成功回执后通知主任务
// 优雅清理 PTY 并退出，由 systemd/launchd/Windows supervisor 拉起磁盘上的新版本。
async fn handle_update_frame(
    cfg: &Config,
    frame: Bytes,
    manager: &Arc<update::UpdateManager>,
    tx: &tokio::sync::mpsc::Sender<OutMsg>,
    shutdown: &Arc<Notify>,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    let update_id = update::frame_update_id(&frame);
    let mgr = manager.clone();
    let enabled = cfg.allow_self_update;
    let result =
        crate::blocking::file_blocking(120, move || mgr.handle_frame(&frame, enabled)).await;
    let (response, ready) = match result {
        Some(Ok(update::UpdateOutcome::Progress)) => return Ok(()),
        Some(Ok(update::UpdateOutcome::Ready {
            update_id,
            build_id,
            size,
            backup,
        })) => (
            serde_json::json!({
                "type": "agent_update_result", "update_id": update_id, "ok": true,
                "build_id": build_id, "size": size, "backup": backup, "restarting": true,
            }),
            true,
        ),
        Some(Err(error)) => {
            manager.abort(); // 任一失败终止本次状态，允许无需重连直接重试
            (
                serde_json::json!({
                    "type": "agent_update_result", "update_id": update_id,
                    "ok": false, "error": error,
                }),
                false,
            )
        }
        None => {
            manager.abort();
            (
                serde_json::json!({
                    "type": "agent_update_result", "update_id": update_id,
                    "ok": false, "error": "update operation timed out",
                }),
                false,
            )
        }
    };
    // 替换一旦成功就必须退出运行新版本，不能把退出依赖于回执发送成功：连接恰在此刻
    // 断开时，磁盘已更新但旧进程若继续运行会永远不上新版本。
    if ready {
        RESTART_AFTER_UPDATE.store(cfg.self_restart_after_update, Ordering::SeqCst);
    }
    // 入队用阻塞式 send（其余生产者一律 try_send）：这里需要"入队成功"的确定信号。
    // 队列满（256，几乎不可能，回执帧极小）时最坏阻塞到写任务超时退出（≤10s）后返回 Err；
    // 本函数无外层超时，故该上界即读循环的最坏等待时间。
    let send_result = tx
        .send(OutMsg::Frame(Message::Text(response.to_string().into())))
        .await
        .map_err(|e| Box::new(e) as Box<dyn Error + Send + Sync>);
    if ready {
        log(if cfg.self_restart_after_update {
            "agent update installed; shutting down and starting replacement"
        } else {
            "agent update installed; shutting down for supervisor restart"
        });
        // 紧跟一个排空屏障：写任务处理到屏障时，前面的回执必然已 send + flush 到 socket
        //（排队序保证）。等屏障回执（≤2s）再通知退出，确保 DO 能拿到"更新成功"而不是断线。
        // 超时/失败也继续退出——替换成功就必须跑新版本，退出不能依赖回执送达。
        if send_result.is_ok() {
            let (ack_tx, ack_rx) = tokio::sync::oneshot::channel();
            if tx.send(OutMsg::Barrier(ack_tx)).await.is_ok() {
                let _ = tokio::time::timeout(Duration::from_secs(2), ack_rx).await;
            }
        }
        shutdown.notify_waiters();
        return Ok(());
    }
    send_result?;
    Ok(())
}

// 控制通道上传帧处理：Binary 混合帧（JSON 头 + '\n' + 原始字节，复用文件会话的 write_bytes 原子写语义）
// 每帧：{type:"upload", upload_id, path, offset, commit, overwrite} + 原始字节。
// 失败（系统路径/目标已存在/写错误）回执 upload_result{ok:false} 并记入 failed_uploads，后续帧直接跳过。
async fn handle_upload_frame(
    cfg: &Config,
    frame: Bytes,
    created: &Arc<std::sync::Mutex<Vec<String>>>,
    failed: &Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
    tx: &tokio::sync::mpsc::Sender<OutMsg>,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    let Some(nl) = frame.iter().position(|&b| b == b'\n') else {
        return Ok(()); // 无 JSON 头：忽略
    };
    let v: serde_json::Value = match serde_json::from_slice(&frame[..nl]) {
        Ok(v) => v,
        Err(_) => return Ok(()),
    };
    if v.get("type").and_then(|x| x.as_str()).unwrap_or("") != "upload" {
        return Ok(());
    }
    let path = v
        .get("path")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let upload_id = v
        .get("upload_id")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let offset = v.get("offset").and_then(|x| x.as_u64()).unwrap_or(0);
    let commit = v.get("commit").and_then(|x| x.as_bool()).unwrap_or(false);
    let overwrite = v
        .get("overwrite")
        .and_then(|x| x.as_bool())
        .unwrap_or(false);
    if path.is_empty() || upload_id.is_empty() {
        return Ok(());
    }
    // 数据切片走 Bytes::slice（O(1) 引用计数）：闭包需 'static，Bytes 本身满足，
    // 无需 to_vec() 复制——此前每个 48KB 块都要整块拷贝一次
    let data = frame.slice(nl + 1..);
    // 该 upload 已失败（首帧拒绝后跳过后续帧，避免重复回执/写入）。
    // Mutex poison 容忍（与其余处 if let Ok 风格一致）：poison 视为未失败继续处理，
    // async 读循环里 panic 会杀进程，不能 unwrap
    if failed
        .lock()
        .map(|f| f.contains(&upload_id))
        .unwrap_or(false)
    {
        return Ok(());
    }
    let reject = |msg: &str| {
        let resp = serde_json::json!({
            "type": "upload_result", "upload_id": upload_id, "path": path, "ok": false, "error": msg,
        });
        // 只入队不 await：队列满/写任务已退出时记日志即可，回执丢失由 DO 侧上传超时兜底
        ctrl_enqueue(tx, Message::Text(resp.to_string().into()), "upload_result");
    };
    // DISABLE_EXEC=1：上传属命令执行类写操作，与终端/文件管理一致拒绝
    if cfg.disable_exec {
        if let Ok(mut f) = failed.lock() {
            f.insert(upload_id.clone());
        }
        reject("exec disabled (DISABLE_EXEC=1)");
        return Ok(());
    }
    // 系统路径保护：写操作拒绝系统目录（/proc /sys /etc /usr /var /root 等，与文件会话一致）
    if session::is_system_path(&path) {
        if let Ok(mut f) = failed.lock() {
            f.insert(upload_id.clone());
        }
        reject(session::SYSTEM_PATH_ERR);
        return Ok(());
    }
    // 复用文件会话的原子写：临时文件 {path}.upload.{upload_id}，offset 严格校验，commit 时 fsync+rename。
    // 所有文件系统访问（包括首帧 exists 预检）都必须在 blocking 封装内：挂死 NFS/SMB 上
    // stat/canonicalize/write 任一步都不能占死控制通道的 async 读循环。
    let created = created.clone();
    let failed = failed.clone();
    let failed_timeout = failed.clone();
    let (upload_id_err, path_err) = (upload_id.clone(), path.clone());
    let timeout_id = upload_id.clone();
    let r = match crate::blocking::file_blocking(30, move || {
        // 首帧（offset==0）：overwrite=false 且目标已存在 → 拒绝（防误覆盖）。
        // exists() 会触发 stat，必须与 write_bytes 一起受超时、信号量和文件熔断保护。
        if offset == 0 && !overwrite && std::path::Path::new(&path).exists() {
            if let Ok(mut f) = failed.lock() {
                f.insert(upload_id.clone());
            }
            return serde_json::json!({
                "type": "upload_result", "upload_id": upload_id, "path": path,
                "ok": false, "error": "target already exists (use overwrite=1)",
            });
        }
        let res = session::write_bytes(&path, offset, &data, commit, &upload_id, &created);
        // 解析 write_bytes 回执（write_result / error），统一包装为 upload_result
        let v: serde_json::Value = serde_json::from_str(&res).unwrap_or(serde_json::Value::Null);
        if v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false) {
            serde_json::json!({
                "type": "upload_result", "upload_id": upload_id, "path": path,
                "ok": true, "size": offset + data.len() as u64, "commit": commit,
            })
        } else {
            let msg = v
                .get("message")
                .and_then(|x| x.as_str())
                .unwrap_or("write failed")
                .to_string();
            if let Ok(mut f) = failed.lock() {
                f.insert(upload_id.clone());
            }
            serde_json::json!({
                "type": "upload_result", "upload_id": upload_id, "path": path,
                "ok": false, "error": msg,
            })
        }
    })
    .await
    {
        Some(v) => v,
        None => {
            if let Ok(mut f) = failed_timeout.lock() {
                f.insert(timeout_id);
            }
            serde_json::json!({
                "type": "upload_result", "upload_id": upload_id_err, "path": path_err,
                "ok": false, "error": "write timeout",
            })
        }
    };
    ctrl_enqueue(tx, Message::Text(r.to_string().into()), "upload_result");
    Ok(())
}

// 上报间隔下限/上限校验（防异常/恶意 interval=0 导致采集紧循环打满 CPU）
fn clamp_report_interval(iv: u64) -> u64 {
    iv.clamp(1, 3600)
}

// 环境变量 REPORT_INTERVAL 解析，与指令路径同走 clamp（防操作员误设 0/超上限）
fn parse_report_interval(raw: Option<String>) -> u64 {
    clamp_report_interval(raw.and_then(|v| v.parse().ok()).unwrap_or(120))
}

// 探活/自定义指标采集间隔解析：下限 5s（不低于快采间隔，再小只增加负载不提升新鲜度
// ——上报最快 5s，采集更密也送不出去），上限 3600s（防数据过度陈旧）。
fn parse_collect_interval(raw: Option<String>, default: u64) -> u64 {
    raw.and_then(|v| v.trim().parse::<u64>().ok())
        .map(|n| n.clamp(5, 3600))
        .unwrap_or(default)
}

async fn dispatch(
    cfg: &Config,
    sessions: &Arc<Mutex<std::collections::HashMap<String, Arc<session::TermSession>>>>,
    file_sessions: &Arc<Mutex<std::collections::HashSet<String>>>,
    tx: &tokio::sync::mpsc::Sender<OutMsg>,
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
                        // 先释放 sessions 锁再入队：入队本身不阻塞，但持锁做 I/O 类操作
                        // 会连坐 resize 等所有会话操作（保持原有顺序约定）
                        drop(map);
                        ctrl_enqueue(
                            tx,
                            Message::Text(
                                format!(r#"{{"type":"terminal_ready","stream_id":"{sid}"}}"#)
                                    .into(),
                            ),
                            "terminal_ready",
                        );
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
            ctrl_enqueue(
                tx,
                Message::Text(format!(r#"{{"type":"terminal_ready","stream_id":"{sid}"}}"#).into()),
                "terminal_ready",
            );
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
                ctrl_enqueue(
                    tx,
                    Message::Text(format!(r#"{{"type":"file_ready","stream_id":"{sid}"}}"#).into()),
                    "file_ready",
                );
                return Ok(());
            }
            log(format!("open_file sid={sid}"));
            // 回执 file_ready，停止 DO 的 open_file 确认重发
            ctrl_enqueue(
                tx,
                Message::Text(format!(r#"{{"type":"file_ready","stream_id":"{sid}"}}"#).into()),
                "file_ready",
            );
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
            let tx = tx.clone();
            let cfg2 = cfg.clone();
            tokio::spawn(async move {
                // DISABLE_EXEC=1：立即回执错误，不等 DO 侧 25s 超时（避免误导性超时提示）
                if cfg2.disable_exec {
                    ctrl_enqueue(
                        &tx,
                        Message::Text(
                            serde_json::json!({
                                "type": "exec_result",
                                "exec_id": exec_id,
                                "stdout": "",
                                "stderr": "",
                                "exit_code": null,
                                "timed_out": false,
                                "error": "exec disabled (DISABLE_EXEC=1)",
                            })
                            .to_string()
                            .into(),
                        ),
                        "exec_result",
                    );
                    return;
                }
                log(format!("exec {exec_id}: {command}"));
                // agent 用原始 timeout_s 执行；DO 兜底定时器比这晚 5s（EXEC_TIMEOUT_GRACE_MS），
                // 正常路径 agent 先回执（超时=无输出：output() 超时分支的缓冲区随 future drop
                // 丢弃，不存在"部分输出"），DO 定时器仅防悬挂。
                // 防孤儿：process_group(0) 让子进程成为新进程组组长，超时后 kill(-pid) 连同
                // 孙进程一并清理（与终端会话 cleanup 的进程组语义一致，见 session.rs）。
                // 跨平台：Unix 进程组（setsid + kill(-pgid)）/ Windows Job Object（terminate 整树）
                let mut cmd = tokio::process::Command::new(platform::EXEC_SHELL);
                for a in platform::exec_shell_args() {
                    cmd.arg(a);
                }
                cmd.arg(&command)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .kill_on_drop(true);
                platform::set_new_process_group(cmd.as_std_mut());
                let mut child = match cmd.spawn() {
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
                        ctrl_enqueue(&tx, Message::Text(msg.to_string().into()), "exec_result");
                        return;
                    }
                };
                let pid = child.id().unwrap_or(0);
                #[cfg(windows)]
                platform::attach_job(pid); // Windows：spawn 后挂 Job Object（树终止依赖）
                // 手动收集 stdout/stderr（timeout 到期时随 future drop 丢弃，无部分输出语义）
                let mut out_pipe = child.stdout.take();
                let mut err_pipe = child.stderr.take();
                // 有界读取（48KB/16KB 上限 + 读满后 drain）语义见 read_limited 注释
                let out = tokio::time::timeout(Duration::from_secs(timeout_s), async {
                    let (o, e) = tokio::join!(
                        async {
                            match out_pipe.as_mut() {
                                Some(r) => read_limited(r, 48 * 1024).await,
                                None => Vec::new(),
                            }
                        },
                        async {
                            match err_pipe.as_mut() {
                                Some(r) => read_limited(r, 16 * 1024).await,
                                None => Vec::new(),
                            }
                        },
                    );
                    let status = child.wait().await;
                    (o, e, status)
                })
                .await;
                let (stdout, stderr, exit_code, timed_out) = match out {
                    Ok((o, e, Ok(status))) => {
                        platform::detach_job(pid); // 正常退出：释放 Job 表项与句柄（Windows）
                        (
                            String::from_utf8_lossy(&o).into_owned(),
                            String::from_utf8_lossy(&e).into_owned(),
                            status.code().unwrap_or(-1),
                            false,
                        )
                    }
                    Ok((o, _e, Err(w))) => {
                        // wait 返回错误时子进程句柄已无法继续正常回收；Windows 仍须移除
                        // JOBS 表项并关闭 Job handle，避免每次失败泄漏到 1024 上限。
                        platform::detach_job(pid);
                        (
                            String::from_utf8_lossy(&o).into_owned(),
                            format!("wait failed: {w}"),
                            -1,
                            false,
                        )
                    }
                    Err(_) => {
                        // 超时：终止整棵进程树（Unix SIGKILL 进程组 / Windows TerminateJobObject，
                        // 孙进程一并清理），再 wait 回收防僵尸。
                        // wait 加短超时：D 状态进程收不到 SIGKILL，裸 wait 会永久挂起本任务
                        platform::kill_tree(pid);
                        let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
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
                ctrl_enqueue(&tx, Message::Text(msg.to_string().into()), "exec_result");
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

// exec 有界读取：stdout/stderr 分别取 48KB/16KB 上限（稍大于截断阈值，留 UTF-8 边界
// 余量），避免刷屏命令（25s 窗口）无界物化导致峰值内存数百 MB。
// 限额读满后继续丢弃式 drain：take 到上限即返回 EOF ≠ 子进程写完——不排空的话
// 子进程写满管道缓冲（Linux 默认 64KB）后阻塞在 write() 上永不退出，wait() 挂到
// 整体超时，大输出命令（输出 > ~112KB = 限额 + 管道缓冲）一律被误报 timed out
// + 丢掉已读输出且拖满超时窗口；drain 到真 EOF 让子进程自然退出，按截断语义上报
//（持续输出的命令仍由外层超时兜底 kill 进程组）
pub(crate) async fn read_limited(r: &mut (impl tokio::io::AsyncRead + Unpin), cap: u64) -> Vec<u8> {
    // 预留容量：read_to_end 否则会按倍增反复 realloc（48KB 需 4~5 次搬移）
    let mut buf = Vec::with_capacity(cap as usize);
    let mut limited = tokio::io::AsyncReadExt::take(&mut *r, cap);
    let _ = tokio::io::AsyncReadExt::read_to_end(&mut limited, &mut buf).await;
    let mut sink = [0u8; 8 * 1024];
    loop {
        match tokio::io::AsyncReadExt::read(r, &mut sink).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
    }
    buf
}

// 上报循环：立即上报 + 分段等待（每 5s 重读间隔，interval 变更立即生效）
async fn report_loop(
    cfg: &Config,
    tx: &tokio::sync::mpsc::Sender<OutMsg>,
    interval: &Arc<AtomicU64>,
    note: &Arc<Notify>,
) {
    loop {
        if let Some(r) = metrics::collect_report(cfg).await {
            if tx.try_send(OutMsg::Frame(Message::Text(r.into()))).is_err() {
                // 队列满/写任务已退出 = 链路不可用（写任务会在发送超时后结束，
                // 读循环随之断开重连）：本任务停止采集，避免继续占用配额
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
// 版本号：优先取构建时注入的 AGENT_BUILD_TS（格式 2026.08.08-2000-a1b2c3d4，CI 统一生成），
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
    println!("cf-panel agent（Rust 版）v{VERSION}");
    println!("用法：AGENT_WSS_URL=wss://<面板>/ws/agent AGENT_KEY=<key> ./cf-panel-agent [--help]");
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
    println!(
        "  DISK_FSTYPE_INCLUDE 默认 空  磁盘统计强制保留的 fstype（逗号分隔），如 fuse.rclone"
    );
    println!("  AGENT_TMPDIR      默认 /tmp/cfpanel-<key前8位>   临时目录");
    println!("  AGENT_LOG         默认 /tmp/cfpanel-<key前8位>-agent.log   日志文件");
    println!("  AGENT_LOG_MAX     默认 262144   日志轮转上限（字节）");
    println!("  ALLOW_SELF_UPDATE 默认 0     设为 1 允许管理员从面板更新 Agent");
    println!(
        "  AGENT_SELF_RESTART 默认 0   无 supervisor 时设为 1，更新后主动启动新进程（与 systemd/launchd 二选一）"
    );
    println!(
        "  AGENT_DNS_MODE    默认 auto 域名解析：auto（自建优先、失败回落系统）/ udp（只用自建）/ system（只用系统）"
    );
    println!(
        "  AGENT_WSS_IP      默认 空   直接连该 IP、跳过 DNS（AGENT_WSS_URL 仍用于 TLS 的 SNI 与证书校验）"
    );
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
    // 单实例锁：同 key 双开（手动重复启动/脚本误执行）会形成两条控制通道交替上报
    // （面板版本号/信息来回跳变）且更新指令打到不确定的连接。抢锁失败不立即退出：
    // self-restart 交接时老进程 spawn 新进程后尚未退出，新进程需等它释放锁；窗口耗尽
    // 仍失败才明确退出（真双开）。
    let lock_slug: String = cfg.key.chars().take(8).collect();
    let lock_path = platform::tmp_base().join(format!("cfpanel-{lock_slug}.lock"));
    let mut waited_ms: u64 = 0;
    let mut instance_guard: Option<platform::InstanceGuard> = loop {
        match platform::acquire_instance_lock(&lock_path) {
            Ok(g) => break Some(g),
            Err(_e) => {
                if waited_ms == 0 {
                    log("another agent instance is holding the lock; waiting for handover");
                }
                if waited_ms >= INSTANCE_LOCK_WAIT_MS {
                    eprintln!(
                        "another agent instance is running (lock: {}): exiting",
                        lock_path.display()
                    );
                    std::process::exit(1);
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
                waited_ms += 500;
            }
        }
    };
    update::cleanup_stale(); // 异常退出留下的同目录 .update-* staging（不删除人工回滚 .bak）
    // 保留 AGENT_TMPDIR 环境变量兼容（Rust 版不依赖临时目录，pty/文件均由进程内管理）
    let _ = std::fs::create_dir_all(&cfg.tmp_dir);
    log(format!("agent starting (wss={})", cfg.wss));

    let sessions: Arc<Mutex<std::collections::HashMap<String, Arc<session::TermSession>>>> =
        Arc::new(Mutex::new(Default::default()));
    // 文件会话注册表（open_file 确认重发场景幂等：重发时已存在仅回执，不重复启动）
    let file_sessions: Arc<Mutex<std::collections::HashSet<String>>> =
        Arc::new(Mutex::new(Default::default()));

    // 信号：SIGTERM/SIGINT（Windows 为 Ctrl+C/Ctrl+Break/关窗）→ 清理退出
    let shutdown = Arc::new(Notify::new());
    {
        let shutdown = shutdown.clone();
        tokio::spawn(async move {
            #[cfg(unix)]
            {
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
            }
            #[cfg(windows)]
            {
                // ctrl_c 覆盖 Ctrl+C 与 Ctrl+Break；关窗/注销由 CONSOLE_CONTROL 处理器兜底
                let _ = tokio::signal::ctrl_c().await;
            }
            log("shutdown signal received");
            shutdown.notify_waiters();
        });
    }

    tokio::select! {
        _ = run_control(&cfg, &sessions, &file_sessions, &shutdown) => {}
        _ = shutdown.notified() => {}
    }

    // 清理：关闭所有终端会话（kill 进程组）
    let guards = sessions.lock().await;
    for t in guards.values() {
        t.cleanup().await;
    }
    drop(guards);
    if RESTART_AFTER_UPDATE.load(Ordering::SeqCst) {
        // 先释放单实例锁再拉起新进程：新进程启动即抢锁，不必等老进程完全退出
        // （等待也不致命——新进程有 20s 交接窗口，但显式释放让交接零延迟）
        drop(instance_guard.take());
        match platform::restart_executable(&cfg.executable) {
            Ok(()) => log("replacement agent started"),
            Err(e) => log(format!(
                "failed to start replacement agent: {e}; supervisor restart required"
            )),
        }
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
    fn parse_collect_interval_clamps_and_defaults() {
        assert_eq!(parse_collect_interval(None, 60), 60, "缺省用传入的默认值");
        assert_eq!(parse_collect_interval(None, 15), 15, "探活用另一默认值");
        assert_eq!(
            parse_collect_interval(Some("0".into()), 60),
            5,
            "误设 0 钳到下限 5s（不低于快采间隔）"
        );
        assert_eq!(
            parse_collect_interval(Some("15".into()), 60),
            15,
            "正常值不变"
        );
        assert_eq!(
            parse_collect_interval(Some("99999".into()), 60),
            3600,
            "超上限钳到 3600"
        );
        assert_eq!(
            parse_collect_interval(Some(" 30 ".into()), 60),
            30,
            "容忍空白"
        );
        assert_eq!(
            parse_collect_interval(Some("abc".into()), 60),
            60,
            "非法值回退默认"
        );
    }

    #[test]
    fn is_auth_error_detects_401_http() {
        use tokio_tungstenite::tungstenite::http::{Response, StatusCode};
        // HTTP 401（key 失效/服务器删除）→ 判为鉴权失败，走长退避。
        // tungstenite 0.24+ Error::Http 变体为 Box<Response<Option<Vec<u8>>>>
        let err: Box<dyn Error + Send + Sync> =
            Box::new(tokio_tungstenite::tungstenite::Error::Http(Box::new(
                Response::builder()
                    .status(StatusCode::UNAUTHORIZED)
                    .body(None)
                    .unwrap(),
            )));
        assert!(is_auth_error(err.as_ref()));
        // 其他状态码（如 404 反代不存在）→ 非鉴权失败，走指数退避
        let err404: Box<dyn Error + Send + Sync> =
            Box::new(tokio_tungstenite::tungstenite::Error::Http(Box::new(
                Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(None)
                    .unwrap(),
            )));
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
        // SAFETY: edition 2024 将 set_var/remove_var 标记为 unsafe（非线程安全 API）。
        // 本测试是 ALLOW_INSECURE_WS 的唯一读写者（其余测试不触碰该变量），无并发竞争
        unsafe { std::env::remove_var("ALLOW_INSECURE_WS") };
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
        // SAFETY: 同上，本测试是该变量的唯一读写者
        unsafe { std::env::set_var("ALLOW_INSECURE_WS", "1") };
        assert!(
            validate_wss("ws://example.com/ws/agent").is_ok(),
            "显式 ALLOW_INSECURE_WS=1 放行"
        );
        // SAFETY: edition 2024 将 set_var/remove_var 标记为 unsafe（非线程安全 API）。
        // 本测试是 ALLOW_INSECURE_WS 的唯一读写者（其余测试不触碰该变量），无并发竞争
        unsafe { std::env::remove_var("ALLOW_INSECURE_WS") };
    }

    #[test]
    fn rustls_crypto_provider_compiled_in() {
        // 回归防护（2026-08-25 生产事故）：tungstenite 的 rustls feature 有意不带 crypto
        // provider，漏配时编译通过、首个真实 wss 连接才 panic——单元/E2E 全走 ws:// 回环
        // 无法暴露。ClientConfig::builder 与 connect_async 同路径：无 provider 时此处
        // panic "Could not automatically determine the process-level CryptoProvider"。
        let _cfg = rustls::ClientConfig::builder();
    }

    #[test]
    fn validate_wss_rejects_bad_scheme() {
        assert!(validate_wss("http://example.com/ws/agent").is_err());
        assert!(validate_wss("").is_err());
        assert!(validate_wss("wss").is_err());
    }

    #[test]
    fn log_file_open_failure_is_recoverable() {
        // 目录不能作为追加日志文件打开；调用方应得到 Err 并切到 stdout，而不是 unwrap panic。
        assert!(open_log_file(std::env::temp_dir().to_string_lossy().as_ref()).is_err());
    }

    // 限额读满后必须 drain——否则对端（子进程）写满管道缓冲后阻塞在
    // write() 上永不结束。模拟：duplex(64KB) 一端写 200KB 后关闭，读端 cap 48KB。
    // 无 drain 时写端任务永远挂住（join 超时）；有 drain 时写端正常写完退出
    #[tokio::test]
    async fn read_limited_drains_beyond_cap() {
        use tokio::io::AsyncWriteExt;
        let (client, mut server) = tokio::io::duplex(64 * 1024);
        let writer = tokio::spawn(async move {
            let chunk = vec![b'x'; 8 * 1024];
            for _ in 0..25 {
                // 25 × 8KB = 200KB > cap(48KB) + 管道缓冲(64KB)
                tokio::io::AsyncWriteExt::write_all(&mut server, &chunk)
                    .await
                    .unwrap();
            }
            server.shutdown().await.unwrap();
        });
        let buf = tokio::time::timeout(Duration::from_secs(10), async {
            let mut client = client;
            read_limited(&mut client, 48 * 1024).await
        })
        .await
        .expect("read_limited 未挂死（drain 生效）");
        assert_eq!(buf.len(), 48 * 1024, "返回数据恰为限额值");
        // 写端必须已自然完成（写完 200KB 并关闭），而非阻塞在管道 write 上
        tokio::time::timeout(Duration::from_secs(10), writer)
            .await
            .expect("写端应能写完退出")
            .expect("writer join ok");
    }

    // 回归防护（2026-09-09 生产事故）：TCP 已建立但 WS/TLS 握手被静默丢弃时，
    // 裸 connect_async 会永久挂起（无日志、无重试、ESTAB 残留数天）。
    #[tokio::test]
    async fn connect_ws_times_out_on_stalled_handshake() {
        // 只 accept TCP、永不回 101：模拟边缘接受连接但握手不完成
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (sock, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(30)).await;
            drop(sock);
        });
        let req = format!("ws://{addr}/control")
            .into_client_request()
            .unwrap();
        let started = std::time::Instant::now();
        let r = connect_ws_within(req, None, Duration::from_millis(300)).await;
        assert!(r.is_err(), "握手卡住必须返回错误而非永久挂起");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "必须在超时窗口内返回"
        );
        server.abort();
    }

    // 起一个最小 WS 服务端：accept 后完成 101 升级，并保持连接数秒
    async fn spawn_ws_server() -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let h = tokio::spawn(async move {
            let (sock, _) = listener.accept().await.unwrap();
            let _ = tokio_tungstenite::accept_async(sock).await;
            tokio::time::sleep(Duration::from_secs(3)).await;
        });
        (addr, h)
    }

    // 自建流路径（dns.rs 解析 → 自己 connect → 把流交给 tungstenite）必须能完成握手：
    // 用 IP 字面量绕开真实 DNS，验证 client_async_with_config 那条分支拼得通，
    // 且返回类型与 connect_async_with_config 一致（WsStream）。
    #[tokio::test]
    async fn connect_via_own_resolver_handshakes() {
        let (addr, server) = spawn_ws_server().await;
        let req = format!("ws://{addr}/control")
            .into_client_request()
            .unwrap();
        // 传 "": 不做 IP 覆盖，走着真实解析路径（IP 字面量会短路，不产生 DNS 流量）
        let ws = connect_via_own_resolver_with(req, None, "")
            .await
            .expect("自建路径应完成 TCP + WS 握手");
        drop(ws);
        server.abort();
    }

    // URL 里的 IPv6 字面量必须走自建路径直连，而不是因方括号解析失败退回落 libc
    //（只有 IPv6 的环境里，回退等于本模块完全失效）。这条同时记录一个事实：
    // http::Uri::host() 对 IPv6 返回**带方括号**的形式（RFC 3986），即 dns::strip_brackets 的由来。
    #[tokio::test]
    async fn ipv6_literal_url_connects_via_own_resolver() {
        let listener = match tokio::net::TcpListener::bind("[::1]:0").await {
            Ok(l) => l,
            Err(_) => return, // 宿主/CI 无 IPv6：跳过（本用例不负责测"无 IPv6"的表现）
        };
        let addr = listener.local_addr().unwrap(); // Display 形如 [::1]:port
        let server = tokio::spawn(async move {
            let (sock, _) = listener.accept().await.unwrap();
            let _ = tokio_tungstenite::accept_async(sock).await;
            tokio::time::sleep(Duration::from_secs(3)).await;
        });
        let req = format!("ws://{addr}/control")
            .into_client_request()
            .unwrap();
        assert_eq!(
            req.uri().host(),
            Some("[::1]"),
            "Uri::host() 对 IPv6 字面量带方括号——strip_brackets 的存在理由"
        );
        match connect_via_own_resolver_with(req, None, "").await {
            Ok(ws) => drop(ws),
            Err(e) => panic!("IPv6 字面量应能直连：{e}"),
        }
        server.abort();
    }

    // AGENT_WSS_IP 的两条语义（非法值报错 / 合法值跳过 DNS）。取值以形参注入，不改环境变量：
    // 测试并行执行，改环境会污染并发用例（实测过一次：非法取值让握手用例一起失败）。
    #[tokio::test]
    async fn agent_wss_ip_pin_semantics() {
        // 1) 非法值必须报错，而不是静默回退 DNS——静默回退会让"设了没生效"极难排查
        let req = "ws://127.0.0.1:9/control".into_client_request().unwrap();
        let e = connect_via_own_resolver_with(req, None, "not-an-ip.example")
            .await
            .unwrap_err();
        assert!(
            e.to_string().contains("AGENT_WSS_IP"),
            "错误信息要指名配置项，实际：{e}"
        );

        // 2) 合法 IP 优先于 DNS：URL 里放一个**解析不了**的域名，只有覆盖生效才能连上。
        //    这是"被控机无法解析域名"时的运维兜底。
        let (addr, server) = spawn_ws_server().await;
        let req = format!("ws://panel.invalid:{}/control", addr.port())
            .into_client_request()
            .unwrap();
        match connect_via_own_resolver_with(req, None, "127.0.0.1").await {
            Ok(ws) => drop(ws),
            Err(e) => panic!("有 IP 覆盖时不应依赖 DNS：{e}"),
        }
        server.abort();
    }

    // 域名解析不了时（own 与 libc 都失败）必须返回错误而非挂起——Auto 模式的回落路径
    #[tokio::test]
    async fn unresolvable_host_errors_without_hanging() {
        let req = "ws://no-such-host.invalid/control"
            .into_client_request()
            .unwrap();
        let started = std::time::Instant::now();
        let r = connect_ws_within(req, None, Duration::from_secs(10)).await;
        assert!(r.is_err(), "解析不了必须报错");
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "必须在上界内返回"
        );
    }

    // 写侧可控的 Sink：stuck=true 时 flush 永不就绪（模拟半开连接）；
    // sent 记录实际写出顺序，用于断言屏障的"此前帧已发出"语义
    struct MockSink {
        stuck: bool,
        sent: Arc<std::sync::Mutex<Vec<String>>>,
    }
    impl futures_util::Sink<Message> for MockSink {
        type Error = tokio_tungstenite::tungstenite::Error;
        fn poll_ready(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            std::task::Poll::Ready(Ok(()))
        }
        fn start_send(self: std::pin::Pin<&mut Self>, item: Message) -> Result<(), Self::Error> {
            if let Message::Text(t) = item {
                self.sent.lock().unwrap().push(t.to_string());
            }
            Ok(())
        }
        fn poll_flush(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            if self.stuck {
                std::task::Poll::Pending
            } else {
                std::task::Poll::Ready(Ok(()))
            }
        }
        fn poll_close(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            std::task::Poll::Ready(Ok(()))
        }
    }

    fn mock_sink(stuck: bool) -> (MockSink, Arc<std::sync::Mutex<Vec<String>>>) {
        let sent = Arc::new(std::sync::Mutex::new(Vec::new()));
        (
            MockSink {
                stuck,
                sent: sent.clone(),
            },
            sent,
        )
    }

    // 回归防护（事故根因之一）：发送永久 pending 时写任务必须自行退出，
    // 否则读循环 select 不到"写侧已死"，整条控制通道僵死且不重连。
    #[tokio::test]
    async fn control_writer_exits_on_send_timeout() {
        let (tx, rx) = tokio::sync::mpsc::channel::<OutMsg>(4);
        tx.send(OutMsg::Frame(Message::Text("x".into())))
            .await
            .unwrap();
        let (sink, _) = mock_sink(true);
        let done = tokio::time::timeout(
            Duration::from_secs(5),
            control_writer(sink, rx, Duration::from_millis(100)),
        )
        .await;
        assert!(done.is_ok(), "写任务必须在发送超时后自行结束");
    }

    // 屏障语义：屏障回执必须意味着"排在其前的帧都已写出"。
    // 旧实现用 Notify 广播"队列排空"，permit 会跨时间残留（无等待者时 notify_one 存一个 permit，
    // 之后 notified() 直接消费）——而排空是常态事件（每帧上报都会排空），于是 self-update 的
    // "等回执交给 socket" 会在回执真正发出前就返回。本测试先制造一次排空再发屏障，锁死该回归。
    #[tokio::test]
    async fn control_writer_barrier_acks_only_after_prior_frames() {
        let (tx, rx) = tokio::sync::mpsc::channel::<OutMsg>(4);
        let (sink, sent) = mock_sink(false);
        let task = tokio::spawn(control_writer(sink, rx, Duration::from_secs(1)));

        // 第一帧：等它真的写出（等价于旧实现里"排空通知"已经发生过）
        tx.send(OutMsg::Frame(Message::Text("first".into())))
            .await
            .unwrap();
        for _ in 0..100 {
            if !sent.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(sent.lock().unwrap().len(), 1, "第一帧应已写出");

        // 第二帧 + 屏障：回执必须晚于第二帧写出
        let (ack_tx, ack_rx) = tokio::sync::oneshot::channel();
        tx.send(OutMsg::Frame(Message::Text("second".into())))
            .await
            .unwrap();
        tx.send(OutMsg::Barrier(ack_tx)).await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), ack_rx)
            .await
            .expect("屏障必须在超时前回执")
            .expect("屏障回执通道正常");
        assert_eq!(
            *sent.lock().unwrap(),
            vec!["first".to_string(), "second".to_string()],
            "屏障回执时第二帧必须已写出"
        );
        drop(tx);
        task.await.expect("写任务正常结束");
    }

    // 屏障失败路径：flush 永久 pending 时写任务按链路故障结束（读循环随之重连）
    #[tokio::test]
    async fn control_writer_barrier_flush_timeout_ends_task() {
        let (tx, rx) = tokio::sync::mpsc::channel::<OutMsg>(4);
        let (ack_tx, ack_rx) = tokio::sync::oneshot::channel();
        tx.send(OutMsg::Barrier(ack_tx)).await.unwrap();
        drop(tx);
        let (sink, _) = mock_sink(true);
        let done = tokio::time::timeout(
            Duration::from_secs(5),
            control_writer(sink, rx, Duration::from_millis(100)),
        )
        .await;
        assert!(done.is_ok(), "flush 超时后写任务必须结束");
        assert!(ack_rx.await.is_err(), "失败路径不得回执成功");
    }
}
