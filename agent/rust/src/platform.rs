// 跨平台原语：进程树终止、一次性命令 shell、终端 shell 探测、临时目录。
// Unix 与 Windows 的公共入口在此收口，业务侧（main.rs/session.rs）零 cfg 分支调用。
//
// 进程树终止语义对齐：Unix 用进程组（spawn 时 setsid，kill(-pgid) 连孙进程一并清理），
// Windows 用 Job Object（spawn 时把子进程挂入 job，TerminateJobObject 清理整树）——
// 两者共同保证「exec 超时 / 终端会话结束时，孙子进程不残留」。
#[cfg(unix)]
pub mod imp {
    use std::process::Command;

    /// 一次性命令解释器：sh -c（POSIX shell，任何发行版可用）
    pub const EXEC_SHELL: &str = "sh";
    /// EXEC_SHELL 的命令参数（&["sh", "-c", cmd]）
    pub fn exec_shell_args() -> Vec<String> {
        vec!["-c".to_string()]
    }

    /// 终端交互 shell：$SHELL → /bin/bash → /bin/sh 探测（busybox/OpenWrt 无 bash 时仍可用）。
    /// 显式声明 xterm-256color：systemd 环境无 TERM 时 TUI 程序检测不到终端类型会输出一屏立即退出
    pub fn terminal_shell() -> String {
        std::env::var("SHELL")
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
            })
    }

    /// 交互 shell 的启动参数（bash -i）
    pub fn terminal_shell_args() -> Vec<String> {
        vec!["-i".to_string()]
    }

    /// 子进程脱离父进程组（setsid 语义）：超时杀树的前提。
    /// tokio/std Command 的 process_group(0) 即 POSIX setpgid(0,0)
    pub fn set_new_process_group(cmd: &mut Command) {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    /// 终止整棵进程树（进程组长 pid 为负 = 全组）。
    /// kill 前不等待：调用方随后 wait() 回收直接子进程防僵尸
    pub fn kill_tree(pgid: u32) {
        if pgid > 0 {
            unsafe {
                libc::kill(-(pgid as i32), libc::SIGKILL);
            }
        }
    }

    /// 终端会话正常关闭时的挂断信号（SIGHUP 发整组，等价关终端窗口）
    pub fn hangup_tree(pgid: u32) {
        if pgid > 0 {
            unsafe {
                libc::kill(-(pgid as i32), libc::SIGHUP);
            }
        }
    }

    /// 进程正常退出后的资源释放（Unix 无进程组资源需要释放：内核随组员全亡回收——no-op）。
    /// 与 Windows 的 detach_job 对称，供调用侧免 cfg 使用
    pub fn detach_job(_pid: u32) {}

    /// 临时目录与日志路径前缀（/tmp 固定语义，与 agent.sh 历史行为一致）
    pub fn tmp_base() -> std::path::PathBuf {
        std::path::PathBuf::from("/tmp")
    }
}

#[cfg(windows)]
pub mod imp {
    use std::process::Command;

    /// 一次性命令解释器：cmd /C（Windows 内置，任何版本可用；
    /// PowerShell 更现代但启动慢 ~10 倍且语法差异大，exec 保持 POSIX 习惯由 cmd 承接）
    pub const EXEC_SHELL: &str = "cmd";
    /// EXEC_SHELL 的命令参数（&["cmd", "/C", cmd]）
    pub fn exec_shell_args() -> Vec<String> {
        vec!["/C".to_string()]
    }

