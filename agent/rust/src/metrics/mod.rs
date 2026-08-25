// 监控采集：探活 + 自定义指标 + 汇总上报（跨平台共享层）
// 系统指标按平台分实现：Linux 走原生 /proc、/sys（metrics/linux.rs，与 agent.sh 同口径）；
// Windows/macOS 走 sysinfo crate（metrics/other.rs）——两套实现导出同名函数集，
// 经下方 cfg 选择 + pub use 对 collect_report 透明（汇总层零平台分支）。
// blocking 调用统一走 crate::blocking（超时 + 信号量 + 文件操作熔断）。
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::*;
#[cfg(not(target_os = "linux"))]
mod other;
#[cfg(not(target_os = "linux"))]
pub use other::*;

use crate::Config;
use futures_util::future::join_all;
use serde_json::json;
use std::net::SocketAddr;
use std::time::Instant;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::Duration;

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
    // 修复 http://域名/ 探活永远 DOWN（此前仅 IP 字面量，域名场景持续误告警）。
    // DNS 解析必须纳入 timeout 作用域：glibc resolver 默认 5s×2 次，DNS 故障时
    // 每个探活额外多挂 10s+ 且无上界（timeout 只包 connect+请求的旧实现形同虚设）
    let addr: SocketAddr = match format!("{host}:{port}").parse() {
        Ok(a) => a,
        Err(_) => {
            match tokio::time::timeout(
                Duration::from_secs(timeout_secs),
                tokio::net::lookup_host((host.as_str(), port)),
            )
            .await
            {
                Ok(Ok(mut it)) => match it.next() {
                    Some(a) => a,
                    None => return None,
                },
                _ => return None,
            }
        }
    };
    let t0 = Instant::now();
    let fut = async {
        let mut conn = TcpStream::connect(addr).await.ok()?;
        let req = format!(
            "GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nUser-Agent: cf-panel-agent\r\n\r\n"
        );
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
    // DNS 解析纳入 timeout 作用域（与 http_probe 同理，防 glibc resolver 无上界挂起）
    let addr: SocketAddr = match target.parse() {
        Ok(a) => a,
        Err(_) => match target.rsplit_once(':') {
            Some((h, p)) if p.parse::<u16>().is_ok() => {
                let p = p.parse().unwrap();
                match tokio::time::timeout(
                    Duration::from_secs(timeout_secs),
                    tokio::net::lookup_host((h, p)),
                )
                .await
                {
                    Ok(Ok(mut it)) => match it.next() {
                        Some(a) => a,
                        None => return false,
                    },
                    _ => return false,
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

// 探活并行执行（join_all）：串行旧实现 N 个探活最坏 5N 秒（http 5s 超时 ×N），
// 5 个探活 + 3 个自定义指标最坏 40s，直接绑架 report_loop 帧率（快采 5s 承诺失效）；
// 并行后总时长 = max(单探活) 而非 sum
async fn collect_probes(cfg: &Config) -> Vec<serde_json::Value> {
    if cfg.probes.trim().is_empty() {
        return Vec::new();
    }
    let futs: Vec<_> = cfg
        .probes
        .split(',')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .filter_map(|p| {
            let mut it = p.splitn(3, ':');
            let name = it.next().unwrap_or("").to_string();
            let ty = it.next().unwrap_or("").to_string();
            let target = it.next().unwrap_or("").to_string();
            if name.is_empty() || ty.is_empty() || target.is_empty() {
                None
            } else {
                Some((name, ty, target))
            }
        })
        .map(|(name, ty, target)| async move {
            match ty.as_str() {
                "http" => {
                    let t0 = Instant::now();
                    let (code, ok) = match http_probe(&target, 5).await {
                        Some((c, _)) => (c, (200..400).contains(&c)),
                        None => (0, false),
                    };
                    json!({ "name": name, "ok": ok, "code": code, "ms": t0.elapsed().as_millis() as u64 })
                }
                "tcp" => {
                    let t0 = Instant::now();
                    let ok = tcp_probe(&target, 3).await;
                    json!({ "name": name, "ok": ok, "code": 0, "ms": t0.elapsed().as_millis() as u64 })
                }
                _ => serde_json::Value::Null, // 未知类型：占位，收尾过滤
            }
        })
        .collect();
    join_all(futs)
        .await
        .into_iter()
        .filter(|v| !v.is_null())
        .collect()
}

// ---- 自定义指标 CUSTOM_METRICS：[{"name","cmd"}] 执行命令取第一行数值（5s 超时）----
// 并行执行（join_all，同探活）：串行旧实现 N 个命令最坏 5N 秒，绑架快采帧率。
// shell 跨平台（Unix: sh -c / Windows: cmd /C）；手动 spawn 而非 output()：
// Windows 需要拿到 pid 挂 Job Object（超时杀整树），Unix 行为与 output() 等价
async fn collect_custom(cfg: &Config) -> Vec<serde_json::Value> {
    let raw = cfg.custom_metrics.trim();
    if raw.is_empty() {
        return Vec::new();
    }
    let arr: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let items = match arr.as_array() {
        Some(a) => a.clone(),
        None => return Vec::new(),
    };
    let futs: Vec<_> = items
        .iter()
        .filter_map(|item| {
            let name = item.get("name")?.as_str()?.to_string();
            let cmd = item.get("cmd")?.as_str()?.to_string();
            if name.is_empty() || cmd.is_empty() {
                None
            } else {
                Some((name, cmd))
            }
        })
        .map(|(name, cmd)| async move {
            // kill_on_drop + 进程组/Job Object：超时取消时杀掉整棵子进程树，防孤儿残留
            let mut c = tokio::process::Command::new(crate::platform::EXEC_SHELL);
            for a in crate::platform::exec_shell_args() {
                c.arg(a);
            }
            c.arg(&cmd)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                // stderr 屏蔽（与旧 output() 丢弃 stderr 行为一致）：不设则继承 agent 的
                // stderr——前台运行时命令报错直接打到面板操作者终端
                .stderr(std::process::Stdio::null())
                .kill_on_drop(true);
            crate::platform::set_new_process_group(c.as_std_mut());
            let mut child = match c.spawn() {
                Ok(ch) => ch,
                Err(_) => return None,
            };
            let pid = child.id().unwrap_or(0);
            #[cfg(windows)]
            crate::platform::attach_job(pid);
            let mut out_pipe = child.stdout.take();
            let res = tokio::time::timeout(Duration::from_secs(5), async {
                let buf = match out_pipe.as_mut() {
                    // 只解析第一行数值，保留 4KB 已足够；超过后继续 drain 管道但不扩容，
                    // 防刷屏命令在 5s 内无界物化数百 MB，同时避免子进程因管道写满阻塞。
                    Some(r) => crate::read_limited(r, 4 * 1024).await,
                    None => Vec::new(),
                };
                let status = child.wait().await;
                (buf, status)
            })
            .await;
            match res {
                Ok((buf, _status)) => {
                    crate::platform::detach_job(pid); // 退出/等待失败均释放 Job 表项（Windows）
                    let line = String::from_utf8_lossy(&buf)
                        .lines()
                        .next()
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    if let Ok(v) = line.parse::<f64>() {
                        Some(json!({ "name": name, "value": v }))
                    } else {
                        None
                    }
                }
                Err(_) => {
                    crate::platform::kill_tree(pid);
                    let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
                    None
                }
            }
        })
        .collect();
    join_all(futs).await.into_iter().flatten().collect()
}

// DISK_FSTYPE_INCLUDE 解析：逗号分隔、去空白、去空项（Linux 磁盘过滤用；
// Windows/macOS 实现不消费该配置，解析保留在共享层无害）
pub fn disk_include(cfg: &Config) -> Vec<String> {
    cfg.disk_fstype_include
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

// ---- 汇总上报 ----
pub async fn collect_report(cfg: &Config) -> Option<String> {
    // 无依赖采集项并行（join!），消除串行累积（cpu 200ms + df/uname/hostname 5s 上限 +
    // probes/custom 5s/个）对快采帧率的稀释。blocking 统一走 blocking.rs 信号量
    //（4 permits）：采集峰值 = info(2: uname+hostname) + disk(1) + conns(1) = 4，
    // 与文件操作共享；超限排队而非泄漏（conns/disk 读取毫秒级，排队影响可忽略）
    let disk_inc = disk_include(cfg);
    let (cpu, mem, load, conns, net, info, probes, custom, disk, disk_io) = tokio::join!(
        collect_cpu(),
        async { collect_mem() },
        // 进程快照放 blocking（Windows CreateToolhelp32Snapshot 5-30ms、上千进程更久；
        // Linux /proc 毫秒级，包 blocking 无行为差异——执行位置统一到线程池）
        async {
            crate::blocking::run_blocking(5, collect_load)
                .await
                .unwrap_or((0.0, 0.0, 0.0, 0, 0))
        },
        collect_conns(),
        collect_net(),
        collect_info(),
        collect_probes(cfg),
        collect_custom(cfg),
        collect_disk(&disk_inc),
        collect_disk_io(),
    );
    let (mem_used, mem_total, swap, swap_total) = mem;
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
            "swap_total": swap_total,
            "disk": disk,
            "disk_io": disk_io,
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

    #[cfg(unix)]
    #[tokio::test]
    async fn custom_metric_large_stdout_keeps_first_value() {
        let cfg = crate::Config {
            wss: String::new(),
            key: String::new(),
            report_interval: 120,
            disable_exec: false,
            probes: String::new(),
            custom_metrics: r#"[{"name":"large","cmd":"printf '42\\n'; yes x | head -c 1048576"}]"#
                .to_string(),
            disk_fstype_include: String::new(),
            tmp_dir: String::new(),
            log_file: String::new(),
            log_max: 0,
            allow_self_update: false,
            self_restart_after_update: false,
            executable: std::path::PathBuf::new(),
        };
        let values = collect_custom(&cfg).await;
        assert_eq!(values, vec![json!({ "name": "large", "value": 42.0 })]);
    }

    #[test]
    fn disk_include_parses_csv() {
        let cfg = crate::Config {
            wss: String::new(),
            key: String::new(),
            report_interval: 120,
            disable_exec: false,
            probes: String::new(),
            custom_metrics: String::new(),
            disk_fstype_include: " fuse.rclone, tmpfs ,,".to_string(),
            tmp_dir: String::new(),
            log_file: String::new(),
            log_max: 0,
            allow_self_update: false,
            self_restart_after_update: false,
            executable: std::path::PathBuf::new(),
        };
        assert_eq!(
            disk_include(&cfg),
            vec!["fuse.rclone".to_string(), "tmpfs".to_string()]
        );
    }
}
