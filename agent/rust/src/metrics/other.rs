// 非 Linux 平台（Windows/macOS）系统指标采集：sysinfo crate 实现。
// 函数集签名与 linux.rs 一一对应（见 imp.rs 注释）。
// 能力边界（与 Linux 实现的差异，如实标注）：
//   - 磁盘 IO 差分：sysinfo 无此数据 → 恒返回 {}（服务端白名单丢弃，前端不显示该图）
//   - TCP/UDP 连接数：无跨平台 API → 恒 (0,0)
//   - 负载：macOS 有（sysinfo load_average）；Windows 无此概念 → 0
//   - 温度：sysinfo Components（Windows 多数驱动不暴露 → None；macOS M 系列有 SoC 温度）
//   - info.ip4/ip6：Windows 解析 ipconfig 输出（跨 locale：IPv4 点分格式可识别）；
//     macOS 暂空（卡片展示走服务端 wan_ip——CF-Connecting-IP，平台无关）
use serde_json::json;
use std::sync::Arc;
use sysinfo::{Disks, Networks, System};

// CPU：两次刷新（间隔 sysinfo 最小间隔，Windows/macOS 实现内部同样要求 ≥200ms）
// 求使用率。global_cpu_usage 为自上次刷新以来的均值，与 Linux 版「区间均值」口径一致
pub async fn collect_cpu() -> f64 {
    let mut sys = System::new();
    sys.refresh_cpu_usage();
    tokio::time::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL).await;
    sys.refresh_cpu_usage();
    f64::from(sys.global_cpu_usage()).clamp(0.0, 100.0)
}

// 内存/swap（字节）：used = total - available（与 Linux 版「MemTotal-MemAvailable」口径一致）
pub fn collect_mem() -> (u64, u64, u64, u64) {
    let mut sys = System::new();
    sys.refresh_memory();
    (
        sys.used_memory(),
        sys.total_memory(),
        sys.used_swap(),
        sys.total_swap(),
    )
}

// 负载 / 进程数 / 开机时间。load_average 在 Windows 未实现（返回 0，与「无此概念」一致）；
// 进程数需全量快照——Windows CreateToolhelp32Snapshot ~5-30ms（5s 上报周期下占比可忽略，
// 内联同步；macOS sysctl KERN_PROC ~1ms）
pub fn collect_load() -> (f64, f64, f64, u64, u64) {
    let la = System::load_average();
    let mut sys = System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, false);
    (
        la.one,
        la.five,
        la.fifteen,
        sys.processes().len() as u64,
        System::uptime(),
    )
}

// 温度：第一个有效热区（℃）。Windows 多数机器驱动不暴露 → None；macOS M 系列有 SoC 温度
pub fn collect_temp() -> Option<f64> {
    let components = sysinfo::Components::new_with_refreshed_list();
    for c in components.list() {
        // 0.33 的 temperature() 返回 Option（部分组件无读数）；过滤无效值（0/负数/>120℃）
        if let Some(t) = c.temperature()
            && t > 0.0
            && t < 120.0
        {
            return Some(f64::from(t));
        }
    }
    None
}

// TCP/UDP 连接数：无跨平台 API（Linux 走 /proc/net/tcp）→ (0, 0)
pub async fn collect_conns() -> (u64, u64) {
    (0, 0)
}

// 磁盘结果缓存：60s 复用（挂载列表基本不变；与 Linux 版节流口径一致）
type DiskCache = tokio::sync::Mutex<Option<(std::time::Instant, Vec<serde_json::Value>)>>;
static DISK_CACHE: std::sync::OnceLock<DiskCache> = std::sync::OnceLock::new();
async fn disk_cache()
-> tokio::sync::MutexGuard<'static, Option<(std::time::Instant, Vec<serde_json::Value>)>> {
    DISK_CACHE
        .get_or_init(|| tokio::sync::Mutex::new(None))
        .lock()
        .await
}

