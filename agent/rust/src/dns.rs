//! 极简 DNS 客户端：绕开 libc 的 `getaddrinfo`，照 glibc 的模式发查询。
//!
//! **为什么需要它**：musl 静态链接时，`getaddrinfo` 走 musl 自带的解析器，其 UDP 发送用的是
//! **未连接 socket + `sendmsg(msg_name=目的地址)`**（等价 `sendto`）。某些沙箱/受限网络把
//! "未连接 UDP 发包"一律判 `EPERM`，于是解析必然失败（表现为 `failed to lookup address
//! information: Try again` = `EAI_AGAIN`），且重连退避会把它拖成"半天不动"。
//! glibc 的解析器用的是 `connect(名字服务器) + send()`，能通过同一策略——本模块就照这个模式：
//!
//! ```text
//! UdpSocket::bind → connect(nameserver) → send(query) → recv
//! ```
//!
//! **刻意只做一件事**：把一个 FQDN 解析成 IP（A 优先、AAAA 兜底）。不解析 `search`/`domain`
//! 后缀补全（我们解析的始终是配置里的完整域名）、不做 CNAME 之外的重定向、不支持 EDNS/DNSSEC。
//! 任何一步失败都返回 `None`，由调用方回退到系统解析器——**绝不让本模块成为单点**。
//!
//! 安全：应答报文是不可信网络输入。所有读取都走 `slice::get`（无越界 panic）、压缩指针有跳转
//! 次数与名字长度上限（防自引用回环）、记录数有上限。测试里对合法报文做了全前缀截断遍历。

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use tokio::net::UdpSocket;

const RESOLV_CONF: &str = "/etc/resolv.conf";
const HOSTS_FILE: &str = "/etc/hosts";

const DNS_PORT: u16 = 53; // 生产恒用 53；测试通过 query_to/resolve_on 注入本地端口
const QUERY_TIMEOUT: Duration = Duration::from_secs(2); // 单个名字服务器单次查询
const MAX_NAMESERVERS: usize = 2; // 只试前两个：connect 总预算 15s，不能全花在解析上
const MAX_RECORDS: usize = 64; // 应答里最多处理的记录数
const MAX_POINTER_HOPS: u8 = 8; // 压缩指针最多跳转次数（防自引用回环）
const MAX_NAME_LEN: usize = 255; // DNS 名字总长上限（RFC 1035）
const MAX_LABEL_LEN: usize = 63;

const QTYPE_A: u16 = 1;
const QTYPE_AAAA: u16 = 28;
const QCLASS_IN: u16 = 1;

/// 解析主机名 → SocketAddr。顺序：IP 字面量 → `/etc/hosts` → UDP DNS。
/// 任一环节失败返回 None，由调用方回退系统解析器（见 `main::connect_ws_inner`）。
pub async fn resolve(host: &str, port: u16) -> Option<SocketAddr> {
    // IP 字面量：直接返回（与 libc 行为一致，也省掉一次 DNS）。
    // 必须容忍方括号：`http::Uri::host()` 对 IPv6 返回的是 "[::1]" 形式（RFC 3986），
    // 直接 parse::<IpAddr>() 会失败，然后掉进 DNS 分支发出一个域名里带方括号的非法查询，
    // 最终白跑一趟再回落系统解析器——只有 IPv6 的环境里等于完全失效。
    if let Some(ip) = parse_ip(host) {
        return Some(SocketAddr::new(ip, port));
    }
    let name = strip_brackets(host).trim_end_matches('.');
    if name.is_empty() || name.len() > MAX_NAME_LEN {
        return None;
    }
    // /etc/hosts 优先（glibc/musl 都先查它；自建面板常用 hosts 指向内网/回环）
    if let Ok(text) = tokio::fs::read_to_string(HOSTS_FILE).await {
        if let Some(ip) = hosts_lookup(&text, name) {
            return Some(SocketAddr::new(ip, port));
        }
    }
    let conf = tokio::fs::read_to_string(RESOLV_CONF).await.ok()?;
    let servers = parse_resolv_conf(&conf);
    if servers.is_empty() {
        return None;
    }
    resolve_on(&servers, DNS_PORT, name, port).await
}

