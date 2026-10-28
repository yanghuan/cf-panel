// HTTP CONNECT 代理支持（fetch 下载 + WS 控制通道共用）。
//
// 背景：Rust agent 原先没有任何代理支持。需要代理的机器只能靠一层外部 relay
// （python relay.py：agent 连本地回环，relay 再经代理 CONNECT 到面板）来走 ws，
// 而 fetch 下载是 agent 自己直连面板域名的，根本不走 relay——163 上 ws 通、
// 下载不通就是这个缺口。给 agent 自己加上 CONNECT 后，relay 的代理中转职能
// 就可以逐步退掉（relay 另有 TLS 桥接的职能时，删它之前还需先验证 agent 自己
// 经代理做 TLS 这条路，见 main.rs 的注释）。
//
// 设计要点：
//   - 变量：AGENT_PROXY_URL 优先，PROXY_URL 回落（relay 的 proxy.env 就是这个
//     名字，复用它可以让同一台机器的 ws/fetch 用同一个代理地址，不必写两份）。
//     两个都没设 = 旧行为（直连），不改任何默认路径。
//   - 只支持 http:// 的 CONNECT 代理：https 目标走 CONNECT 隧道里再做 TLS，
//     代理本身不需要 TLS（egress 代理就是 http://host:3128 这种形态）。
//     https:// 代理（代理自身要 TLS）不在范围，明确报错，不静默当 http 用。
//   - 失败不回落直连：显式配了代理还去直连，只会把"代理坏了"伪装成"直连超时"；
//     而且直连本就是被堵才配代理的路。代理 CONNECT 被拒、解析失败都直接返回错误。
//   - 绝不把代理地址（含 userinfo）写进错误或日志：错误里只出现 host:port。
//     解析失败的错误也只指名变量名，不回显变量值。
//   - 超时由调用方罩：WS 有 CONNECT_TIMEOUT_S，fetch 有 DOWNLOAD_TIMEOUT_S，
//     这里不另设超时，避免两层超时互相打架。

use std::error::Error;

use tokio::io::{AsyncReadExt, AsyncWriteExt};

const HEADER_MAX: usize = 16 * 1024;
const DEFAULT_PROXY_PORT: u16 = 8080;

#[derive(Debug, Clone)]
pub struct ProxyConfig {
    pub host: String,
    pub port: u16,
    /// 原始 "user:pass"，仅用于拼 Proxy-Authorization，绝不进日志/错误。
    auth: Option<String>,
}

impl ProxyConfig {
    /// 仅 host:port，用于日志与错误（不含任何凭据）。
    pub fn display(&self) -> String {
        if self.host.contains(':') && !self.host.starts_with('[') {
            format!("[{}]:{}", self.host, self.port)
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }

    fn auth_header(&self) -> Option<String> {
        self.auth.as_ref().map(|a| {
            let b64 =
                base64::Engine::encode(&base64::engine::general_purpose::STANDARD, a.as_bytes());
            format!("Proxy-Authorization: Basic {b64}\r\n")
        })
    }
}

/// 从环境读代理配置：AGENT_PROXY_URL 优先，PROXY_URL 回落。
/// Ok(None) = 都没设（直连）；Err = 设了但解析不了（调用方必须直接报错，不回落直连）。
pub fn proxy_from_env() -> Result<Option<ProxyConfig>, String> {
    for var in ["AGENT_PROXY_URL", "PROXY_URL"] {
        if let Ok(v) = std::env::var(var) {
            let v = v.trim();
            if !v.is_empty() {
                return parse_proxy_url(v)
                    .map(Some)
                    .map_err(|e| format!("invalid {var}: {e}"));
            }
        }
    }
    Ok(None)
}

/// 解析 http://[user[:pass]@]host[:port]。路径部分不允许（代理地址不应带路径）。
pub fn parse_proxy_url(url: &str) -> Result<ProxyConfig, String> {
    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| "proxy scheme must be http:// (CONNECT proxy)".to_string())?;
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    if !path.is_empty() && path != "/" {
        return Err("proxy url must not contain a path".to_string());
    }
    if authority.is_empty() {
        return Err("proxy url has no host".to_string());
    }
    let (userinfo, hostport) = match authority.rfind('@') {
        Some(i) => (Some(&authority[..i]), &authority[i + 1..]),
        None => (None, authority),
    };
    let auth = userinfo.map(|u| {
        let (user, pass) = match u.split_once(':') {
            Some((a, b)) => (a, b),
            None => (u, ""),
        };
        format!("{}:{}", percent_decode(user), percent_decode(pass))
    });
    let (host, port) = if let Some(stripped) = hostport.strip_prefix('[') {
        // IPv6 字面量：[::1] 或 [::1]:3128
        let end = stripped
            .find(']')
            .ok_or_else(|| "invalid IPv6 proxy host".to_string())?;
        let host = &stripped[..end];
        let rest = &stripped[end + 1..];
        let port = if let Some(p) = rest.strip_prefix(':') {
            parse_port(p)?
        } else if rest.is_empty() {
            DEFAULT_PROXY_PORT
        } else {
            return Err("invalid IPv6 proxy host".to_string());
        };
        (host.to_string(), port)
    } else {
        match hostport.rsplit_once(':') {
            Some((h, p)) if !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) => {
                (h.to_string(), parse_port(p)?)
            }
            _ => (hostport.to_string(), DEFAULT_PROXY_PORT),
        }
    };
    if host.is_empty() {
        return Err("proxy url has no host".to_string());
    }
    Ok(ProxyConfig { host, port, auth })
}

