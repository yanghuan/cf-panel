// cf-panel 国际化（i18n）框架：t() + 语言包注册 + 变更订阅
// 零构建、零依赖。本文件只含框架；**语言包在 public/lang/*.js**，各自通过
// CfI18n.register(code, pack, { label }) 注册（index.html 显式引入——零构建下
// 无法扫描目录，新增语言 = 加一个 lang 文件 + 在 index.html 加一行 script）。
//
// 代码里不出现任何面向用户的中文字面量，全部走 t(key)。
// key 命名：<模块>.<语义>（common/login/server/term/file/monitor/stats/...）。
(() => {
  'use strict';

  // 注册表：code -> { pack, label }。语言包由 public/lang/*.js 在加载时注册，
  // 本文件不内置任何文案——"支持哪些语言"完全由加载了哪些 lang 文件决定。
  const registry = new Map();
  // 语言变更订阅者：setLocale 成功后逐一回调（app.js 据此刷新动态渲染的内容）
  const listeners = new Set();

  const DEFAULT_LOCALE = 'zh-CN';
  const STORAGE_KEY = 'cfpanel_locale';

  // 懒初始化：首次 t() 时才检测语言。原因——脚本顺序是 i18n.js → lang/*.js → app.js，
  // 模块加载时语言包尚未注册，此时检测必然落到"空注册表"。
  let current = null;

  function register(code, pack, meta) {
    if (!code || !pack || typeof pack !== 'object') return false;
    const label = (meta && meta.label) || code;
    registry.set(code, { pack, label });
    return true;
  }

  // 语言选择优先级：用户手动选择（localStorage）> 浏览器语言（精确 → 前缀匹配）>
  // 默认语言 > 任意已注册语言（兜底：lang 文件被删光时不至于返回 null）。
  function detectLocale() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && registry.has(saved)) return saved;
      const nav = [].concat(navigator.languages || [], navigator.language || []).filter(Boolean);
      for (const n of nav) {
        const s = String(n);
        if (registry.has(s)) return s;
        const base = s.split('-')[0].toLowerCase();
        const hit = [...registry.keys()].find((c) => c.split('-')[0].toLowerCase() === base);
        if (hit) return hit;
      }
    } catch { /* localStorage/navigator 不可用时按默认处理 */ }
    if (registry.has(DEFAULT_LOCALE)) return DEFAULT_LOCALE;
    return registry.keys().next().value || null;
  }

  function ensureInit() {
    if (current != null) return;
    current = detectLocale();
    try { if (document.documentElement) document.documentElement.lang = current || ''; } catch { /* ignore */ }
  }

  // 翻译：缺失 key 原样返回（而不是空串）——开发期一眼看出未翻译项，
  // 线上也不会出现"界面大片空白"这种更糟的失败形态。
  function t(key, vars) {
    ensureInit();
    if (key == null || key === '') return '';
    const entry = current != null ? registry.get(current) : null;
    let s = entry ? entry.pack[key] : null;
    if (s == null) return String(key);
    if (vars) {
      s = String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
    }
    return s;
  }

  // 切换语言：持久化 + 广播。**只切变量不会刷新界面**——已渲染的动态内容
  // （卡片/弹窗标题等）是渲染那一刻求值的，订阅方（app.js）收到通知后负责
  // 重新填充静态 DOM 并重渲染动态部分。
  // 同语言重复设置视为幂等（不写存储、不广播），避免无意义的全界面重渲染。
  function setLocale(code) {
    ensureInit();
    if (!code || !registry.has(code)) return false;
    if (code === current) return true;
    current = code;
    try { localStorage.setItem(STORAGE_KEY, code); } catch { /* 写失败仅影响下次记忆 */ }
    try { if (document.documentElement) document.documentElement.lang = code; } catch { /* ignore */ }
    for (const fn of listeners) {
      try { fn(code); } catch (e) { console.error('i18n onChange listener failed:', e); }
    }
    return true;
  }

  // 订阅语言变更；返回取消函数。回调失败不影响其他订阅者。
  function onChange(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  // 批量填充带 data-i18n 的静态 DOM（index.html 的文本/属性）：
  //   data-i18n="key"      → textContent
  //   data-i18n-html="key" → innerHTML（说明段落带 <code>/<strong> 等标记时用；
  //                          文案来自语言包本身，不是用户输入，无注入面）
  //   data-i18n-ph="key"   → placeholder
  //   data-i18n-title="key"→ title
  //   data-i18n-aria="key" → aria-label
  function applyDom(root) {
    const scope = root || document;
    scope.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    scope.querySelectorAll('[data-i18n-html]').forEach((el) => {
      el.innerHTML = t(el.getAttribute('data-i18n-html'));
    });
    scope.querySelectorAll('[data-i18n-ph]').forEach((el) => {
      el.placeholder = t(el.getAttribute('data-i18n-ph'));
    });
    scope.querySelectorAll('[data-i18n-title]').forEach((el) => {
      el.title = t(el.getAttribute('data-i18n-title'));
    });
    scope.querySelectorAll('[data-i18n-aria]').forEach((el) => {
      el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria')));
    });
  }

  // 已注册语言列表（顺序 = 注册顺序 = 菜单展示顺序），供语言菜单生成
  const supported = () => [...registry.entries()].map(([code, v]) => ({ code, label: v.label }));

  window.CfI18n = {
    t,
    setLocale,
    onChange,
    applyDom,
    register,
    supported,
    get locale() { ensureInit(); return current; },
    // 测试用：回到未初始化状态（下次 t() 重新检测）
    __reset() { current = null; },
  };
})();
