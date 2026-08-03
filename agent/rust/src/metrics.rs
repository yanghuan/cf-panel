// 监控采集：/proc 指标 + 磁盘 + 网络差分 + 系统信息 + 探活 + 自定义指标
// 与 agent.sh collect_report 对齐（字段名/结构一致）
use crate::{log, Config};
use serde_json::json;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Instant;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio::time::Duration;

// 网络速率差分状态（上次累计值 + 采样时间）
struct NetState {
    rx: u64,
    tx: u64,
    ts: u64,
}
static NET: std::sync::OnceLock<Arc<Mutex<Option<NetState>>>> = std::sync::OnceLock::new();
async fn net_state() -> Arc<Mutex<Option<NetState>>> {
    NET.get_or_init(|| Arc::new(Mutex::new(None))).clone()
}

fn read_file(path: &str) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

// CPU：两次采样（间隔 200ms）求差值，对齐 shell awk 算法
async fn collect_cpu() -> f64 {
    let s1 = read_file("/proc/stat").and_then(|s| s.lines().next().map(|l| l.to_string()));
    tokio::time::sleep(Duration::from_millis(200)).await;
    let s2 = read_file("/proc/stat").and_then(|s| s.lines().next().map(|l| l.to_string()));
    let parse = |l: &str| -> Option<(u64, u64, u64, u64)> {
        let mut it = l.split_whitespace().skip(1);
        let u = it.next()?.parse().ok()?;
        let n = it.next()?.parse().ok()?;
        let s = it.next()?.parse().ok()?;
        let i = it.next()?.parse().ok()?;
        Some((u, n, s, i))
    };
    match (s1.as_deref().and_then(parse), s2.as_deref().and_then(parse)) {
        (Some((u0, n0, s0, i0)), Some((u1, n1, s1, i1))) => {
            let total = (u1 + n1 + s1 + i1) as i64 - (u0 + n0 + s0 + i0) as i64;
            let idle = i1 as i64 - i0 as i64;
            if total <= 0 {
                0.0
            } else {
                (100.0 * (1.0 - idle as f64 / total as f64)).min(100.0).max(0.0)
            }
        }
        _ => 0.0,
    }
}

// 内存/swap：/proc/meminfo
fn collect_mem() -> (u64, u64, u64) {
    let text = read_file("/proc/meminfo").unwrap_or_default();
    let mut t = 0u64;
    let mut a = 0u64;
    let mut st = 0u64;
    let mut sf = 0u64;
    for line in text.lines() {
        let mut it = line.split_whitespace();
        let key = it.next().unwrap_or("");
        let val: u64 = it.next().and_then(|v| v.parse().ok()).unwrap_or(0);
        match key {
            "MemTotal:" => t = val,
            "MemAvailable:" => a = val,
            "SwapTotal:" => st = val,
            "SwapFree:" => sf = val,
            _ => {}
        }
    }
    (t.saturating_sub(a) * 1024, t * 1024, st.saturating_sub(sf) * 1024) // used, total, swap
}

// 负载 / 进程数 / 开机时间
fn collect_load() -> (f64, f64, f64, u64, u64) {
    let text = read_file("/proc/loadavg").unwrap_or_default();
    let mut it = text.split_whitespace();
    let l1: f64 = it.next().and_then(|v| v.parse().ok()).unwrap_or(0.0);
    let l5: f64 = it.next().and_then(|v| v.parse().ok()).unwrap_or(0.0);
    let l15: f64 = it.next().and_then(|v| v.parse().ok()).unwrap_or(0.0);
    let procs = it.next().and_then(|p| p.split('/').nth(1)).and_then(|p| p.parse().ok()).unwrap_or(0);
    let uptime = read_file("/proc/uptime")
        .and_then(|s| s.split_whitespace().next().map(|v| v.to_string()))
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.0) as u64;
    (l1, l5, l15, procs, uptime)
}

// 温度：第一个热区（℃）
fn collect_temp() -> Option<f64> {
    let dir = "/sys/class/thermal";
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if !name.starts_with("thermal_zone") {
                continue;
            }
            if let Some(v) = read_file(&format!("{dir}/{name}/temp")).and_then(|s| s.trim().parse::<f64>().ok()) {
                return Some(v / 1000.0);
            }
        }
    }
    None
}

// TCP/UDP 连接数
fn collect_conns() -> (u64, u64) {
    let tcp = read_file("/proc/net/tcp").map(|s| s.lines().count().saturating_sub(1) as u64).unwrap_or(0);
    let udp = read_file("/proc/net/udp").map(|s| s.lines().count().saturating_sub(1) as u64).unwrap_or(0);
    (tcp, udp)
}

