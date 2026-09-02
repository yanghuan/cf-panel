// Linux 系统指标采集：/proc、/sys 原生实现（无外部依赖，与 agent.sh collect_report 同口径）。
// 函数集签名见 imp.rs 注释——与 other.rs（sysinfo 实现）一一对应。
use serde_json::json;
use std::sync::Arc;
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

// CPU：两次采样（间隔 200ms）求差值。
// 扩展 8 字段口径（shell 版已弃用，不再对齐其 4 字段简化算法）——
// total = user+nice+system+idle+iowait+irq+softirq+steal（guest/guest_nice 内核已计入 user/nice，
// 不重复累加）；usage = (total - idle) / total，iowait/irq/softirq/steal 计入忙碌，
// 高 iowait（磁盘/网络慢）与云主机 steal 被抢占时读数不再偏低
pub async fn collect_cpu() -> f64 {
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

// 内存/swap：/proc/meminfo（返回 used, total, swap_used, swap_total）
pub fn collect_mem() -> (u64, u64, u64, u64) {
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
        st * 1024,
    ) // used, total, swap_used, swap_total
}

// 负载 / 进程数 / 开机时间
pub fn collect_load() -> (f64, f64, f64, u64, u64) {
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
pub fn collect_temp() -> Option<f64> {
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
// IPv4 + IPv6 合计（仅读 tcp/udp 会让 IPv6-only 主机连接数恒为 0；
// 文件不存在（老内核）时 count_lines 返回 0，天然兼容）
// 阻塞读取放 blocking 线程：50 万连接时 /proc/net/tcp 是几十 MB 文本（BufReader 流式
// 计数已避免物化整串，但同步 read 仍会占住 async worker 几十 ms~秒级）
pub async fn collect_conns() -> (u64, u64) {
    crate::blocking::run_blocking(5, || {
        (
            count_lines("/proc/net/tcp") + count_lines("/proc/net/tcp6"),
            count_lines("/proc/net/udp") + count_lines("/proc/net/udp6"),
        )
    })
    .await
    .unwrap_or((0, 0))
}

// 磁盘结果缓存：df 结果 60s 内复用；超时/失败返回上次成功值（熔断降级，不空转重试）
type DiskCache = tokio::sync::Mutex<Option<(std::time::Instant, Vec<serde_json::Value>)>>;
static DISK_CACHE: std::sync::OnceLock<DiskCache> = std::sync::OnceLock::new();
async fn disk_cache()
-> tokio::sync::MutexGuard<'static, Option<(std::time::Instant, Vec<serde_json::Value>)>> {
    DISK_CACHE
        .get_or_init(|| tokio::sync::Mutex::new(None))
        .lock()
        .await
}

fn preserve_nonempty_disk_cache(
    old: Option<Vec<serde_json::Value>>,
    fresh: Vec<serde_json::Value>,
) -> Vec<serde_json::Value> {
    if fresh.is_empty() {
        old.filter(|value| !value.is_empty()).unwrap_or_default()
    } else {
        fresh
    }
}

// 磁盘：statvfs + /proc/mounts（无外部命令依赖，替代 df -Pkl——busybox 精简版/
// 最小镜像无 df 或参数缺失）。保留 spawn_blocking + 5s 超时：挂死的 NFS 挂载点上
// statvfs 同样会阻塞，与 df 行为等价；60s 缓存 + 失败真熔断逻辑不变。
// 统一走 blocking.rs 信号量（此前裸 spawn_blocking 不占信号量，与注释「峰值 2<4」不符）
// include：DISK_FSTYPE_INCLUDE 强制保留的 fstype 列表（默认排除的网络盘可借此计入统计）
pub async fn collect_disk(include: &[String]) -> Vec<serde_json::Value> {
    let now = std::time::Instant::now();
    if let Some((ts, disk)) = disk_cache().await.as_ref()
        && now.duration_since(*ts).as_secs() < 60
    {
        return disk.clone(); // 60s 缓存命中（快采 5s → 12 帧只跑一次）
    }
    let include = include.to_vec(); // spawn_blocking 需 'static
    let out = crate::blocking::run_blocking(5, move || disk_usage_static(&include)).await;
    match out {
        Some(Ok(disk)) if !disk.is_empty() => {
            *disk_cache().await = Some((now, disk.clone())); // 成功且非空：更新缓存
            disk
        }
        Some(Ok(disk)) => {
            // 全部挂载点瞬时不可读时不能用空结果覆盖曾经的非空成功值；刷新时间戳形成
            // 60s 熔断，保留旧数据显示。确实从未采到磁盘时才缓存空值。
            let mut c = disk_cache().await;
            let old = c.as_ref().map(|(_, value)| value.clone());
            let value = preserve_nonempty_disk_cache(old, disk);
            *c = Some((now, value.clone()));
            value
        }
        _ => {
            // 失败/超时：真熔断——刷新时间戳，后续 60s 内直接返回旧值/空值不重试；
            // 无旧值也写空缓存（开机即挂死 NFS 场景下避免每帧重跑挂 5s）
            let mut c = disk_cache().await;
            let old = c.as_ref().map(|(_, v)| v.clone());
            *c = Some((now, old.clone().unwrap_or_default()));
            old.unwrap_or_default()
        }
    }
}

// statvfs 读取：遍历 /proc/mounts，伪文件系统过滤（proc/sysfs/cgroup 等），
// 设备去重（同一设备 bind mount 不重复计数，dev 为空/无意义时退回按挂载点去重）。
// 统计口径向"真实磁盘分区"看齐——默认排除：
//   1) 虚拟/内存文件系统：tmpfs/ramfs/rootfs 容量是内存比例、overlay 是宿主盘容量、squashfs 只读镜像、
//      drvfs/9p 是跨系统共享盘——计入会把内存/远程容量混进磁盘 total，稀释使用率
//   2) 网络文件系统：nfs*/fuse.*（rclone/sshfs 等）统计的是远程配额，不是本机磁盘
//      （fuseblk 即 NTFS 外接数据盘是真实分区，保留）
// DISK_FSTYPE_INCLUDE（include 参数）可强制保留上述默认排除的类型（如 fuse.rclone 的 OneDrive）
fn disk_usage_static(include: &[String]) -> Result<Vec<serde_json::Value>, ()> {
    let mounts = std::fs::read_to_string("/proc/mounts").map_err(|_| ())?;
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for line in mounts.lines() {
        let mut it = line.split_whitespace();
        let dev = it.next().unwrap_or("");
        let mount = it.next().unwrap_or("");
        let fstype = it.next().unwrap_or("");
        if !mount.starts_with('/') {
            continue; // 非绝对路径跳过
        }
        // 设备去重：同一设备多挂载（bind/子目录挂载）只保留首个，避免容量重复统计；
        // dev 为空或 "none" 时无设备语义，退回按挂载点去重
        let key = if dev.is_empty() || dev == "none" {
            mount.to_string()
        } else {
            dev.to_string()
        };
        if seen.contains(&key) {
            continue;
        }
        // 伪文件系统 / 虚拟内存盘 / 网络盘默认跳过；DISK_FSTYPE_INCLUDE 显式保留优先
        if disk_excluded(fstype, include) {
            continue;
        }
        // 目录检查：容器会把 /etc/hosts、/etc/hostname、/etc/resolv.conf 等文件做成 bind mount，
        // 与根盘同 dev 同 fstype——设备去重拦不住，statvfs 对文件也成功（返回绑定源 FS 统计），
        // 会把它误当"数据盘挂载点"显示根盘容量。文件型 bind mount 直接跳过。
        let Ok(md) = std::fs::metadata(mount) else {
            continue; // 单个过期 NFS/autofs/权限异常挂载点不应拖垮整份磁盘列表
        };
        if !md.is_dir() {
            continue;
        }
        let c_path = std::ffi::CString::new(mount.as_bytes()).map_err(|_| ())?;
        let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statvfs(c_path.as_ptr(), &mut st) } != 0 {
            continue; // statvfs 失败（权限/挂死点异常）跳过该挂载点
        }
        let frsize = if st.f_frsize > 0 {
            st.f_frsize as u64
        } else {
            1
        };
        // total 直接用 f_blocks（与 df 的 Size 列一致）：used = f_blocks - f_bfree（含 root 保留块的
        // 已用口径）；f_bavail 不含保留块，若 total = used + avail 会少算保留块（ext4 默认 5%）
        let total = st.f_blocks as u64 * frsize;
        let used = st.f_blocks.saturating_sub(st.f_bfree) as u64 * frsize;
        seen.insert(key); // 只有成功采集后才去重，同设备后续挂载仍可作为失败兜底
        // 上报 used/total（字节），百分比由前端计算——信息无损的完备表示（u 为派生值不再传输）
        out.push(json!({ "m": mount, "used": used, "total": total }));
    }
    Ok(out)
}

