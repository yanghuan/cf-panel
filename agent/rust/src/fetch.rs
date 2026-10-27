// 极简 HTTPS GET 下载器（阶段 B/C：Agent 从 Worker 拉暂存文件 / Release 资产）。
//
// 为什么不用 reqwest：
//   1. 本模块所需能力 = 一次 GET + 流式落到临时文件，没有重定向/压缩/连接池/cookie 需求；
//   2. reqwest 会引入约 40 个传递依赖，且其 rustls 后端必须与主 crate 的 ring 保持一致，
//      否则重演 2026-08-25 那次 "Could not automatically determine CryptoProvider" 事故；
//   3. 手写 HTTP 在 main.rs 的 lenient_ws_handshake 里已有同构实现（写请求行 + 读响应头），
//      DNS 与 TLS 也都有现成封装（dns::resolve / build_rustls_config）。
//
// 只支持 GET：这两个端点（upload download / agent-update-asset）都是只读下载。
// 关键约束：**必须处理 Content-Length 与 chunked 两种响应**——Worker 端我们显式设了
// Content-Length，但 Cloudflare 对某些路径可能改写为 chunked，硬编码一种会偶发解析错位。
use std::error::Error;
use std::io::Write as _;
use std::path::Path;

use tokio::io::{AsyncReadExt, AsyncWriteExt};

const HEADER_MAX: usize = 16 * 1024;

pub struct FetchResult {
    pub bytes: u64,
}

/// 从 `url` 下载到 `dest`，边下边算 SHA-256 并校验 `expect_size` / `expect_sha256`。
/// 全程流式：不把整个文件读进内存（Release 资产最大 32MB，暂存文件上限 100MB）。
pub async fn download_to_file(
    url: &str,
    dest: &Path,
    expect_size: Option<u64>,
    expect_sha256: Option<&str>,
    max_bytes: u64,
) -> Result<FetchResult, Box<dyn Error + Send + Sync>> {
    let parsed = parse_url(url)?;
    let addr = resolve_addr(&parsed).await?;
    let tcp = tokio::net::TcpStream::connect(addr).await?;
    tcp.set_nodelay(true).ok();

    // 与 WS 路径一致：https 才做 TLS；http 仅用于本地开发（回环）
    let mut stream: Box<dyn AsyncReadWrite> = if parsed.tls {
        let config = crate::build_rustls_config()?;
        let connector = tokio_rustls::TlsConnector::from(config);
        let server_name = rustls::pki_types::ServerName::try_from(parsed.host.clone())
            .map_err(|e| format!("invalid SNI host {}: {}", parsed.host, e))?;
        Box::new(connector.connect(server_name, tcp).await?)
    } else {
        Box::new(tcp)
    };

    let req = format!(
        "GET {} HTTP/1.1\r\nHost: {}\r\nAccept: application/octet-stream\r\nUser-Agent: cf-panel-agent\r\nConnection: close\r\n\r\n",
        parsed.path_and_query,
        parsed.host_header()
    );
    stream.write_all(req.as_bytes()).await?;
    stream.flush().await?;

    // ---- 读响应头 ----
    let mut buf: Vec<u8> = Vec::with_capacity(8192);
    let mut tmp = vec![0u8; 8192];
    let head_end = loop {
        if let Some(p) = find_head_end(&buf) {
            break p;
        }
        if buf.len() > HEADER_MAX {
            return Err("response header too large".into());
        }
        let n = stream.read(&mut tmp).await?;
        if n == 0 {
            return Err("connection closed before response header".into());
        }
        buf.extend_from_slice(&tmp[..n]);
    };
    let (head, rest) = buf.split_at(head_end);
    let head_str = String::from_utf8_lossy(head).to_string();
    let mut lines = head_str.lines();
    let status_line = lines.next().ok_or("empty response")?;
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| format!("bad status line: {status_line}"))?;
    let mut content_length: Option<u64> = None;
    let mut chunked = false;
    for line in lines {
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        let key = k.trim().to_ascii_lowercase();
        let val = v.trim();
        if key == "content-length" {
            content_length = val.parse().ok();
        } else if key == "transfer-encoding" && val.to_ascii_lowercase().contains("chunked") {
            chunked = true;
        }
    }
    if status != 200 {
        return Err(format!("download failed: HTTP {status}").into());
    }
    if let (Some(exp), Some(got)) = (expect_size, content_length) {
        if exp != got {
            return Err(format!("size mismatch: expected {exp}, server says {got}").into());
        }
    }
    if let Some(cl) = content_length {
        if cl > max_bytes {
            return Err(format!("file too large: {cl} > {max_bytes}").into());
        }
    }

    // ---- 写文件（流式）----
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await.ok();
    }
    let mut file = std::fs::File::create(dest)?;
    let mut hasher = <sha2::Sha256 as sha2::Digest>::new();
    let mut written: u64 = 0;
    // 响应头之后已经读进来的字节先落盘
    let mut pending = rest.to_vec();

    let write_chunk = |data: &[u8],
                       file: &mut std::fs::File,
                       hasher: &mut sha2::Sha256,
                       written: &mut u64|
     -> Result<(), Box<dyn Error + Send + Sync>> {
        *written += data.len() as u64;
        if *written > max_bytes {
            return Err(format!("file too large: > {max_bytes}").into());
        }
        file.write_all(data)?;
        sha2::Digest::update(hasher, data);
        Ok(())
    };

    if chunked {
        // chunked：按 size 行逐块读，最后 0-size 块结束。pending 里可能已含有若干块数据。
        let mut raw = std::mem::take(&mut pending);
        loop {
            let (size, consumed) = match parse_chunk_size(&raw) {
                Some(v) => v,
                None => {
                    // 数据不够，继续读
                    if raw.len() > 32 {
                        return Err("bad chunk size line".into());
                    }
                    let n = stream.read(&mut tmp).await?;
                    if n == 0 {
                        return Err("connection closed in chunked body".into());
                    }
                    raw.extend_from_slice(&tmp[..n]);
                    continue;
                }
            };
            if size == 0 {
                break;
            }
            if raw.len() < consumed + size + 2 {
                let n = stream.read(&mut tmp).await?;
                if n == 0 {
                    return Err("connection closed mid-chunk".into());
                }
                raw.extend_from_slice(&tmp[..n]);
                continue;
            }
            write_chunk(
                &raw[consumed..consumed + size],
                &mut file,
                &mut hasher,
                &mut written,
            )?;
            raw.drain(..consumed + size + 2); // 末尾 CRLF
        }
    } else {
        write_chunk(&pending, &mut file, &mut hasher, &mut written)?;
        pending.clear();
        loop {
            let n = stream.read(&mut tmp).await?;
            if n == 0 {
                break;
            }
            write_chunk(&tmp[..n], &mut file, &mut hasher, &mut written)?;
        }
    }

    file.flush()?;
    drop(file);

    if let Some(exp) = expect_size {
        if written != exp {
            let _ = std::fs::remove_file(dest);
            return Err(format!("size mismatch after download: {written} != {exp}").into());
        }
    }
    if let Some(exp) = expect_sha256 {
        let got = hex_lower(&sha2::Digest::finalize(hasher));
        if !got.eq_ignore_ascii_case(exp) {
            let _ = std::fs::remove_file(dest);
            return Err(format!("sha256 mismatch: {got} != {exp}").into());
        }
    }
    Ok(FetchResult { bytes: written })
}