// 磁盘：sysinfo Disks（Windows 卷 / macOS 卷）。used = total - available（available 为
// 当前用户可用；Windows 无 root 保留块概念，与 Linux 口径差异可忽略）。
// include 参数（DISK_FSTYPE_INCLUDE）为 Linux 专用过滤，此处忽略
pub async fn collect_disk(_include: &[String]) -> Vec<serde_json::Value> {
    let now = std::time::Instant::now();
    if let Some((ts, disk)) = disk_cache().await.as_ref()
        && now.duration_since(*ts).as_secs() < 60
    {
        return disk.clone(); // 60s 缓存命中
    }
    // 枚举放 blocking 线程（与 Linux 版对挂死 NFS 的防御同构）：Windows 上指向
    // 已断开网络驱动器的卷、macOS 上挂起的外置盘，GetDiskFreeSpaceEx/statfs 可阻塞秒级
    let out = crate::blocking::run_blocking(5, disk_snapshot).await;
    match out {
        Some(v) => {
            *disk_cache().await = Some((now, v.clone())); // 成功：更新缓存
            v
        }
        None => {
            // 超时：保留旧值并刷新时间戳（与 Linux 版熔断语义对齐——否则一次超时把缓存
            // 刷成空数组，断开的网络驱动器场景下 60s 内磁盘信息周期性闪空）
            let mut c = disk_cache().await;
            let old = c.as_ref().map(|(_, v)| v.clone());
            *c = Some((now, old.clone().unwrap_or_default()));
            old.unwrap_or_default()
        }
    }
}

fn disk_snapshot() -> Vec<serde_json::Value> {
    let disks = Disks::new_with_refreshed_list();
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for d in disks.list() {
        let mount = d.mount_point().to_string_lossy().into_owned();
        // 挂载点去重（同一卷多挂载点只计一次，与 Linux 版设备去重语义对齐）
        if !seen.insert(mount.clone()) {
            continue;
        }
        let total = d.total_space();
        let available = d.available_space();
        if total == 0 {
            continue; // 无容量的虚拟卷跳过
        }
        let used = total.saturating_sub(available);
        out.push(json!({ "m": mount, "used": used, "total": total }));
    }
    out
}

// 磁盘 IO：sysinfo 无该数据 → 恒空对象（首帧语义，服务端白名单丢弃）
pub async fn collect_disk_io() -> serde_json::Value {
    json!({})
}

// 网络速率差分状态（与 Linux 版同模式：累计值差分 / 秒）
struct NetState {
    rx: u64,
    tx: u64,
    ts: u64,
}
static NET: std::sync::OnceLock<Arc<tokio::sync::Mutex<Option<NetState>>>> =
    std::sync::OnceLock::new();

// 虚拟网卡过滤：按接口名前缀/关键字（Windows 接口是友好名「以太网/Loopback…」，
// macOS 是 en0/lo0/bridge*/utun*——跨平台合并一张表，误杀/漏杀个别命名影响极小）
fn is_virtual_iface(name: &str) -> bool {
    let lower = name.to_lowercase();
    const VIRT_KEYWORDS: &[&str] = &[
        "loopback",
        "isatap",
        "teredo",
        "6to4",
        "hyper-v",
        "v ethernet",
        "vmware",
        "virtual",
        "vpn",
        "bluetooth",
        "awdl",
        "llw",
        "anpi",
        "bridge",
        "utun",
        "vmnet",
        "veth",
        "docker",
        "br-",
        "virbr",
        "tun",
        "tap",
        "vxlan",
        "gretap",
        "dummy",
        "vnet",
    ];
    lower == "lo" || VIRT_KEYWORDS.iter().any(|k| lower.contains(k))
}

pub async fn collect_net() -> (u64, u64) {
    let mut rx = 0u64;
    let mut tx = 0u64;
    {
        let nets = NETS
            .get_or_init(|| std::sync::Mutex::new(Networks::new_with_refreshed_list()))
            .lock();
        if let Ok(mut nets) = nets {
            nets.refresh(true);
            for (name, data) in nets.iter() {
                if is_virtual_iface(name) {
                    continue;
                }
                // 必须用 total_*（自系统启动的累计值）参与差分：received() 是「自上次
                // refresh 的增量」——对增量再做二次差分得到的是增量的变化率（稳定流量下
                // 恒 0，突增时虚高尖峰），与 Linux 版 /proc/net/dev 的累计值口径不符
                rx += data.total_received();
                tx += data.total_transmitted();
            }
        }
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let st = NET
        .get_or_init(|| Arc::new(tokio::sync::Mutex::new(None)))
        .clone();
    let mut guard = st.lock().await;
    let (in_rate, out_rate) = match guard.as_ref() {
        Some(prev) if prev.ts > 0 && now > prev.ts => {
            let dt = now - prev.ts;
            (
                rx.saturating_sub(prev.rx) / dt,
                tx.saturating_sub(prev.tx) / dt,
            )
        }
        _ => (0, 0),
    };
    *guard = Some(NetState { rx, tx, ts: now });
    (in_rate, out_rate)
}
static NETS: std::sync::OnceLock<std::sync::Mutex<Networks>> = std::sync::OnceLock::new();

// 系统信息缓存：OS/内核/IP 基本不变，10min 复用（与 Linux 版口径一致）
type InfoCache = tokio::sync::Mutex<Option<(std::time::Instant, serde_json::Value)>>;
static INFO_CACHE: std::sync::OnceLock<InfoCache> = std::sync::OnceLock::new();
async fn info_cache()
-> tokio::sync::MutexGuard<'static, Option<(std::time::Instant, serde_json::Value)>> {
    INFO_CACHE
        .get_or_init(|| tokio::sync::Mutex::new(None))
        .lock()
        .await
}

