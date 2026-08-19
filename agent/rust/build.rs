// 格式门禁：编译前强制 rustfmt --check（与 CI 的 cargo fmt --check 对齐）。
// 任何触发编译的命令（build/check/test/IDE 保存检查/CI）都会先过格式检查，
// 格式不合规或 rustfmt 组件未安装时直接编译失败。
use std::process::Command;

fn main() {
    // 源码或 Cargo.toml（edition）变化时重跑本脚本
    println!("cargo:rerun-if-changed=src/");
    println!("cargo:rerun-if-changed=Cargo.toml");

    // rustfmt 未安装：直接报错（与 CI 对齐：agent-rust test job 已装组件，格式检查是硬性要求）
    if Command::new("rustfmt").arg("--version").output().is_err() {
        panic!(
            "rustfmt 未安装：请先运行 `rustup component add rustfmt`（CI 会强制 cargo fmt --check）"
        );
    }

    // 收集 src/ 下所有 .rs（新增文件自动纳入）
    let files: Vec<String> = std::fs::read_dir("src")
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.extension().map(|x| x == "rs").unwrap_or(false))
                .map(|p| p.to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    if files.is_empty() {
        return;
    }

    // edition 从 Cargo.toml 读取（与 cargo fmt 行为一致）
    let edition = std::fs::read_to_string("Cargo.toml")
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.trim_start().starts_with("edition"))
                .and_then(|l| l.split('=').nth(1))
                .map(|v| v.trim().trim_matches('"').to_string())
        })
        .unwrap_or_else(|| "2021".to_string());

    let mut cmd = Command::new("rustfmt");
    cmd.args(["--edition", &edition, "--check"]).args(&files);
    match cmd.output() {
        Ok(out) if out.status.success() => {}
        Ok(out) => {
            // 透传 rustfmt 的 diff 到 stderr（build script 的 stdout 会被 cargo 吞掉），panic 使编译失败
            eprint!("{}", String::from_utf8_lossy(&out.stdout));
            eprint!("{}", String::from_utf8_lossy(&out.stderr));
            panic!("rustfmt --check 未通过，请先运行 cargo fmt 再编译");
        }
        Err(e) => println!("cargo:warning=rustfmt 执行失败，跳过格式检查: {e}"),
    }
}