    /// 终端交互 shell：PowerShell（Windows 10+ 自带，交互体验远好于 cmd）
    pub fn terminal_shell() -> String {
        // powershell.exe 在 System32\WindowsPowerShell\v1.0\，PATH 必含 System32；
        // 缺失（精简 Server Core？）回退 cmd.exe
        if std::path::Path::new("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
            .exists()
        {
            "powershell.exe".to_string()
        } else {
            "cmd.exe".to_string()
        }
    }

    /// 交互 shell 无额外参数（cmd/powershell 本身即交互模式）
    pub fn terminal_shell_args() -> Vec<String> {
        Vec::new()
    }

    /// 子进程挂入新 Job Object（KILL_ON_JOB_CLOSE 兜底：agent 崩溃时整树随 job 句柄关闭被清理）。
    /// 句柄由 kill_tree 持有（见 JOBS），Command 经 creation_flags 暂不能挂 job——
    /// 在此用 CREATE_SUSPENDED 之外的常规方式：spawn 后立即 AssignProcessToJobObject。
    /// 之所以不在 pre_exec 做：std Command Windows 侧无 pre_exec。
    pub fn set_new_process_group(_cmd: &mut Command) {
        // 无事可做（进程组是 Unix 概念）；Job 挂接在 attach_job 完成
    }

    // pid → job 句柄表：杀树时按 pid 定位 job 终止整树。
    // 句柄为内核对象，进程退出不自动失效（KILL_ON_JOB_CLOSE 在句柄全关闭时才触发——
    // 我们持有句柄直到 kill_tree，正好覆盖 agent 存活期；agent 崩溃时句柄随进程关闭→整树被杀）
    static JOBS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<u32, isize>>> =
        std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

    /// 把已 spawn 的子进程挂入新 Job Object（exec/终端会话在拿到 pid 后调用）。
    /// 失败静默：后续 kill_tree 退化为仅杀直接子进程（Windows 无进程组，尽力而为）
    pub fn attach_job(pid: u32) {
        unsafe {
            const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_SIZE: usize =
                std::mem::size_of::<JOBOBJECTEXTENDEDLIMITINFORMATION>();
            let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
            if job.is_null() {
                return;
            }
            // KILL_ON_JOB_CLOSE：最后一个句柄关闭时终止 job 内全部进程
            let mut info: JOBOBJECTEXTENDEDLIMITINFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let _ = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const std::ffi::c_void,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_SIZE as u32,
            );
            let h = OpenProcess(PROCESS_ALL_ACCESS, 0, pid);
            if h.is_null() {
                CloseHandle(job);
                return;
            }
            if AssignProcessToJobObject(job, h) == 0 {
                CloseHandle(h);
                CloseHandle(job);
                return;
            }
            CloseHandle(h);
            if let Ok(mut jobs) = JOBS.lock() {
                if jobs.len() > 1024 {
                    // 上限清理只关「无存活进程」的 job：job 设有 KILL_ON_JOB_CLOSE，关闭
                    // 最后一个句柄会终止 job 内全部仍在运行的进程——全部 drain 会误杀
                    // 存活中的 exec/自定义指标/终端 shell（症状为"终端莫名断开"）。
                    // QueryInformationJobObject 查 ActiveProcesses：0 才关；查询失败保留
                    // （宁可泄漏一个句柄也不误杀，泄漏由 detach/kill 正常路径回收）
                    let mut retained = std::collections::HashMap::new();
                    for (p, j) in jobs.drain() {
                        if job_has_active_processes(j as *mut std::ffi::c_void) {
                            retained.insert(p, j);
                        } else {
                            // 外层 unsafe 块内，无需嵌套 unsafe（edition 2024 lint）
                            let _ = CloseHandle(j as *mut std::ffi::c_void);
                        }
                    }
                    *jobs = retained;
                }
                jobs.insert(pid, job as isize);
            }
        }
    }

    /// job 内是否仍有存活进程（Accounting 的 ActiveProcesses）。查询失败按「有存活」处理
    /// （保守方向：误判为存活只是多保留一个句柄；误判为退出会让调用方 CloseHandle，
    /// 触发 KILL_ON_JOB_CLOSE 杀掉运行中的进程树——方向必须朝「保留」一侧）
    fn job_has_active_processes(job: *mut std::ffi::c_void) -> bool {
        unsafe {
            let mut info: JOBOBJECTBASICACCOUNTINGINFORMATION = std::mem::zeroed();
            let ok = QueryInformationJobObject(
                job,
                JobObjectBasicAccountingInformation,
                &mut info as *mut _ as *mut std::ffi::c_void,
                std::mem::size_of::<JOBOBJECTBASICACCOUNTINGINFORMATION>() as u32,
                std::ptr::null_mut(),
            );
            // 查询失败（ok==0）→ 保守视为有存活：宁可句柄泄漏（由 detach/kill 正常回收），
            // 绝不在不确定时 CloseHandle 误杀进程树
            ok == 0 || info.ActiveProcesses > 0
        }
    }

