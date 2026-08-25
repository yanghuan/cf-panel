// Agent 自更新：控制通道 Binary 混合帧 → 同目录 staging → SHA-256/版本校验 →
// self-replace 跨平台替换。下载与权限/审计由 Worker/TerminalDO 负责；本模块只接受
// 已鉴权控制通道上的专用 agent_update 帧，且默认关闭（ALLOW_SELF_UPDATE=1 显式开启）。
use sha2::{Digest, Sha256};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const UPDATE_PROTOCOL: u64 = 1;
const UPDATE_MAX_BYTES: u64 = 32 * 1024 * 1024;
const UPDATE_HEADER_MAX: usize = 4096;

pub fn is_update_frame(frame: &[u8]) -> bool {
    let Some(nl) = frame
        .iter()
        .take(UPDATE_HEADER_MAX + 1)
        .position(|&b| b == b'\n')
    else {
        return false;
    };
    serde_json::from_slice::<serde_json::Value>(&frame[..nl])
        .ok()
        .and_then(|v| v.get("type").and_then(|x| x.as_str()).map(str::to_string))
        .as_deref()
        == Some("agent_update")
}

pub fn frame_update_id(frame: &[u8]) -> String {
    frame
        .iter()
        .take(UPDATE_HEADER_MAX + 1)
        .position(|&b| b == b'\n')
        .and_then(|nl| serde_json::from_slice::<serde_json::Value>(&frame[..nl]).ok())
        .and_then(|v| {
            v.get("update_id")
                .and_then(|x| x.as_str())
                .map(str::to_string)
        })
        .unwrap_or_default()
}

#[derive(Debug)]
struct UpdateSession {
    id: String,
    build_id: String,
    expected_size: u64,
    sha256: String,
    platform: String,
    staging: PathBuf,
    written: u64,
}

#[derive(Debug)]
pub enum UpdateOutcome {
    Progress,
    Ready {
        update_id: String,
        build_id: String,
        size: u64,
        backup: String,
    },
}

pub struct UpdateManager {
    inner: Mutex<Option<UpdateSession>>,
    cancelled: std::sync::atomic::AtomicBool,
}

impl UpdateManager {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
            cancelled: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// 控制连接退出时清理未完成 staging；已替换成功时 state 已清空，不动正式二进制/backup。
    pub fn abort(&self) {
        self.cancelled
            .store(true, std::sync::atomic::Ordering::SeqCst);
        // try_lock：若 spawn_blocking 已超时但底层线程仍卡在文件系统，不能在 async 清理路径
        // 再次阻塞等待同一锁；后台线程恢复后会在替换前检查 cancelled 并清 staging。
        if let Ok(mut guard) = self.inner.try_lock()
            && let Some(s) = guard.take()
        {
            let _ = std::fs::remove_file(s.staging);
        }
    }