// 磁盘统计过滤判断：伪文件系统 / 虚拟内存盘（tmpfs/ramfs/overlay/squashfs/drvfs/9p）/
// 网络盘（nfs*/cifs/smbfs/fuse.*）默认排除；include 中显式列出的 fstype 强制保留。
// fuseblk（NTFS 外接数据盘，走 fuse 驱动）是真实分区，不排除
fn disk_excluded(fstype: &str, include: &[String]) -> bool {
    if include.iter().any(|s| s == fstype) {
        return false;
    }
    const FAKE: &[&str] = &[
        "proc",
        "sysfs",
        "devpts",
        "devtmpfs",
        "cgroup",
        "cgroup2",
        "pstore",
        "securityfs",
        "debugfs",
        "tracefs",
        "fusectl",
        "configfs",
        "mqueue",
        "binfmt_misc",
        "hugetlbfs",
        "autofs",
        "rpc_pipefs",
        "nsfs",
        "bpf",
    ];
    const VIRT: &[&str] = &[
        "tmpfs", "ramfs", "overlay", "squashfs", "drvfs", "9p", "rootfs",
    ];
    const NET: &[&str] = &["nfs", "nfs4", "cifs", "smbfs", "fuse"];
    FAKE.contains(&fstype)
        || VIRT.contains(&fstype)
        || NET.contains(&fstype)
        || fstype.starts_with("fuse.")
}

