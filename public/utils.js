// cf-panel 前端工具库 + IP 归属地组件
// 普通 script（IIFE），挂 window.CfUtils；app.js 开头解构所需（保持引用不变）
// 依赖：index.html 中须在 app.js 之前加载本文件
(() => {
  'use strict';

  const t = (k, v) => (window.CfI18n ? window.CfI18n.t(k, v) : k); // i18n 缺席时回退显示 key（顺序由 index.html 保证，此处兜底） // i18n：协议层用户可见文案

  // ---------- 通用工具 ----------
  const $ = (sel) => document.querySelector(sel);

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fmtBytes(n) {
    if (n == null) return '-';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = n, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 100 ? 0 : 1) + units[i];
  }

  // Agent 文件列表属于不可信输入：在进入 HTML/属性和数值格式化前统一收口。
  function normalizeFileEntry(entry) {
    const raw = entry && typeof entry === 'object' ? entry : {};
    const numberOrZero = (value) => {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 ? Math.min(n, Number.MAX_SAFE_INTEGER) : 0;
    };
    // 文本字段只接受字符串本身，绝不 String(...) 强转：
    // String(['<img src=x onerror=...>']) 会得到原样的 '<img ...>'，数组/对象的
    // toString 会把危险内容拼进来，收口层形同虚设（下游虽有 escapeHtml 兜底，
    // 但收口就应当是第一道也是最后一道防线）。
    const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
    return {
      name: str(raw.name, 4096),
      // path 仅递归搜索（find）返回：绝对路径；目录浏览条目为空串
      path: str(raw.path, 4096),
      type: raw.type === 'dir' ? 'dir' : 'file',
      size: numberOrZero(raw.size),
      mtime: numberOrZero(raw.mtime),
      mode: numberOrZero(raw.mode), // 权限位（Unix 真实值；Windows 由只读位折算）
    };
  }

  // 路径拼接/父目录：跨平台（Unix '/' 与 Windows 盘符 '\'）。
  // Windows agent 返回的路径形如 C:\Users\me（反斜杠）；按 cwd 判定分隔符，
  // 尾分隔符正确处理（'/' 根与 'C:\' 根都不重复加分隔符）
  function fileJoin(dir, name) {
    const sep = dir.includes('\\') || /^[A-Za-z]:$/.test(dir) ? '\\' : '/';
    const base = dir.endsWith(sep) || dir === '/' ? dir : dir + sep;
    return base + name;
  }
  function fileParent(p) {
    const s = String(p || '/');
    // Windows 驱动器根（C:\）：无法再上溯，返回自身
    if (/^[A-Za-z]:\\?$/.test(s.replace(/[\\/]+$/, '')) || /^[A-Za-z]:$/.test(s)) {
      return s.replace(/[\\/]+$/, '') + '\\';
    }
    const t = s.replace(/[\\/]+$/, '');
    const i = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'));
    if (i <= 0) return '/';
    let parent = t.slice(0, i);
    if (/^[A-Za-z]:$/.test(parent)) parent += '\\'; // C:\Users → C:（补回根斜杠）
    return parent;
  }
  // basename 提取（跨平台）：同时按 / 与 \ 取最后一段——Windows agent 返回 C:\Users\me\a.txt，
  // 仅按 / 切分会取到整条路径（下载文件名/重命名默认值/移动源名全部错位）
  function fileBase(p) {
    const s = String(p || '');
    const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i < 0 ? s : s.slice(i + 1);
  }

  // 权限位 → "rwxr-xr-x (0755)"。仅 Unix 口径：Windows 无 POSIX mode，agent 端把
  // 只读位折算为 0o444/0o666 上报，故 Windows 上这里的字符串是"近似展示"，
  // 修改权限时也只提供只读开关（不给出假的 POSIX 等价物）。
  function modeText(mode) {
    const n = Number(mode);
    if (!Number.isFinite(n) || n <= 0) return '';
    const bit = (shift) => (n & (0o400 >> shift)) ? 'r' : '-';
    const tri = (t) => {
      const w = (n & (0o200 >> t * 3)) ? 'w' : '-';
      const x = (n & (0o100 >> t * 3)) ? 'x' : '-';
      return bit(t * 3) + w + x;
    };
    const oct = (n & 0o777).toString(8).padStart(3, '0');
    return `${tri(0)}${tri(1)}${tri(2)} (${oct})`;
  }

  // 滚动锁计数栈：嵌套弹窗（文件弹窗内开新建目录 promptDialog）关闭内层时外层仍锁——
  // 无计数的赋值式会在关内层时误解锁背景
  let scrollLockCount = 0;
  function lockScroll() { scrollLockCount += 1; document.body.style.overflow = 'hidden'; }
  function unlockScroll() {
    scrollLockCount = Math.max(0, scrollLockCount - 1);
    if (scrollLockCount === 0) document.body.style.overflow = '';
  }

  // 监控常量与降采样
  const MONITOR_STEP_MAX = 240; // 长区间降采样目标点数
  const MONITOR_COLORS = ['#8b5cf6', '#22d3ee', '#f472b6', '#34d399', '#fbbf24', '#a78bfa'];

  // 长区间数据太多时按区间平均降采样，保证可读性
  // 字段完整性：数值主字段（含 mem_total）平均；extra（swap/磁盘/进程/连接等）取区间内最后一条非空——
  // 否则内存/Swap/磁盘/进程/连接图在长区间全部无数据（mem_total 与 extra 丢失）
  function downsample(rows, max = MONITOR_STEP_MAX) {
    if (rows.length <= max) return rows;
    const step = rows.length / max;
    const out = [];
    for (let i = 0; i < max; i++) {
      const start = Math.floor(i * step);
      const slice = rows.slice(start, Math.max(start + 1, Math.floor((i + 1) * step)));
      const agg = { ts: slice[0].ts };
      for (const k of ['cpu', 'mem_used', 'mem_total', 'net_in', 'net_out']) {
        const vals = slice.map((r) => r[k]).filter((v) => v != null);
        agg[k] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      }
      for (let j = slice.length - 1; j >= 0; j--) {
        if (slice[j].extra) { agg.extra = slice[j].extra; break; }
      }
      out.push(agg);
    }
    return out;
  }

  // ---------- IP 归属地（Geo：查询 + 缓存 + <cf-ip> 组件） ----------
  let geoEnabled = false; // IP 归属地第三方查询开关（默认关闭，隐私保护；由 app.js 设置）
  function setGeoEnabled(v) { geoEnabled = !!v; }

  const geoCache = new Map(); // ip -> {label, cc, ts}（内存缓存：同页会话命中）
  const GEO_CACHE_KEY = 'cfpanel_geo_cache';
  const GEO_CACHE_TTL = 45 * 24 * 3600 * 1000; // 持久化缓存 45 天（服务器 IP 归属地几乎不变，吸收第三方数据库修正即可，避免频繁重查）
  const GEO_FAIL_TTL = 60 * 1000; // 查询失败的内存缓存短 TTL：第三方瞬时抖动（限流 429 等）
  // 过后 60s 自动重查——原实现失败永久缓存，同页会话该 IP 归属地永不恢复（刷新才恢复）
  const GEO_CACHE_MAX = 500;
  // 启动时从 localStorage 恢复持久化缓存（仅未过期条目）。
  // 只恢复新格式（含 cc 字段）：旧格式（仅 label 字符串，无国家代码）直接丢弃——
  // 若保留则 geoLookup 命中缓存永远不重查，旗帜将无法补全（丢弃后下次自动重查拿 cc）
  try {
    const raw = JSON.parse(localStorage.getItem(GEO_CACHE_KEY) || '{}');
    for (const [k, v] of Object.entries(raw)) {
      if (Date.now() - v.ts < GEO_CACHE_TTL && v.cc) {
        geoCache.set(k, { label: v.label, cc: v.cc });
      }
    }
  } catch { /* localStorage 不可用则仅内存缓存 */ }
  function geoCacheSave(ip, obj) {
    geoCache.set(ip, obj);
    try {
      const store = JSON.parse(localStorage.getItem(GEO_CACHE_KEY) || '{}');
      store[ip] = { label: obj.label, cc: obj.cc || '', ts: Date.now() };
      const keys = Object.keys(store);
      if (keys.length > GEO_CACHE_MAX) {
        // 只保留最新 GEO_CACHE_MAX 条（按 ts 倒序），防无限增长
        const trimmed = {};
        keys.sort((a, b) => store[b].ts - store[a].ts).slice(0, GEO_CACHE_MAX).forEach((k) => { trimmed[k] = store[k]; });
        localStorage.setItem(GEO_CACHE_KEY, JSON.stringify(trimmed));
      } else {
        localStorage.setItem(GEO_CACHE_KEY, JSON.stringify(store));
      }
    } catch { /* 写失败（配额满等）退化为纯内存缓存 */ }
  }
  // 私网/保留地址不查询：10.x 172.16-31.x 192.168.x 127.x 169.254.x 0.x 100.64-127.x
  const GEO_PRIVATE = /^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
  // 返回 {label, cc}（label=展示文本，cc=ISO 3166-1 alpha-2 国家代码，旗帜渲染用）；失败/私网/开关关闭返回 null。
  // geoEnabled 入口统一收口：卡片旗帜（updateFlags）与 <cf-ip> 组件两个调用方都受控——
  // 隐私开关关闭时绝不向第三方地理服务发送 IP（开关文案承诺的行为）
  async function geoLookup(ip) {
    if (!geoEnabled || !ip || GEO_PRIVATE.test(ip)) return null;
    const cached = geoCache.get(ip);
    // 成功结果（有 label）或失败结果仍在短 TTL 内 → 命中；失败超 TTL 自动重查
    if (cached && (cached.label || Date.now() - cached.ts < GEO_FAIL_TTL)) return cached;
    let label = '';
    let cc = '';
    // 仅用 HTTPS 源（http:// 在 HTTPS 面板下是混合内容，会被浏览器直接拦截）
    // 主：ipapi.co（https，免费无 key）；备：ipwho.is（https，免费无 key）
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 5000);
      const r = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, { signal: ctl.signal });
      clearTimeout(t);
      const j = await r.json();
      if (j && j.country_name) {
        label = j.country_name + (j.city ? ' ' + j.city : '');
        cc = String(j.country_code || '').toUpperCase();
      }
    } catch { /* 换备选 */ }
    if (!label) {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 5000);
        const r = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, { signal: ctl.signal });
        clearTimeout(t);
        const j = await r.json();
        if (j && j.success) {
          label = (j.country || '') + (j.city ? ' ' + j.city : '');
          cc = String(j.country_code || '').toUpperCase();
        }
      } catch { /* 查询失败则不显示 */ }
    }
    if (label) {
      const obj = { label, cc };
      geoCacheSave(ip, obj); // 成功：内存 + localStorage 持久化（跨会话复用）
      return obj;
    }
    // 失败：仅内存缓存（避免同批重复查，不持久化坏数据），带 ts 供 GEO_FAIL_TTL 过期重查
    geoCache.set(ip, { label: '', cc: '', ts: Date.now() });
    return null;
  }
  // 旗帜渲染：ISO 3166-1 alpha-2 代码 → 旗帜。
  // 运行时检测系统能否渲染彩色旗帜 emoji（覆盖全部平台）：
  //   Windows 默认 Segoe UI Emoji 无旗帜字形（渲染成 CN 字母）→ 图片；
  //   Linux 无 emoji 字体（渲染成豆腐块）→ 图片；装了含旗帜字形的字体 → emoji；
  //   macOS / 带彩色 emoji 字体的 Linux → emoji（零请求）。
  // 检测原理：canvas 绘制 🇨🇳 统计彩色像素占比——旗帜是多色图案，fallback（字母/豆腐块）是单色。
  // 黑白旗帜字体（Symbola 等）会判"不支持"→ 退回图片（无害方向，最坏不过多一次图片请求）。
  // 一次检测缓存全局复用；getImageData 异常时保守返回 false（走图片，无显示错误）。
  function detectFlagEmoji() {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const ctx = c.getContext('2d');
      if (!ctx) return false;
      ctx.font = '48px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('\u{1F1E8}\u{1F1F3}', 32, 32); // 🇨🇳
      const d = ctx.getImageData(0, 0, 64, 64).data;
      let colored = 0, total = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] <= 128) continue; // 透明像素不计
        total++;
        const max = Math.max(d[i], d[i + 1], d[i + 2]);
        const min = Math.min(d[i], d[i + 1], d[i + 2]);
        if (max - min > 32) colored++; // RGB 通道差大 → 彩色像素
      }
      return total > 100 && colored / total > 0.02; // 有少量彩色像素即判定支持
    } catch { return false; }
  }
  const FLAG_EMOJI_SUPPORTED = detectFlagEmoji();
  function flagHtml(cc) {
    if (!cc || !/^[A-Za-z]{2}$/.test(cc)) return '';
    if (FLAG_EMOJI_SUPPORTED) return String.fromCodePoint(0x1F1E6 + cc.charCodeAt(0) - 65, 0x1F1E6 + cc.charCodeAt(1) - 65);
    const c = cc.toLowerCase();
    return `<img src="https://flagcdn.com/${c}.svg" alt="${escapeHtml(cc)}" loading="lazy" class="flag-img">`;
  }

  // 操作系统图标：simple-icons CDN SVG（白色，适配深色主题）。  // 匹配 info.os 字符串（agent 上报的 PRETTY_NAME / 平台名）：Windows/macOS 走平台分支，
  // Linux 按发行版关键字映射 slug，未知 Linux 兜底 linux 图标，无法识别返回 ''（不显示）。
  // Windows 图标：simple-icons 已于 2024 年下架全部微软品牌图标（含 windows 各变体），
  // 改用 bootstrap-icons 的 Windows 窗格图标路径（MIT），data URI 内联（CSP img-src 已放行 data:）
  const WINDOWS_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#fff"><path d="M0 3.449 9.75 2.1v9.451H0Zm10.949-1.602L24 .137v11.35H10.949ZM0 12.6h9.75v9.451L0 20.699Zm10.949 0H24V24l-13.051-1.8Z"/></svg>';
  const OS_ICON_MAP = [
    ['apple', ['mac os', 'macos', 'darwin', 'os x']],
    ['ubuntu', ['ubuntu']],
    ['debian', ['debian']],
    ['centos', ['centos']],
    ['alpine', ['alpine']],
    ['fedora', ['fedora']],
    ['archlinux', ['arch']],
    ['rockylinux', ['rocky']],
    ['almalinux', ['alma']],
    ['opensuse', ['opensuse', 'suse']],
    ['raspberrypi', ['raspbian', 'raspberry']],
    ['linuxmint', ['mint']],
    ['manjaro', ['manjaro']],
    ['kali', ['kali']],
    ['oracle', ['oracle']],
    ['popos', ['pop os', 'popos', 'pop!_os']],
    ['elementaryos', ['elementary']],
    ['gentoo', ['gentoo']],
    ['nixos', ['nixos']],
    ['linux', ['linux']], // 未知发行版兜底
  ];
  function osIconHtml(os) {
    if (!os) return '';
    const s = String(os).toLowerCase();
    if (s.includes('windows') || s.includes('microsoft')) {
      return `<img src="data:image/svg+xml,${encodeURIComponent(WINDOWS_SVG)}" alt="" title="${escapeHtml(String(os))}" loading="lazy" class="os-ico">`;
    }
    for (const [slug, keys] of OS_ICON_MAP) {
      if (keys.some((k) => s.includes(k))) {
        return `<img src="https://cdn.simpleicons.org/${slug}/fff" alt="" title="${escapeHtml(String(os))}" loading="lazy" class="os-ico">`;
      }
    }
    return '';
  }

  // 受保护系统路径判定（与 agent 词法层同规则）：绝对路径归一化（折叠 //、解析 . ..）
  // 后匹配黑名单；相对路径/越根一律视为受保护。前端用于隐藏系统目录/文件的删除与
  // 重命名菜单（下载保留）；agent 端为最终防线，此处仅为 UX 层。
  // Windows 盘符路径（C:\...）：归一化后按驱动器根一级目录黑名单（大小写不敏感，
  // 任意盘符；与 agent 端 WIN_SYSTEM_ROOT_DIRS 同规则）
  const SYSTEM_PATH_PREFIXES = [
    '/proc', '/sys', '/dev', '/etc', '/usr', '/var', '/boot', '/bin',
    '/sbin', '/lib', '/lib64', '/efi', '/snap', '/root', '/run',
    '/lost+found', // 注：/opt /srv 不拦（第三方软件部署目录，与 agent 端黑名单同步）
  ];
  const WIN_SYSTEM_ROOT_DIRS = [
    'windows', 'program files', 'program files (x86)', 'programdata',
    'perflogs', 'recovery', '$recycle.bin', 'system volume information',
  ];
  function isSystemPath(path) {
    if (!path) return true; // 相对路径按受保护处理
    const s = String(path);
    // Windows 盘符路径分支
    const m = s.match(/^([A-Za-z]:)[\\/](.*)$/);
    if (m) {
      const segs = [];
      for (const seg of m[2].split(/[\\/]/)) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') {
          if (!segs.pop()) return true; // 越过驱动器根 → 受保护
        } else segs.push(seg);
      }
      if (segs.length === 0) return true; // 驱动器根本身
      const first = segs[0].toLowerCase();
      return WIN_SYSTEM_ROOT_DIRS.includes(first);
    }
    // Unix 绝对路径（或无盘符输入 → fail closed）
    if (!s.startsWith('/')) return true;
    const parts = [];
    for (const seg of s.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        if (!parts.pop()) return true; // 越根 → 受保护
      } else parts.push(seg);
    }
    const norm = '/' + parts.join('/');
    if (norm === '/') return true;
    return SYSTEM_PATH_PREFIXES.some((p) => norm === p || norm.startsWith(p + '/'));
  }

  // 脚本/CSS 懒加载（首屏不拉 vendor 大文件：xterm 283KB 仅终端用、Chart.js 200KB 仅监控用）。
  // Promise 缓存去重（并发调用同 src 共享一次加载）；失败清理标签并删除缓存允许重试
  const loadedAssets = new Map(); // src -> Promise<void>
  function loadScript(src) {
    if (!loadedAssets.has(src)) {
      loadedAssets.set(src, new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = () => resolve();
        s.onerror = () => {
          s.remove();
          loadedAssets.delete(src); // 失败清缓存：下次调用重试，不永久卡死
          reject(new Error(t('common.loadFail') + src));
        };
        document.head.appendChild(s);
      }));
    }
    return loadedAssets.get(src);
  }
  function loadCss(href) {
    if (!loadedAssets.has(href)) {
      loadedAssets.set(href, new Promise((resolve, reject) => {
        const l = document.createElement('link');
        l.rel = 'stylesheet';
        l.href = href;
        l.onload = () => resolve();
        l.onerror = () => {
          l.remove();
          loadedAssets.delete(href);
          reject(new Error(t('common.loadFail') + href));
        };
        document.head.appendChild(l);
      }));
    }
    return loadedAssets.get(href);
  }

  // Monaco Editor CDN 懒加载（编辑器体量大 ~3MB，不进 vendor；cdnjs 固定版本避免供应链漂移）。
  // AMD loader 流程：loader.js → require.config({paths:{vs}}) → require editor.main。
  // worker 用 blob proxy（CSP worker-src blob:）承载 CDN workerMain，importScripts 回源加载。
  // 失败（无网/CDN 不可达）reject，调用方回退 textarea
  const MONACO_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min';
  let monacoPromise = null;
  function loadMonaco() {
    if (!monacoPromise) {
      monacoPromise = (async () => {
        await loadScript(`${MONACO_BASE}/vs/loader.min.js`);
        if (!window.require) throw new Error(t('utils.monacoLoader'));
        window.require.config({ paths: { vs: `${MONACO_BASE}/vs` } });
        await new Promise((resolve, reject) => {
          window.require(['vs/editor/editor.main'], resolve, reject);
        });
        if (!window.monaco) throw new Error(t('utils.monacoError'));
        // blob proxy worker：跨域 CDN 无法直接 new Worker(cdn url)，经 blob importScripts 中转
        const src = `self.MonacoEnvironment={baseUrl:'${MONACO_BASE}/'};importScripts('${MONACO_BASE}/vs/base/worker/workerMain.js');`;
        window.MonacoEnvironment = {
          getWorkerUrl: () => URL.createObjectURL(new Blob([src], { type: 'text/javascript' })),
        };
        return window.monaco;
      })().catch((e) => {
        monacoPromise = null; // 失败清缓存：下次打开编辑器重试
        throw e;
      });
    }
    return monacoPromise;
  }

  // Markdown 渲染器本地 vendor 懒加载（预览低频使用不进首屏；本地化避免 CDN 不可达，与 xterm/Chart.js 同策略）。
  // marked 渲染 + DOMPurify 消毒（文件内容来自服务器，HTML 必须过滤防 XSS）。
  // 必须走动态 import 的 ESM 通道：Monaco 的 AMD loader 会定义 window.define（带 amd 标记），
  // UMD 构建检测到 AMD 后注册为匿名模块、不设 window 全局 → marked/DOMPurify 取不到
  let markdownPromise = null;
  function loadMarkdown() {
    if (!markdownPromise) {
      markdownPromise = (async () => {
        const [markedMod, purifyMod] = await Promise.all([
          import('/vendor/marked.esm.js'),
          import('/vendor/purify.es.mjs'),
        ]);
        const m = markedMod.marked || markedMod.default;
        const p = purifyMod.default || purifyMod;
        if (!m || typeof m.parse !== 'function' || !p || typeof p.sanitize !== 'function') {
          throw new Error(t('utils.mdError'));
        }
        return { marked: m, purify: p };
      })().catch((e) => {
        markdownPromise = null; // 失败清缓存：下次点预览重试
        throw e;
      });
    }
    return markdownPromise;
  }

  // 二进制扩展名黑名单：这些类型的"编辑"必然损坏文件（UTF-8 解码替换字符写回），
  // 直接不显示编辑入口。名单外的仍可能误判（无扩展名二进制），由 api.js 解码校验兜底。
  // 集合元素带点（.jpg），比较时补点——两侧口径不一致会全量漏判
  const BINARY_EXTS = new Set(('.jpg .jpeg .png .gif .webp .bmp .ico .svgz .tif .tiff .heic .avif '
    + '.zip .gz .bz2 .xz .7z .rar .zst .tar .tgz .tbz2 .txz .jar .war '
    + '.exe .dll .so .dylib .bin .o .a .class .pyc .wasm '
    + '.mp3 .mp4 .avi .mkv .mov .flv .wmv .webm .m4a .flac .wav .ogg '
    + '.pdf .doc .docx .xls .xlsx .ppt .pptx .odt .ods .sqlite .db .mdb '
    + '.woff .woff2 .ttf .otf .eot .deb .rpm .apk .ipa .img .iso').split(/\s+/));
  function isBinaryExt(name) {
    const i = String(name || '').lastIndexOf('.');
    return i > 0 && BINARY_EXTS.has('.' + name.slice(i + 1).toLowerCase());
  }

  // ---------- 空闲观看保护（IdleGuard）：无操作计时 + 提示 + 自动暂停，动作经回调注入 ----------
  // 类似视频网站"继续观看？"：长时间无浏览器操作 → 提示 → 60s 无响应自动暂停；
  // 任何活动恢复。暂停/恢复/提示等 UI 动作由 handlers 提供（app.js 注入 stopPush/startPush/confirmDialog）
  class IdleGuard {
    constructor(handlers = {}) {
      this.h = handlers; // { timeout, promptMs, isActive, onPrompt(continueFn, pauseFn), onPause, onResume, onPromptDismiss? }
      this.timeout = handlers.timeout || 10 * 60 * 1000;  // 无操作判定阈值
      this.promptMs = handlers.promptMs || 60 * 1000;     // 提示后无响应自动暂停
      this.timer = null;
      this.promptTimer = null;
      this.paused = false;
      this.prompting = false; // 提示弹窗显示中（期间用户活动不清自动暂停倒计时）
    }
    _active() { return this.h.isActive ? this.h.isActive() : true; }

    start() { this.reset(); }
    reset() {
      if (this.paused || !this._active()) return;
      clearTimeout(this.timer);
      if (!this.prompting) clearTimeout(this.promptTimer); // 提示中保留自动暂停兜底
      this.timer = setTimeout(() => this._onTimeout(), this.timeout);
    }
    _onTimeout() {
      if (!this._active() || this.paused || this.prompting) return;
      this.prompting = true;
      const pause = () => { this.prompting = false; this.pause(); };
      // 确认=继续（已自动暂停则先恢复——弹窗停留期间 60s 倒计时可能已触发 pause）；
      // 取消=立即暂停；关闭弹窗=忽略（promptMs 倒计时自动暂停兜底）
      const cont = () => { this.prompting = false; if (this.paused) this.resume(); else this.reset(); };
      if (this.h.onPrompt) this.h.onPrompt(cont, pause);
      this.promptTimer = setTimeout(() => { this.prompting = false; this.pause(); }, this.promptMs);
    }
    pause() {
      if (this.paused) return;
      this.paused = true;
      this.prompting = false;
      clearTimeout(this.timer);
      clearTimeout(this.promptTimer);
      if (this.h.onPause) this.h.onPause();
      // 自动/手动暂停时提示弹窗可能仍显示（60s 无响应路径、用户点取消由 confirmDialog 自身关闭）——
      // 经回调交由 UI 侧关闭残留弹窗（本类零 DOM 依赖，不直接操作）
      if (this.h.onPromptDismiss) this.h.onPromptDismiss();
    }
    resume() {
      if (!this.paused) return;
      this.paused = false;
      this.prompting = false;
      if (this.h.onResume) this.h.onResume();
      this.reset();
    }
    // 用户活动监听：暂停中 → 恢复；观看中 → 重置计时
    bind() {
      ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'].forEach((ev) => {
        document.addEventListener(ev, () => {
          if (this.paused) this.resume();
          else this.reset();
        }, { passive: true });
      });
    }
  }

  // <cf-ip> 组件：显示 IP 并自动查询归属地（复用 Geo 缓存；geoEnabled 关闭时仅显示 IP）。
  // 任意位置可用：<cf-ip ip="1.2.3.4"></cf-ip>（卡片 meta、审计日志、未来任何 IP 展示）
  class CfIp extends HTMLElement {
    static observedAttributes = ['ip'];
    connectedCallback() { this.render(); }
    attributeChangedCallback(name) { if (name === 'ip') this.render(); }
    render() {
      const ip = this.getAttribute('ip') || '';
      this.textContent = ip; // 先显示 IP，归属地异步补全
      if (!ip || !geoEnabled) return;
      geoLookup(ip).then((res) => {
        if (res && res.label && this.isConnected && this.getAttribute('ip') === ip) {
          this.textContent = `${ip} （${res.label}）`; // 归属地查询结果（缓存命中即时）
        }
      });
    }
  }
  customElements.define('cf-ip', CfIp);

  // 导出（app.js 开头解构）
  window.CfUtils = {
    $, escapeHtml, fmtBytes, normalizeFileEntry, fileJoin, fileParent, fileBase, downsample, modeText,
    lockScroll, unlockScroll,
    MONITOR_STEP_MAX, MONITOR_COLORS,
    GEO_PRIVATE, geoLookup, flagHtml, osIconHtml, isSystemPath, isBinaryExt, loadScript, loadCss, loadMonaco, loadMarkdown, setGeoEnabled, IdleGuard,
  };
})();