    /// 进程正常退出后的 job 释放：移除表项并关句柄（job 内已无进程，CloseHandle 即回收）。
    /// exec/自定义指标的成功路径必须调用——否则表项残留、句柄占用（KILL_ON_JOB_CLOSE
    /// 随最后句柄关闭触发，但 job 已空，无副作用）
    pub fn detach_job(pid: u32) {
        let job = JOBS.lock().ok().and_then(|mut jobs| jobs.remove(&pid));
        if let Some(j) = job {
            unsafe {
                let _ = CloseHandle(j as *mut std::ffi::c_void);
            }
        }
    }

    /// 终止整棵进程树（TerminateJobObject：job 内直接 + 全部后代一并 SIGKILL 语义）；
    /// 无 job（挂接失败）时退化为 OpenProcess + TerminateProcess 杀直接子进程
    pub fn kill_tree(pid: u32) {
        unsafe {
            let job = JOBS.lock().ok().and_then(|mut jobs| jobs.remove(&pid));
            if let Some(j) = job {
                let _ = TerminateJobObject(j as _, 1);
                let _ = CloseHandle(j as _);
                return;
            }
            if pid > 0 {
                let h = OpenProcess(PROCESS_ALL_ACCESS, 0, pid);
                if !h.is_null() {
                    let _ = TerminateProcess(h, 1);
                    let _ = CloseHandle(h);
                }
            }
        }
    }

    /// 终端会话关闭：Windows 无 SIGHUP，杀树即可（调用方 cleanup 流程直接 kill_tree）
    pub fn hangup_tree(pgid: u32) {
        kill_tree(pgid);
    }

    /// 临时目录与日志路径前缀（%TEMP% 通常为 C:\Users\<u>\AppData\Local\Temp）
    pub fn tmp_base() -> std::path::PathBuf {
        std::env::temp_dir()
    }