// 网络速率：/proc/net/dev 累计差分（字节/秒）。
// lo/tun/tap 仅匹配精确名称或数字后缀（lo0/tun0/tap1），避免误杀 logical0、tunnel0、tap-water；
// 其余前缀是 Linux 明确的虚拟接口命名族（如 vethXXXX、docker_gwbridge），继续按前缀过滤。
fn is_virtual_iface(name: &str) -> bool {
    const NUMBERED_PREFIXES: &[&str] = &["lo", "tun", "tap"];
    const VIRT_PREFIXES: &[&str] = &[
        "docker", "veth", "br-", "virbr", "tunl", "vxlan", "gretap", "ip6tnl", "sit", "dummy",
        "vnet",
    ];
    NUMBERED_PREFIXES.iter().any(|p| {
        name.strip_prefix(p)
            .is_some_and(|suffix| suffix.is_empty() || suffix.bytes().all(|b| b.is_ascii_digit()))
    }) || VIRT_PREFIXES.iter().any(|p| name.starts_with(p))
}
pub async fn collect_net() -> (u64, u64) {
    let mut rx = 0u64;
    let mut tx = 0u64;
    if let Some(text) = read_file("/proc/net/dev") {
        for line in text.lines().skip(2) {
            let mut it = line.split_whitespace();
            let iface = it.next().unwrap_or("").trim_end_matches(':');
            if iface.is_empty() || is_virtual_iface(iface) {
                continue;
            }
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

// ---- 磁盘 IO：/sys/block/<dev>/stat 累计计数器差分（与网络速率同模式）----
// stat 字段（无 major/minor/name 前 3 列，索引 0 起）：
//   0 reads  2 sectors_read  3 time_reading(ms)  4 writes  6 sectors_written
//   7 time_writing(ms)  9 time_doing_io(ms)
// /sys/block 只列整盘（分区在子目录），天然避开分区重复计数；
// 虚拟设备（ram/loop/dm 等）跳过，仅真实磁盘求和
struct DiskIoState {
    reads: u64,
    writes: u64,
    r_sectors: u64,
    w_sectors: u64,
    t_io_ms: u64,
    ts: u64,
}
static DISK_IO: std::sync::OnceLock<tokio::sync::Mutex<Option<DiskIoState>>> =
    std::sync::OnceLock::new();
async fn disk_io_state() -> tokio::sync::MutexGuard<'static, Option<DiskIoState>> {
    DISK_IO
        .get_or_init(|| tokio::sync::Mutex::new(None))
        .lock()
        .await
}

fn is_virtual_disk(name: &str) -> bool {
    const VIRT_PREFIXES: &[&str] = &[
        "ram", "loop", "fd", "dm-", "md", "sr", "nbd", "zram", "drbd",
    ];
    VIRT_PREFIXES.iter().any(|p| name.starts_with(p))
}

// 汇总全部真实整盘累计值（无真实盘时全 0）
fn read_disk_io_totals() -> (u64, u64, u64, u64, u64) {
    let mut reads = 0u64;
    let mut writes = 0u64;
    let mut r_sectors = 0u64;
    let mut w_sectors = 0u64;
    let mut t_io_ms = 0u64;
    if let Ok(entries) = std::fs::read_dir("/sys/block") {
        for ent in entries.flatten() {
            let name = ent.file_name().to_string_lossy().to_string();
            if is_virtual_disk(&name) {
                continue;
            }
            if let Some(text) = read_file(&format!("/sys/block/{}/stat", name)) {
                let f: Vec<u64> = text
                    .split_whitespace()
                    .filter_map(|v| v.parse().ok())
                    .collect();
                if f.len() >= 10 {
                    reads += f[0];
                    r_sectors += f[2];
                    writes += f[4];
                    w_sectors += f[6];
                    t_io_ms += f[9];
                }
            }
        }
    }
    (reads, writes, r_sectors, w_sectors, t_io_ms)
}

// 差分计算（纯函数便于测试）：dt=0 或无数据时返回空对象（首帧无历史，返回 {} 由白名单丢弃）
fn disk_io_diff(prev: &DiskIoState, cur: &DiskIoState) -> serde_json::Value {
    let dt = cur.ts.saturating_sub(prev.ts);
    if dt == 0 {
        return json!({});
    }
    let kb = |sectors: u64, base: u64| {
        ((sectors.saturating_sub(base)) as f64 * 512.0 / dt as f64 / 1024.0 * 10.0).round() / 10.0
    };
    let iops = |cnt: u64, base: u64| ((cnt.saturating_sub(base)) as f64 / dt as f64).round();
    // util%：Δtime_doing_io / Δt × 100；多盘并行求和可能超 100%，clamp
    let util = ((cur.t_io_ms.saturating_sub(prev.t_io_ms)) as f64 / (dt as f64 * 1000.0) * 100.0)
        .clamp(0.0, 100.0);
    json!({
        "read_kbs": kb(cur.r_sectors, prev.r_sectors),
        "write_kbs": kb(cur.w_sectors, prev.w_sectors),
        "r_iops": iops(cur.reads, prev.reads),
        "w_iops": iops(cur.writes, prev.writes),
        "util_pct": (util * 10.0).round() / 10.0,
    })
}

pub async fn collect_disk_io() -> serde_json::Value {
    let (reads, writes, r_sectors, w_sectors, t_io_ms) = read_disk_io_totals();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let cur = DiskIoState {
        reads,
        writes,
        r_sectors,
        w_sectors,
        t_io_ms,
        ts: now,
    };
    let mut guard = disk_io_state().await;
    let out = match guard.as_ref() {
        Some(prev) => disk_io_diff(prev, &cur),
        None => json!({}),
    };
    *guard = Some(cur);
    out
}

// 系统信息缓存：OS/内核/IP 基本不变，10min 内复用（快采不再每帧 fork uname/hostname）
type InfoCache = tokio::sync::Mutex<Option<(std::time::Instant, serde_json::Value)>>;
static INFO_CACHE: std::sync::OnceLock<InfoCache> = std::sync::OnceLock::new();
async fn info_cache()
-> tokio::sync::MutexGuard<'static, Option<(std::time::Instant, serde_json::Value)>> {
    INFO_CACHE
        .get_or_init(|| tokio::sync::Mutex::new(None))
        .lock()
        .await
}

// 系统信息：OS / 内核 / IP / agent 版本（uname/hostname 放线程池+超时）
pub async fn collect_info() -> serde_json::Value {
    let now = std::time::Instant::now();
    if let Some((ts, v)) = info_cache().await.as_ref()
        && now.duration_since(*ts).as_secs() < 600
    {
        return v.clone(); // 10min 缓存命中
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
    let kern =
        crate::blocking::run_blocking(5, || std::process::Command::new("uname").arg("-r").output())
            .await
            .and_then(|r| r.ok())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
    // hostname -I 在 busybox/精简镜像不支持 → 依次回退 `ip -o addr show scope global`
    // （busybox ip 可用，不限 -4：v4/v6 一次取齐，精简镜像上否则永远无 IPv6）与裸
    // `hostname`（单值）；ip 输出解析为 IP 列表（去掉 /prefix）
    let host = crate::blocking::run_blocking(5, || {
        if let Ok(o) = std::process::Command::new("hostname").arg("-I").output()
            && o.status.success()
        {
            return String::from_utf8_lossy(&o.stdout).trim().to_string();
        }
        if let Ok(o) = std::process::Command::new("ip")
            .args(["-o", "addr", "show", "scope", "global"])
            .output()
            && o.status.success()
        {
            let ips: Vec<String> = String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter_map(|l| {
                    // 格式: "2: eth0    inet 1.2.3.4/24 brd ... scope global eth0"
                    let mut it = l.split_whitespace();
                    let _ = it.next(); // "2:"
                    let _ = it.next(); // "eth0"
                    let _ = it.next(); // "inet"
                    it.next()
                        .map(|addr| addr.split('/').next().unwrap_or("").to_string())
                })
                .collect();
            return ips.join(" ");
        }
        std::process::Command::new("hostname")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default()
    })
    .await
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
    let val = json!({
        "os": os,
        "kern": kern,
        "ip4": ip4,
        "ip6": ip6,
        "agent_version": crate::VERSION,
        "agent_platform": crate::update::platform_key(),
        "update_protocol": crate::update::UPDATE_PROTOCOL,
        "self_update_enabled": crate::CONFIG.get().map(|c| c.allow_self_update).unwrap_or(false),
        "self_update_mode": crate::CONFIG.get().map(|c| if !c.allow_self_update { "disabled" } else if c.self_restart_after_update { "self" } else { "supervisor" }).unwrap_or("disabled"),
    });
    // uname/hostname 全空（采集超时/失败）不缓存：避免空结果（IP 字段空显）被缓存 10 分钟
    if !kern.is_empty() || !host.is_empty() {
        *info_cache().await = Some((now, val.clone()));
    }
    val
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collect_mem_parses() {
        let (used, total, swap_used, swap_total) = collect_mem();
        assert!(total > 0, "MemTotal 应可读");
        assert!(used <= total, "已用不超过总量");
        assert!(swap_used <= swap_total, "swap 已用不超过总量");
    }

    #[test]
    fn collect_load_parses() {
        let (l1, l5, l15, procs, uptime) = collect_load();
        assert!(l1 >= 0.0 && l5 >= 0.0 && l15 >= 0.0);
        assert!(uptime > 0, "uptime 应可读");
        assert!(procs > 0);
    }

    #[tokio::test]
    async fn collect_conns_parses() {
        let (tcp, udp) = collect_conns().await;
        assert!(tcp > 0, "/proc/net/tcp 应可读");
        assert!(udp > 0);
    }

    #[test]
    fn is_virtual_iface_avoids_broad_short_prefixes() {
        assert!(is_virtual_iface("lo"));
        assert!(is_virtual_iface("lo0"));
        assert!(is_virtual_iface("tun0"));
        assert!(is_virtual_iface("tap12"));
        assert!(is_virtual_iface("tunl0"));
        assert!(is_virtual_iface("vethabcd"));
        assert!(is_virtual_iface("docker_gwbridge"));
        assert!(!is_virtual_iface("logical0"));
        assert!(!is_virtual_iface("tunnel0"));
        assert!(!is_virtual_iface("tap-water"));
        assert!(!is_virtual_iface("eth0"));
    }

    #[test]
    fn is_virtual_disk_filters_ram_loop() {
        assert!(is_virtual_disk("ram0"));
        assert!(is_virtual_disk("loop7"));
        assert!(is_virtual_disk("dm-0"));
        assert!(is_virtual_disk("md0"));
        assert!(is_virtual_disk("sr0"));
        assert!(is_virtual_disk("zram0"));
        // 真实盘保留
        assert!(!is_virtual_disk("sda"));
        assert!(!is_virtual_disk("nvme0n1"));
        assert!(!is_virtual_disk("vda"));
        assert!(!is_virtual_disk("mmcblk0"));
    }

    #[test]
    fn disk_io_diff_computes_rates() {
        let prev = DiskIoState {
            reads: 100,
            writes: 50,
            r_sectors: 1000, // 1000 扇区 × 512 = 500KB
            w_sectors: 500,  // 250KB
            t_io_ms: 0,
            ts: 1000,
        };
        let cur = DiskIoState {
            reads: 130,      // 30 次 / 10s = 3 IOPS
            writes: 70,      // 20 次 / 10s = 2 IOPS
            r_sectors: 2000, // 500KB / 10s = 50 KB/s
            w_sectors: 1000, // 250KB / 10s = 25 KB/s
            t_io_ms: 5000,   // 5s / 10s = 50%
            ts: 1010,
        };
        let v = disk_io_diff(&prev, &cur);
        assert_eq!(v["read_kbs"], 50.0);
        assert_eq!(v["write_kbs"], 25.0);
        assert_eq!(v["r_iops"], 3.0);
        assert_eq!(v["w_iops"], 2.0);
        assert_eq!(v["util_pct"], 50.0);
        // dt=0 空对象（首帧语义）
        assert_eq!(
            disk_io_diff(&cur, &DiskIoState { ts: 1010, ..cur }),
            json!({})
        );
    }

    #[test]
    fn empty_disk_refresh_preserves_previous_nonempty_value() {
        let old = vec![json!({ "m": "/", "used": 1, "total": 2 })];
        assert_eq!(preserve_nonempty_disk_cache(Some(old.clone()), vec![]), old);
        assert!(preserve_nonempty_disk_cache(None, vec![]).is_empty());
        let fresh = vec![json!({ "m": "/data", "used": 3, "total": 4 })];
        assert_eq!(
            preserve_nonempty_disk_cache(Some(old), fresh.clone()),
            fresh,
            "非空新值正常替换旧缓存"
        );
    }

    #[test]
    fn disk_excluded_filters_virtual_and_network() {
        let empty: Vec<String> = vec![];
        // 真实磁盘分区保留
        assert!(!disk_excluded("ext4", &empty));
        assert!(!disk_excluded("xfs", &empty));
        assert!(!disk_excluded("btrfs", &empty));
        assert!(!disk_excluded("vfat", &empty));
        assert!(!disk_excluded("fuseblk", &empty)); // NTFS 外接盘是真实分区
        // 伪文件系统 / 虚拟内存盘 / 网络盘排除
        assert!(disk_excluded("proc", &empty));
        assert!(disk_excluded("tmpfs", &empty));
        assert!(disk_excluded("ramfs", &empty));
        assert!(disk_excluded("overlay", &empty));
        assert!(disk_excluded("rootfs", &empty)); // WSL /init 是内核内存 FS
        assert!(disk_excluded("squashfs", &empty));
        assert!(disk_excluded("drvfs", &empty));
        assert!(disk_excluded("9p", &empty));
        assert!(disk_excluded("nfs", &empty));
        assert!(disk_excluded("nfs4", &empty));
        assert!(disk_excluded("cifs", &empty));
        assert!(disk_excluded("fuse", &empty));
        assert!(disk_excluded("fuse.rclone", &empty));
        assert!(disk_excluded("fuse.sshfs", &empty));
    }

    #[test]
    fn disk_excluded_include_overrides() {
        // DISK_FSTYPE_INCLUDE 显式保留优先于默认排除
        let inc = vec!["fuse.rclone".to_string(), "tmpfs".to_string()];
        assert!(!disk_excluded("fuse.rclone", &inc)); // OneDrive 挂载点计入统计
        assert!(!disk_excluded("tmpfs", &inc));
        assert!(disk_excluded("nfs", &inc)); // 未列出的网络盘仍排除
        // include 是精确匹配：fuse.sshfs 不会被 fuse.rclone 放行
        assert!(disk_excluded("fuse.sshfs", &inc));
    }
}
