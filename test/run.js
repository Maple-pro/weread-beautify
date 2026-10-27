/* eslint-disable no-console */
// 用 jsdom 模拟微信读书阅读器 DOM，对用户脚本做端到端逻辑测试。
// 运行：node test/run.js

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'weread-beautify.user.js'), 'utf8');

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log('  \u2713 ' + name);
  } else {
    failures++;
    console.log('  \u2717 ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''));
  }
}

function makeDom() {
  const items = [];
  const titles = ['扉页', '版权信息', '红楼梦 上', '前折页', '书名页', '修订说明', '三版序言', '再版序', '第一回', '第二回'];
  for (let i = 0; i < titles.length; i++) {
    items.push(
      '<li class="readerCatalog_list_item' + (i === 5 ? ' readerCatalog_list_item_selected' : '') + '">' +
        '<div class="readerCatalog_list_item_inner readerCatalog_list_item_level_1">' +
          '<div class="readerCatalog_list_item_info"><div class="readerCatalog_list_item_title">' +
            '<div class="readerCatalog_list_item_title_text">' + titles[i] + '</div>' +
          '</div></div>' +
        '</div>' +
      '</li>'
    );
  }

  const html = `<!doctype html><html lang="zh-cmn"><head><title>测试</title></head>
<body class="wr_page_reader wr_reader_font_size_level_2">
  <div id="app" class="app"><div id="routerView" class="routerView"><div class="wr_horizontalReader">
    <div class="wr_horizontalReader_app_content">
      <div class="readerTopBar"><div class="readerTopBar_inner">
        <a class="readerTopBar_link">首页</a><a class="readerTopBar_link">登录</a>
      </div></div>
      <div class="wr_various_font_provider_wrapper">
        <div class="readerChapterContent_container">
          <div class="readerChapterContent fontLevel1">
            <div class="preRenderContainer"><div id="preRenderContent" class="preRenderContent"></div></div>
            <div class="renderTargetContainer">
              <div class="renderTargetPageInfo">
                <div class="renderTargetPageInfo_header">
                  <span class="renderTargetPageInfo_header_chapterTitle">《红楼梦》校注本四版修订说明</span>
                </div>
              </div>
              <div class="wr_canvasContainer"><canvas width="393" height="670"></canvas></div>
              <div class="readerControls">
                <button class="readerControls_item catalog">目录</button>
                <button class="readerControls_item fontSizeButton">字号</button>
              </div>
              <div class="renderTarget_pager">
                <div class="renderTarget_pager_content">
                  <button class="renderTarget_pager_button"><span>上一页</span></button>
                </div>
                <div class="renderTarget_pager_content renderTarget_pager_content_right">
                  <button class="renderTarget_pager_button renderTarget_pager_button_right"><span>下一页</span></button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="readerCatalog"><ul class="readerCatalog_list">${items.join('')}</ul></div>
  </div></div></div>
</body></html>`;

  const dom = new JSDOM(html, { url: 'https://weread.qq.com/web/reader/0da329707210329f0da4d39k123', runScripts: 'outside-only', pretendToBeVisual: true });
  return dom;
}