/// A 与 AAAA **并行**发起，两者都拿不到才算失败；结果优先取 A（v4 优先）。
///
/// 并行是必要的：串行（先 A 再 AAAA）在名字服务器不可达时最坏要等
/// 2 × MAX_NAMESERVERS × QUERY_TIMEOUT（默认 8s），而 DNS 阶段又被 15s 的连接总超时罩着，
/// 很容易把重连预算吃光。并行后最坏 ≈ 4s（两条链同时跑）。
///
/// 优先 A 是刻意的：受限网络常整段禁掉 IPv6 出口，若优先返回 AAAA，连接会直接失败
///（连接层不做 v4/v6 回退，只连解析出的那一个地址）。IPv6-only 主机没有 A 记录，
/// 解析器会快速返回 NXDOMAIN，并行结构让这种情况不必等 A 的超时。
async fn resolve_on(
    servers: &[IpAddr],
    dns_port: u16,
    name: &str,
    port: u16,
) -> Option<SocketAddr> {
    let (v4, v6) = tokio::join!(
        query_any(servers, dns_port, name, QTYPE_A),
        query_any(servers, dns_port, name, QTYPE_AAAA),
    );
    v4.or(v6).map(|ip| SocketAddr::new(ip, port))
}

/// 依次问各个名字服务器（最多 MAX_NAMESERVERS 个），第一个给出地址的胜出。
async fn query_any(servers: &[IpAddr], port: u16, host: &str, qtype: u16) -> Option<IpAddr> {
    for server in servers.iter().take(MAX_NAMESERVERS) {
        if let Some(ip) = query_to(*server, port, host, qtype)
            .await
            .and_then(|v| v.into_iter().next())
        {
            return Some(ip);
        }
    }
    None
}

/// 去掉 URL 风格的方括号与首尾空白（`"[::1]"` → `"::1"`）。
fn strip_brackets(h: &str) -> &str {
    let t = h.trim();
    t.strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(t)
}

/// 解析 IP 字面量，容忍方括号与空白（URL 的 host、`AGENT_WSS_IP` 都可能是这两种形式）。
pub fn parse_ip(s: &str) -> Option<IpAddr> {
    strip_brackets(s).parse().ok()
}

// ---------------- 传输 ----------------

/// 向单个名字服务器发一次查询。**connect + send**——本模块存在的理由就是这两行。
///
/// `port` 只为测试可注入（本地假 DNS 服务端绑不到 53）：生产路径恒用 `DNS_PORT`。
async fn query_to(server: IpAddr, port: u16, host: &str, qtype: u16) -> Option<Vec<IpAddr>> {
    let bind_addr: SocketAddr = match server {
        IpAddr::V4(_) => (Ipv4Addr::UNSPECIFIED, 0).into(),
        IpAddr::V6(_) => (Ipv6Addr::UNSPECIFIED, 0).into(),
    };
    let sock = UdpSocket::bind(bind_addr).await.ok()?;
    sock.connect(SocketAddr::new(server, port)).await.ok()?;
    let id = query_id(host, qtype);
    let packet = build_query(id, host, qtype)?;
    tokio::time::timeout(QUERY_TIMEOUT, async {
        sock.send(&packet).await.ok()?;
        let mut buf = [0u8; 1500];
        // 已连接 socket 仍可能收到过期应答（端口复用/迟到包）：ID 不匹配的丢弃后继续等
        loop {
            let n = sock.recv(&mut buf).await.ok()?;
            if n < 12 {
                continue;
            }
            if u16::from_be_bytes([buf[0], buf[1]]) != id {
                continue;
            }
            return parse_response(&buf[..n], id, qtype).ok();
        }
    })
    .await
    .ok()
    .flatten()
    .filter(|v| !v.is_empty())
}

fn query_id(host: &str, qtype: u16) -> u16 {
    // 无 rand 依赖：时间纳秒 + 主机/qtype 混合。已连接 socket 由内核按源地址/端口过滤，
    // ID 只用于区分同一 socket 上的迟到应答，不承担抗投毒职责。
    let mut h: u64 = qtype as u64;
    for b in host.as_bytes() {
        h = h.wrapping_mul(31).wrapping_add(*b as u64);
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64 ^ d.as_secs())
        .unwrap_or(0);
    (h ^ now) as u16
}