// 系统信息：sysinfo 静态信息（name/os_version/kernel_version，零命令调用）+
// Windows 经 ipconfig 解析 IP（跨 locale：IPv4 点分十进制全局可识别；GBK 输出下
// ASCII 数字与点仍无损）。macOS IP 暂空（卡片展示走服务端 wan_ip，平台无关）
pub async fn collect_info() -> serde_json::Value {
    let now = std::time::Instant::now();
    if let Some((ts, v)) = info_cache().await.as_ref()
        && now.duration_since(*ts).as_secs() < 600
    {
        return v.clone(); // 10min 缓存命中
    }
    let os = match (System::name(), System::os_version()) {
        (Some(n), Some(v)) => format!("{n} {v}"),
        (Some(n), None) => n,
        _ => std::env::consts::OS.to_string(),
    };
    let kern = System::kernel_version().unwrap_or_default();
    let (ip4, ip6) = collect_ips().await;
    let val = json!({
        "os": os,
        "kern": kern,
        "ip4": ip4,
        "ip6": ip6,
        "agent_version": crate::VERSION,
    });
    // 全空（采集失败）不缓存：避免空结果被缓存 10 分钟
    if !kern.is_empty() || !ip4.is_empty() {
        *info_cache().await = Some((now, val.clone()));
    }
    val
}

// 平台 IP 采集：Windows 跑 ipconfig 解析；macOS 返回空（保留扩展位）
async fn collect_ips() -> (String, String) {
    #[cfg(windows)]
    {
        let out =
            crate::blocking::run_blocking(5, || std::process::Command::new("ipconfig").output())
                .await
                .and_then(|r| r.ok())
                .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
                .unwrap_or_default();
        let mut ip4 = String::new();
        let mut ip6 = String::new();
        for tok in out.split_whitespace() {
            let tok = tok.trim_end_matches('.');
            let is_v4 = {
                let parts: Vec<&str> = tok.split('.').collect();
                parts.len() == 4
                    && parts
                        .iter()
                        .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
            };
            if is_v4 {
                if ip4.is_empty() && !tok.starts_with("127.") && !tok.starts_with("169.254.") {
                    ip4 = tok.to_string();
                }
            } else if tok.contains(':')
                && tok.len() >= 2
                && tok.chars().all(|c| c.is_ascii_hexdigit() || c == ':')
            {
                let lower = tok.to_lowercase();
                if ip6.is_empty() && lower != "::1" && !lower.starts_with("fe80:") {
                    ip6 = tok.to_string();
                }
            }
        }
        (ip4, ip6)
    }
    #[cfg(not(windows))]
    {
        (String::new(), String::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collect_mem_parses() {
        let (used, total, _, _) = collect_mem();
        assert!(total > 0, "总内存应可读");
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
    fn is_virtual_iface_filters_common() {
        assert!(is_virtual_iface("lo"));
        assert!(is_virtual_iface("Loopback Pseudo-Interface 1"));
        assert!(is_virtual_iface("utun3"));
        assert!(is_virtual_iface("bridge100"));
        // 物理接口保留
        assert!(!is_virtual_iface("en0"));
        assert!(!is_virtual_iface("以太网"));
        assert!(!is_virtual_iface("Ethernet"));
    }

    #[tokio::test]
    async fn collect_disk_returns_mounts() {
        let disks = collect_disk(&[]).await;
        // 至少有系统盘；字段结构 {m, used, total}
        assert!(!disks.is_empty(), "应至少枚举到一个卷");
        for d in &disks {
            assert!(d["m"].is_string());
            assert!(d["total"].as_u64().unwrap_or(0) > 0);
        }
    }
}