// ---------- 内部工具 ----------

trait AsyncReadWrite: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send {}
impl<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send> AsyncReadWrite for T {}

struct ParsedUrl {
    host: String,
    port: u16,
    tls: bool,
    path_and_query: String,
}

impl ParsedUrl {
    fn host_header(&self) -> String {
        let default_port = if self.tls { 443 } else { 80 };
        if self.port == default_port {
            self.host.clone()
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }
}

fn parse_url(url: &str) -> Result<ParsedUrl, Box<dyn Error + Send + Sync>> {
    let (tls, rest) = if let Some(r) = url.strip_prefix("https://") {
        (true, r)
    } else if let Some(r) = url.strip_prefix("http://") {
        (false, r)
    } else {
        return Err(format!("unsupported scheme: {url}").into());
    };
    let (authority, path_and_query) = match rest.find('/') {
        Some(i) => (&rest[..i], rest[i..].to_string()),
        None => (rest, "/".to_string()),
    };
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) if !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) => {
            (h.to_string(), p.parse::<u16>()?)
        }
        _ => (authority.to_string(), if tls { 443 } else { 80 }),
    };
    if host.is_empty() {
        return Err("url has no host".into());
    }
    Ok(ParsedUrl {
        host,
        port,
        tls,
        path_and_query,
    })
}

async fn resolve_addr(u: &ParsedUrl) -> Result<std::net::SocketAddr, Box<dyn Error + Send + Sync>> {
    crate::dns::resolve(&u.host, u.port)
        .await
        .ok_or_else(|| format!("dns resolve failed for {}", u.host).into())
}

fn find_head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4)
}

// 解析 chunked 的 "<hex>[;ext]\r\n"，返回 (块大小, 头部字节数)
fn parse_chunk_size(buf: &[u8]) -> Option<(usize, usize)> {
    let crlf = buf.windows(2).position(|w| w == b"\r\n")?;
    let line = std::str::from_utf8(&buf[..crlf]).ok()?;
    let hex = line.split(';').next()?.trim();
    let size = usize::from_str_radix(hex, 16).ok()?;
    Some((size, crlf + 2))
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_url_variants() {
        let u = parse_url("https://panel.example/mcp/upload-jobs/download?id=1&x=2").unwrap();
        assert!(u.tls);
        assert_eq!(u.host, "panel.example");
        assert_eq!(u.port, 443);
        assert_eq!(u.path_and_query, "/mcp/upload-jobs/download?id=1&x=2");
        assert_eq!(u.host_header(), "panel.example");

        let u = parse_url("http://127.0.0.1:8787/x").unwrap();
        assert!(!u.tls);
        assert_eq!(u.port, 8787);
        assert_eq!(u.host_header(), "127.0.0.1:8787");

        // 无路径 → "/"
        let u = parse_url("https://a.b").unwrap();
        assert_eq!(u.path_and_query, "/");

        assert!(parse_url("ftp://x/y").is_err());
    }

    #[test]
    fn chunk_size_parsing() {
        assert_eq!(parse_chunk_size(b"10\r\n"), Some((16, 4)));
        assert_eq!(parse_chunk_size(b"0\r\n\r\n"), Some((0, 3)));
        // "1a;ext=1" = 8 字节 + CRLF = 10
        assert_eq!(parse_chunk_size(b"1a;ext=1\r\n"), Some((26, 10)));
        assert_eq!(parse_chunk_size(b"1"), None, "无 CRLF 视为数据不足");
        assert_eq!(parse_chunk_size(b"zz\r\n"), None, "非法十六进制");
    }
}
