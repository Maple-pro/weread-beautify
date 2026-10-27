// ==UserScript==
// @name         微信读书 · 沉浸阅读优化
// @namespace    https://github.com/weread-beautify
// @version      1.1.3
// @description  微信读书网页版阅读器增强：沉浸无干扰、加宽版面、纸感/护眼/夜间主题、阅读进度、滚轮翻页、自动翻页、快捷键
// @author       weread-beautify
// @match        https://weread.qq.com/web/reader/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @noframes
// ==/UserScript==

/*
 * 说明（实现要点）
 * ---------------------------------------------------------------
 * 1. 微信读书网页版的正文是画在 <canvas> 上的，不能用 CSS 改字体/字号。
 *    因此排版只调整「页面容器」的宽高，再派发一次 resize 事件让官方阅读器
 *    重新分页；换色则通过 canvas 的 CSS filter 实现（只作用于正文画布，
 *    不会影响插图）。
 * 2. 官方阅读器的顶栏、右侧工具栏、翻页按钮都是固定 DOM，这里在沉浸模式下
 *    隐藏它们，鼠标移到屏幕边缘时再淡入，既干净又不丢功能。
 * 3. 所有设置保存在 GM 存储（无 GM 时退回 localStorage）。
 * ---------------------------------------------------------------
 */

