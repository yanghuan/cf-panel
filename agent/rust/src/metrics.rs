// 监控采集：/proc 指标 + 磁盘 + 网络差分 + 系统信息 + 探活 + 自定义指标
// 与 agent.sh collect_report 对齐（字段名/结构一致）
use crate::Config;
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

// 阻塞并发上限：限制 spawn_blocking 任务数，防挂死挂载点/命令累积耗尽线程池
static BLOCKING_PERMITS: usize = 4;
static BLOCKING_SEM: std::sync::OnceLock<Arc<tokio::sync::Semaphore>> = std::sync::OnceLock::new();
fn blocking_sem() -> Arc<tokio::sync::Semaphore> {
    BLOCKING_SEM
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(BLOCKING_PERMITS)))
        .clone()
}

// spawn_blocking + 超时：命令在阻塞线程池执行，防止挂死的挂载点/命令阻塞 async runtime。
// 信号量限并发：挂死任务（tokio 无法取消 spawn_blocking）最多占满 4 个槽，其余采集立即失败不堆积
async fn run_blocking<F, T>(secs: u64, f: F) -> Option<T>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    let _permit = blocking_sem().acquire_owned().await.ok()?;
    let join = tokio::task::spawn_blocking(f);
    match tokio::time::timeout(Duration::from_secs(secs), join).await {
        Ok(Ok(v)) => Some(v),
        _ => None,
    }
}

// CPU：两次采样（间隔 200ms）求差值。
// 扩展 8 字段口径（shell 版已弃用，不再对齐其 4 字段简化算法）——
// total = user+nice+system+idle+iowait+irq+softirq+steal（guest/guest_nice 内核已计入 user/nice，
// 不重复累加）；usage = (total - idle) / total，iowait/irq/softirq/steal 计入忙碌，
// 高 iowait（磁盘/网络慢）与云主机 steal 被抢占时读数不再偏低
async fn collect_cpu() -> f64 {
    let s1 = read_file("/proc/stat").and_then(|s| s.lines().next().map(|l| l.to_string()));
    tokio::time::sleep(Duration::from_millis(200)).await;
    let s2 = read_file("/proc/stat").and_then(|s| s.lines().next().map(|l| l.to_string()));
    let parse = |l: &str| -> Option<(u64, u64)> {
        let mut it = l.split_whitespace().skip(1);
        let u: u64 = it.next()?.parse().ok()?;
        let n: u64 = it.next()?.parse().ok()?;
        let s: u64 = it.next()?.parse().ok()?;
        let i: u64 = it.next()?.parse().ok()?;
        let io: u64 = it.next()?.parse().ok()?;
        let irq: u64 = it.next()?.parse().ok()?;
        let soft: u64 = it.next()?.parse().ok()?;
        let steal: u64 = it.next()?.parse().ok()?;
        Some((u + n + s + i + io + irq + soft + steal, i))
    };
    match (s1.as_deref().and_then(parse), s2.as_deref().and_then(parse)) {
        (Some((t0, idle0)), Some((t1, idle1))) => {
            let total = t1 as i64 - t0 as i64;
            let idle = idle1 as i64 - idle0 as i64;
            if total <= 0 {
                0.0
            } else {
                (100.0 * (1.0 - idle as f64 / total as f64)).clamp(0.0, 100.0)
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
    (
        t.saturating_sub(a) * 1024,
        t * 1024,
        st.saturating_sub(sf) * 1024,
    ) // used, total, swap
}

// 负载 / 进程数 / 开机时间
fn collect_load() -> (f64, f64, f64, u64, u64) {
    let text = read_file("/proc/loadavg").unwrap_or_default();
    let mut it = text.split_whitespace();
    let l1: f64 = it.next().and_then(|v| v.parse().ok()).unwrap_or(0.0);
    let l5: f64 = it.next().and_then(|v| v.parse().ok()).unwrap_or(0.0);
    let l15: f64 = it.next().and_then(|v| v.parse().ok()).unwrap_or(0.0);
    let procs = it
        .next()
        .and_then(|p| p.split('/').nth(1))
        .and_then(|p| p.parse().ok())
        .unwrap_or(0);
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
            if let Some(v) =
                read_file(&format!("{dir}/{name}/temp")).and_then(|s| s.trim().parse::<f64>().ok())
            {
                return Some(v / 1000.0);
            }
        }
    }
    None
}

// TCP/UDP 连接数（BufReader 流式计数，不物化全文件——50 万连接不再一次性分配 ~75MB String）
fn count_lines(path: &str) -> u64 {
    use std::io::BufRead;
    std::fs::File::open(path)
        .map(|f| std::io::BufReader::new(f).lines().count().saturating_sub(1) as u64)
        .unwrap_or(0)
}
fn collect_conns() -> (u64, u64) {
    (count_lines("/proc/net/tcp"), count_lines("/proc/net/udp"))
}

// 磁盘结果缓存：df 结果 60s 内复用；超时/失败返回上次成功值（熔断降级，不空转重试）
type DiskCache = tokio::sync::Mutex<Option<(std::time::Instant, Vec<serde_json::Value>)>>;
static DISK_CACHE: std::sync::OnceLock<DiskCache> = std::sync::OnceLock::new();
async fn disk_cache(
) -> tokio::sync::MutexGuard<'static, Option<(std::time::Instant, Vec<serde_json::Value>)>> {
    DISK_CACHE
        .get_or_init(|| tokio::sync::Mutex::new(None))
        .lock()
        .await
}

