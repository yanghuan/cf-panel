// spawn_blocking 统一封装（收敛此前 metrics.rs run_blocking 与 session.rs
// blocking_with_timeout 两套重复实现与两个独立 4-permit 信号量）。
// 三层防护：
// 1. 超时：挂死的阻塞调用（NFS statvfs/read、D 状态进程 wait 等）不会永久挂起调用方；
// 2. 信号量限流（4 permits）：超时只是放弃等待，挂死的 blocking 线程本身不可取消、
//    会继续占用线程池——信号量限制「并发在跑」的 blocking 任务数，正常负载不打穿线程池；
// 3. 文件操作熔断（file_blocking）：连续超时达阈值后冷却期内快速失败，不再 spawn——
//    堵住「挂死挂载点 + 操作员重试/前端自动重试放大」场景的线程持续泄漏（每次超时
//    permit 释放后重试又 spawn 新线程，数小时即可耗尽 blocking pool 默认 512 线程）。
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, Semaphore};

const BLOCKING_PERMITS: usize = 4;
static BLOCKING_SEM: std::sync::OnceLock<Arc<Semaphore>> = std::sync::OnceLock::new();

fn blocking_sem() -> Arc<Semaphore> {
    BLOCKING_SEM
        .get_or_init(|| Arc::new(Semaphore::new(BLOCKING_PERMITS)))
        .clone()
}

async fn with_sem_timeout<F, T>(secs: u64, f: F) -> Option<T>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    let _permit = blocking_sem().acquire_owned().await.ok()?;
    let join = tokio::task::spawn_blocking(f);
    // 超时返回后 JoinHandle drop（任务分离）：挂死的线程不可取消，permit 随返回释放；
    // 泄漏治理靠调用方语义（采集有缓存熔断，文件操作有 file_blocking 熔断）
    tokio::time::timeout(Duration::from_secs(secs), join)
        .await
        .ok()
        .and_then(|r| r.ok())
}

/// 采集类阻塞调用（/proc 读取、uname/hostname、statvfs）：超时 + 信号量，无熔断。
/// 采集路径自带缓存/熔断策略（如磁盘 60s 熔断），叠加文件熔断会互相干扰。
pub async fn run_blocking<F, T>(secs: u64, f: F) -> Option<T>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    with_sem_timeout(secs, f).await
}

// 文件操作熔断状态：连续超时计数 + 最近一次超时时间；任一成功即清零。
// 全局粒度（与磁盘采集熔断一致）：挂死挂载点触发后 30s 内所有文件操作快速失败
//（报 timeout），冷却结束半开放行一次试探——比按路径分组简单且无状态清理问题
type Breaker = Mutex<Option<(Instant, u32)>>;
static FILE_BREAKER: std::sync::OnceLock<Breaker> = std::sync::OnceLock::new();
fn file_breaker() -> &'static Breaker {
    FILE_BREAKER.get_or_init(|| Mutex::new(None))
}
const BREAKER_TRIP: u32 = 3; // 连续 3 次超时 → 熔断开启
const BREAKER_COOLDOWN_SECS: u64 = 30; // 冷却 30s，结束后半开放行试探

/// 文件操作阻塞调用（读/写/删/改名/打包/上传）：超时 + 信号量 + 连续超时熔断。
/// 返回 None（超时或熔断开启）时调用方按各自 "xx timeout" 语义报错。
pub async fn file_blocking<F, T>(secs: u64, f: F) -> Option<T>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    // 熔断开启（冷却期内）：快速失败，不排队、不 spawn 新线程
    {
        let b = file_breaker().lock().await;
        if let Some((last, fails)) = *b
            && fails >= BREAKER_TRIP
            && last.elapsed().as_secs() < BREAKER_COOLDOWN_SECS
        {
            return None;
        }
    }
    let out = with_sem_timeout(secs, f).await;
    let mut b = file_breaker().lock().await;
    match out {
        Some(_) => *b = None, // 成功（含业务 Err）：计数清零，半开试探成功即关闭熔断
        None => {
            let fails = b.map(|(_, n)| n).unwrap_or(0);
            *b = Some((Instant::now(), fails + 1));
        }
    }
    out
}