// 磁盘：df -Pk（挂载点以 / 开头）
fn collect_disk() -> Vec<serde_json::Value> {
    let out = std::process::Command::new("df").args(["-Pk"]).output().ok();
    let mut disk = Vec::new();
    if let Some(out) = out {
        let text = String::from_utf8_lossy(&out.stdout);
        for line in text.lines().skip(1) {
            let mut it = line.split_whitespace();
            let _fs = it.next();
            let _blocks = it.next();
            let _used = it.next();
            let _avail = it.next();
            let cap = it.next().unwrap_or("");
            let mount = it.next().unwrap_or("");
            if mount.starts_with('/') {
                let pct = cap.trim_end_matches('%').parse::<u64>().unwrap_or(0);
                disk.push(json!({ "m": mount, "u": pct }));
            }
        }
    }
    disk
}

// 网络速率：/proc/net/dev 累计差分（字节/秒）
async fn collect_net() -> (u64, u64) {
    let mut rx = 0u64;
    let mut tx = 0u64;
    if let Some(text) = read_file("/proc/net/dev") {
        for line in text.lines().skip(2) {
            let mut it = line.split_whitespace();
            let _iface = it.next();
            if let Some(r) = it.next().and_then(|v| v.parse::<u64>().ok()) {
                rx += r;
            }
            // 第 10 列为 tx 字节
            let mut v = it.clone();
            for _ in 0..7 {
                v.next();
            }
            if let Some(t) = v.next().and_then(|s| s.parse::<u64>().ok()) {
                tx += t;
            }
        }
    }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let st = net_state().await;
    let mut guard = st.lock().await;
    let (in_rate, out_rate) = match guard.as_ref() {
        Some(prev) if prev.ts > 0 && now > prev.ts => {
            let dt = now - prev.ts;
            let i = if rx >= prev.rx { (rx - prev.rx) / dt } else { 0 };
            let o = if tx >= prev.tx { (tx - prev.tx) / dt } else { 0 };
            (i, o)
        }
        _ => (0, 0),
    };
    *guard = Some(NetState { rx, tx, ts: now });
    (in_rate, out_rate)
}

// 系统信息：OS / 内核 / IP
fn collect_info() -> serde_json::Value {
    let os = read_file("/etc/os-release")
        .and_then(|s| {
            s.lines().find(|l| l.starts_with("PRETTY_NAME=")).and_then(|l| {
                l.splitn(2, '=').nth(1).map(|v| v.trim_matches('"').trim().to_string())
            })
        })
        .unwrap_or_else(|| std::env::consts::OS.to_string());
    let kern = std::process::Command::new("uname").arg("-r").output().ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    let host = std::process::Command::new("hostname").arg("-I").output().ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    let mut ip4 = String::new();
    let mut ip6 = String::new();
    for p in host.split_whitespace() {
        if p.contains(':') {
            if ip6.is_empty() && p != "::1" {
                ip6 = p.to_string();
            }
        } else if !p.starts_with("127.") && ip4.is_empty() {
            ip4 = p.to_string();
        }
    }
    json!({ "os": os, "kern": kern, "ip4": ip4, "ip6": ip6 })
}

// ---- 探活 PROBES：名称:类型:目标,...（http 检查 2xx/3xx，tcp 测连通）----
// 注：仅支持 http://（明文）与 tcp 探测；https:// 探活暂不支持（记为失败），wss 不受影响
async fn http_probe(url: &str, timeout_secs: u64) -> Option<(u16, u128)> {
    let (scheme, rest) = url.split_once("://")?;
    if scheme != "http" {
        return None; // https 探活暂不支持
    }
    let (hostport, path) = match rest.find('/') {
        Some(i) => rest.split_at(i),
        None => (rest, ""),
    };
    let (host, port) = match hostport.rsplit_once(':') {
        Some((h, p)) if p.parse::<u16>().is_ok() => (h.to_string(), p.parse().unwrap()),
        _ => (hostport.to_string(), 80u16),
    };
    let path = if path.is_empty() { "/" } else { path };
    let addr: SocketAddr = format!("{host}:{port}").parse().ok()?;
    let t0 = Instant::now();
    let fut = async {
        let mut conn = TcpStream::connect(addr).await.ok()?;
        let req = format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nUser-Agent: cf-panel-agent\r\n\r\n");
        conn.write_all(req.as_bytes()).await.ok()?;
        conn.flush().await.ok()?;
        let mut buf = vec![0u8; 4096];
        let n = conn.read(&mut buf).await.ok()?;
        let head = String::from_utf8_lossy(&buf[..n]);
        let status: u16 = head.lines().next()?.split_whitespace().nth(1)?.parse().ok()?;
        Some(status)
    };
    let status = tokio::time::timeout(Duration::from_secs(timeout_secs), fut).await.ok().flatten()?;
    Some((status, t0.elapsed().as_millis()))
}