async function runCase(label, opts) {
  console.log('\n[' + label + ']');
  const dom = makeDom();
  const win = dom.window;
  const doc = win.document;

  // 记录 resize 次数
  let resizeCount = 0;
  win.addEventListener('resize', function () { resizeCount++; });

  // 翻页按钮点击计数
  const clicks = { next: 0, prev: 0 };
  doc.querySelector('.renderTarget_pager_button_right').addEventListener('click', function () { clicks.next++; });
  doc.querySelector('.renderTarget_pager_button').addEventListener('click', function () { clicks.prev++; });

  if (opts && opts.gm) {
    win.GM_getValue = function (k, d) { return win.__gmStore && win.__gmStore[k] !== undefined ? win.__gmStore[k] : d; };
    win.GM_setValue = function (k, v) { (win.__gmStore = win.__gmStore || {})[k] = v; };
  }

  win.eval(SCRIPT);
  await new Promise(function (r) { setTimeout(r, 420); });

  const api = win.__WRBF__;
  const root = doc.documentElement;
  const host = doc.getElementById('wrbf-ui');
  const sr = host && host.shadowRoot;

  check('脚本初始化', !!api);
  check('注入样式', !!doc.getElementById('wrbf-style'));
  check('根元素类名', root.classList.contains('wrbf'));
  check('默认主题为纸黄', root.getAttribute('data-wrbf-theme') === 'paper', root.getAttribute('data-wrbf-theme'));
  check('默认沉浸模式', root.classList.contains('wrbf-immersive'));
  check('创建 Shadow UI', !!host && !!sr);
  check('浮层挂在 body 下（避开广告拦截规则）', host && host.parentElement === doc.body);
  check('浮层内联 !important 防隐藏', host && /display:\s*block\s*!important/.test(host.getAttribute('style') || ''));
  check('launcher 存在', !!sr.getElementById('launcher'));
  check('进度标签正确', /第 6 \/ 10 章 · 60%/.test(sr.getElementById('barLabel').textContent), sr.getElementById('barLabel').textContent);
  check('进度条宽度 60%', sr.getElementById('barFill').style.width === '60%', sr.getElementById('barFill').style.width);
  check('面板默认关闭', sr.getElementById('panel').hidden === true);
  // 初次重新分页是异步的，等一会儿
  const deadline = Date.now() + 2000;
  while (resizeCount === 0 && Date.now() < deadline) {
    await new Promise(function (r) { setTimeout(r, 50); });
  }
  check('初始触发重新分页', resizeCount > 0, resizeCount);

  // 翻页
  api.turnPage(1);
  api.turnPage(-1);
  check('turnPage 点击下一页', clicks.next === 1, clicks.next);
  check('turnPage 点击上一页', clicks.prev === 1, clicks.prev);

  // 快捷键：Alt+T 切主题
  const key = (code, extra) => win.dispatchEvent(new win.KeyboardEvent('keydown', Object.assign({ code, key: code.replace('Key', '').toLowerCase(), bubbles: true, cancelable: true, altKey: true }, extra || {})));
  key('KeyT');
  check('Alt+T 切换主题', api.cfg.theme === 'green', api.cfg.theme);
  key('KeyT');
  key('KeyT');
  key('KeyT');
  check('主题循环回原样', api.cfg.theme === 'paper', api.cfg.theme);

  // Alt+S 打开面板
  key('KeyS');
  check('Alt+S 打开面板', sr.getElementById('panel').hidden === false);
  key('KeyS');
  check('Alt+S 关闭面板', sr.getElementById('panel').hidden === true);

  // 面板交互
  sr.getElementById('panel').hidden = false;
  const sw = sr.querySelector('.sw[data-theme="night"]');
  sw.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  check('点击夜间主题', root.getAttribute('data-wrbf-theme') === 'night', root.getAttribute('data-wrbf-theme'));

  const range = sr.getElementById('wRange');
  range.value = '1200';
  range.dispatchEvent(new win.Event('change', { bubbles: true }));
  check('宽度设置生效', root.style.getPropertyValue('--wrbf-page-max') === '1200px', root.style.getPropertyValue('--wrbf-page-max'));

  const cImm = sr.getElementById('cImmersive');
  cImm.checked = false;
  cImm.dispatchEvent(new win.Event('change', { bubbles: true }));
  check('关闭沉浸模式', !root.classList.contains('wrbf-immersive'));

  // 滚轮翻页（沉浸关闭时不应触发）
  const before = clicks.next;
  const wheel = (delta, extra) => {
    const ev = new win.Event('wheel', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'deltaY', { value: delta });
    Object.defineProperty(ev, 'target', { value: doc.body });
    Object.assign(ev, extra || {});
    doc.body.dispatchEvent(ev);
  };
  wheel(120);
  check('滚轮翻页（非沉浸模式同样可用）', clicks.next === before + 1, clicks.next - before);
  await new Promise(function (r) { setTimeout(r, 760); });

  cImm.checked = true;
  cImm.dispatchEvent(new win.Event('change', { bubbles: true }));
  wheel(40);
  wheel(60); // 累计 100
  check('滚轮累计达阈值翻页', clicks.next === before + 2, clicks.next - before);
  wheel(120);
  check('滚轮冷却期内不重复翻页', clicks.next === before + 2, clicks.next - before);

  // 修改当前章节，进度应更新
  const items = doc.querySelectorAll('.readerCatalog_list_item');
  items[5].classList.remove('readerCatalog_list_item_selected');
  items[8].classList.add('readerCatalog_list_item_selected');
  doc.querySelector('.renderTargetPageInfo_header_chapterTitle').textContent = '第一回';
  win.dispatchEvent(new win.HashChangeEvent('hashchange'));
  check('章节变化后进度更新', /第 9 \/ 10 章 · 90%/.test(sr.getElementById('barLabel').textContent), sr.getElementById('barLabel').textContent);

  // 自动翻页
  api.cfg.autoTurn = 0;
  key('KeyA');
  check('Alt+A 开启自动翻页', api.cfg.autoTurn === 30, api.cfg.autoTurn);
  check('自动翻页提示显示', sr.getElementById('pill').hidden === false);
  key('KeyA');
  check('Alt+A 关闭自动翻页', api.cfg.autoTurn === 0, api.cfg.autoTurn);

  // 持久化
  const raw = opts && opts.gm ? (win.__gmStore || {})['wrbf.settings.v1'] : win.localStorage.getItem('wrbf.settings.v1');
  check('设置已持久化', !!raw && JSON.parse(raw).theme === 'night', raw);

  // 重置
  sr.getElementById('btnReset').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  check('恢复默认主题', api.cfg.theme === 'paper' && root.getAttribute('data-wrbf-theme') === 'paper');
  check('恢复默认宽度', root.style.getPropertyValue('--wrbf-page-max') === '1500px', root.style.getPropertyValue('--wrbf-page-max'));

  win.close();
}

async function runNoCatalog() {
  console.log('\n[无目录数据时不报错]');
  const dom = makeDom();
  const win = dom.window;
  const doc = win.document;
  doc.querySelector('.readerCatalog').remove();
  win.eval(SCRIPT);
  await new Promise(function (r) { setTimeout(r, 60); });
  const sr = doc.getElementById('wrbf-ui').shadowRoot;
  check('脚本仍可用', !!win.__WRBF__);
  check('进度标签回退为章节名', /红楼梦|修订说明/.test(sr.getElementById('barLabel').textContent), sr.getElementById('barLabel').textContent);
  win.close();
}

(async function () {
  await runCase('localStorage 存储', { gm: false });
  await runCase('GM 存储', { gm: true });
  await runNoCatalog();

  console.log('\n' + (failures === 0 ? '全部通过' : failures + ' 项失败'));
  process.exit(failures === 0 ? 0 : 1);
})();