// ---------------- 报文构造 ----------------

/// 构造查询报文（无压缩——问题段的 QNAME 允许直接写完整标签）。
/// 返回 None 表示域名不合法（空标签/超长），交由调用方回退系统解析器。
pub fn build_query(id: u16, host: &str, qtype: u16) -> Option<Vec<u8>> {
    let mut v = Vec::with_capacity(32 + host.len());
    v.extend_from_slice(&id.to_be_bytes());
    v.extend_from_slice(&[0x01, 0x00]); // flags：RD=1（期望递归）
    v.extend_from_slice(&1u16.to_be_bytes()); // QDCOUNT
    v.extend_from_slice(&[0; 6]); // ANCOUNT/NSCOUNT/ARCOUNT
    for label in host.split('.') {
        let b = label.as_bytes();
        if b.is_empty() || b.len() > MAX_LABEL_LEN {
            return None;
        }
        v.push(b.len() as u8);
        v.extend_from_slice(b);
    }
    v.push(0); // 根标签
    v.extend_from_slice(&qtype.to_be_bytes());
    v.extend_from_slice(&QCLASS_IN.to_be_bytes());
    Some(v)
}

// ---------------- 报文解析 ----------------

/// 解析应答报文，取出请求类型的 A/AAAA 记录。
/// 只扫描应答段里**类型匹配**的记录——递归解析器会把 CNAME 链一起放进应答段，
/// 按类型过滤即可自然穿透到链尾的真实地址。
pub fn parse_response(buf: &[u8], id: u16, qtype: u16) -> Result<Vec<IpAddr>, &'static str> {
    if buf.len() < 12 {
        return Err("short header");
    }
    if u16::from_be_bytes([buf[0], buf[1]]) != id {
        return Err("id mismatch");
    }
    let flags = u16::from_be_bytes([buf[2], buf[3]]);
    if flags & 0x8000 == 0 {
        return Err("not a response");
    }
    if flags & 0x0200 != 0 {
        return Err("truncated (TC)");
    }
    if flags & 0x000F != 0 {
        return Err("rcode non-zero");
    }
    let qd = u16::from_be_bytes([buf[4], buf[5]]) as usize;
    let an = u16::from_be_bytes([buf[6], buf[7]]) as usize;
    let mut pos = 12;
    for _ in 0..qd {
        // 问题段：NAME + QTYPE(2) + QCLASS(2)
        pos = skip_name(buf, pos)?.checked_add(4).ok_or("overflow")?;
        if pos > buf.len() {
            return Err("question truncated");
        }
    }
    let mut out = Vec::new();
    for _ in 0..an.min(MAX_RECORDS) {
        pos = skip_name(buf, pos)?;
        // 固定头：TYPE(2) CLASS(2) TTL(4) RDLENGTH(2)
        let head = buf.get(pos..pos + 10).ok_or("rr header truncated")?;
        let rtype = u16::from_be_bytes([head[0], head[1]]);
        let rclass = u16::from_be_bytes([head[2], head[3]]);
        let rdlen = u16::from_be_bytes([head[8], head[9]]) as usize;
        pos += 10;
        let rdata = buf.get(pos..pos + rdlen).ok_or("rdata truncated")?;
        pos += rdlen;
        if rclass != QCLASS_IN {
            continue;
        }
        if rtype == QTYPE_A && qtype == QTYPE_A && rdlen == 4 {
            out.push(IpAddr::V4(Ipv4Addr::new(
                rdata[0], rdata[1], rdata[2], rdata[3],
            )));
        } else if rtype == QTYPE_AAAA && qtype == QTYPE_AAAA && rdlen == 16 {
            let mut o = [0u8; 16];
            o.copy_from_slice(rdata);
            out.push(IpAddr::V6(Ipv6Addr::from(o)));
        }
    }
    Ok(out)
}