async fn tcp_probe(target: &str, timeout_secs: u64) -> bool {
    let addr: SocketAddr = match target.parse() {
        Ok(a) => a,
        Err(_) => match target.rsplit_once(':') {
            Some((h, p)) if p.parse::<u16>().is_ok() => {
                let p = p.parse().unwrap();
                match tokio::net::lookup_host((h, p)).await {
                    Ok(mut it) => match it.next() {
                        Some(a) => a,
                        None => return false,
                    },
                    Err(_) => return false,
                }
            }
            _ => return false,
        },
    };
    tokio::time::timeout(Duration::from_secs(timeout_secs), TcpStream::connect(addr))
        .await
        .map(|r| r.is_ok())
        .unwrap_or(false)
}

async fn collect_probes(cfg: &Config) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    if cfg.probes.trim().is_empty() {
        return out;
    }
    for p in cfg.probes.split(',') {
        let p = p.trim();
        if p.is_empty() {
            continue;
        }
        let mut it = p.splitn(3, ':');
        let name = it.next().unwrap_or("").to_string();
        let ty = it.next().unwrap_or("").to_string();
        let target = it.next().unwrap_or("").to_string();
        if name.is_empty() || ty.is_empty() || target.is_empty() {
            continue;
        }
        match ty.as_str() {
            "http" => {
                let t0 = Instant::now();
                let (code, ok) = match http_probe(&target, 5).await {
                    Some((c, _)) => (c, c >= 200 && c < 400),
                    None => (0, false),
                };
                let ms = t0.elapsed().as_millis() as u64;
                out.push(json!({ "name": name, "ok": ok, "code": code, "ms": ms }));
            }
            "tcp" => {
                let t0 = Instant::now();
                let ok = tcp_probe(&target, 3).await;
                let ms = t0.elapsed().as_millis() as u64;
                out.push(json!({ "name": name, "ok": ok, "code": 0, "ms": ms }));
            }
            _ => {}
        }
    }
    out
}

// ---- 自定义指标 CUSTOM_METRICS：[{"name","cmd"}] 执行命令取第一行数值（5s 超时）----
async fn collect_custom(cfg: &Config) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    let raw = cfg.custom_metrics.trim();
    if raw.is_empty() {
        return out;
    }
    let arr: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return out,
    };
    let items = match arr.as_array() {
        Some(a) => a.clone(),
        None => return out,
    };
    for item in items {
        let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let cmd = item.get("cmd").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if name.is_empty() || cmd.is_empty() {
            continue;
        }
        let fut = tokio::process::Command::new("sh").arg("-c").arg(&cmd).output();
        if let Ok(Ok(o)) = tokio::time::timeout(Duration::from_secs(5), fut).await {
            let line = String::from_utf8_lossy(&o.stdout).lines().next().unwrap_or("").trim().to_string();
            if !line.is_empty() {
                if let Ok(v) = line.parse::<f64>() {
                    out.push(json!({ "name": name, "value": v }));
                }
            }
        }
    }
    out
}

// ---- 汇总上报 ----
pub async fn collect_report(cfg: &Config) -> Option<String> {
    let cpu = collect_cpu().await;
    let (mem_used, mem_total, swap) = collect_mem();
    let (l1, l5, l15, procs, uptime) = collect_load();
    let (tcp, udp) = collect_conns();
    let (net_in, net_out) = collect_net().await;
    let info = collect_info();
    let probes = collect_probes(cfg).await;
    let custom = collect_custom(cfg).await;
    let report = json!({
        "type": "report",
        "cpu": cpu,
        "mem_used": mem_used,
        "mem_total": mem_total,
        "net_in": net_in,
        "net_out": net_out,
        "extra": {
            "swap": swap,
            "disk": collect_disk(),
            "load1": l1, "load5": l5, "load15": l15,
            "temp": collect_temp(),
            "procs": procs, "tcp": tcp, "udp": udp,
            "uptime": uptime,
        },
        "info": info,
        "probes": probes,
        "custom": custom,
    });
    log("report collected");
    Some(report.to_string())
}