(function () {
  'use strict';

  // 防止重复注入（油猴 + 手动 eval 测试）
  if (window.__WRBF__) return;

  const log = function () {
    try { console.info.apply(console, ['[weread-beautify]'].concat([].slice.call(arguments))); } catch (err) { /* ignore */ }
  };
  const logError = function () {
    try { console.error.apply(console, ['[weread-beautify]'].concat([].slice.call(arguments))); } catch (err) { /* ignore */ }
  };
  log('v1.1.3 已加载，等待阅读器就绪');

  const VERSION = '1.1.3';
  const STORAGE_KEY = 'wrbf.settings.v1';
  const ROOT = document.documentElement;

  const DEFAULTS = {
    theme: 'paper',      // site | paper | green | night
    immersive: true,     // 隐藏顶栏/按钮，边缘唤出
    maxWidth: 1500,      // 阅读区最大宽度（px）
    wheel: true,         // 滚轮翻页
    autoTurn: 0,         // 自动翻页间隔（秒），0 = 关闭
    progress: true,      // 底部阅读进度条
    hintSeen: false      // 是否已经展示过入口提示
  };

  const THEMES = ['site', 'paper', 'green', 'night'];

  /* ============================================================
   * 配置读写
   * ============================================================ */

  function readStore() {
    try {
      if (typeof GM_getValue === 'function') {
        const raw = GM_getValue(STORAGE_KEY, '');
        return raw ? JSON.parse(raw) : {};
      }
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (err) {
      return {};
    }
  }

  function writeStore(data) {
    const raw = JSON.stringify(data);
    try {
      if (typeof GM_setValue === 'function') GM_setValue(STORAGE_KEY, raw);
      else localStorage.setItem(STORAGE_KEY, raw);
    } catch (err) {
      /* 存储失败不影响使用 */
    }
  }

  const cfg = Object.assign({}, DEFAULTS, readStore());
  // 容错：保证字段类型正确
  cfg.theme = THEMES.indexOf(cfg.theme) >= 0 ? cfg.theme : DEFAULTS.theme;
  cfg.immersive = !!cfg.immersive;
  cfg.wheel = !!cfg.wheel;
  cfg.progress = !!cfg.progress;
  cfg.maxWidth = Math.min(2200, Math.max(900, Number(cfg.maxWidth) || DEFAULTS.maxWidth));
  cfg.autoTurn = [0, 15, 30, 60].indexOf(Number(cfg.autoTurn)) >= 0 ? Number(cfg.autoTurn) : 0;
  cfg.hintSeen = !!cfg.hintSeen;

  function save() {
    writeStore(cfg);
  }

  /* ============================================================
   * 样式
   * ============================================================ */

  const CSS = `
/* ---------- 主题变量 ---------- */
html.wrbf {
  --wrbf-page-max: 1500px;
  --wrbf-outside: #1c1c1d;
  --wrbf-surface: #1c1c1d;
  --wrbf-muted: #8a8f98;
  --wrbf-accent: #d5a35c;
  --wrbf-ink: #d0d3d8;
  --wrbf-line: rgba(255, 255, 255, .10);
}
html.wrbf[data-wrbf-theme="paper"] {
  --wrbf-outside: #e7ddcb;
  --wrbf-surface: #fbf5e6;
  --wrbf-muted: #99855f;
  --wrbf-accent: #b0813f;
  --wrbf-ink: #3a3126;
  --wrbf-line: rgba(60, 45, 20, .14);
}
html.wrbf[data-wrbf-theme="green"] {
  --wrbf-outside: #dde6d7;
  --wrbf-surface: #edf3e4;
  --wrbf-muted: #77876d;
  --wrbf-accent: #5d7c50;
  --wrbf-ink: #2f3a2b;
  --wrbf-line: rgba(40, 60, 35, .14);
}
html.wrbf[data-wrbf-theme="night"] {
  --wrbf-outside: #07090c;
  --wrbf-surface: #111419;
  --wrbf-muted: #6d7784;
  --wrbf-accent: #5d82ab;
  --wrbf-ink: #d5dbe3;
  --wrbf-line: rgba(255, 255, 255, .10);
}

/* ---------- 版面：更宽、更高、去掉多余留白 ---------- */
html.wrbf .wr_horizontalReader .readerChapterContent {
  width: min(var(--wrbf-page-max), 92vw) !important;
  max-width: 92vw !important;
  height: calc(100% - 72px) !important;
  margin-top: 72px !important;
  border-radius: 10px !important;
}
html.wrbf.wrbf-immersive .wr_horizontalReader .readerChapterContent {
  height: 100% !important;
  margin-top: 0 !important;
  border-radius: 0 !important;
}
/* 关掉阅读区底部那条多余的渐变占位 */
html.wrbf .wr_horizontalReader .readerChapterContent_container {
  height: 100% !important;
}

/* ---------- 主题底色 ---------- */
html.wrbf:not(.wrbf-flyleaf)[data-wrbf-theme]:not([data-wrbf-theme="site"]) {
  background-color: var(--wrbf-outside) !important;
}
html.wrbf:not(.wrbf-flyleaf)[data-wrbf-theme]:not([data-wrbf-theme="site"]) body {
  background-color: var(--wrbf-outside) !important;
}
html.wrbf:not(.wrbf-flyleaf)[data-wrbf-theme]:not([data-wrbf-theme="site"]) .wr_horizontalReader_app_content,
html.wrbf:not(.wrbf-flyleaf)[data-wrbf-theme]:not([data-wrbf-theme="site"]) .readerChapterContent_container,
html.wrbf:not(.wrbf-flyleaf)[data-wrbf-theme]:not([data-wrbf-theme="site"]) .wr_various_font_provider_wrapper {
  background-color: var(--wrbf-outside) !important;
}
html.wrbf:not(.wrbf-flyleaf)[data-wrbf-theme]:not([data-wrbf-theme="site"]) .readerChapterContent {
  background-color: var(--wrbf-surface) !important;
  box-shadow: 0 18px 60px rgba(90, 72, 42, 0.10) !important;
}
html.wrbf.wrbf-immersive[data-wrbf-theme]:not([data-wrbf-theme="site"]) .readerChapterContent {
  box-shadow: none !important;
}
html.wrbf:not(.wrbf-flyleaf)[data-wrbf-theme]:not([data-wrbf-theme="site"]) .renderTargetPageInfo_header_chapterTitle {
  color: var(--wrbf-muted) !important;
}

/* ---------- 正文换色：canvas 滤镜（只作用于正文画布，不影响插图） ---------- */
/* 原站浅色主题：深色字 -> 仍为深色，加一点暖/绿色调 */
html.wrbf:not(.wrbf-flyleaf)[data-wrbf-theme="paper"] body.wr_whiteTheme .wr_canvasContainer canvas {
  filter: sepia(.30) saturate(.96) contrast(.93) brightness(1.01);
}
/* 原站深色主题：浅色字 -> 反相成深色，再暖化 */
html.wrbf:not(.wrbf-flyleaf)[data-wrbf-theme="paper"] body:not(.wr_whiteTheme) .wr_canvasContainer canvas {
  filter: invert(1) sepia(.26) saturate(.92) hue-rotate(-4deg) contrast(.95);
}
html.wrbf:not(.wrbf-flyleaf)[data-wrbf-theme="green"] body.wr_whiteTheme .wr_canvasContainer canvas {
  filter: sepia(.16) hue-rotate(28deg) saturate(.82) contrast(.95);
}
html.wrbf:not(.wrbf-flyleaf)[data-wrbf-theme="green"] body:not(.wr_whiteTheme) .wr_canvasContainer canvas {
  filter: invert(1) sepia(.22) hue-rotate(42deg) saturate(.78) contrast(.95);
}
html.wrbf:not(.wrbf-flyleaf)[data-wrbf-theme="night"] body.wr_whiteTheme .wr_canvasContainer canvas {
  filter: invert(1) hue-rotate(180deg) saturate(.8) brightness(.9);
}
html.wrbf:not(.wrbf-flyleaf)[data-wrbf-theme="night"] body:not(.wr_whiteTheme) .wr_canvasContainer canvas {
  filter: brightness(.94) saturate(.9);
}


/* ---------- 章节末尾的页脚（"本章完 / 下一章"）跟随主题 ---------- */
html.wrbf:not(.wrbf-flyleaf)[data-wrbf-theme]:not([data-wrbf-theme="site"]) .readerFooter,
html.wrbf:not(.wrbf-flyleaf)[data-wrbf-theme]:not([data-wrbf-theme="site"]) .readerFooter_desc,
html.wrbf:not(.wrbf-flyleaf)[data-wrbf-theme]:not([data-wrbf-theme="site"]) .readerFooter_ending_time,
html.wrbf:not(.wrbf-flyleaf)[data-wrbf-theme]:not([data-wrbf-theme="site"]) .readerFooter_ending_counter {
  color: var(--wrbf-muted) !important;
}
html.wrbf:not(.wrbf-flyleaf)[data-wrbf-theme]:not([data-wrbf-theme="site"]) .readerFooter_button:not(.blue) {
  background-color: rgba(127, 127, 127, .12) !important;
  color: var(--wrbf-accent) !important;
}
html.wrbf:not(.wrbf-flyleaf)[data-wrbf-theme]:not([data-wrbf-theme="site"]) .readerFooter_button:not(.blue):hover {
  background-color: rgba(127, 127, 127, .18) !important;
}
html.wrbf:not(.wrbf-flyleaf)[data-wrbf-theme]:not([data-wrbf-theme="site"]) .readerFooter_ending_title {
  color: var(--wrbf-ink) !important;
}
html.wrbf:not(.wrbf-flyleaf)[data-wrbf-theme]:not([data-wrbf-theme="site"]) .readerFooter_ending .readerFooter_ending_recommend {
  background-color: var(--wrbf-outside) !important;
}

/* ---------- 顶栏跟随主题 ---------- */
html.wrbf[data-wrbf-theme]:not([data-wrbf-theme="site"]) .readerTopBar {
  background-color: var(--wrbf-surface) !important;
  border-bottom: 1px solid var(--wrbf-line) !important;
  padding: 0 24px !important;
}
html.wrbf[data-wrbf-theme]:not([data-wrbf-theme="site"]) .readerTopBar_title,
html.wrbf[data-wrbf-theme]:not([data-wrbf-theme="site"]) .readerTopBar_title_link {
  color: var(--wrbf-ink) !important;
}
html.wrbf[data-wrbf-theme]:not([data-wrbf-theme="site"]) .readerTopBar_link {
  color: var(--wrbf-muted) !important;
}
html.wrbf[data-wrbf-theme]:not([data-wrbf-theme="site"]) .readerTopBar_link_sep {
  background-color: var(--wrbf-line) !important;
}
html.wrbf[data-wrbf-theme]:not([data-wrbf-theme="site"]) .readerTopBar_addToShelf {
  color: var(--wrbf-muted) !important;
  border-color: var(--wrbf-line) !important;
}
html.wrbf[data-wrbf-theme]:not([data-wrbf-theme="site"]) .readerTopBar_addToShelf svg,
html.wrbf[data-wrbf-theme]:not([data-wrbf-theme="site"]) .readerTopBar_addToShelf svg path {
  fill: currentColor !important;
}
/* 站点深色 -> 浅色主题时换用浅色主题的 logo；反之亦然 */
html.wrbf[data-wrbf-theme="paper"] body:not(.wr_whiteTheme) .readerTopBar_home,
html.wrbf[data-wrbf-theme="green"] body:not(.wr_whiteTheme) .readerTopBar_home {
  background-image: url("https://cdn.weread.qq.com/web/wrwebnjlogic/image/web_nav_logo_light.55c74ef3.svg") !important;
}
html.wrbf[data-wrbf-theme="night"] body.wr_whiteTheme .readerTopBar_home {
  background-image: url("https://cdn.weread.qq.com/web/wrwebnjlogic/image/web_nav_logo_dark.ee940675.svg") !important;
}

/* ---------- 沉浸模式：隐藏常驻 UI ---------- */
html.wrbf.wrbf-immersive .readerTopBar {
  display: none !important;
}
html.wrbf.wrbf-immersive.wrbf-top .readerTopBar {
  display: flex !important;
}
html.wrbf.wrbf-immersive .readerControls {
  position: fixed !important;
  right: 14px !important;
  top: 50% !important;
  transform: translateY(-50%) !important;
  z-index: 90 !important;
  opacity: 0;
  visibility: hidden;
  transition: opacity .18s ease, visibility .18s ease;
}
html.wrbf.wrbf-immersive .renderTarget_pager {
  opacity: 0;
  visibility: hidden;
  transition: opacity .18s ease, visibility .18s ease;
}
html.wrbf.wrbf-immersive .renderTargetPageInfo_header {
  opacity: 0 !important;
  visibility: hidden !important;
  pointer-events: none !important;
}
html.wrbf.wrbf-immersive.wrbf-ui .readerControls,
html.wrbf.wrbf-immersive.wrbf-ui .renderTarget_pager {
  opacity: 1;
  visibility: visible;
}
/* 翻页按钮在屏幕底部时保持可点 */
html.wrbf.wrbf-immersive .renderTarget_pager {
  pointer-events: none;
}
html.wrbf.wrbf-immersive.wrbf-ui .renderTarget_pager {
  pointer-events: auto;
}

/* ---------- 非沉浸模式下也把工具栏固定在可视区右侧 ---------- */
html.wrbf:not(.wrbf-immersive) .readerControls {
  position: fixed !important;
  right: 14px !important;
  top: 50% !important;
  transform: translateY(-50%) !important;
  z-index: 90 !important;
}

/* ---------- 右侧工具栏固定在右边后，提示气泡改到左侧，避免出屏 ---------- */
html.wrbf .readerControls .wr_tooltip_item--right {
  left: auto !important;
  right: calc(100% + var(--offset)) !important;
  transform: translateY(-50%) !important;
}

/* ---------- 关闭沉浸时，顶栏与阅读区同宽 ---------- */
html.wrbf .wr_horizontalReader_app_content .readerTopBar {
  width: min(var(--wrbf-page-max), 92vw) !important;
  max-width: 92vw !important;
}
`;

  function injectStyle() {
    if (document.getElementById('wrbf-style')) return;
    const style = document.createElement('style');
    style.id = 'wrbf-style';
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  /* ============================================================
   * 面板 UI（Shadow DOM，隔离站点样式）
   * ============================================================ */

  const UI_HTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; }

  .bar {
    position: absolute; left: 0; right: 0; bottom: 0; height: 16px;
    background: transparent; pointer-events: auto; z-index: 3;
    font: 12px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  .bar-fill {
    position: absolute; left: 0; bottom: 0; height: 3px; width: 0;
    background: linear-gradient(90deg, #f0b25e, #d98b3a);
    opacity: .55; transition: width .5s cubic-bezier(.22,.61,.36,1), opacity .2s, height .15s;
  }
  .bar:hover .bar-fill { opacity: .9; height: 5px; }
  .bar-label {
    position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%);
    max-width: 86vw; padding: 5px 10px; border-radius: 8px;
    background: rgba(18,20,24,.92); color: #e9ecf1; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis; opacity: 0; pointer-events: none;
    transition: opacity .18s ease; box-shadow: 0 6px 20px rgba(0,0,0,.3);
  }
  .bar:hover .bar-label { opacity: 1; }

  .launcher {
    position: absolute; left: 14px; bottom: 14px; width: 34px; height: 34px;
    border: 1px solid rgba(255,255,255,.45); border-radius: 50%; padding: 0; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    color: #fff;
    background: linear-gradient(180deg, #e6ad63, #cd7f2c);
    box-shadow: 0 4px 14px rgba(90, 55, 10, .38), inset 0 1px 0 rgba(255,255,255,.35);
    opacity: .9; transition: opacity .2s ease, transform .2s ease;
    pointer-events: auto; z-index: 5;
  }
  .launcher:hover, .launcher.on { opacity: 1; transform: scale(1.06); }
  .launcher svg { width: 18px; height: 18px; }
  .launcher.pulse { animation: wrbfPulse 1.5s ease-in-out 0s 3; }
  @keyframes wrbfPulse {
    0%, 100% { box-shadow: 0 4px 14px rgba(90, 55, 10, .38), 0 0 0 0 rgba(224,167,90,.0); }
    50% { box-shadow: 0 4px 14px rgba(90, 55, 10, .38), 0 0 0 9px rgba(224,167,90,.22); }
  }

  .hint {
    position: absolute; left: 58px; bottom: 21px;
    padding: 7px 11px; border-radius: 10px;
    background: rgba(24,26,30,.94); color: #f2f4f7;
    font: 12px/1.35 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    box-shadow: 0 8px 24px rgba(0,0,0,.32);
    pointer-events: none; white-space: nowrap; z-index: 6;
    opacity: 0; transform: translateY(2px);
    transition: opacity .25s ease, transform .25s ease;
  }
  .hint.show { opacity: 1; transform: translateY(0); }
  .hint::after {
    content: ""; position: absolute; left: -5px; bottom: 12px; width: 10px; height: 10px;
    background: rgba(24,26,30,.94); transform: rotate(45deg);
  }

  .pill {
    position: absolute; left: 50%; top: 14px; transform: translateX(-50%);
    display: flex; align-items: center; gap: 8px;
    padding: 6px 8px 6px 12px; border-radius: 999px;
    background: rgba(24,26,30,.9); color: #e9ecf1;
    font: 12px/1 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    box-shadow: 0 8px 24px rgba(0,0,0,.3); pointer-events: auto; z-index: 6;
    backdrop-filter: blur(8px);
  }
  .pill[hidden] { display: none; }
  .pill button {
    border: 1px solid rgba(255,255,255,.22); background: transparent; color: #fff;
    border-radius: 999px; padding: 4px 10px; font-size: 12px; cursor: pointer;
  }
  .pill button:hover { background: rgba(255,255,255,.12); }

  .panel {
    position: absolute; left: 14px; bottom: 58px; width: 328px;
    max-height: min(76vh, 640px); overflow: auto;
    background: rgba(24,26,31,.96); color: #e8ebef;
    border: 1px solid rgba(255,255,255,.08); border-radius: 16px;
    box-shadow: 0 24px 70px rgba(0,0,0,.5);
    backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
    pointer-events: auto; z-index: 7;
    font: 13px/1.55 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    padding: 14px 16px 12px;
  }
  .panel[hidden] { display: none; }
  .p-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  .p-head b { font-size: 14px; font-weight: 600; letter-spacing: .2px; }
  .p-head .ver { margin-left: 6px; font-size: 11px; color: #7f8792; }
  .p-close {
    width: 26px; height: 26px; border: 0; border-radius: 8px; cursor: pointer;
    background: rgba(255,255,255,.06); color: #aeb6c0; font-size: 13px;
  }
  .p-close:hover { background: rgba(255,255,255,.12); color: #fff; }

  .p-sec { padding: 9px 0; border-top: 1px solid rgba(255,255,255,.07); }
  .p-sec:first-of-type { border-top: 0; padding-top: 0; }
  .p-label { color: #9aa3ad; font-size: 12px; margin-bottom: 8px; display: flex; justify-content: space-between; }
  .p-label output { color: #d8dde4; font-variant-numeric: tabular-nums; }

  .themes { display: flex; gap: 8px; }
  .sw {
    flex: 1; border: 1px solid transparent; border-radius: 9px; padding: 4px 4px 5px;
    background: rgba(255,255,255,.05); color: #aab2bc; cursor: pointer;
    display: flex; flex-direction: column; align-items: center; gap: 4px;
    font: 11px/1.2 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  .sw i { display: block; width: 100%; height: 26px; border-radius: 6px; border: 1px solid rgba(255,255,255,.14); }
  .sw:hover { background: rgba(255,255,255,.1); color: #e8ebef; }
  .sw.on { border-color: rgba(255,255,255,.5); background: rgba(255,255,255,.14); color: #fff; }

  input[type="range"] {
    width: 100%; margin: 2px 0 0; accent-color: #e0a75a; cursor: pointer;
  }
  .p-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .p-row label { color: #c7ced6; cursor: pointer; }
  input[type="checkbox"] { width: 16px; height: 16px; accent-color: #e0a75a; cursor: pointer; }
  select {
    background: rgba(255,255,255,.08); color: #e8ebef; border: 1px solid rgba(255,255,255,.12);
    border-radius: 8px; padding: 4px 8px; font-size: 12px; cursor: pointer; outline: none;
  }
  .p-btns { display: flex; gap: 8px; }
  .p-btn {
    flex: 1; border: 1px solid rgba(255,255,255,.14); border-radius: 9px;
    background: rgba(255,255,255,.07); color: #e8ebef; padding: 7px 10px;
    font-size: 12px; cursor: pointer;
  }
  .p-btn:hover { background: rgba(255,255,255,.14); }
  .p-btn.ghost { background: transparent; color: #9aa3ad; }
  .p-keys { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 10px; color: #8f98a3; font-size: 11.5px; }
  .p-keys kbd {
    display: inline-block; min-width: 18px; padding: 1px 4px; margin-right: 2px;
    border-radius: 4px; border: 1px solid rgba(255,255,255,.16);
    background: rgba(255,255,255,.06); color: #cfd6de;
    font: 10.5px/1.4 ui-monospace, Menlo, Consolas, monospace; text-align: center;
  }
</style>

<div class="bar" id="bar" role="progressbar" aria-label="阅读进度" aria-valuemin="0" aria-valuemax="100">
  <div class="bar-fill" id="barFill"></div>
  <div class="bar-label" id="barLabel"></div>
</div>

<button class="launcher" id="launcher" title="阅读优化设置（Alt+S）" aria-label="阅读优化设置">
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M4 7h8M17 7h3M4 17h3M12 17h8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
    <circle cx="14.5" cy="7" r="2.1" stroke="currentColor" stroke-width="1.7"/>
    <circle cx="9.5" cy="17" r="2.1" stroke="currentColor" stroke-width="1.7"/>
  </svg>
</button>

<div class="hint" id="hint">点这里打开设置 · Alt+S</div>

<div class="pill" id="pill" hidden>
  <span>自动翻页中</span>
  <button id="pillStop">停止</button>
</div>

<div class="panel" id="panel" hidden>
  <div class="p-head">
    <div><b>阅读优化</b><span class="ver">v${VERSION}</span></div>
    <button class="p-close" id="pClose" aria-label="关闭">✕</button>
  </div>

  <div class="p-sec">
    <div class="p-label">主题</div>
    <div class="themes" id="themes">
      <button class="sw" data-theme="site"><i style="background:linear-gradient(135deg,#f6f6f6 0 50%,#1c1c1d 50% 100%)"></i><span>原版</span></button>
      <button class="sw" data-theme="paper"><i style="background:#fbf5e6"></i><span>纸黄</span></button>
      <button class="sw" data-theme="green"><i style="background:#edf3e4"></i><span>护眼</span></button>
      <button class="sw" data-theme="night"><i style="background:#111419"></i><span>夜间</span></button>
    </div>
  </div>

  <div class="p-sec">
    <div class="p-label">页面最大宽度 <output id="wOut">1500px</output></div>
    <input type="range" id="wRange" min="900" max="2200" step="20" value="1500">
  </div>

  <div class="p-sec p-row">
    <label for="cImmersive">沉浸模式</label>
    <input type="checkbox" id="cImmersive">
  </div>
  <div class="p-sec p-row">
    <label for="cWheel">滚轮翻页</label>
    <input type="checkbox" id="cWheel">
  </div>
  <div class="p-sec p-row">
    <label for="cProgress">底部阅读进度</label>
    <input type="checkbox" id="cProgress">
  </div>
  <div class="p-sec p-row">
    <label for="sAuto">自动翻页</label>
    <select id="sAuto">
      <option value="0">关闭</option>
      <option value="15">15 秒</option>
      <option value="30">30 秒</option>
      <option value="60">60 秒</option>
    </select>
  </div>

  <div class="p-sec p-btns">
    <button class="p-btn" id="btnFull">全屏阅读</button>
    <button class="p-btn ghost" id="btnReset">恢复默认</button>
  </div>

  <div class="p-sec p-keys">
    <div><kbd>Alt</kbd><kbd>H</kbd> 沉浸模式</div>
    <div><kbd>Alt</kbd><kbd>T</kbd> 切换主题</div>
    <div><kbd>Alt</kbd><kbd>S</kbd> 设置面板</div>
    <div><kbd>Alt</kbd><kbd>A</kbd> 自动翻页</div>
    <div><kbd>Alt</kbd><kbd>↵</kbd> 全屏</div>
    <div><kbd>Esc</kbd> 关闭面板</div>
  </div>
</div>
`;

  let host = null;
  let sr = null;
  let booted = false;
  let panelOpen = false;
  let ui = {};

  function createUI() {
    if (host || !document.body) return;
    log('createUI: 开始创建界面');
    host = document.createElement('div');
    host.id = 'wrbf-ui';
    host.setAttribute('data-wrbf', 'ui');
    // 用内联 !important 防止广告拦截插件把浮层当成广告隐藏
    // （有的过滤规则是 head ~ div[style*="z-index"]，会误伤挂在 <html> 下的浮层）
    host.style.cssText = 'position:fixed!important;inset:0!important;z-index:2147483000!important;' +
      'pointer-events:none!important;display:block!important;visibility:visible!important;' +
      'opacity:1!important;width:100vw!important;height:100vh!important;';
    if (typeof host.attachShadow !== 'function') throw new Error('当前浏览器不支持 Shadow DOM');
    sr = host.attachShadow({ mode: 'open' });
    sr.innerHTML = UI_HTML;
    document.body.appendChild(host);

    ui = {
      bar: sr.getElementById('bar'),
      barFill: sr.getElementById('barFill'),
      barLabel: sr.getElementById('barLabel'),
      launcher: sr.getElementById('launcher'),
      hint: sr.getElementById('hint'),
      pill: sr.getElementById('pill'),
      pillStop: sr.getElementById('pillStop'),
      panel: sr.getElementById('panel'),
      pClose: sr.getElementById('pClose'),
      themes: sr.getElementById('themes'),
      wRange: sr.getElementById('wRange'),
      wOut: sr.getElementById('wOut'),
      cImmersive: sr.getElementById('cImmersive'),
      cWheel: sr.getElementById('cWheel'),
      cProgress: sr.getElementById('cProgress'),
      sAuto: sr.getElementById('sAuto'),
      btnFull: sr.getElementById('btnFull'),
      btnReset: sr.getElementById('btnReset')
    };

    bindUI();
    syncPanel();
    log('createUI: 界面已创建');
  }

  function bindUI() {
    ui.launcher.addEventListener('click', function () {
      panelOpen ? closePanel() : openPanel();
    });
    ui.pClose.addEventListener('click', closePanel);
    ui.pillStop.addEventListener('click', function () {
      cfg.autoTurn = 0;
      save();
      apply(false);
    });
    ui.btnFull.addEventListener('click', toggleFullscreen);
    ui.btnReset.addEventListener('click', function () {
      Object.assign(cfg, DEFAULTS);
      save();
      apply();
      closePanel();
      toast('已恢复默认设置');
    });

    ui.themes.addEventListener('click', function (ev) {
      const btn = ev.target.closest('.sw');
      if (!btn) return;
      cfg.theme = btn.getAttribute('data-theme');
      save();
      apply(false);
    });

    ui.wRange.addEventListener('input', function () {
      ui.wOut.textContent = ui.wRange.value + 'px';
    });
    ui.wRange.addEventListener('change', function () {
      cfg.maxWidth = Number(ui.wRange.value) || DEFAULTS.maxWidth;
      save();
      apply();
    });

    ui.cImmersive.addEventListener('change', function () {
      cfg.immersive = ui.cImmersive.checked;
      save();
      apply();
    });
    ui.cWheel.addEventListener('change', function () {
      cfg.wheel = ui.cWheel.checked;
      save();
      apply(false);
    });
    ui.cProgress.addEventListener('change', function () {
      cfg.progress = ui.cProgress.checked;
      save();
      apply(false);
    });
    ui.sAuto.addEventListener('change', function () {
      cfg.autoTurn = Number(ui.sAuto.value) || 0;
      save();
      apply(false);
    });
  }

  function ensureUI() {
    if (ui && ui.panel) return true;
    if (!document.body) return false;
    try {
      createUI();
      apply();
      return !!(ui && ui.panel);
    } catch (err) {
      logError('界面创建失败：', err);
      showFallback();
      return false;
    }
  }

  function openPanel() {
    if (!ensureUI()) return;
    panelOpen = true;
    ui.panel.hidden = false;
    ui.launcher.classList.add('on');
    if (ui.hint) {
      ui.hint.classList.remove('show');
      clearTimeout(hintTimer);
    }
    showChrome();
  }

  function closePanel() {
    panelOpen = false;
    if (ui.panel) ui.panel.hidden = true;
    if (ui.launcher) ui.launcher.classList.remove('on');
  }

  function syncPanel() {
    if (!ui.themes) return;
    Array.prototype.forEach.call(ui.themes.children, function (btn) {
      btn.classList.toggle('on', btn.getAttribute('data-theme') === cfg.theme);
    });
    ui.wRange.value = cfg.maxWidth;
    ui.wOut.textContent = cfg.maxWidth + 'px';
    ui.cImmersive.checked = cfg.immersive;
    ui.cWheel.checked = cfg.wheel;
    ui.cProgress.checked = cfg.progress;
    ui.sAuto.value = String(cfg.autoTurn);
  }

  let hintTimer = 0;
  function showHint(ms) {
    if (!ui.hint) return;
    ui.hint.classList.add('show');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(function () { ui.hint.classList.remove('show'); }, ms || 6000);
  }

  function showFallback() {
    if (!document.body || document.getElementById('wrbf-fallback')) return;
    const el = document.createElement('div');
    el.id = 'wrbf-fallback';
    el.textContent = '阅读优化加载失败，请按 F12 查看 [weread-beautify] 日志';
    el.style.cssText = 'position:fixed;left:14px;bottom:14px;z-index:2147483647;padding:8px 12px;' +
      'border-radius:8px;background:#b3261e;color:#fff;font:12px/1.4 -apple-system,"PingFang SC",sans-serif;' +
      'box-shadow:0 6px 20px rgba(0,0,0,.3);';
    document.body.appendChild(el);
  }

  let toastTimer = 0;
  function toast(text) {
    if (!sr) return;
    let el = sr.getElementById('wrbf-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'wrbf-toast';
      el.style.cssText = 'position:absolute;left:50%;top:18px;transform:translateX(-50%);padding:7px 14px;' +
        'border-radius:999px;background:rgba(24,26,30,.92);color:#fff;font:12px/1.4 -apple-system,"PingFang SC",sans-serif;' +
        'box-shadow:0 8px 24px rgba(0,0,0,.35);opacity:0;transition:opacity .2s;pointer-events:none;z-index:20;';
      sr.appendChild(el);
    }
    el.textContent = text;
    el.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.style.opacity = '0'; }, 1400);
  }

  /* ============================================================
   * 进度条
   * ============================================================ */

  let lastProgressText = '';

  function updateProgress() {
    if (!ui.bar || !cfg.progress) return;
    let total = 0;
    let index = 0;
    try {
      const items = document.querySelectorAll('.readerCatalog_list_item');
      total = items.length;
      const sel = document.querySelector('.readerCatalog_list_item_selected');
      if (sel && total) index = Array.prototype.indexOf.call(items, sel) + 1;
    } catch (err) { /* ignore */ }

    const titleEl = document.querySelector('.renderTargetPageInfo_header_chapterTitle');
    let chapter = titleEl ? (titleEl.textContent || '').trim() : '';
    if (!chapter) {
      const selTitle = document.querySelector('.readerCatalog_list_item_selected .readerCatalog_list_item_title_text');
      chapter = selTitle ? (selTitle.textContent || '').trim() : '';
    }

    let percent = 0;
    if (total > 0 && index > 0) percent = Math.min(100, Math.round((index / total) * 100));

    ui.barFill.style.width = percent + '%';

    let text = '';
    if (total > 0 && index > 0) text = '第 ' + index + ' / ' + total + ' 章 · ' + percent + '%';
    if (chapter) text += (text ? '　' : '') + chapter;
    if (!text) text = '阅读进度';
    if (text !== lastProgressText) {
      lastProgressText = text;
      ui.barLabel.textContent = text;
    }
    ui.bar.setAttribute('aria-valuenow', String(percent));
  }


  /* 扉页 / 封底这类"站点原生页面"上暂停主题，避免深色主题的浅色文字落到浅色背景上 */
  let flyleafState = null;

  function elVisible(el) {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function syncFlyleaf() {
    const visible = elVisible(document.querySelector('.reader_flyleaf_container')) ||
      elVisible(document.querySelector('.horizontal_reader_back_cover_wrapper'));
    if (visible === flyleafState) return;
    flyleafState = visible;
    ROOT.classList.toggle('wrbf-flyleaf', visible);
  }

  /* ============================================================
   * 翻页 / 自动翻页
   * ============================================================ */

  function turnPage(dir) {
    const nextBtn = document.querySelector('.renderTarget_pager_button_right');
    const prevBtn = document.querySelector('.renderTarget_pager_content:not(.renderTarget_pager_content_right) .renderTarget_pager_button');
    const btn = dir > 0 ? nextBtn : prevBtn;

    if (btn) {
      btn.click();
      setTimeout(syncFlyleaf, 80);
      return true;
    }

    // 章节末尾/开头时按钮可能不存在，退回到官方快捷键
    const ev = new KeyboardEvent('keydown', {
      key: dir > 0 ? 'ArrowRight' : 'ArrowLeft',
      code: dir > 0 ? 'ArrowRight' : 'ArrowLeft',
      keyCode: dir > 0 ? 39 : 37,
      which: dir > 0 ? 39 : 37,
      bubbles: true,
      cancelable: true
    });
    document.body.dispatchEvent(ev);
    return true;
  }

  let autoTimer = 0;

  function restartAutoTurn() {
    clearInterval(autoTimer);
    autoTimer = 0;
    if (cfg.autoTurn > 0) {
      autoTimer = setInterval(function () {
        if (document.hidden || sitePanelOpen()) return;
        turnPage(1);
      }, cfg.autoTurn * 1000);
    }
    if (ui.pill) ui.pill.hidden = cfg.autoTurn <= 0;
  }

  /* ============================================================
   * 滚轮翻页
   * ============================================================ */

  let wheelAccum = 0;
  let wheelLockUntil = 0;

  // 站点自己的目录/评论/AI 面板是否打开（这些面板开着时不自动翻页）
  function sitePanelOpen() {
    const nodes = document.querySelectorAll(
      '.readerCatalog,.reader_float_panel,.reader_float_panel_overlay_wrapper,.wr_dialog,.readerAIChatPanel'
    );
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width > 40 && rect.height > 40) return true;
    }
    return false;
  }

  function overUI(target) {
    if (!(target instanceof Element)) return false;
    return !!target.closest(
      '.readerCatalog,.reader_float_panel,.wr_dialog,.readerTopBar,.readerControls,' +
      '.reader_float_panel_overlay_wrapper,.readerAIChatPanel,.review_editor_container_in_reader'
    );
  }

  function onWheel(ev) {
    if (!cfg.wheel) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (overUI(ev.target)) return;
    if (ev.composedPath && ev.composedPath().indexOf(host) >= 0) return;

    // 正在选中文字时不翻页
    const sel = window.getSelection();
    if (sel && String(sel).length > 0) return;
    if (panelOpen) return;

    const now = Date.now();
    if (now < wheelLockUntil) return;

    wheelAccum += ev.deltaY;
    if (Math.abs(wheelAccum) < 90) return;

    const dir = wheelAccum > 0 ? 1 : -1;
    wheelAccum = 0;
    if (sitePanelOpen()) return;
    wheelLockUntil = now + 700;

    if (ev.cancelable) ev.preventDefault();
    turnPage(dir);
  }

  /* ============================================================
   * 沉浸 UI 显隐
   * ============================================================ */

  let uiTimer = 0;
  let topTimer = 0;
  let pointer = { x: 0, y: 0 };

  function showTopChrome() {
    if (!cfg.immersive) return;
    ROOT.classList.add('wrbf-top');
    clearTimeout(topTimer);
    topTimer = setTimeout(function () { ROOT.classList.remove('wrbf-top'); }, 2200);
  }

  function showChrome() {
    if (!cfg.immersive) return;
    ROOT.classList.add('wrbf-ui');
    clearTimeout(uiTimer);
    uiTimer = setTimeout(hideChrome, 1800);
  }

  function hideChrome() {
    if (!cfg.immersive || panelOpen) return;
    const nearEdge = pointer.y < 72 || pointer.x > window.innerWidth - 90 || pointer.y > window.innerHeight - 72;
    if (nearEdge) {
      uiTimer = setTimeout(hideChrome, 1200);
      return;
    }
    ROOT.classList.remove('wrbf-ui');
  }

  function onPointerMove(ev) {
    pointer = { x: ev.clientX, y: ev.clientY };
    if (!cfg.immersive) return;
    if (ev.clientY < 60) showTopChrome();
    if (ev.clientY < 72 || ev.clientX > window.innerWidth - 90 || ev.clientY > window.innerHeight - 72) {
      showChrome();
    }
  }

  /* ============================================================
   * 重新分页
   * ============================================================ */

  let reflowTimer = 0;

  function repaginate(delay) {
    clearTimeout(reflowTimer);
    reflowTimer = setTimeout(function () {
      try {
        window.dispatchEvent(new Event('resize'));
      } catch (err) { /* ignore */ }
    }, typeof delay === 'number' ? delay : 60);
  }

  /* ============================================================
   * 主题 / 设置应用
   * ============================================================ */

  function apply(layout) {
    ROOT.classList.toggle('wrbf-immersive', !!cfg.immersive);
    ROOT.setAttribute('data-wrbf-theme', cfg.theme);
    ROOT.style.setProperty('--wrbf-page-max', cfg.maxWidth + 'px');

    if (!cfg.immersive) {
      ROOT.classList.remove('wrbf-ui', 'wrbf-top');
      clearTimeout(uiTimer);
      clearTimeout(topTimer);
    }

    if (ui.bar) ui.bar.style.display = cfg.progress ? '' : 'none';
    if (ui.pill) ui.pill.hidden = cfg.autoTurn <= 0;

    syncPanel();
    restartAutoTurn();
    updateProgress();
    if (layout !== false) repaginate(80);
  }

  function setTheme(theme) {
    if (THEMES.indexOf(theme) < 0) return;
    cfg.theme = theme;
    save();
    apply(false);
  }

  function cycleTheme() {
    const idx = THEMES.indexOf(cfg.theme);
    setTheme(THEMES[(idx + 1) % THEMES.length]);
    toast('主题：' + themeName(cfg.theme));
  }

  function themeName(t) {
    return { site: '原版', paper: '纸黄', green: '护眼', night: '夜间' }[t] || t;
  }

  /* ============================================================
   * 全屏
   * ============================================================ */

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      try {
        const p = document.exitFullscreen && document.exitFullscreen();
        if (p && p.catch) p.catch(function () {});
      } catch (err) { /* ignore */ }
    } else {
      const el = document.documentElement;
      const req = el.requestFullscreen || el.webkitRequestFullscreen;
      if (req) {
        try {
          const p = req.call(el);
          if (p && p.catch) p.catch(function () {});
        } catch (err) { /* ignore */ }
      }
    }
  }

  /* ============================================================
   * 快捷键
   * ============================================================ */

  function isEditable(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  function onKeyDown(ev) {
    if (ev.key === 'Escape') {
      if (panelOpen) {
        ev.stopPropagation();
        closePanel();
      }
      return;
    }
    if (!ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
    if (isEditable(ev.target)) return;

    switch (ev.code) {
      case 'KeyH':
        ev.preventDefault();
        cfg.immersive = !cfg.immersive;
        save();
        apply();
        break;
      case 'KeyT':
        ev.preventDefault();
        cycleTheme();
        break;
      case 'KeyS':
      case 'Comma':
        ev.preventDefault();
        panelOpen ? closePanel() : openPanel();
        break;
      case 'KeyA':
        ev.preventDefault();
        cfg.autoTurn = cfg.autoTurn > 0 ? 0 : 30;
        save();
        apply(false);
        toast(cfg.autoTurn > 0 ? '自动翻页：30 秒' : '已停止自动翻页');
        break;
      case 'Enter':
        ev.preventDefault();
        toggleFullscreen();
        break;
      default:
        break;
    }
  }

  /* ============================================================
   * 初始化
   * ============================================================ */

  function boot() {
    if (booted) return;
    if (!document.body) {
      setTimeout(boot, 50);
      return;
    }
    booted = true;
    if (!ensureUI()) return;

    // 首次安装时把入口"指"给用户，避免找不到左下角的按钮
    if (!cfg.hintSeen) {
      cfg.hintSeen = true;
      save();
      if (ui.launcher) {
        ui.launcher.classList.add('pulse');
        setTimeout(function () { ui.launcher.classList.remove('pulse'); }, 5200);
      }
      showHint(7000);
    }
    log('阅读器 UI 已就绪，入口在左下角，也可按 Alt+S / Alt+, 打开');

    // 样式在 document-start 已注入，首次分页本就应该用新宽度；
    // 这里只做一次兜底重排，避免阅读器在极少数情况下按旧宽度排版。
    repaginate(600);

    window.addEventListener('mousemove', onPointerMove, { passive: true });
    window.addEventListener('touchstart', showChrome, { passive: true });
    window.addEventListener('wheel', onWheel, { passive: false, capture: true });
    window.addEventListener('keydown', onKeyDown, true);
    try {
      ['pushState', 'replaceState'].forEach(function (name) {
        const orig = history[name];
        history[name] = function () {
          const ret = orig.apply(this, arguments);
          setTimeout(function () { updateProgress(); syncFlyleaf(); }, 40);
          return ret;
        };
      });
    } catch (err) { /* ignore */ }
    window.addEventListener('hashchange', updateProgress);
    window.addEventListener('popstate', updateProgress);

    syncFlyleaf();
    setInterval(updateProgress, 900);
    setInterval(syncFlyleaf, 350);

    // 站点切换主题（body.wr_whiteTheme）时无需处理，纯 CSS 自适应
  }

  // 尽早注入样式与根类名，避免闪烁
  try {
    injectStyle();
    ROOT.classList.add('wrbf');
    ROOT.setAttribute('data-wrbf-theme', cfg.theme);
    ROOT.classList.toggle('wrbf-immersive', !!cfg.immersive);
    ROOT.style.setProperty('--wrbf-page-max', cfg.maxWidth + 'px');
    if (cfg.immersive) ROOT.classList.add('wrbf-immersive');
  } catch (err) { /* ignore */ }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
  // 兜底：万一部分浏览器/管理器错过了 DOMContentLoaded，也保证入口出现
  setTimeout(boot, 3000);

  // 最后一道保险：如果 UI 没建起来，或者 launcher 尺寸为 0（被浏览器/样式吃掉），
  // 就在 light DOM 里放一个一定能看见的入口按钮。
  function createFallbackEntry(reason) {
    if (!document.body || document.getElementById('wrbf-entry')) return;
    logError('启用降级入口：' + reason);
    const btn = document.createElement('button');
    btn.id = 'wrbf-entry';
    btn.type = 'button';
    btn.textContent = '阅读优化设置';
    btn.style.cssText = 'position:fixed;left:14px;bottom:14px;z-index:2147483647;padding:8px 14px;' +
      'border:0;border-radius:999px;background:linear-gradient(180deg,#e6ad63,#cd7f2c);color:#fff;' +
      'font:13px/1.2 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;cursor:pointer;' +
      'box-shadow:0 4px 14px rgba(90,55,10,.38);';
    btn.addEventListener('click', function () {
      if (ensureUI()) {
        btn.remove();
        openPanel();
      }
    });
    document.body.appendChild(btn);
  }

  setTimeout(function () {
    if (document.getElementById('wrbf-entry')) return;
    const hostEl = document.getElementById('wrbf-ui');
    if (!hostEl) {
      createFallbackEntry('未找到 #wrbf-ui');
      return;
    }
    try {
      const launcher = hostEl.shadowRoot && hostEl.shadowRoot.getElementById('launcher');
      const rect = launcher ? launcher.getBoundingClientRect() : null;
      if (!rect || rect.width < 2 || rect.height < 2) {
        createFallbackEntry('launcher 尺寸异常');
      }
    } catch (err) {
      createFallbackEntry('检查 launcher 失败：' + err);
    }
  }, 3200);

  // 油猴菜单
  try {
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('切换沉浸模式', function () {
        cfg.immersive = !cfg.immersive;
        save();
        apply();
      });
      GM_registerMenuCommand('切换主题', cycleTheme);
      GM_registerMenuCommand('打开设置面板', function () { openPanel(); });
      GM_registerMenuCommand('全屏阅读', toggleFullscreen);
    }
  } catch (err) { /* ignore */ }

  // 调试/自动化入口
  window.__WRBF__ = {
    version: VERSION,
    cfg: cfg,
    apply: apply,
    setTheme: setTheme,
    turnPage: turnPage,
    get state() {
      return {
        theme: cfg.theme,
        immersive: cfg.immersive,
        maxWidth: cfg.maxWidth,
        autoTurn: cfg.autoTurn,
        panelOpen: panelOpen,
        progressLabel: lastProgressText
      };
    }
  };
})();