    /// 同步文件操作入口（调用方必须放 blocking::file_blocking 内）。
    pub fn handle_frame(&self, frame: &[u8], enabled: bool) -> Result<UpdateOutcome, String> {
        if !enabled {
            return Err("self update disabled (set ALLOW_SELF_UPDATE=1)".into());
        }
        let Some(nl) = frame
            .iter()
            .take(UPDATE_HEADER_MAX + 1)
            .position(|&b| b == b'\n')
        else {
            return Err("bad update frame header".into());
        };
        if nl == 0 || nl > UPDATE_HEADER_MAX {
            return Err("bad update frame header".into());
        }
        let v: serde_json::Value =
            serde_json::from_slice(&frame[..nl]).map_err(|_| "bad update frame json")?;
        if v.get("type").and_then(|x| x.as_str()) != Some("agent_update") {
            return Err("unexpected binary frame type".into());
        }
        let id = field(&v, "update_id")?;
        let build_id = field(&v, "build_id")?;
        let sha256 = field(&v, "sha256")?.to_ascii_lowercase();
        let platform = field(&v, "platform")?;
        let expected_size = v
            .get("size")
            .and_then(|x| x.as_u64())
            .ok_or("invalid update size")?;
        let offset = v
            .get("offset")
            .and_then(|x| x.as_u64())
            .ok_or("invalid update offset")?;
        let commit = v.get("commit").and_then(|x| x.as_bool()).unwrap_or(false);
        let data = &frame[nl + 1..];

        if id.len() > 80
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err("invalid update_id".into());
        }
        if build_id.is_empty() || build_id.len() > 64 {
            return Err("invalid build_id".into());
        }
        if sha256.len() != 64 || !sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("invalid sha256".into());
        }
        if platform != platform_key() {
            return Err(format!(
                "platform mismatch: expected {}, got {platform}",
                platform_key()
            ));
        }
        if expected_size == 0 || expected_size > UPDATE_MAX_BYTES {
            return Err(format!(
                "invalid update size (max {}MB)",
                UPDATE_MAX_BYTES / 1024 / 1024
            ));
        }
        if commit && !data.is_empty() {
            return Err("commit frame must not contain data".into());
        }

        let mut guard = self.inner.lock().map_err(|_| "update state poisoned")?;
        // 上一次 Worker/DO 请求中断但控制 WS 仍存活时，staging 状态会残留。新的 update_id
        // 从 offset=0 开始可原地接管：先清旧文件再创建，避免用户必须失败两次才能重试。
        if offset == 0
            && !commit
            && guard.as_ref().is_some_and(|s| s.id != id)
            && let Some(old) = guard.take()
        {
            let _ = std::fs::remove_file(old.staging);
        }
        if self.cancelled.load(std::sync::atomic::Ordering::SeqCst) && guard.is_some() {
            return abort_locked(&mut guard, "update cancelled");
        }
        if guard.is_none() {
            if offset != 0 || commit {
                return Err("update must start at offset 0".into());
            }
            if build_id == crate::VERSION {
                return Err("agent is already on requested build".into());
            }
            self.cancelled
                .store(false, std::sync::atomic::Ordering::SeqCst);
            let current = std::env::current_exe().map_err(|e| format!("current exe: {e}"))?;
            let parent = current.parent().ok_or("current exe has no parent")?;
            let name = current
                .file_name()
                .and_then(|x| x.to_str())
                .unwrap_or("cf-panel-agent");
            // Windows CreateProcess 对无 .exe 后缀的 PE 行为不一致，staging 保留 .exe 后缀；
            // Unix 使用隐藏临时名。两者都在当前 exe 同目录，保证 self-replace 原子 rename 条件。
            let staging_name = if cfg!(windows) {
                format!(".{name}.update-{}-{id}.exe", std::process::id())
            } else {
                format!(".{name}.update-{}-{id}", std::process::id())
            };
            let staging = parent.join(staging_name);
            let _ = std::fs::remove_file(&staging);
            let mut opts = std::fs::OpenOptions::new();
            opts.create_new(true).write(true);
            opts.open(&staging)
                .map_err(|e| format!("create update staging: {e}"))?;
            *guard = Some(UpdateSession {
                id: id.clone(),
                build_id: build_id.clone(),
                expected_size,
                sha256: sha256.clone(),
                platform: platform.clone(),
                staging,
                written: 0,
            });
        }

        let (metadata_matches, written, declared_size) = {
            let session = guard.as_ref().ok_or("update state unavailable")?;
            (
                session.id == id
                    && session.build_id == build_id
                    && session.expected_size == expected_size
                    && session.sha256 == sha256
                    && session.platform == platform,
                session.written,
                session.expected_size,
            )
        };
        if !metadata_matches {
            return abort_locked(&mut guard, "update metadata changed between frames");
        }
        if offset != written {
            return abort_locked(
                &mut guard,
                &format!("update offset mismatch: expected {written}, got {offset}"),
            );
        }
        let new_size = written
            .checked_add(data.len() as u64)
            .ok_or("update size overflow")?;
        if new_size > declared_size {
            return abort_locked(&mut guard, "update exceeds declared size");
        }

        if !data.is_empty() {
            let staging = guard
                .as_ref()
                .ok_or("update state unavailable")?
                .staging
                .clone();
            let mut f = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&staging)
                .map_err(|e| format!("open update staging: {e}"))?;
            let actual = f
                .metadata()
                .map_err(|e| format!("stat update staging: {e}"))?
                .len();
            if actual != written {
                return abort_locked(&mut guard, "update staging length changed");
            }
            f.seek(SeekFrom::Start(written))
                .map_err(|e| format!("seek update staging: {e}"))?;
            f.write_all(data)
                .map_err(|e| format!("write update staging: {e}"))?;
            guard.as_mut().ok_or("update state unavailable")?.written = new_size;
        }
        if !commit {
            return Ok(UpdateOutcome::Progress);
        }
        let (written, declared_size) = {
            let session = guard.as_ref().ok_or("update state unavailable")?;
            (session.written, session.expected_size)
        };
        if written != declared_size {
            return abort_locked(
                &mut guard,
                &format!("update size mismatch: expected {declared_size}, got {written}"),
            );
        }

        let done = guard.take().ok_or("update state unavailable")?;
        match install(done, &self.cancelled) {
            Ok(v) => Ok(v),
            Err((path, e)) => {
                let _ = std::fs::remove_file(path);
                Err(e)
            }
        }
    }
}

