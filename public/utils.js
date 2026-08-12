// cf-panel 前端工具库 + IP 归属地组件
// 普通 script（IIFE），挂 window.CfUtils；app.js 开头解构所需（保持引用不变）
// 依赖：index.html 中须在 app.js 之前加载本文件
(() => {
  'use strict';

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

  function fileJoin(dir, name) {
    return (dir === '/' ? '' : dir) + '/' + name;
  }

  function fileParent(p) {
    const t = String(p || '/').replace(/\/+$/, '');
    const i = t.lastIndexOf('/');
    return i <= 0 ? '/' : t.slice(0, i);
  }

  function lockScroll() { document.body.style.overflow = 'hidden'; }
  function unlockScroll() { document.body.style.overflow = ''; }

  // 监控常量与降采样
  const MONITOR_STEP_MAX = 240; // 长区间降采样目标点数
  const MONITOR_RANGE_LABEL = { '1h': '近1小时', '12h': '近12小时', '3d': '近3天', '7d': '近7天', '30d': '近30天' };
  const MONITOR_COLORS = ['#8b5cf6', '#22d3ee', '#f472b6', '#34d399', '#fbbf24', '#a78bfa'];

  // 长区间数据太多时按区间平均降采样，保证可读性
  function downsample(rows, max = MONITOR_STEP_MAX) {
    if (rows.length <= max) return rows;
    const step = rows.length / max;
    const out = [];
    for (let i = 0; i < max; i++) {
      const start = Math.floor(i * step);
      const slice = rows.slice(start, Math.max(start + 1, Math.floor((i + 1) * step)));
      const agg = { ts: slice[0].ts };
      for (const k of ['cpu', 'mem_used', 'net_in', 'net_out']) {
        const vals = slice.map((r) => r[k]).filter((v) => v != null);
        agg[k] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      }
      out.push(agg);
    }
    return out;
  }

  // ---------- IP 归属地（Geo：查询 + 缓存 + <cf-ip> 组件） ----------
  let geoEnabled = false; // IP 归属地第三方查询开关（默认关闭，隐私保护；由 app.js 设置）
  function setGeoEnabled(v) { geoEnabled = !!v; }

  const geoCache = new Map(); // ip -> {label, cc}（内存缓存：同页会话命中）
  const GEO_CACHE_KEY = 'cfpanel_geo_cache';
  const GEO_CACHE_TTL = 7 * 24 * 3600 * 1000; // 持久化缓存 7 天（IP 变化少，避免跨刷新/跨会话重复查询）
  const GEO_CACHE_MAX = 500;
  // 启动时从 localStorage 恢复持久化缓存（仅未过期条目；兼容旧格式 label 为字符串）
  try {
    const raw = JSON.parse(localStorage.getItem(GEO_CACHE_KEY) || '{}');
    for (const [k, v] of Object.entries(raw)) {
      if (Date.now() - v.ts < GEO_CACHE_TTL) {
        geoCache.set(k, typeof v.label === 'string' ? { label: v.label, cc: '' } : v.label);
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
  // 返回 {label, cc}（label=展示文本，cc=ISO 3166-1 alpha-2 国家代码，旗帜渲染用）；失败/私网返回 null
  async function geoLookup(ip) {
    if (!ip || GEO_PRIVATE.test(ip)) return null;
    const cached = geoCache.get(ip);
    if (cached) return cached;
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
    geoCache.set(ip, { label: '', cc: '' }); // 失败：仅内存缓存（避免同批重复查，不持久化坏数据）
    return null;
  }
  // 旗帜 emoji：ISO 3166-1 alpha-2 代码 → 区域指示符（如 CN → 🇨🇳；零资源，随系统字体渲染）
  function flagEmoji(cc) {
    if (!cc || !/^[A-Za-z]{2}$/.test(cc)) return '';
    const a = cc.toUpperCase();
    return String.fromCodePoint(0x1F1E6 + a.charCodeAt(0) - 65, 0x1F1E6 + a.charCodeAt(1) - 65);
  }

  // ---------- 空闲观看保护（IdleGuard）：无操作计时 + 提示 + 自动暂停，动作经回调注入 ----------
  // 类似视频网站"继续观看？"：长时间无浏览器操作 → 提示 → 60s 无响应自动暂停；
  // 任何活动恢复。暂停/恢复/提示等 UI 动作由 handlers 提供（app.js 注入 stopPush/startPush/confirmDialog）
  class IdleGuard {
    constructor(handlers = {}) {
      this.h = handlers; // { timeout, promptMs, isActive, onPrompt(continueFn, pauseFn), onPause, onResume }
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
      // 确认=继续（重置计时）；取消=立即暂停；关闭弹窗=忽略（promptMs 倒计时自动暂停兜底）
      if (this.h.onPrompt) this.h.onPrompt(() => { this.prompting = false; this.reset(); }, pause);
      this.promptTimer = setTimeout(() => { this.prompting = false; this.pause(); }, this.promptMs);
    }
    pause() {
      if (this.paused) return;
      this.paused = true;
      this.prompting = false;
      clearTimeout(this.timer);
      clearTimeout(this.promptTimer);
      if (this.h.onPause) this.h.onPause();
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
    $, escapeHtml, fmtBytes, fileJoin, fileParent, downsample,
    lockScroll, unlockScroll,
    MONITOR_STEP_MAX, MONITOR_RANGE_LABEL, MONITOR_COLORS,
    GEO_PRIVATE, geoLookup, flagEmoji, setGeoEnabled, IdleGuard,
  };
})();