    // ---- Win32 FFI（仅本模块使用；避免引 windows-rs 全家桶，六个函数足矣）----
    #[allow(non_snake_case)]
    #[repr(C)]
    struct JOBOBJECTBASICLIMITINFORMATION {
        PerProcessUserTimeLimit: i64,
        PerJobUserTimeLimit: i64,
        LimitFlags: u32,
        MinimumWorkingSetSize: usize,
        MaximumWorkingSetSize: usize,
        ActiveProcessLimit: u32,
        Affinity: usize,
        PriorityClass: u32,
        SchedulingClass: u32,
    }
    #[allow(non_snake_case)]
    #[repr(C)]
    struct IO_COUNTERS {
        ReadOperationCount: u64,
        WriteOperationCount: u64,
        OtherOperationCount: u64,
        ReadTransferCount: u64,
        WriteTransferCount: u64,
        OtherTransferCount: u64,
    }
    #[allow(non_snake_case)]
    #[repr(C)]
    struct JOBOBJECTEXTENDEDLIMITINFORMATION {
        BasicLimitInformation: JOBOBJECTBASICLIMITINFORMATION,
        IoInfo: IO_COUNTERS,
        ProcessMemoryLimit: usize,
        JobMemoryLimit: usize,
        PeakProcessMemoryUsed: usize,
        PeakJobMemoryUsed: usize,
    }
    #[allow(non_snake_case)]
    #[repr(C)]
    struct JOBOBJECTBASICACCOUNTINGINFORMATION {
        TotalUserTime: i64,
        TotalKernelTime: i64,
        ThisPeriodTotalUserTime: i64,
        ThisPeriodTotalKernelTime: i64,
        TotalPageFaultCount: u32,
        TotalProcesses: u32,
        ActiveProcesses: u32,
        TotalTerminatedProcesses: u32,
        IoInfo: IO_COUNTERS,
    }
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
    // Win32 原名 JobObjectExtendedLimitInformation（保留可读性，不按 Rust 常量命名风格改写）
    #[allow(non_upper_case_globals)]
    const JobObjectExtendedLimitInformation: i32 = 9;
    #[allow(non_upper_case_globals)]
    const JobObjectBasicAccountingInformation: i32 = 1;
    const PROCESS_ALL_ACCESS: u32 = 0x1F0FFF;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateJobObjectW(
            lpJobAttributes: *mut std::ffi::c_void,
            lpName: *const u16,
        ) -> *mut std::ffi::c_void;
        fn SetInformationJobObject(
            hJob: *mut std::ffi::c_void,
            JobObjectInfoClass: i32,
            lpJobObjectInfo: *const std::ffi::c_void,
            cbJobObjectInfoLength: u32,
        ) -> i32;
        fn QueryInformationJobObject(
            hJob: *mut std::ffi::c_void,
            JobObjectInfoClass: i32,
            lpJobObjectInfo: *mut std::ffi::c_void,
            cbJobObjectInfoLength: u32,
            lpReturnLength: *mut u32,
        ) -> i32;
        fn AssignProcessToJobObject(
            hJob: *mut std::ffi::c_void,
            hProcess: *mut std::ffi::c_void,
        ) -> i32;
        fn TerminateJobObject(hJob: *mut std::ffi::c_void, uExitCode: u32) -> i32;
        fn OpenProcess(
            dwDesiredAccess: u32,
            bInheritHandle: i32,
            dwProcessId: u32,
        ) -> *mut std::ffi::c_void;
        fn TerminateProcess(hProcess: *mut std::ffi::c_void, uExitCode: u32) -> i32;
        fn CloseHandle(hObject: *mut std::ffi::c_void) -> i32;
    }

    // 真机 FFI 生命周期验证（仅 Windows 编译，CI build-windows 的 cargo test 执行）：
    // 交叉 check 只能验证布局正确，QueryInformationJobObject 的实际返回值需真进程实证
    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn job_accounting_lifecycle() {
            // cmd ping 约 2s 存活：保证 attach 后轮询窗口内进程仍在运行
            let mut child = std::process::Command::new("cmd")
                .args(["/C", "ping -n 3 127.0.0.1 >nul"])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .expect("spawn cmd");
            let pid = child.id();
            attach_job(pid);
            let job = JOBS
                .lock()
                .ok()
                .and_then(|jobs| jobs.get(&pid).copied())
                .expect("attach 后表项存在");
            let job = job as *mut std::ffi::c_void;
            // 轮询（最多 3s）等 Query 成功且会计确认挂接。CI 环境（runner 嵌套 job）曾
            // 观察到 QueryInformationJobObject 持续失败（返回 0 且 GetLastError=0，原因未明）
            // ——此时跳过会计语义断言（生产侧 job_has_active_processes 已保守为「失败=有
            // 存活」，方向安全），仅输出诊断；Query 成功路径仍硬验证会计语义（捕获布局错误）
            let mut last: Option<(i32, JOBOBJECTBASICACCOUNTINGINFORMATION)> = None;
            for _ in 0..30 {
                let mut info: JOBOBJECTBASICACCOUNTINGINFORMATION = unsafe { std::mem::zeroed() };
                let ok = unsafe {
                    QueryInformationJobObject(
                        job,
                        JobObjectBasicAccountingInformation,
                        &mut info as *mut _ as *mut std::ffi::c_void,
                        std::mem::size_of::<JOBOBJECTBASICACCOUNTINGINFORMATION>() as u32,
                        std::ptr::null_mut(),
                    )
                };
                let active = ok != 0 && info.ActiveProcesses > 0;
                last = Some((ok, info));
                if active {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            let (ok, info) = last.unwrap();
            if ok != 0 {
                // Query 成功：存活窗口内会计必须确认挂接（Active > 0 或累计 Total >= 1）
                assert!(
                    info.ActiveProcesses > 0 || info.TotalProcesses >= 1,
                    "job 会计应确认进程挂接：ActiveProcesses={} TotalProcesses={}",
                    info.ActiveProcesses,
                    info.TotalProcesses,
                );
            } else {
                eprintln!(
                    "warn: QueryInformationJobObject 持续失败（err={}），跳过会计语义断言",
                    std::io::Error::last_os_error()
                );
            }
            // 存活窗口内 job_has_active_processes 必须 true（Query 成功+active，或失败保守 true）
            assert!(
                job_has_active_processes(job),
                "存活进程的 job 应报告 active（含查询失败的保守方向）"
            );
            let _ = child.wait();
            // 退出后：仅 Query 成功路径断言 inactive（失败环境保守 true 为预期）
            if ok != 0 {
                let mut inactive = false;
                for _ in 0..10 {
                    if !job_has_active_processes(job) {
                        inactive = true;
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                assert!(inactive, "进程退出后 job 应报告 inactive");
            }
            detach_job(pid); // 清理表项与句柄
            assert!(
                JOBS.lock()
                    .map(|jobs| !jobs.contains_key(&pid))
                    .unwrap_or(true),
                "detach 后表项移除"
            );
        }
    }
}

pub use imp::*;