fn field(v: &serde_json::Value, name: &str) -> Result<String, String> {
    v.get(name)
        .and_then(|x| x.as_str())
        .filter(|x| !x.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("missing {name}"))
}

fn abort_locked(guard: &mut Option<UpdateSession>, message: &str) -> Result<UpdateOutcome, String> {
    if let Some(s) = guard.take() {
        let _ = std::fs::remove_file(s.staging);
    }
    Err(message.to_string())
}

fn install(
    session: UpdateSession,
    cancelled: &std::sync::atomic::AtomicBool,
) -> Result<UpdateOutcome, (PathBuf, String)> {
    let fail = |msg: String| Err((session.staging.clone(), msg));
    let mut f = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&session.staging)
        .map_err(|e| (session.staging.clone(), format!("open staged update: {e}")))?;
    f.sync_all()
        .map_err(|e| (session.staging.clone(), format!("sync staged update: {e}")))?;
    f.seek(SeekFrom::Start(0))
        .map_err(|e| (session.staging.clone(), format!("seek staged update: {e}")))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f
            .read(&mut buf)
            .map_err(|e| (session.staging.clone(), format!("hash staged update: {e}")))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let actual = format!("{:x}", hasher.finalize());
    drop(f); // Windows：候选执行/self-replace 前释放 staging 文件句柄
    if actual != session.sha256 {
        return fail(format!(
            "update sha256 mismatch: expected {}, got {actual}",
            session.sha256
        ));
    }
    if cancelled.load(std::sync::atomic::Ordering::SeqCst) {
        return fail("update cancelled before install".into());
    }

    let current = std::env::current_exe()
        .map_err(|e| (session.staging.clone(), format!("current exe: {e}")))?;
    set_candidate_permissions(&current, &session.staging).map_err(|e| {
        (
            session.staging.clone(),
            format!("set update permissions: {e}"),
        )
    })?;
    let got_version =
        probe_candidate_version(&session.staging).map_err(|e| (session.staging.clone(), e))?;
    if got_version != session.build_id {
        return fail(format!(
            "staged update version mismatch: expected {}, got {got_version}",
            session.build_id
        ));
    }
    if cancelled.load(std::sync::atomic::Ordering::SeqCst) {
        return fail("update cancelled before backup".into());
    }

    // 保留最近一版备份供人工回滚；先写 .tmp + sync + rename，避免中断留下半个 backup。
    let name = current
        .file_name()
        .and_then(|x| x.to_str())
        .unwrap_or("cf-panel-agent");
    let parent = current.parent().ok_or_else(|| {
        (
            session.staging.clone(),
            "current exe has no parent".to_string(),
        )
    })?;
    let backup = parent.join(format!("{name}.bak"));
    let backup_tmp = parent.join(format!(".{name}.bak.tmp-{}", std::process::id()));
    let _ = std::fs::remove_file(&backup_tmp);
    std::fs::copy(&current, &backup_tmp).map_err(|e| {
        (
            session.staging.clone(),
            format!("backup current agent: {e}"),
        )
    })?;
    let backup_file = std::fs::OpenOptions::new()
        .read(true)
        .open(&backup_tmp)
        .map_err(|e| (session.staging.clone(), format!("open agent backup: {e}")))?;
    backup_file
        .sync_all()
        .map_err(|e| (session.staging.clone(), format!("sync agent backup: {e}")))?;
    let _ = std::fs::remove_file(&backup);
    std::fs::rename(&backup_tmp, &backup).map_err(|e| {
        (
            session.staging.clone(),
            format!("publish agent backup: {e}"),
        )
    })?;
    if cancelled.load(std::sync::atomic::Ordering::SeqCst) {
        return fail("update cancelled before replace".into());
    }

    self_replace::self_replace(&session.staging)
        .map_err(|e| (session.staging.clone(), format!("replace agent: {e}")))?;
    let _ = std::fs::remove_file(&session.staging);
    Ok(UpdateOutcome::Ready {
        update_id: session.id,
        build_id: session.build_id,
        size: session.written,
        backup: backup.to_string_lossy().into_owned(),
    })
}

