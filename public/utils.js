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

  // 文件管理常量
  const FILE_CHUNK = 512 * 1024;       // 分段传输块大小 512KB（base64 后 ~683KB < workerd 入站 1MB 限制）
  const FILE_MAX = 500 * 1024 * 1024;  // 单文件大小上限 500MB

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

  const geoCache = new Map(); // ip -> 归属地标签（内存缓存：同页会话命中）
  const GEO_CACHE_KEY = 'cfpanel_geo_cache';
  const GEO_CACHE_TTL = 7 * 24 * 3600 * 1000; // 持久化缓存 7 天（IP 变化少，避免跨刷新/跨会话重复查询）
  const GEO_CACHE_MAX = 500;
  // 启动时从 localStorage 恢复持久化缓存（仅未过期条目）
  try {
    const raw = JSON.parse(localStorage.getItem(GEO_CACHE_KEY) || '{}');
    for (const [k, v] of Object.entries(raw)) {
      if (Date.now() - v.ts < GEO_CACHE_TTL) geoCache.set(k, v.label);
    }
  } catch { /* localStorage 不可用则仅内存缓存 */ }
  function geoCacheSave(ip, label) {
    geoCache.set(ip, label);
    try {
      const store = JSON.parse(localStorage.getItem(GEO_CACHE_KEY) || '{}');
      store[ip] = { label, ts: Date.now() };
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
  async function geoLookup(ip) {
    if (!ip || GEO_PRIVATE.test(ip)) return '';
    if (geoCache.has(ip)) return geoCache.get(ip) || '';
    let label = '';
    // 仅用 HTTPS 源（http:// 在 HTTPS 面板下是混合内容，会被浏览器直接拦截）
    // 主：ipapi.co（https，免费无 key）；备：ipwho.is（https，免费无 key）
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 5000);
      const r = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, { signal: ctl.signal });
      clearTimeout(t);
      const j = await r.json();
      if (j && j.country_name) label = j.country_name + (j.city ? ' ' + j.city : '');
    } catch { /* 换备选 */ }
    if (!label) {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 5000);
        const r = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, { signal: ctl.signal });
        clearTimeout(t);
        const j = await r.json();
        if (j && j.success) label = (j.country || '') + (j.city ? ' ' + j.city : '');
      } catch { /* 查询失败则不显示 */ }
    }
    if (label) geoCacheSave(ip, label); // 成功：内存 + localStorage 持久化（跨会话复用）
    else geoCache.set(ip, '');          // 失败：仅内存缓存（避免同批重复查，不持久化坏数据）
    return label;
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
      geoLookup(ip).then((label) => {
        if (label && this.isConnected && this.getAttribute('ip') === ip) {
          this.textContent = `${ip} （${label}）`; // 归属地查询结果（缓存命中即时）
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
    FILE_CHUNK, FILE_MAX,
    GEO_PRIVATE, geoLookup, setGeoEnabled,
  };
})();