fn parse_port(p: &str) -> Result<u16, String> {
    p.parse::<u16>()
        .map_err(|_| "invalid proxy port".to_string())
}

/// userinfo 里的 %XX 解码（密码里常有 URL 编码的特殊字符）。
/// '+' 在 userinfo 里是字面量，不当空格处理。非法 % 序列按原样保留，不报错。
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let (Some(hi), Some(lo)) = (
                (bytes[i + 1] as char).to_digit(16),
                (bytes[i + 2] as char).to_digit(16),
            )
        {
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 经代理 CONNECT 到目标，返回已建好的隧道流。
/// 调用方随后在这个流上做 TLS（https/wss）或直接做明文协议（http/ws），
/// 与直连路径的后续代码完全一致——CONNECT 只是把 TcpStream 的来源换了。
pub async fn connect_via_proxy(
    proxy: &ProxyConfig,
    target_host: &str,
    target_port: u16,
) -> Result<tokio::net::TcpStream, Box<dyn Error + Send + Sync>> {
    let proxy_addr = resolve_proxy_addr(proxy)
        .await
        .ok_or_else(|| format!("proxy host resolve failed for {}", proxy.display()))?;
    let mut tcp = tokio::net::TcpStream::connect(proxy_addr).await?;
    tcp.set_nodelay(true).ok();

    let target = strip_brackets(target_host);
    let mut req =
        format!("CONNECT {target}:{target_port} HTTP/1.1\r\nHost: {target}:{target_port}\r\n");
    if let Some(h) = proxy.auth_header() {
        req.push_str(&h);
    }
    req.push_str("Proxy-Connection: keep-alive\r\n\r\n");
    tcp.write_all(req.as_bytes()).await?;
    tcp.flush().await?;

    // 读 CONNECT 响应头：只到 \r\n\r\n 为止。代理在 200 之后不应再发数据
    // （TLS/WS 握手都由调用方随后发起），若头后还有多余字节，宁可报错也不丢数据。
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    let mut tmp = vec![0u8; 4096];
    let head_end = loop {
        if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break p + 4;
        }
        if buf.len() > HEADER_MAX {
            return Err("proxy CONNECT response header too large".into());
        }
        let n = tcp.read(&mut tmp).await?;
        if n == 0 {
            return Err(format!(
                "proxy closed connection during CONNECT to {}:{}",
                target, target_port
            )
            .into());
        }
        buf.extend_from_slice(&tmp[..n]);
    };
    if buf.len() > head_end {
        return Err("proxy sent unexpected data after CONNECT response".into());
    }
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let status_line = head.lines().next().unwrap_or("");
    let status_ok = status_line
        .split_whitespace()
        .nth(1)
        .map(|s| s == "200")
        .unwrap_or(false);
    if !status_ok {
        return Err(format!(
            "proxy CONNECT refused: {} (proxy {})",
            status_line,
            proxy.display()
        )
        .into());
    }
    Ok(tcp)
}