fn probe_candidate_version(path: &Path) -> Result<String, String> {
    let mut child = std::process::Command::new(path)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("run staged update: {e}"))?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("staged update --version timed out".into());
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("wait staged update: {e}"));
            }
        }
    };
    if !status.success() {
        return Err("staged update --version failed".into());
    }
    let mut stdout = Vec::new();
    if let Some(mut out) = child.stdout.take() {
        // --version 正常只有几十字节；take 防异常候选输出放大内存。
        let _ = (&mut out).take(4096).read_to_end(&mut stdout);
    }
    let text = String::from_utf8_lossy(&stdout);
    let mut parts = text.split_whitespace();
    if parts.next() != Some("cf-panel-agent") {
        return Err("staged update identity mismatch".into());
    }
    Ok(parts.next().unwrap_or("").to_string())
}

#[cfg(unix)]
fn set_candidate_permissions(current: &Path, staged: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    // 仅继承 rwx 权限，不复制 setuid/setgid/sticky 特殊位到下载的新文件。
    let mode = std::fs::metadata(current)?.permissions().mode() & 0o777;
    std::fs::set_permissions(staged, std::fs::Permissions::from_mode(mode))
}

#[cfg(windows)]
fn set_candidate_permissions(_current: &Path, _staged: &Path) -> std::io::Result<()> {
    Ok(())
}

/// 启动时清理异常退出留下的 staging（仅匹配当前可执行文件专属前缀，不碰 .bak）。
pub fn cleanup_stale() {
    let Ok(current) = std::env::current_exe() else {
        return;
    };
    let Some(parent) = current.parent() else {
        return;
    };
    let name = current
        .file_name()
        .and_then(|x| x.to_str())
        .unwrap_or("cf-panel-agent");
    let prefix = format!(".{name}.update-");
    if let Ok(entries) = std::fs::read_dir(parent) {
        for entry in entries.flatten() {
            let file_name = entry.file_name();
            if file_name.to_string_lossy().starts_with(&prefix) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

pub fn platform_key() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => "linux-x86_64",
        ("linux", "aarch64") => "linux-aarch64",
        ("macos", "aarch64") => "macos-aarch64",
        ("windows", "x86_64") => "windows-x86_64",
        _ => "unsupported",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_key_is_known_for_supported_targets() {
        assert_ne!(platform_key(), "unsupported");
    }

    #[test]
    fn invalid_frame_is_rejected() {
        let manager = UpdateManager::new();
        assert!(manager.handle_frame(b"bad", true).is_err());
        assert!(
            manager
                .handle_frame(b"{\"type\":\"agent_update\"}\n", true)
                .is_err()
        );
        assert!(manager
            .handle_frame(
                b"{\"type\":\"agent_update\",\"update_id\":\"x\",\"build_id\":\"v\",\"sha256\":\"00\",\"platform\":\"linux-x86_64\",\"size\":1,\"offset\":0}\nx",
                false,
            )
            .is_err());
    }

    #[test]
    fn partial_update_stages_and_bad_hash_aborts_without_replacing() {
        let manager = UpdateManager::new();
        let id = format!("test-{}", std::process::id());
        let platform = platform_key();
        let sha = "0".repeat(64); // 与字节 x 的真实 SHA 不同，commit 必须拒绝
        let head = format!(
            "{{\"type\":\"agent_update\",\"update_id\":\"{id}\",\"build_id\":\"future\",\"sha256\":\"{sha}\",\"platform\":\"{platform}\",\"size\":1,\"offset\":0,\"commit\":false}}\nx"
        );
        assert!(matches!(
            manager.handle_frame(head.as_bytes(), true),
            Ok(UpdateOutcome::Progress)
        ));
        let commit = format!(
            "{{\"type\":\"agent_update\",\"update_id\":\"{id}\",\"build_id\":\"future\",\"sha256\":\"{sha}\",\"platform\":\"{platform}\",\"size\":1,\"offset\":1,\"commit\":true}}\n"
        );
        let err = manager.handle_frame(commit.as_bytes(), true).unwrap_err();
        assert!(err.contains("sha256 mismatch"));
        manager.abort(); // 幂等：commit 失败已清 staging
    }

    #[test]
    fn new_update_id_at_zero_replaces_interrupted_session() {
        let manager = UpdateManager::new();
        let platform = platform_key();
        let sha = "0".repeat(64);
        for id in ["old", "new"] {
            let frame = format!(
                "{{\"type\":\"agent_update\",\"update_id\":\"{id}\",\"build_id\":\"future-{id}\",\"sha256\":\"{sha}\",\"platform\":\"{platform}\",\"size\":2,\"offset\":0,\"commit\":false}}\nx"
            );
            assert!(matches!(
                manager.handle_frame(frame.as_bytes(), true),
                Ok(UpdateOutcome::Progress)
            ));
        }
        manager.abort();
    }
}