// 磁盘：df -Pkl（-l 仅本地文件系统，不碰 NFS/CIFS 挂死挂载点）；tokio 子进程 +
// kill_on_drop + 进程组（超时即杀，不留孤儿）；60s 缓存；失败走真熔断——
// 刷新缓存时间戳使熔断窗口内直接返回旧值不重试（60s 后重试一次）
async fn collect_disk() -> Vec<serde_json::Value> {
    let now = std::time::Instant::now();
    if let Some((ts, disk)) = disk_cache().await.as_ref() {
        if now.duration_since(*ts).as_secs() < 60 {
            return disk.clone(); // 60s 缓存命中（快采 5s → 12 帧只跑一次 df）
        }
    }
    let mut cmd = tokio::process::Command::new("df");
    cmd.args(["-Pkl"]).kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0); // 超时取消时杀掉整个进程组，防 df 孤儿残留
    let out = tokio::time::timeout(Duration::from_secs(5), cmd.output()).await;
    let mut disk = Vec::new();
    match out {
        Ok(Ok(out)) if out.status.success() => {
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
            *disk_cache().await = Some((now, disk.clone())); // 成功：更新缓存
        }
        _ => {
            // 失败/超时：真熔断——刷新时间戳，后续 60s 内直接返回旧值/空值不重试；
            // 无旧值也写空缓存（开机即挂死 NFS 场景下避免每帧重跑 df 挂 5s）
            let mut c = disk_cache().await;
            let old = c.as_ref().map(|(_, v)| v.clone());
            *c = Some((now, old.clone().unwrap_or_default()));
            if let Some(old) = old {
                return old;
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
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let st = net_state().await;
    let mut guard = st.lock().await;
    let (in_rate, out_rate) = match guard.as_ref() {
        Some(prev) if prev.ts > 0 && now > prev.ts => {
            let dt = now - prev.ts;
            let i = if rx >= prev.rx {
                (rx - prev.rx) / dt
            } else {
                0
            };
            let o = if tx >= prev.tx {
                (tx - prev.tx) / dt
            } else {
                0
            };
            (i, o)
        }
        _ => (0, 0),
    };
    *guard = Some(NetState { rx, tx, ts: now });
    (in_rate, out_rate)
}

// 系统信息缓存：OS/内核/IP 基本不变，10min 内复用（快采不再每帧 fork uname/hostname）
type InfoCache = tokio::sync::Mutex<Option<(std::time::Instant, serde_json::Value)>>;
static INFO_CACHE: std::sync::OnceLock<InfoCache> = std::sync::OnceLock::new();
async fn info_cache(
) -> tokio::sync::MutexGuard<'static, Option<(std::time::Instant, serde_json::Value)>> {
    INFO_CACHE
        .get_or_init(|| tokio::sync::Mutex::new(None))
        .lock()
        .await
}

// 系统信息：OS / 内核 / IP（uname/hostname 放线程池+超时）
async fn collect_info() -> serde_json::Value {
    let now = std::time::Instant::now();
    if let Some((ts, v)) = info_cache().await.as_ref() {
        if now.duration_since(*ts).as_secs() < 600 {
            return v.clone(); // 10min 缓存命中
        }
    }
    let os = read_file("/etc/os-release")
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with("PRETTY_NAME="))
                .and_then(|l| {
                    l.split_once('=')
                        .map(|(_, v)| v.trim_matches('"').trim().to_string())
                })
        })
        .unwrap_or_else(|| std::env::consts::OS.to_string());
    let kern = run_blocking(5, || std::process::Command::new("uname").arg("-r").output())
        .await
        .and_then(|r| r.ok())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    let host = run_blocking(5, || {
        std::process::Command::new("hostname").arg("-I").output()
    })
    .await
    .and_then(|r| r.ok())
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
    let val = json!({ "os": os, "kern": kern, "ip4": ip4, "ip6": ip6 });
    // uname/hostname 全空（采集超时/失败）不缓存：避免空结果（IP 字段空显）被缓存 10 分钟
    if !kern.is_empty() || !host.is_empty() {
        *info_cache().await = Some((now, val.clone()));
    }
    val
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
    // 域名兜底：IP 字面量直接解析；否则 lookup_host DNS（与 tcp_probe 对齐），
    // 修复 http://域名/ 探活永远 DOWN（此前仅 IP 字面量，域名场景持续误告警）
    let addr: SocketAddr = match format!("{host}:{port}").parse() {
        Ok(a) => a,
        Err(_) => match tokio::net::lookup_host((host.as_str(), port)).await {
            Ok(mut it) => match it.next() {
                Some(a) => a,
                None => return None,
            },
            Err(_) => return None,
        },
    };
    let t0 = Instant::now();
    let fut = async {
        let mut conn = TcpStream::connect(addr).await.ok()?;
        let req = format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nUser-Agent: cf-panel-agent\r\n\r\n");
        conn.write_all(req.as_bytes()).await.ok()?;
        conn.flush().await.ok()?;
        let mut buf = vec![0u8; 4096];
        let n = conn.read(&mut buf).await.ok()?;
        let head = String::from_utf8_lossy(&buf[..n]);
        let status: u16 = head
            .lines()
            .next()?
            .split_whitespace()
            .nth(1)?
            .parse()
            .ok()?;
        Some(status)
    };
    let status = tokio::time::timeout(Duration::from_secs(timeout_secs), fut)
        .await
        .ok()
        .flatten()?;
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
                    Some((c, _)) => (c, (200..400).contains(&c)),
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
        let name = item
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let cmd = item
            .get("cmd")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if name.is_empty() || cmd.is_empty() {
            continue;
        }
        // kill_on_drop + process_group(0)：超时取消时杀掉整个子进程组，防孤儿残留
        let mut c = tokio::process::Command::new("sh");
        c.arg("-c").arg(&cmd).kill_on_drop(true);
        #[cfg(unix)]
        c.process_group(0);
        let fut = c.output();
        if let Ok(Ok(o)) = tokio::time::timeout(Duration::from_secs(5), fut).await {
            let line = String::from_utf8_lossy(&o.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
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
    // 无依赖采集项并行（join!），消除串行累积（cpu 200ms + df/uname/hostname 5s 上限 +
    // probes/custom 5s/个）对快采帧率的稀释；blocking 峰值 = info(1) + disk(1) = 2 < Semaphore 4
    let (cpu, mem, load, conns, net, info, probes, custom, disk) = tokio::join!(
        collect_cpu(),
        async { collect_mem() },
        async { collect_load() },
        async { collect_conns() },
        collect_net(),
        collect_info(),
        collect_probes(cfg),
        collect_custom(cfg),
        collect_disk(),
    );
    let (mem_used, mem_total, swap) = mem;
    let (l1, l5, l15, procs, uptime) = load;
    let (tcp, udp) = conns;
    let (net_in, net_out) = net;
    let report = json!({
        "type": "report",
        "cpu": cpu,
        "mem_used": mem_used,
        "mem_total": mem_total,
        "net_in": net_in,
        "net_out": net_out,
        "extra": {
            "swap": swap,
            "disk": disk,
            "load1": l1, "load5": l5, "load15": l15,
            "temp": collect_temp(),
            "procs": procs, "tcp": tcp, "udp": udp,
            "uptime": uptime,
        },
        "info": info,
        "probes": probes,
        "custom": custom,
    });
    Some(report.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collect_mem_parses() {
        let (used, total, _swap) = collect_mem();
        assert!(total > 0, "MemTotal 应可读");
        assert!(used <= total, "已用不超过总量");
    }

    #[test]
    fn collect_load_parses() {
        let (l1, l5, l15, procs, uptime) = collect_load();
        assert!(l1 >= 0.0 && l5 >= 0.0 && l15 >= 0.0);
        assert!(uptime > 0, "uptime 应可读");
        assert!(procs > 0);
    }

    #[test]
    fn collect_conns_parses() {
        let (tcp, udp) = collect_conns();
        assert!(tcp > 0, "/proc/net/tcp 应可读");
        assert!(udp > 0);
    }
}