/// 跳过（并消费）一个域名编码，返回其后第一个字节的下标。
/// 支持压缩指针（0xC0）：遇到指针时记下"跳转前应返回的位置"，再跳到目标继续读。
/// 有跳转次数与总长上限——自引用指针（指向自己）会因此在有限步内报错而非死循环。
fn skip_name(buf: &[u8], start: usize) -> Result<usize, &'static str> {
    let mut pos = start;
    let mut hops: u8 = 0;
    let mut after_pointer: Option<usize> = None;
    let mut total = 0usize;
    loop {
        let b = *buf.get(pos).ok_or("name out of bounds")?;
        if b == 0 {
            return Ok(after_pointer.unwrap_or(pos + 1));
        }
        if b & 0xC0 == 0xC0 {
            let b2 = *buf.get(pos + 1).ok_or("pointer out of bounds")?;
            let target = (((b & 0x3F) as usize) << 8) | b2 as usize;
            if after_pointer.is_none() {
                after_pointer = Some(pos + 2);
            }
            hops += 1;
            if hops > MAX_POINTER_HOPS {
                return Err("pointer loop");
            }
            total += 2;
            if total > MAX_NAME_LEN {
                return Err("name too long");
            }
            pos = target;
            continue;
        }
        if b & 0xC0 != 0 {
            return Err("reserved label type");
        }
        let l = b as usize;
        if l == 0 || l > MAX_LABEL_LEN {
            return Err("bad label length");
        }
        total += l + 1;
        if total > MAX_NAME_LEN {
            return Err("name too long");
        }
        pos = pos.checked_add(1 + l).ok_or("overflow")?;
    }
}

// ---------------- 配置文件解析 ----------------

/// 解析 `/etc/resolv.conf` 的 `nameserver` 行（去重、保留顺序）。
/// 只认这一个指令：`search`/`domain`/`options` 与我们无关（解析的始终是完整域名）。
pub fn parse_resolv_conf(text: &str) -> Vec<IpAddr> {
    let mut out: Vec<IpAddr> = Vec::new();
    for line in text.lines() {
        let line = line.split(['#', ';']).next().unwrap_or("").trim();
        let mut it = line.split_whitespace();
        if it.next() != Some("nameserver") {
            continue;
        }
        // 带 %iface 作用域的 IPv6（fe80::1%eth0）解析失败 → 跳过：链路本地地址无意义
        if let Some(Ok(ip)) = it.next().map(str::parse::<IpAddr>) {
            if !out.contains(&ip) {
                out.push(ip);
            }
        }
    }
    out
}