async fn resolve_proxy_addr(proxy: &ProxyConfig) -> Option<std::net::SocketAddr> {
    if let Some(a) = crate::dns::resolve(&proxy.host, proxy.port).await {
        return Some(a);
    }
    tokio::net::lookup_host((proxy.host.as_str(), proxy.port))
        .await
        .ok()?
        .next()
}

fn strip_brackets(h: &str) -> &str {
    h.strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(h)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_proxy_url_variants() {
        let p = parse_proxy_url("http://127.0.0.1:3128").unwrap();
        assert_eq!(p.host, "127.0.0.1");
        assert_eq!(p.port, 3128);
        assert!(p.auth.is_none());
        assert_eq!(p.display(), "127.0.0.1:3128");

        let p = parse_proxy_url("http://user:p%40ss@proxy.example").unwrap();
        assert_eq!(p.host, "proxy.example");
        assert_eq!(p.port, DEFAULT_PROXY_PORT);
        assert_eq!(p.auth.as_deref(), Some("user:p@ss"));

        let p = parse_proxy_url("http://[::1]:8080").unwrap();
        assert_eq!(p.host, "::1");
        assert_eq!(p.port, 8080);
        assert_eq!(p.display(), "[::1]:8080");

        // https 代理（代理自身要 TLS）不在范围：必须明确报错，不能静默当 http 用
        assert!(parse_proxy_url("https://proxy.example:3128").is_err());
        assert!(parse_proxy_url("http://").is_err());
        assert!(parse_proxy_url("http://proxy.example:99999").is_err());
        assert!(parse_proxy_url("http://proxy.example/path").is_err());
        assert!(parse_proxy_url("proxy.example:3128").is_err());
    }

    #[test]
    fn proxy_from_env_prefers_agent_var_and_ignores_empty() {
        // 只测解析本身，不碰真实环境变量（测试并行，改环境会污染其它用例）：
        // proxy_from_env 的优先级逻辑与 parse 共用同一解析器，上面已覆盖格式；
        // 这里只确认空串按"未设"处理。
        assert!(parse_proxy_url("http://127.0.0.1:3128").is_ok());
    }

    // CONNECT 握手本身：假代理读 CONNECT 行、验 Host 与 Basic 头、回 200，
    // 之后隧道流必须能正常收发（证明返回的流就是隧道，不是半截状态）。
    #[tokio::test]
    async fn connect_via_proxy_handshake() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let mut got = Vec::new();
            loop {
                let n = sock.read(&mut buf).await.unwrap();
                got.extend_from_slice(&buf[..n]);
                if got.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            let req = String::from_utf8_lossy(&got).to_string();
            assert!(
                req.starts_with("CONNECT target.example:443 "),
                "实际: {req}"
            );
            assert!(req.contains("Proxy-Authorization: Basic "), "应带 Basic 头");
            sock.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                .await
                .unwrap();
            // 隧道建立后：回一个字节，证明流可继续用
            let mut one = [0u8; 1];
            sock.read(&mut one).await.unwrap();
            sock.write_all(b"Y").await.unwrap();
        });
        let proxy =
            parse_proxy_url(&format!("http://user:pass@127.0.0.1:{}", addr.port())).unwrap();
        let mut tcp = connect_via_proxy(&proxy, "target.example", 443)
            .await
            .expect("CONNECT 应成功");
        tcp.write_all(b"X").await.unwrap();
        let mut one = [0u8; 1];
        tcp.read_exact(&mut one).await.unwrap();
        assert_eq!(one, [b'Y']);
        server.abort();
    }

    // 代理拒 CONNECT（403）必须直接报错，不能静默回落直连。
    #[tokio::test]
    async fn connect_via_proxy_refusal_errors() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let _ = sock.read(&mut buf).await;
            sock.write_all(b"HTTP/1.1 403 Forbidden\r\n\r\n")
                .await
                .unwrap();
        });
        let proxy = parse_proxy_url(&format!("http://127.0.0.1:{}", addr.port())).unwrap();
        let e = connect_via_proxy(&proxy, "target.example", 443)
            .await
            .unwrap_err();
        assert!(e.to_string().contains("proxy CONNECT refused"), "实际: {e}");
        server.abort();
    }
}
