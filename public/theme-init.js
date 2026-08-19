// 主题预置：在任何渲染前把 data-theme 写到 <html>，避免浅色用户刷新时闪深色（FOUC）。
// 独立文件而非内联脚本：CSP script-src 'self' 不允许内联；同步小脚本在 <head> 中先于样式应用执行。
document.documentElement.dataset.theme = localStorage.getItem('cfpanel_theme') === 'light' ? 'light' : 'dark';