/// 在 `/etc/hosts` 内容里查主机名（精确匹配，大小写不敏感；支持同一行的别名）。
pub fn hosts_lookup(text: &str, host: &str) -> Option<IpAddr> {
    let want = host.trim_end_matches('.');
    for line in text.lines() {
        let line = line.split('#').next().unwrap_or("").trim();
        let mut it = line.split_whitespace();
        let Some(Ok(ip)) = it.next().map(str::parse::<IpAddr>) else {
            continue;
        };
        if it.any(|name| name.eq_ignore_ascii_case(want)) {
            return Some(ip);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造一个应答报文：头部 + 一个问题段（qname 在 12 处）+ 若干应答记录。
    fn response(id: u16, qname: &str, flags: u16, answers: &[(u16, u16, Vec<u8>)]) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&id.to_be_bytes());
        v.extend_from_slice(&flags.to_be_bytes());
        v.extend_from_slice(&1u16.to_be_bytes()); // QDCOUNT
        v.extend_from_slice(&(answers.len() as u16).to_be_bytes());
        v.extend_from_slice(&[0; 4]); // NSCOUNT/ARCOUNT
        let qname_at = v.len();
        for label in qname.split('.') {
            v.push(label.len() as u8);
            v.extend_from_slice(label.as_bytes());
        }
        v.push(0);
        v.extend_from_slice(&QTYPE_A.to_be_bytes());
        v.extend_from_slice(&QCLASS_IN.to_be_bytes());
        for (rtype, rclass, rdata) in answers {
            // 应答记录名字用压缩指针指回问题段（真实解析器的常见做法）
            v.push(0xC0);
            v.push(qname_at as u8);
            v.extend_from_slice(&rtype.to_be_bytes());
            v.extend_from_slice(&rclass.to_be_bytes());
            v.extend_from_slice(&[0, 0, 0, 60]); // TTL
            v.extend_from_slice(&(rdata.len() as u16).to_be_bytes());
            v.extend_from_slice(rdata);
        }
        v
    }

    const OK: u16 = 0x8180; // QR=1, RD=1, RA=1, RCODE=0

    #[test]
    fn build_query_shape() {
        let q = build_query(0x1234, "a.bc", QTYPE_A).unwrap();
        assert_eq!(
            q,
            vec![
                0x12, 0x34, // ID
                0x01, 0x00, // RD
                0x00, 0x01, // QDCOUNT
                0, 0, 0, 0, 0, 0, // AN/NS/AR
                0x01, b'a', // "a"
                0x02, b'b', b'c', // "bc"
                0x00, // 根
                0x00, 0x01, // QTYPE=A
                0x00, 0x01, // QCLASS=IN
            ]
        );
        // 非法域名：空标签 / 超长标签 → None（调用方回退系统解析器，不抛错）
        assert!(build_query(1, "a..b", QTYPE_A).is_none());
        assert!(build_query(1, &format!("{}.com", "x".repeat(64)), QTYPE_A).is_none());
    }

    #[test]
    fn parse_a_and_aaaa() {
        let buf = response(
            7,
            "p.example.com",
            OK,
            &[(QTYPE_A, QCLASS_IN, vec![1, 2, 3, 4])],
        );
        assert_eq!(
            parse_response(&buf, 7, QTYPE_A).unwrap(),
            vec![IpAddr::V4(Ipv4Addr::new(1, 2, 3, 4))]
        );
        // qtype 不匹配 → 不采纳（调用方另发 AAAA 查询）
        assert!(parse_response(&buf, 7, QTYPE_AAAA).unwrap().is_empty());

        let v6 = vec![0x20, 0x01, 0xd, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
        let buf6 = response(9, "p.example.com", OK, &[(QTYPE_AAAA, QCLASS_IN, v6)]);
        let got = parse_response(&buf6, 9, QTYPE_AAAA).unwrap();
        assert_eq!(got.len(), 1);
        assert!(matches!(got[0], IpAddr::V6(_)));
    }

    #[test]
    fn parse_cname_chain_reaches_a() {
        // 递归解析器把 CNAME 链一起放进应答段：按类型过滤要能穿透到链尾的 A
        let cname = {
            let mut v = Vec::new();
            for label in "cdn.example.net".split('.') {
                v.push(label.len() as u8);
                v.extend_from_slice(label.as_bytes());
            }
            v.push(0);
            v
        };
        let buf = response(
            3,
            "p.example.com",
            OK,
            &[
                (5 /* CNAME */, QCLASS_IN, cname),
                (QTYPE_A, QCLASS_IN, vec![5, 6, 7, 8]),
            ],
        );
        assert_eq!(
            parse_response(&buf, 3, QTYPE_A).unwrap(),
            vec![IpAddr::V4(Ipv4Addr::new(5, 6, 7, 8))]
        );
    }

    #[test]
    fn parse_rejects_bad_packets() {
        let ok = response(
            7,
            "p.example.com",
            OK,
            &[(QTYPE_A, QCLASS_IN, vec![1, 2, 3, 4])],
        );
        assert!(parse_response(&ok, 8, QTYPE_A).is_err(), "ID 不匹配");
        assert!(
            parse_response(&response(7, "p.example.com", 0x0180, &[]), 7, QTYPE_A).is_err(),
            "QR=0 不是应答"
        );
        assert!(
            parse_response(&response(7, "p.example.com", 0x8380, &[]), 7, QTYPE_A).is_err(),
            "TC 置位"
        );
        assert!(
            parse_response(&response(7, "p.example.com", 0x8183, &[]), 7, QTYPE_A).is_err(),
            "NXDOMAIN"
        );
        assert!(parse_response(&[], 7, QTYPE_A).is_err());
    }

    #[test]
    fn parse_never_panics_on_truncation() {
        // 应答是不可信输入：对合法报文的**每个前缀**都要么 Err 要么 Ok，绝不能 panic/越界。
        // 这条覆盖了 skip_name / rdata 切片 / 固定头读取的全部边界。
        let ok = response(
            7,
            "p.example.com",
            OK,
            &[(QTYPE_A, QCLASS_IN, vec![1, 2, 3, 4])],
        );
        for n in 0..=ok.len() {
            let _ = parse_response(&ok[..n], 7, QTYPE_A);
        }
        // 同时验证解析器确实能从完整报文里取出地址（避免上面全是 Err 也算通过）
        assert_eq!(parse_response(&ok, 7, QTYPE_A).unwrap().len(), 1);
    }

    #[test]
    fn pointer_loop_is_bounded() {
        // 自引用指针：名字指向它自己。必须有限步报错，不能死循环。
        let buf = vec![
            0, 7, 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0, // 头
            0xC0, 12, // 问题段 QNAME → 指向自己
            0, 1, 0, 1, // QTYPE/QCLASS
            0xC0, 12, // 应答段 NAME → 又指回去
            0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 1, 2, 3, 4,
        ];
        assert!(parse_response(&buf, 7, QTYPE_A).is_err());
    }

    #[test]
    fn parse_resolv_conf_variants() {
        let text = "# comment\n\
                    nameserver 10.0.0.1   # 主\n\
                    nameserver fe80::1%eth0\n\
                    nameserver 10.0.0.1\n\
                    search corp.example\n\
                    options timeout:1\n\
                    ; 另一种注释\n\
                    nameserver 2001:4860:4860::8888\n\
                    garbage\n";
        let got = parse_resolv_conf(text);
        assert_eq!(
            got,
            vec![
                "10.0.0.1".parse::<IpAddr>().unwrap(),
                "2001:4860:4860::8888".parse::<IpAddr>().unwrap(),
            ],
            "去重、跳过带作用域的地址与非 nameserver 行"
        );
        assert!(parse_resolv_conf("").is_empty());
        assert!(parse_resolv_conf("nameserver not-an-ip\n").is_empty());
    }

    #[test]
    fn hosts_lookup_variants() {
        let text = "# hosts\n\
                    127.0.0.1   localhost localhost.localdomain\n\
                    10.0.0.5    Panel.Local  panel-alias\n\
                    ::1         ip6-localhost\n";
        assert_eq!(
            hosts_lookup(text, "panel.local"),
            Some("10.0.0.5".parse().unwrap()),
            "大小写不敏感"
        );
        assert_eq!(
            hosts_lookup(text, "panel-alias"),
            Some("10.0.0.5".parse().unwrap()),
            "首个地址后的别名"
        );
        assert_eq!(
            hosts_lookup(text, "localhost."),
            Some("127.0.0.1".parse().unwrap()),
            "尾点等价"
        );
        assert_eq!(
            hosts_lookup(text, "ip6-localhost"),
            Some("::1".parse().unwrap())
        );
        assert_eq!(hosts_lookup(text, "not-there"), None);
        // 行内注释后不得继续当主机名匹配
        assert_eq!(hosts_lookup("10.0.0.9 a # b", "b"), None);
    }

    /// 极简假 DNS 服务端（仅测试用）：只答给定的 (qtype, rdata)，其余 qtype 回 NXDOMAIN。
    /// 用来补齐此前只测"解析"、不测"真的发出去、真的收回来"的空白。
    async fn fake_dns(
        answers: Vec<(u16, Vec<u8>)>,
    ) -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
        let sock = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let addr = sock.local_addr().unwrap();
        let h = tokio::spawn(async move {
            let mut buf = [0u8; 1500];
            loop {
                let Ok((n, from)) = sock.recv_from(&mut buf).await else {
                    break;
                };
                if n < 12 {
                    continue;
                }
                let Ok(qend) = skip_name(&buf[..n], 12) else {
                    continue;
                };
                let Some(qt) = buf.get(qend..qend + 2) else {
                    continue;
                };
                let qtype = u16::from_be_bytes([qt[0], qt[1]]);
                let hit = answers.iter().find(|(t, _)| *t == qtype);
                let mut out = Vec::new();
                out.extend_from_slice(&buf[0..2]); // 回同样的 ID
                out.extend_from_slice(
                    &(if hit.is_some() { 0x8180u16 } else { 0x8183u16 }).to_be_bytes(),
                ); // RCODE 3=NXDOMAIN
                out.extend_from_slice(&1u16.to_be_bytes()); // QDCOUNT
                out.extend_from_slice(&(if hit.is_some() { 1u16 } else { 0u16 }).to_be_bytes());
                out.extend_from_slice(&[0; 4]); // NSCOUNT/ARCOUNT
                out.extend_from_slice(&buf[12..qend + 4]); // 问题段原样回
                if let Some((_, rdata)) = hit {
                    out.push(0xC0);
                    out.push(12); // 应答名字用压缩指针指回问题段
                    out.extend_from_slice(&qtype.to_be_bytes());
                    out.extend_from_slice(&QCLASS_IN.to_be_bytes());
                    out.extend_from_slice(&[0, 0, 0, 60]); // TTL
                    out.extend_from_slice(&(rdata.len() as u16).to_be_bytes());
                    out.extend_from_slice(rdata);
                }
                let _ = sock.send_to(&out, from).await;
            }
        });
        (addr, h)
    }

    #[tokio::test]
    async fn query_roundtrip_and_a_preference() {
        let v6: Vec<u8> = "2001:db8::7".parse::<Ipv6Addr>().unwrap().octets().to_vec();
        let (dns, srv) = fake_dns(vec![
            (QTYPE_A, vec![203, 0, 113, 7]),
            (QTYPE_AAAA, v6.clone()),
        ])
        .await;
        let (ip, port) = (dns.ip(), dns.port());

        // 1) 真发一次查询、真收一次应答、真解析出地址（此前只覆盖到"解析合成报文"）
        assert_eq!(
            query_to(ip, port, "p.example.com", QTYPE_A).await,
            Some(vec![IpAddr::V4(Ipv4Addr::new(203, 0, 113, 7))])
        );
        assert_eq!(
            query_to(ip, port, "p.example.com", QTYPE_AAAA).await,
            Some(vec![IpAddr::V6("2001:db8::7".parse().unwrap())])
        );
        // 2) 服务端不认的 qtype → NXDOMAIN → None
        assert_eq!(query_to(ip, port, "p.example.com", 99).await, None);

        // 3) A 与 AAAA 都在时必须取 A（v4 优先；连接受限网络常整段禁 v6）
        assert_eq!(
            resolve_on(&[ip], port, "p.example.com", 443).await,
            Some("203.0.113.7:443".parse().unwrap()),
            "同时候选时 A 优先"
        );

        // 4) 只有 AAAA 时才回退到 v6（IPv6-only 主机的情形）
        let (dns6, srv6) = fake_dns(vec![(QTYPE_AAAA, v6)]).await;
        assert_eq!(
            resolve_on(&[dns6.ip()], dns6.port(), "only6.example.com", 443).await,
            Some("[2001:db8::7]:443".parse().unwrap()),
            "无 A 记录时用 AAAA"
        );
        srv.abort();
        srv6.abort();
    }

    #[test]
    fn a_and_aaaa_are_queried_in_parallel() {
        // 串行（先 A 再 AAAA）在名字服务器不可达时最坏要 2 × MAX_NAMESERVERS × QUERY_TIMEOUT
        // （默认 8s），而整个解析阶段被 15s 的连接总超时罩着——退化成串行没有任何功能症状，
        // 只是变慢，所以在这里锁结构。
        let prod = include_str!("dns.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap_or("");
        let join_needle = concat!("tokio::", "join!(");
        assert!(prod.contains(join_needle), "A 与 AAAA 必须并行发起");
        let seq_needle = concat!("for qtype in [", "QTYPE_A, QTYPE_AAAA]");
        assert!(!prod.contains(seq_needle), "不得退回串行的 qtype 循环");
    }

    #[test]
    fn transport_must_connect_before_send() {
        // 本模块存在的唯一理由：UDP 必须**先 connect 再 send**。
        // 沙箱把"未连接 UDP 发包"（sendto / sendmsg 带 msg_name）一律判 EPERM——musl 解析器
        // 正是那个写法，所以在那些环境里必然失败；glibc 用 connect+send 才过得去。
        // 一旦有人"顺手"改回 send_to，本模块就失去意义，而**这种回归在没有沙箱的 CI 里
        // 完全看不出来**（本地解析照常成功）。故在此做源码级锁定。
        // 两处收窄，都是写这个测试时踩出来的：
        //  1) 只扫 `#[cfg(test)]` 之前的生产代码——测试里的假 DNS 服务端要用 send_to 回包，
        //     那是服务端行为，不在本模块要约束的"客户端发包方式"范围内；
        //  2) 再剥掉注释行——模块文档必然要提到 sendmsg/sendto 来说明成因，不剥离会自我误报。
        // 关键字另用 concat! 拆开：否则断言里的字符串会匹配到测试自身，检查形同虚设。
        let src = include_str!("dns.rs");
        let prod = src.split("#[cfg(test)]").next().unwrap_or("");
        let code: String = prod
            .lines()
            .filter(|l| {
                let t = l.trim_start();
                !(t.starts_with("//") || t.starts_with("/*") || t.starts_with('*'))
            })
            .collect::<Vec<_>>()
            .join("\n");
        let connect_needle = concat!(".connect(Socket", "Addr::new(server, port))");
        let send_needle = concat!(".send(&", "packet)");
        let sendto_needle = concat!("send", "_to(");
        let sendmsg_needle = concat!("send", "msg(");
        assert!(code.contains(connect_needle), "必须先 connect 名字服务器");
        assert!(code.contains(send_needle), "必须用 send 而非 sendto");
        assert!(
            !code.contains(sendto_needle),
            "不得使用 sendto（未连接 UDP 发包会被沙箱拒）"
        );
        assert!(!code.contains(sendmsg_needle), "不得使用 sendmsg（同上）");
    }

    #[tokio::test]
    async fn resolve_handles_ip_literals_without_dns() {
        // IP 字面量必须短路返回：不该读 /etc/hosts 或 resolv.conf
        assert_eq!(
            resolve("127.0.0.1", 8443).await,
            Some("127.0.0.1:8443".parse().unwrap())
        );
        assert_eq!(resolve("::1", 80).await, Some("[::1]:80".parse().unwrap()));
        // URL 的 host 形式：IPv6 带方括号（http::Uri::host() 就是这种形态），必须同样短路。
        // ⚠️ 以下几行是冒烟测试而**不是**可靠的回归锁：部分环境的解析器会把"长得像 IP 的名字"
        // （连方括号一起）直接解析成对应地址，于是剥方括号即使失效也能靠 DNS 侥幸成功。
        // 本机（WSL）实测：AAAA("[::1]") → ::1、A("[127.0.0.1]") → 127.0.0.1，两者都能"救回"。
        // 因此环境无关的权威锁只有 ip_literal_parsing_tolerates_brackets_and_spaces
        //（它直接断言 parse_ip，不经过任何解析器；去掉 strip_brackets 必然失败）。
        assert_eq!(
            resolve("[::1]", 80).await,
            Some("[::1]:80".parse().unwrap()),
            "方括号形式必须识别为字面量"
        );
        assert_eq!(
            resolve("[127.0.0.1]", 8443).await,
            Some("127.0.0.1:8443".parse().unwrap())
        );
        assert_eq!(resolve("", 80).await, None);
    }

    #[test]
    fn ip_literal_parsing_tolerates_brackets_and_spaces() {
        assert_eq!(parse_ip("[::1]"), Some("::1".parse().unwrap()));
        assert_eq!(parse_ip("::1"), Some("::1".parse().unwrap()));
        assert_eq!(
            parse_ip("  [2001:db8::1]  "),
            Some("2001:db8::1".parse().unwrap())
        );
        assert_eq!(parse_ip(" 127.0.0.1 "), Some("127.0.0.1".parse().unwrap()));
        assert_eq!(parse_ip("not-an-ip"), None);
        assert_eq!(parse_ip(""), None);
        assert_eq!(parse_ip("[]"), None);
    }
}
