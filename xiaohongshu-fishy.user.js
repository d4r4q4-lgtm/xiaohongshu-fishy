// ==UserScript==
// @name         小红书 · 表格模式（摸鱼）
// @namespace    https://github.com/d4r4q4-lgtm/xiaohongshu-fishy
// @version      1.23
// @author       haozi
// @description  把小红书伪装成 Excel 在线表格：一帖一行，封面图变成「封面图」文字链接，点开才看原图
// @license      MIT
// @homepageURL  https://github.com/d4r4q4-lgtm/xiaohongshu-fishy
// @supportURL   https://github.com/d4r4q4-lgtm/xiaohongshu-fishy/issues
// @match        *://xiaohongshu.com/*
// @match        *://*.xiaohongshu.com/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // 同一页面被注入两次（Tampermonkey 里装了两份、调试时重复注入）会各建一整套界面：
  // 两层表格、好几个详情表，而且设置改完只对其中一套生效，看着像开关坏了。
  // 所以先认领一次，第二份直接退出。
  try {
    if (window.__fzLoaded) return;
    window.__fzLoaded = 1;
  } catch (eOnce) {}

  var DEMO = !!window.__FISHY_DEMO__;
  var HOST_OK = /(^|\.)xiaohongshu\.com$/.test(location.hostname);
  // 笔记路径 /explore/{id}（若将来要支持别的站点，只改这三行）
  var NOTE_PATH = /\/explore\/([0-9a-zA-Z]+)/;
  var NOTE_A_SEL = 'a[href*="/explore/"]';
  function noteHref(id, token) {
    return '/explore/' + (id || '') +
      (token ? '?xsec_token=' + encodeURIComponent(token) + '&xsec_source=pc_feed' : '');
  }
  if (!DEMO && !HOST_OK) return;

  console.info('%c[fishy] v1.23 已注入 · ' + location.host + location.pathname, 'color:#217346;font-weight:600');

  // ---- 排障：脚本"没接管"时必须说得出为什么 ----
  // 用户看到的只有"还是原网页"，这句话没法排查。所以把"走到哪一步、为什么停、看到多少行"
  // 记下来：控制台打一行人话，同时回执给本机更新源（http://127.0.0.1:8125/status 直接看，
  // 不用开 devtools）。真机出现过"装了却没反应"，就是靠这条线把"没跑起来"和"跑了没接管"分开。
  var DIAG = { stage: 'start', why: '', rows: 0, at: 0, err: '' };
  var diagLast = '';
  function diagLine() {
    return 'stage=' + DIAG.stage + (DIAG.why ? ' why=' + DIAG.why : '') +
      (DIAG.rows ? ' rows=' + DIAG.rows : '') + (DIAG.err ? ' err=' + DIAG.err : '');
  }
  function diagPing() {
    try {
      var u = 'http://127.0.0.1:8125/hit?v=1.23&p=' + encodeURIComponent(location.pathname) +
        '&stage=' + encodeURIComponent(DIAG.stage) + '&why=' + encodeURIComponent(DIAG.why) +
        '&rows=' + DIAG.rows + '&err=' + encodeURIComponent(String(DIAG.err).slice(0, 120));
      if (navigator.sendBeacon) { navigator.sendBeacon(u); return; }
      fetch(u, { mode: 'no-cors', cache: 'no-store' }).catch(function () {});
    } catch (eD) {}
  }
  function diagSet(stage, why, extra) {
    DIAG.stage = stage;
    if (why) DIAG.why = why;
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) DIAG[k] = extra[k];
    DIAG.at = Date.now();
    if (diagLine() !== diagLast) { diagLast = diagLine(); diagPing(); }
    return DIAG;
  }
  function fzRowCount() { return document.querySelectorAll('.fz-row, .fz-nrow').length; }
  // 为什么没接管（纯函数，方便自测直接断言，不用等定时器）
  function diagWhy() {
    if (!CFG.tableMode) return 'off';                     // 用户自己关掉了，不算故障
    if (!document.querySelector('.fz-chrome')) return 'no-chrome';
    var n = fzRowCount();
    if (n > 0) return 'built';
    if (!document.body || !document.body.textContent) return 'no-dom';
    return needNoData(n) ? 'nodata' : 'no-rows';
  }
  function diagWatchdog() {
    setTimeout(function () {
      if (DIAG.stage === 'built') return;
      var why = diagWhy();
      diagSet(why === 'built' ? 'built' : why, why, { rows: fzRowCount() });
      if (why === 'off' || why === 'built') return;       // 关掉是用户的选择，别吓人
      try {
        console.warn('[fishy] 这个页面没接管：' + diagLine() +
          '，把这一行发我。也可以打开 http://127.0.0.1:8125/status 看，脚本没跑起来的话那里不会有心跳');
      } catch (eW) {}
    }, 8000);
  }
  // 版本回执：只发到本机 127.0.0.1，用来确认实际在跑哪一版（排查"改了没生效"）
  (function fzPing() {
    try {
      var u = 'http://127.0.0.1:8125/hit?v=1.23&p=' + encodeURIComponent(location.pathname);
      if (navigator.sendBeacon) { navigator.sendBeacon(u); return; }
      fetch(u, { mode: 'no-cors', cache: 'no-store' }).catch(function () {});
    } catch (e) {}
  })();

  // 带 fzoff=1 时完全不接管，用于"用原生页面退出登录"这类场景
  try {
    if (/[?&]fzoff=1/.test(location.search)) {
      console.info('[fishy] 原生模式（?fzoff=1），脚本不接管');
      return;
    }
  } catch (e) {}

  // 先遮住页面，避免原样式闪一下
  var bootAt = Date.now();
  // 第一帧到底画了没：rAF 只代表"下一帧要开始"，真正画完要看 paint 计时条目
  function firstPaintAt() {
    try {
      var p = performance.getEntriesByType('paint');
      if (p && p.length) return p[0].startTime;   // 相对 timeOrigin 的毫秒
    } catch (e) {}
    return -1;
  }
  var curtainInfo = { installed: false, tries: 0, at: 0, why: '' };
  // 装幕布。返回 false 就一定要再试：@run-at document-start 下 <html> 不一定已经长出来，
  // 原来整段包在 try/catch 里，于是"没装成"跟"装成了"看起来一模一样，遮罩等于不存在，
  // 原生页面会闪出来，而且是最难发现的那种静默失效。
  // （无头注入实测就是这么翻的车：documentElement 为 null，幕布压根没装上；我一开始还把
  //   采样里"没有 BOOT"误读成"幕布挂了 3.8 秒"，数据要看全，别急着下结论。）
  function installCurtain() {
    try {
      if (document.getElementById('fz-curtain')) {   // 装过了就绝不再动（掀掉之后不许又盖回来）
        curtainInfo.installed = true;
        return true;
      }
      var host = document.head || document.documentElement;
      if (!host) { curtainInfo.why = 'no-documentElement'; return false; }
      var st = document.createElement('style');
      st.id = 'fz-curtain';
      st.textContent = 'html.fz-boot,html.fz-boot body{opacity:0 !important;background:#fff !important;}';
      host.appendChild(st);
      document.documentElement.classList.add('fz-boot');
      curtainInfo = { installed: true, tries: curtainInfo.tries + 1, at: Date.now() - bootAt, why: 'ok' };
      return true;
    } catch (e) {
      curtainInfo = { installed: false, tries: curtainInfo.tries + 1, at: Date.now() - bootAt,
                      why: String((e && e.message) || e) };
      return false;
    }
  }
  (function curtain() {
    if (installCurtain()) return;
    // 还没长出文档树：趁解析器什么都还没画，赶紧补上（0ms 轮询 + readystatechange 双保险）
    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      if (installCurtain() || tries > 200) clearInterval(iv);
    }, 0);
    try {
      document.addEventListener('readystatechange', function () { installCurtain(); });
    } catch (e2) {}
  })();

  try {
    if (sessionStorage.getItem('fz-off') === '1') {
      // 关掉之后必须留一条"自己回得来"的路。以前只能开 devtools 删 sessionStorage，
      // 等于关得掉、开不回来（自测时就这么卡住过一次），现在再按一次快捷键就回来。
      document.documentElement.classList.remove('fz-boot');
      console.warn('[fishy] 已被「Alt+Shift+T」临时关闭。再按一次 Alt+Shift+T 就恢复。');
      var fzResume = function () {
        try { sessionStorage.removeItem('fz-off'); } catch (e1) {}
        location.reload();
      };
      addEventListener('keydown', function (e) {
        if (e.altKey && e.shiftKey && (e.key === 'T' || e.key === 't')) {
          e.preventDefault();
          fzResume();
        }
      }, true);
      try { window.__fzOff = { on: true, resume: fzResume }; } catch (e2) {}
      return;
    }
  } catch (e) {}

  // ---------- 可调参数 ----------
  var FZ_VER = '1.2';
  var CFG = {
    tableMode: true,       // 首页信息流重排成表格
    detailSheet: true,     // 笔记详情页也渲染成同一张表
    docTitle: '工作簿1',    // 标题栏文件名
    sheetName: 'Sheet1',
    login: true,          // 标题栏的"已登录"伪装状态（纯装饰）
    minImgSize: 64,
    idleCollapseMs: 9000,
    // ---- 设置面板里的开关 ----
    foldText: true,       // 超过 300 字的正文折起来，给「展开全文（N 字）」
    imgLink: true,        // 图片列成蓝色链接（关掉只写「N 张图」）
    tips: true,           // 单元格悬停看全文
    busy: true,           // 加载时的进度卡片
    hush: true,           // 视频默认静音
    // 头像：默认不显示（表格是纯文字的）。关掉这个开关就把头像画回来：
    // 瀑布页画楼主头像，详情页画楼主 + 各楼层 + 回复的头像。
    hideAvatar: true,
    // 表情符号：开起来会把标题/正文/作者/评论里的 emoji 去掉。默认关：
    // 它会改内容（导出也跟着少字），要看干净的表再自己开。
    hideEmoji: false,
    // ---- v1.0 ----
    linkPlainTitle: false, // 标题不标蓝（当普通文字，照样能点）
    linkPlainImg: false,   // 封面图 / 图2 / 视频 这些不标蓝
    opMark: true,         // 详情页认人：楼主那一行加「楼主」标记并淡黄底
    floorTint: true,      // 详情页有回复的楼层用浅绿底（关掉只留左边那条绿线）
    showFloor: true,      // 详情页显示「N楼」徽标
    userTable: false      // 点用户名：false=新标签页开原生用户页；true=当前页交给表格
  };

  // 外壳高度：标题栏30 + 工具栏26 + 公式栏30 + 列号18
  var HEAD_H = 128;   // 标题30+工具26+公式30+列号18+表头24
  var FOOT_H = 30;

  var store = {
    get: function (k, d) {
      try {
        if (typeof GM_getValue === 'function') return GM_getValue(k, d);
        var v = localStorage.getItem('fz:' + k);
        return v === null ? d : JSON.parse(v);
      } catch (e) { return d; }
    },
    set: function (k, v) {
      try {
        if (typeof GM_setValue === 'function') return GM_setValue(k, v);
        localStorage.setItem('fz:' + k, JSON.stringify(v));
      } catch (e) {}
    }
  };
  CFG.tableMode = store.get('tableMode', CFG.tableMode);
  CFG.detailSheet = store.get('detailSheet', CFG.detailSheet);
  CFG.docTitle = store.get('docTitle', CFG.docTitle);
  CFG.login = store.get('login', true);
  ['foldText', 'imgLink', 'tips', 'busy', 'hush', 'hideAvatar', 'hideEmoji',
    'linkPlainTitle', 'linkPlainImg', 'opMark', 'floorTint', 'showFloor', 'userTable']
    .forEach(function (k) {
      // 默认值取 CFG 里写的那一份：默认关的开关（hideEmoji / linkPlain / userTable）
      // 不能因为"没存过"就被当成开
      CFG[k] = store.get(k, CFG[k]) !== false;
    });
  // 上次关掉了表格模式：html 上先挂 fz-off，别等到第一帧才闪一下伪装层
  if (!CFG.tableMode) {
    try { document.documentElement.classList.add('fz-off'); } catch (eOff) {}
  }
  // 启动时把这些"整张表怎么看"的类同步一次（头像 / 纯文字链接 / 详情页三个开关）
  setTimeout(function () { try { applyView(); } catch (eOff3) {} }, 0);

  // ---------- 工具 ----------
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // 表情符号（v0.98）。范围：单码位 emoji、符号区、变体选择符（️）、零宽连接符（👨‍👩‍👧 靠它拼）、
  // 肤色修饰。设置里关掉"隐藏表情"时这个函数原样返回，一个字都不动。
  var EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0E}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]/gu;
  // [偷笑R] / [点赞R] / [笑哭R] 这种：小红书自家的表情代码，页面上是方括号+名字+R。
  // 只认"以 R 结尾"或常见几个，别把正文里真正写成 [已编辑] 的方括号吃掉。
  var CODE_RE = /\[[^\[\]\s]{1,12}\]/g;
  var CODE_KEEP = { '[已编辑]': 1, '[图片]': 1 };
  function stripEmoji(s) {
    var t = String(s == null ? '' : s);
    if (!CFG.hideEmoji) return t;
    t = t.replace(CODE_RE, function (m) {
      var inner = m.slice(1, -1);
      if (CODE_KEEP[m]) return m;              // 明确要留的
      return /[Rr]$/.test(inner) ? '' : m;     // 只清 R 结尾的那种
    });
    return t.replace(EMOJI_RE, '').replace(/[ \t]{2,}/g, ' ').replace(/^\s+|\s+$/g, '');
  }
  function escT(s) { return esc(stripEmoji(s)); }
  function pad(n) { n = String(n); return n.length < 2 ? '0' + n : n; }
  function txt(el, max) {
    var s = (el && el.textContent || '').replace(/\s+/g, ' ').trim();
    max = max || 60;
    return s.length > max ? s.slice(0, max) + '…' : s;
  }
  function txtLines(el, max) {
    if (!el) return '';
    var s = (el.innerText || el.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
    max = max || 600;
    return s.length > max ? s.slice(0, max) + '…' : s;
  }
  // 正文/评论里的小图是小红书表情，临时换成 alt 文字再取文本，取完还原
  function textWithEmoji(el, max) {
    if (!el) return '';
    var imgs = Array.prototype.slice.call(el.querySelectorAll('img'));
    var swapped = [];
    for (var i = 0; i < imgs.length; i++) {
      var im = imgs[i];
      if (im.closest && im.closest('a[href*="/user/"]')) continue;
      var r = im.getBoundingClientRect();
      if (r.width > 40 || r.height > 40) continue;
      var alt = im.getAttribute('alt') || im.getAttribute('data-alt') ||
        im.getAttribute('data-name') || im.getAttribute('aria-label') ||
        im.getAttribute('title') || '';
      if (!alt) alt = '[表情]';
      if (alt.charAt(0) !== '[') alt = '[' + alt + ']';
      var sp = document.createElement('span');
      sp.textContent = alt;
      if (im.parentNode) {
        im.parentNode.replaceChild(sp, im);
        swapped.push([sp, im]);
      }
    }
    var out = (el.innerText || el.textContent || '');
    for (var k = 0; k < swapped.length; k++) {
      var sp2 = swapped[k][0], im2 = swapped[k][1];
      if (sp2.parentNode) sp2.parentNode.replaceChild(im2, sp2);
    }
    out = out.replace(/\n{3,}/g, '\n\n').trim();
    max = max || 600;
    return out.length > max ? out.slice(0, max) + '…' : out;
  }

  function pick(root, sels, max) {
    if (!root) return '';
    for (var i = 0; i < sels.length; i++) {
      var s = txt(root.querySelector(sels[i]), max);
      if (s) return s;
    }
    return '';
  }
  function thumb(fn, wait) {
    var t = 0;
    return function () {
      var now = Date.now();
      if (now - t < wait) return;
      t = now;
      fn();
    };
  }
  function origSrc(img) {
    // 已加载用 currentSrc；没加载(naturalWidth=0)时用 data-src，别拿占位图
    var nw = img.naturalWidth || 0;
    var s = nw > 0
      ? (img.currentSrc || img.getAttribute('src') || '')
      : (img.getAttribute('data-src') || img.getAttribute('src') || img.currentSrc || '');
    if (!s) return '';
    if (s.indexOf('data:') === 0) return s;
    return s.trim().replace(/^\/\//, 'https://');
  }
  // 去掉裁剪后缀的"干净"版本，作为加载失败时的备选
  function cleanSrc(u) {
    if (!u || u.indexOf('data:') === 0) return '';
    return u.split('?')[0].split('!')[0];
  }
  // 把"1天前 / 昨天 21:13 / 10-01 17:22 / 刚刚"统一成 2026-10-27 08:14
  function normTime(t) {
    if (!t) return '';
    t = String(t).replace(/\s+/g, ' ').trim()
      .replace(/^(编辑于|发布于|更新于|发表于|修改于)\s*/, '')
      .replace(/^[·•]\s*/, '');
    var now = new Date();
    var m;
    function fmt(d) {
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
        ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }
    if (/刚刚/.test(t)) return fmt(now);
    if ((m = t.match(/^(\d+)\s*秒前/))) return fmt(new Date(now - m[1] * 1000));
    if ((m = t.match(/^(\d+)\s*分钟前/))) return fmt(new Date(now - m[1] * 60000));
    if ((m = t.match(/^(\d+)\s*小时前/))) return fmt(new Date(now - m[1] * 3600000));
    if ((m = t.match(/^(\d+)\s*天前/))) return fmt(new Date(now - m[1] * 86400000));
    if ((m = t.match(/^昨天\s*(\d{1,2}):(\d{2})/))) {
      var d1 = new Date(now - 86400000);
      d1.setHours(+m[1], +m[2], 0, 0);
      return fmt(d1);
    }
    if ((m = t.match(/^(\d{1,2})-(\d{1,2})\s*(\d{1,2}):(\d{2})/))) {
      var d2 = new Date(now.getFullYear(), +m[1] - 1, +m[2], +m[3], +m[4]);
      if (d2 > now) d2.setFullYear(now.getFullYear() - 1);
      return fmt(d2);
    }
    if ((m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) {
      return m[1] + '-' + pad(m[2]) + '-' + pad(m[3]);
    }
    return t;
  }

  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // ---------- 内容图判定 ----------
  // 站点自己的 UI 素材（角标、占位图、播放图标）不是笔记图片。
  // 真机实测：有的卡片里混着一张 picasso-static.xiaohongshu.com/fe-platform/… 的图，
  // 尺寸过了 64px 那道线，就被当成"第 2 张封面"，点开是张素材图（图02 打开是 fe-platform）。
  function isSiteAsset(src) {
    return /picasso-static\.xiaohongshu\.com|fe-platform|fe-video-qc|\/static\/image/i.test(src || '');
  }

  // 头像/图标一律不算正文图片
  function isAvatarImg(im) {
    var t = ((im.getAttribute('src') || '') + ' ' + (im.getAttribute('data-src') || '')).toLowerCase();
    if (t.indexOf('avatar') > -1 || t.indexOf('sns-avatar') > -1) return true;
    if (im.closest && im.closest('[class*="avatar"],[class*="Avatar"],[class*="head-img"],[class*="headImg"],[class*="portrait"]')) return true;
    return false;
  }

  function isPhoto(img) {
    if (img.dataset.fz) return false;
    // .fz-src 是隐藏的源列表，动它的图片会拖垮站点自己的布局与翻页
    if (img.closest('.fz-row,.fz-chrome,.fz-viewer,.fz-notesheet,.fz-src,.fz-board,.fz-morerow')) return false;
    if (img.closest('[class*="comment-item"]')) return false;
    if (NOTE_PATH.test(location.pathname)) return false;   // 笔记页整页由表格接管
    if (img.closest('a[href*="/user/"]')) return false;
    if (img.closest('[data-fz-skip]')) return false;

    var r = img.getBoundingClientRect();
    var w = r.width || img.naturalWidth || 0;
    var h = r.height || img.naturalHeight || 0;
    if (w < CFG.minImgSize || h < CFG.minImgSize) return false;

    var src = img.getAttribute('data-src') || img.currentSrc || img.getAttribute('src') || '';
    if (!src) return false;
    if (DEMO) return true;
    if (/sns-avatar|avatar/i.test(src)) return false;
    if (isSiteAsset(src)) return false;
    if (/emoji|smiley/i.test(img.className || '')) return false;
    return /xhscdn\.com|sns-webpic|sns-img|ci\.xiaohongshu/i.test(src);
  }

  function findPanel(img) {
    var r = img.getBoundingClientRect();
    if (!r.height || r.height < 160) return null;
    var box = img.parentElement, cand = null, lv = 0;
    while (box && box !== document.body && lv < 6) {
      // 顶层容器（直接挂在 body 下）绝不隐藏，否则可能把整页/整个弹层干掉
      if (box.parentElement === document.body) break;
      var br = box.getBoundingClientRect();
      var t = (box.textContent || '').replace(/\s+/g, '').length;
      // 面板高度应和图片接近，超过 2.2 倍说明是外层布局容器
      if (br.height > 240 && br.height <= r.height * 2.2) {
        if (t < 40) cand = box;
        else break;
      } else if (t >= 40) {
        break;
      }
      box = box.parentElement; lv++;
    }
    return cand;
  }

  // ---------- 图片 → 文字链接 ----------
  function nextIndex(img) {
    var scope = img.closest('article,section,[class*="detail"],[class*="note"],main') || document.body;
    return scope.querySelectorAll('[data-fz="img"]').length + 1;
  }

  function degrade(img) {
    if (img.dataset.fz) return null;
    var real = origSrc(img);
    if (!real) return null;

    var w = img.naturalWidth || Math.round(img.getBoundingClientRect().width) || 0;
    var h = img.naturalHeight || Math.round(img.getBoundingClientRect().height) || 0;
    var idx = Math.min(nextIndex(img), 99);
    var dim = (w && h) ? w + '×' + h : '';
    var label = '图' + idx;

    var panel = findPanel(img);
    img.dataset.fz = '1';

    var link = document.createElement('a');
    link.className = 'fz-link fz-imglink';
    link.dataset.fz = 'img';
    link.dataset.url = real;
    link.textContent = label;
    link.title = '点击查看原图';

    if (panel) {
      panel.style.setProperty('display', 'none', 'important');
      var box = panel.parentElement, target = null, bestLen = 0;
      if (box) {
        for (var i = 0; i < box.children.length; i++) {
          var ch = box.children[i];
          if (ch === panel || ch.contains(panel)) continue;
          var len = (ch.textContent || '').replace(/\s+/g, '').length;
          if (len > bestLen) { bestLen = len; target = ch; }
        }
      }
      if (target) target.insertBefore(link, target.firstChild);
      else panel.parentNode.insertBefore(link, panel);
      link.dataset.mode = 'panel';
    } else {
      img.replaceWith(link);
    }

    link.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      openImage(link, real, '图' + idx + (dim ? ' · ' + dim : ''), cleanSrc(real));
    });
    return link;
  }

  // 全页降级很贵：源列表整棵在文档流里，动辄几千个节点，绝不能跟着每次 DOM 变动跑
  var lastDegrade = 0, degradeTimer = 0;

  function degradeAll(force) {
    var now = Date.now();
    if (!force && now - lastDegrade < 800) {
      if (!degradeTimer) {
        degradeTimer = setTimeout(function () { degradeTimer = 0; try { degradeAll(true); } catch (e) {} }, 820);
      }
      return;
    }
    lastDegrade = now;
    var imgs = document.images, i;
    for (i = 0; i < imgs.length; i++) {
      if (!imgs[i].closest || imgs[i].closest('.fz-src')) continue;   // 源列表不动它
      if (isPhoto(imgs[i])) degrade(imgs[i]);
    }
    degradeBg();
  }

  // 有些大图是 background-image，不是 <img>
  var bgIdx = 0;
  function degradeBg() {
    // 按 body 直接子节点分组扫，整块跳过源列表（它是隐藏的，扫它纯粹浪费）
    if (!document.body) return;
    var roots = document.body.children;
    for (var k = 0; k < roots.length; k++) {
      var rt = roots[k];
      if (!rt.querySelectorAll) continue;
      var rc = rt.classList;
      if (rc && (rc.contains('fz-src') || rc.contains('fz-pullmask') || rc.contains('fz-chrome') ||
                 rc.contains('fz-board') || rc.contains('fz-viewer') || rc.contains('fz-notesheet'))) continue;
      scanBg(rt);
    }
  }

  function scanBg(root) {
    var els = root.querySelectorAll('div,section,li,a,span,figure');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.dataset.fzBg) continue;
      if (el.closest('.fz-row,.fz-chrome,.fz-viewer,.fz-notesheet,.fz-src,.fz-board,.fz-morerow')) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 260 || r.height < 200) continue;
      var b = getComputedStyle(el).backgroundImage;
      var m = b && b.match(/url\(["']?(.*?)["']?\)/);
      if (!m || !/xhscdn|sns-webpic|sns-img|ci\.xiaohongshu/.test(m[1])) continue;
      el.dataset.fzBg = '1';
      var url = m[1].split('?')[0].split('!')[0];
      var link = document.createElement('a');
      link.className = 'fz-link fz-imgcell';
      link.dataset.fz = 'img';
      link.textContent = '图' + (++bgIdx);
      (function (u, lb) {
        link.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          openImage(link, u, lb, cleanSrc(u));
        });
      })(url, link.textContent);
      el.style.setProperty('background-image', 'none', 'important');
      el.parentNode.insertBefore(link, el);
    }
  }

  // ---------- 悬浮看图 ----------
  var viewer = null, viewerStep = null;

  // 同一行的所有图 = 一组：看完图 1 想看下一张，不该让人关掉再点下一个
  function galleryOf(urls, dims, cover) {
    var out = [], n = (urls || []).length;
    for (var i = 0; i < n; i++) {
      out.push({
        url: urls[i],
        // 标题跟表格里那一格用同一个词（封面图1 / 图01），别同一张图两个名字
        label: imgLinkLabel(i, n, cover) + (dims && dims[i] ? ' · ' + dims[i] : ''),
        alt: cleanSrc(urls[i])
      });
    }
    return out;
  }

  function openImage(anchor, url, caption, alt, gallery, index) {
    closeViewer();
    var items = (gallery && gallery.length) ? gallery : [{ url: url, label: caption, alt: alt }];
    if (typeof index !== 'number' || index < 0 || index >= items.length) {
      index = 0;
      // 没给下标就按 url 认一下，认不出就用第一张
      for (var k = 0; k < items.length; k++) if (items[k].url === url) { index = k; break; }
    }
    var many = items.length > 1;

    var v = document.createElement('div');
    v.className = 'fz-viewer';
    v.innerHTML =
      '<div class="fz-v-hd"><b>' + esc(caption) + '</b><span class="fz-v-x">关闭</span>' +
        (many ? '<span class="fz-v-nav"><i class="fz-v-prev" title="上一张（←）">‹</i>' +
          '<span class="fz-v-pos"></span>' +
          '<i class="fz-v-next" title="下一张（→）">›</i></span>' : '') +
      '</div>' +
      '<div class="fz-v-bd"></div>';
    var body = v.querySelector('.fz-v-bd');

    // 每次换图都重建 <img>：加载失败时"替换成提示"的老逻辑就不用带着状态走
    function show(i) {
      index = ((i % items.length) + items.length) % items.length;
      var cur = items[index];
      var b = v.querySelector('.fz-v-hd b');
      if (b) b.textContent = cur.label || caption;
      var pos = v.querySelector('.fz-v-pos');
      if (pos) pos.textContent = (index + 1) + '/' + items.length;

      body.innerHTML = '';
      var vim = document.createElement('img');
      var triedAlt = false, rough = cur.alt || '';
      vim.onerror = function () {
        if (!triedAlt && rough && vim.getAttribute('src') !== rough) {
          triedAlt = true;
          vim.src = rough;
          return;
        }
        var err = document.createElement('div');
        err.className = 'fz-v-err';
        err.textContent = '图片加载失败（可能已过期）';
        vim.replaceWith(err);
      };
      vim.src = cur.url;
      body.appendChild(vim);
    }
    viewerStep = show;
    show(index);

    v.querySelector('.fz-v-x').onclick = closeViewer;
    if (many) {
      v.querySelector('.fz-v-prev').onclick = function (e) { e.stopPropagation(); show(index - 1); };
      v.querySelector('.fz-v-next').onclick = function (e) { e.stopPropagation(); show(index + 1); };
    }
    v.addEventListener('click', function (e) { e.stopPropagation(); });
    document.body.appendChild(v);
    markKeyboard(v);

    var r = anchor.getBoundingClientRect();
    var vw = Math.min(340, Math.round(innerWidth * 0.38));
    var below = innerHeight - r.bottom - 40;
    var above = r.top - 40;
    var top = (below < 300 && above > below) ? Math.max(HEAD_H + 8, r.top - 380) : r.bottom + 6;

    v.style.width = vw + 'px';
    v.style.left = Math.max(10, Math.min(r.left - 6, innerWidth - vw - 14)) + 'px';
    v.style.top = top + 'px';
    v.style.maxHeight = Math.max(200, innerHeight - top - 40) + 'px';

    viewer = v;
    resetIdle();
  }

  function closeViewer() {
    if (viewer && viewer.parentNode) viewer.parentNode.removeChild(viewer);
    viewer = null;
    viewerStep = null;
  }

  // ←/→ 翻同一组图（循环）：键盘党不用去够那两个小箭头
  function viewerGo(d) {
    if (!viewer || !viewerStep) return false;
    var pos = viewer.querySelector('.fz-v-pos');
    if (!pos) return false;             // 只有一张图，没得翻
    var m = /^(\d+)\/(\d+)$/.exec(pos.textContent || '');
    if (!m) return false;
    var i = parseInt(m[1], 10) - 1 + d, n = parseInt(m[2], 10);
    viewerStep(((i % n) + n) % n);
    resetIdle();
    return true;
  }

  // ---------- 取数 ----------
  function imgList(root, limit) {
    var out = [], all = root.querySelectorAll('img');
    for (var i = 0; i < all.length && out.length < (limit || 9); i++) {
      var im = all[i];
      if (im.closest('a[href*="/user/"]')) continue;
      if (isAvatarImg(im)) continue;
      var src = origSrc(im);
      if (!src) continue;
      if (isSiteAsset(src)) continue;      // 站点的 UI 素材不算笔记图片（demo 用 data:，不受影响）
      var w = im.naturalWidth || im.width || 0;
      var h = im.naturalHeight || im.height || 0;
      if (!DEMO && w && h && (w < CFG.minImgSize || h < CFG.minImgSize)) continue;
      out.push({ src: src, w: w, h: h });
    }
    return out;
  }

  function readCard(card) {
    var link = card.querySelector(NOTE_A_SEL);
    var href = link ? (link.getAttribute('href') || '') : '';
    var authorLink = card.querySelector('a[href*="/user/"]');
    var uid = '';
    if (authorLink) {
      var um = (authorLink.getAttribute('href') || '').match(/\/user\/(?:profile\/)?([0-9a-zA-Z]+)/);
      if (um) uid = um[1];
    }
    var imgs = imgList(card, 9);
    // 封面兜底（v1.1）：视频笔记的封面是 <video poster>，不是 <img>，以前这类卡片
    // 会出现"封面图那格是空的"。再退一步，卡片里任何一张非头像图也比空白强。
    if (!imgs.length) {
      var vd = card.querySelector('video');
      var poster = vd ? (vd.getAttribute('poster') || vd.getAttribute('data-poster') || '') : '';
      if (poster) imgs = [{ src: poster, w: 0, h: 0 }];
    }
    if (!imgs.length) {
      var anyIm = card.querySelector('img[src],img[data-src]');
      var anySrc = anyIm ? origSrc(anyIm) : '';
      if (anySrc && !isAvatarImg(anyIm) && !isSiteAsset(anySrc)) imgs = [{ src: anySrc, w: 0, h: 0 }];
    }
    var title = pick(card, ['[class*="title"]', 'a[title]', NOTE_A_SEL + ' span'], 50) || txt(link, 50);
    // 头像（v1.1）：只给"隐藏头像"关掉时用。卡片里用户头像一般是 a[href*="/user/"] 里的 img
    var avImg = (authorLink && authorLink.querySelector('img')) ||
      card.querySelector('img[src*="avatar"],img[src*="sns-avatar"]');
    var avatar = avImg ? (avImg.currentSrc || avImg.getAttribute('src') || '') : '';

    return {
      href: href,
      title: title,
      desc: pick(card, ['[class*="desc"]', '[class*="abstract"]'], 120),
      author: pick(card, ['a[href*="/user/"] span', '[class*="name"]', 'a[href*="/user/"]'], 16),
      uid: uid,
      avatar: avatar,
      likes: pick(card, ['[class*="like"] span', '[class*="like"]', '[class*="count"]'], 10),
      time: pick(card, ['[class*="time"]', '[class*="date"]'], 20),
      type: (card.querySelector('video') || card.querySelector('[class*="play"],.play-icon,[class*="video"]')) ? '视频' : '图文',
      urls: imgs.map(function (o) { return o.src; }),
      dims: imgs.map(function (o) { return (o.w && o.h) ? o.w + '×' + o.h : ''; })
    };
  }

  // 详情页取数
  // 把评论区滚到底，逼站点加载更多评论（只滚，不乱点，避免误跳转）
  function pullComments() {
    var c = document.querySelector('[class*="comment-item"]');
    if (!c) return;
    var p = c.parentElement;
    for (var i = 0; i < 8 && p && p !== document.body; i++) {
      var cs = getComputedStyle(p);
      if (/(auto|scroll)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 20) {
        try { p.scrollTop = p.scrollHeight; } catch (e) {}
        try { p.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (e) {}
        return;
      }
      p = p.parentElement;
    }
    // 没有独立滚动容器就滚窗口
    try { window.scrollTo(0, document.body.scrollHeight); } catch (e) {}
  }

  function readCommentsDom() {
    var items = document.querySelectorAll('[class*="comment-item"]');
    var list = [], byEl = new Map();

    for (var i = 0; i < items.length && list.length < 120; i++) {
      var el = items[i];
      if (!visible(el)) continue;

      var bodyEl = el.querySelector('[class*="content"],[class*="desc"]') || el;
      var t = textWithEmoji(bodyEl, 240);
      if (!t) continue;

      // 自己的图片（排除头像和小图标）
      var imgs = [], all = el.querySelectorAll('img');
      for (var k = 0; k < all.length; k++) {
        var im = all[k];
        if (im.closest('a[href*="/user/"]')) continue;
        if (isAvatarImg(im)) continue;
        var rr = im.getBoundingClientRect();
        var w = Math.round(rr.width) || im.width || 0;
        var h = Math.round(rr.height) || im.height || 0;
        // 表情/小图标按显示尺寸排除（原始图可能很大，但只显示 20px）
        if (!w || !h || w < 60 || h < 60) continue;
        var src = origSrc(im);
        if (!src) continue;
        imgs.push({ src: src, w: w, h: h });
      }

      // 兜底：图可能已被降级成 <a data-src>，从链接上取回
      var cellLinks = el.querySelectorAll('[data-fz="img"][data-src]');
      for (var ck = 0; ck < cellLinks.length; ck++) {
        var u0 = cellLinks[ck].getAttribute('data-src');
        if (u0 && !imgs.some(function (o) { return o.src === u0; })) {
          imgs.push({ src: u0, w: 0, h: 0 });
        }
      }

      var lk = txt(el.querySelector('[class*="like"]'), 12).replace(/^赞\s*/, '').replace(/\s*赞$/, '');
      if (!/^\d/.test(lk)) {
        var mLike = (el.innerText || '').match(/赞\s*(\d+)/);
        lk = mLike ? mLike[1] : '';
      }

      var parentEl = el.parentElement && el.parentElement.closest
        ? el.parentElement.closest('[class*="comment-item"]') : null;

      // 兜底：正文本身就是"回复 @某某：..."
      var mAt = t.match(/^回复\s*@?([^：:\s]{1,20})\s*[：:]/);

      var node = {
        author: txt(el.querySelector('[class*="name"],[class*="author"]'), 16) || '匿名用户',
        desc: t,
        likes: lk,
        depth: parentEl ? 1 : (mAt ? 1 : 0),
        parentEl: parentEl,
        parentAuthor: mAt ? mAt[1] : '',
        kids: [],
        time: normTime(pickTime(txt(el.querySelector('[class*="date"],[class*="time"]'), 40))),
        urls: imgs.map(function (o) { return o.src; }),
        dims: imgs.map(function (o) { return (o.w && o.h) ? o.w + '×' + o.h : ''; }),
        // 属地：站点在评论节点里放了一个 .location（"江苏""云南"）。
        // v1.0 之前这里是空的，于是"走 DOM 兜底读出来的评论"IP 列一直是空白。
        ip: (function () {
          var loc = el.querySelector('[class*="location"],[class*="ip"]');
          var t = loc ? (loc.textContent || '').trim() : '';
          return t.length <= 8 ? t : '';
        })(),
        // 头像：评论节点里的第一张 sns-avatar 图
        avatar: (function () {
          var im = el.querySelector('img[src*="avatar"],img[src*="sns-avatar"]');
          return im ? (im.currentSrc || im.getAttribute('src') || '') : '';
        })(),
        // 头像那个链接就是主页链接（v0.98）：从它身上把 uid 抠出来，
        // 这样走 DOM 兜底读出来的评论也能点名字进主页
        uid: (function () {
          var ua = el.querySelector('a[href*="/user/"]');
          var m = ua && (ua.getAttribute('href') || '').match(/\/user\/(?:profile\/)?([0-9a-zA-Z]+)/);
          return m ? m[1] : '';
        })()
      };
      // DOM 里读来的评论没有接口 id：给个"作者+正文前 24 字"的稳定指纹，
      // 整块重画之后才能认出"还是这条"（选区、去重都靠它）
      node.cid = 'dom:' + node.author + '|' + String(node.desc || '').slice(0, 24);
      list.push(node);
      byEl.set(el, node);
    }

    // 挂父子关系
    var roots = [];
    for (var j = 0; j < list.length; j++) {
      var n = list[j];
      var pe = n.parentEl;
      var parent = pe ? byEl.get(pe) : null;
      if (parent) { parent.kids.push(n); n.depth = parent.depth + 1; n.parentAuthor = parent.author; }
      else roots.push(n);
    }
    // 给每个节点标上它属于哪条一级评论
    roots.forEach(function (r, k) {
      r.rootKey = k;
      (function mark(list2) {
        (list2 || []).forEach(function (c) { c.rootKey = k; mark(c.kids); });
      })(r.kids);
    });
    readComments.lastRoots = roots;
    // 扁平返回，但顺序改成"父 → 子 → 兄弟"，保证表格里层级读得出来
    var ordered = [];
    (function dfs(arr) {
      for (var q = 0; q < arr.length; q++) {
        ordered.push(arr[q]);
        if (arr[q].kids && arr[q].kids.length) dfs(arr[q].kids);
      }
    })(roots);
    return ordered.length ? ordered : list;
  }

  function fmtTs(ts) {
    var n = Number(ts);
    if (!n) return '';
    if (n < 1e12) n *= 1000;              // 秒级时间戳也兼容
    var d = new Date(n);
    if (isNaN(d.getTime())) return '';
    // 表格里用短格式：12/30 23:59
    return pad(d.getMonth() + 1) + '/' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  // 笔记 id 是 24 位 hex 的 ObjectId，前 8 位就是创建时间戳（秒）。
  // 首页卡片和 feed 数据里都没有发布时间（interactInfo 只有 likedCount），
  // 所以这是列表上唯一能拿到的真实时间（2026-10-30 实测：3 篇里 2 篇与站点显示分秒一致，
  // 差的那篇是被编辑过，站点详情显示的是"最后编辑时间"）。
  function noteIdMs(id) {
    var s = String(id == null ? '' : id);
    if (!/^[0-9a-fA-F]{24}$/.test(s)) return 0;
    var ts = parseInt(s.slice(0, 8), 16);              // 秒
    if (!(ts > 1600000000 && ts < 4102444800)) return 0;   // 2020-09 ~ 2100 之外不当时间用
    return ts * 1000;
  }
  function noteIdTime(id) {
    var ms = noteIdMs(id);
    return ms ? fmtTs(ms) : '';
  }
  // 统一成表格里的短格式 MM/DD HH:MM（"2026-10-01 09:09" 这种会被截短）
  function shortTime(t) {
    var s = String(t == null ? '' : t);
    var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/);
    if (m) return pad(m[2]) + '/' + pad(m[3]) + (m[4] ? ' ' + pad(m[4]) + ':' + m[5] : '');
    return s;
  }
  var TIME_SHORT_RE = /^\d{1,2}\/\d{1,2}( \d{1,2}:\d{2})?$/;
  // 从"屏上那串时间"反推毫秒（v0.56 时间筛选用）。
  // 站点渲染出来的评论往往只有 "10/09 12:21" 这种文本、没有原始时间戳，
  // 但时间筛选必须能作用于评论，所以按"当前年份"补年；补出来落在未来一天以上就减一年
  //（跨年那几天看到的 "12/30" 其实属于上一年）。
  function timeTextMs(t) {
    var s = String(t == null ? '' : t);
    var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
    if (m) {
      var full = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), 0, 0).getTime();
      return isNaN(full) ? 0 : full;
    }
    var m2 = s.match(/^(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/);
    if (!m2) return 0;
    var now = new Date();
    var d = new Date(now.getFullYear(), +m2[1] - 1, +m2[2], +(m2[3] || 0), +(m2[4] || 0), 0, 0);
    var ms = d.getTime();
    if (isNaN(ms)) return 0;
    if (ms > Date.now() + 86400000) {
      d.setFullYear(now.getFullYear() - 1);
      ms = d.getTime();
    }
    return ms;
  }

  // 卡片对象可能只有 href（DOM 那条路），也可能只有 id（state 那条路）
  function idOf(d) {
    if (d && d.id) return d.id;
    var m = String((d && (d.href || d.url || d.link)) || '').match(/\/explore\/([0-9a-zA-Z]{24})/);
    return m ? m[1] : '';
  }
  // 列表和详情共用一个"时间"列的取值：先信站点给的，站点没给就用 id 里的创建时间
  function timeTextOf(d) {
    var t = shortTime(d && d.time);
    if (!TIME_SHORT_RE.test(t)) t = '';      // 不像时间就别占着这一列
    return t || noteIdTime(idOf(d));
  }

  // 评论图片
  function cmtPics(c) {
    var ps = c.pictures || c.images || c.imageList || c.image_list || [];
    var arr = [];
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i] || {};
      var u = p.urlDefault || p.url_default || p.urlPre || p.url_pre || p.url ||
        (p.infoList && p.infoList[0] && p.infoList[0].url) || '';
      if (u) arr.push({ src: String(u).replace(/^\/\//, 'https://'), w: p.width || 0, h: p.height || 0 });
    }
    return arr;
  }

  // 从 state 里读评论：这里才有楼中楼（DOM 默认不展开回复）
  // withPool：连"接口拦到、但 state 里还没出现"的翻页评论一起给。
  // 只给「加载更多」那条路用，首屏渲染不许用它，否则同一个列表读两次可能顺序不同，
  // 整块重画时用户的选区会跳到别的行上去。
  function stateComments(pid, withPool) {
    if (!pid) return null;
    var st = readInitialState();
    if (!st) return null;
    var dm = st.note && (st.note.noteDetailMap || st.note.note_detail_map);
    var entry = dm && (dm[pid] || dm[String(pid)]);
    var cs = entry && (entry.comments || entry.comment);
    var list = cs && (cs.list || cs.comments || []);
    if (withPool) {
      // state 只装第一页：后面翻出来的页靠接口拦截（cmtPool）补。
      // 补的时候只认 noteId 对得上的，别人的评论一条都不许进来。
      var extra = [], seen0 = {}, i0, pr = null;
      try { pr = pooledRoots(pid); } catch (eP) { pr = null; }
      for (i0 = 0; i0 < (list || []).length; i0++) if (list[i0] && list[i0].id) seen0[list[i0].id] = 1;
      for (i0 = 0; i0 < (pr || []).length; i0++) {
        var rc = pr[i0];
        if (!rc || !rc.id || seen0[rc.id]) continue;
        seen0[rc.id] = 1;
        extra.push(rc);
      }
      if (extra.length) list = (list || []).concat(extra);
    }
    if (!list || !list.length) return null;

    var out = [], byId = {};
    function mk(c, depth, parent, rootKey) {
      var pics = cmtPics(c);
      // 接口返回是 snake_case（user_info / like_count / create_time），页面 state 是驼峰，两套都认
      var ui = c.userInfo || c.user_info || {};
      var nick = ui.nickname || ui.nick_name || ui.nickName || ui.name || '匿名用户';
      var node = {
        author: nick,
        desc: String(c.content || '').replace(/\s+/g, ' ').trim(),
        likes: String(c.likeCount || c.like_count || ''),
        depth: depth,
        parentAuthor: parent ? parent.author : '',
        rootKey: rootKey,
        kids: [],
        time: (c.createTime || c.create_time) ? fmtTs(c.createTime || c.create_time) : '',
      ms: Number(c.createTime || c.create_time) || 0,
        urls: pics.map(function (o) { return o.src; }),
        dims: pics.map(function (o) { return (o.w && o.h) ? o.w + '×' + o.h : ''; }),
        uid: ui.userId || ui.user_id || '',
        ip: c.ipLocation || c.ip_location || '',
        avatar: ui.image || ui.avatar || ui.avatarUrl || '',
        cid: c.id || ''
      };
      return node;
    }

    // ---- 第一遍：建所有一级评论 ----
    var roots = [];
    for (var i = 0; i < list.length && roots.length < 120; i++) {
      var c = list[i];
      if (!c || c.invalid) continue;
      var root = mk(c, 0, null, i);
      var subs0 = c.subComments || c.sub_comments || c.subCommentList || [];
      root.subTotal = c.subCommentCount || c.subComment_count || subs0.length || 0;
      root.subHasMore = !!(c.subCommentHasMore || c.sub_comment_has_more) ||
        (parseInt(root.subTotal, 10) || 0) > subs0.length;
      root._subs = subs0;
      roots.push(root);
      if (root.cid) byId[root.cid] = root;
    }

    // ---- 第二遍：每个一级评论下，先建全部回复，再按 targetComment 定父子 ----
    for (var ri = 0; ri < roots.length; ri++) {
      var rt = roots[ri];
      var subs = rt._subs || [];
      delete rt._subs;
      // 接口拦截到的完整回复优先补进来（state 里通常只带第一条）
      try {
        var pool = pooledSubs(rt.cid, pid);
        if (pool.length) {
          var have = {};
          for (var q0 = 0; q0 < subs.length; q0++) if (subs[q0] && subs[q0].id) have[subs[q0].id] = 1;
          for (var q1 = 0; q1 < pool.length; q1++) {
            var pc = pool[q1];
            if (pc && pc.id && !have[pc.id]) { subs.push(pc); have[pc.id] = 1; }
          }
        }
      } catch (e0) {}
      if (subs.length > (parseInt(rt.subTotal, 10) || 0)) rt.subTotal = subs.length;

      // 2.1 先全部挂到一级（保证每个节点都已存在）
      var pairs = [], byCid = {};
      for (var j = 0; j < subs.length; j++) {
        var sc = subs[j];
        if (!sc || sc.invalid) continue;
        var node = mk(sc, 1, rt, ri);
        node.kidx = j;
        rt.kids.push(node);
        pairs.push({ sc: sc, node: node });
        if (node.cid) byCid[node.cid] = node;
      }

      // 2.2 再按"它回复的是谁"重新挂到那个节点下面（找不到就留在一级，绝不串上一条）
      for (var k = 0; k < pairs.length; k++) {
        var pr = pairs[k], nd = pr.node;
        var tc = pr.sc.targetComment || pr.sc.target_comment;
        if (!tc) continue;
        var par = null;
        if (tc.id) par = byCid[tc.id] || byId[tc.id] || null;
        if (!par) {
          var ti = tc.userInfo || tc.user_info || {};
          var nm = ti.nickname || ti.nickName || ti.nick_name || ti.name || '';
          if (nm) {
            for (var q = pairs.length - 1; q >= 0; q--) {
              var cand = pairs[q].node;
              if (cand !== nd && cand.author === nm) { par = cand; break; }
            }
          }
        }
        if (!par || par === nd) continue;
        var oi = rt.kids.indexOf(nd);
        if (oi > -1) rt.kids.splice(oi, 1);
        nd.depth = Math.min((par.depth || 0) + 1, 3);
        nd.parentAuthor = par.author;
        par.kids.push(nd);
      }
    }

    // ---- 第三遍：按树 DFS 展平（父 → 子 → 兄弟）----
    function walk(n) {
      out.push(n);
      for (var w = 0; w < n.kids.length && out.length < 400; w++) walk(n.kids[w]);
    }
    for (var r2 = 0; r2 < roots.length; r2++) walk(roots[r2]);
    return out;
  }

  // 统一入口：state 为主（有楼中楼），DOM 只用来补 state 里还没出现的
  function readComments(pid, withPool) {
    var id = pid || (location.pathname.match(NOTE_PATH) || [])[1] || '';
    var st = null;
    try { st = stateComments(id, withPool); } catch (e) { st = null; }
    if (st && st.length) {
      var dom = [];
      try { dom = readCommentsDom() || []; } catch (e2) { dom = []; }
      var key = {};
      st.forEach(function (c) { key[(c.author || '') + '|' + (c.desc || '').slice(0, 24)] = 1; });
      var extra = [];
      dom.forEach(function (c) {
        if (c.depth) return;            // DOM 拿不到层级，只补一级
        var k = (c.author || '') + '|' + (c.desc || '').slice(0, 24);
        if (key[k]) return;
        key[k] = 1;
        extra.push(c);
      });
      return st.concat(extra);
    }
    try { return readCommentsDom(); } catch (e3) { return []; }
  }

  // ---------- 前台遮挡（cover）----------
  // 回到原生页面拿数据的那几秒，把"当前看到的表格"克隆一份钉在最上层，
  // 用户看到的画面不变，底下原生页面在滚。克隆限行数，避免几百行时卡顿。
  var coverEl = null;

  function makeCover(sel, tipText) {
    dropCover();
    var src = document.querySelector(sel || '.fz-board');
    if (!src) return null;
    var wrap = document.createElement('div');
    wrap.className = 'fz-cover';
    var inner = document.createElement('div');
    inner.className = 'fz-cover-inner';
    var clone = src.cloneNode(true);
    clone.removeAttribute('id');
    var ids = clone.querySelectorAll('[id]'), i;
    for (i = 0; i < ids.length; i++) ids[i].removeAttribute('id');
    var links = clone.querySelectorAll('.fz-link,[data-cmore],[data-fz-pic]');
    for (i = 0; i < links.length; i++) links[i].removeAttribute('data-cmore');
    inner.style.transform = 'translateY(' + (-Math.round(window.scrollY || 0)) + 'px)';
    inner.appendChild(clone);
    wrap.appendChild(inner);
    var tip = document.createElement('div');
    tip.className = 'fz-cover-tip';
    tip.textContent = tipText || '正在加载…';
    wrap.appendChild(tip);
    try { document.body.appendChild(wrap); } catch (e) {}
    coverEl = wrap;
    return wrap;
  }

  function setCoverTip(txt) {
    var t = coverEl && coverEl.querySelector('.fz-cover-tip');
    if (t) t.textContent = txt;
  }

  function dropCover() {
    if (coverEl && coverEl.parentNode) coverEl.parentNode.removeChild(coverEl);
    coverEl = null;
  }

  // 详情页真正的容器：#noteContainer（弹层里的那块），拿不到才退而求其次
  function noteRoot() {
    var cands = ['#noteContainer', '.note-detail-mask', '[class*="note-detail"]'];
    for (var i = 0; i < cands.length; i++) {
      var e = document.querySelector(cands[i]);
      if (e && e.getBoundingClientRect().width > 200) return e;
    }
    return null;
  }

  // 从 "编辑于 09-27 广东" 里只取时间部分，IP 属地直接丢掉
  function pickTime(t) {
    if (!t) return '';
    var s2 = String(t).replace(/\s+/g, ' ').trim().replace(/^(编辑于|发布于|更新于|修改于)\s*/, '');
    var m = s2.match(/(刚刚|\d+\s*(?:秒|分钟|小时|天)前|昨天\s*\d{1,2}:\d{2}|\d{4}-\d{1,2}-\d{1,2}(?:\s*\d{1,2}:\d{2})?|\d{1,2}-\d{1,2}(?:\s*\d{1,2}:\d{2})?|\d{1,2}:\d{2})/);
    return m ? m[0] : s2;
  }

  // 提数字（"3250" / "1.2万" / "10+" 都能吃）
  function pickNum(t) {
    var m = String(t || '').replace(/\s+/g, '').match(/([\d.]+[万千wW]?\+?)/);
    return m ? m[1] : '';
  }

  // "1.2万" / "3,456" / "12" → 数字。认不出来返回 null（null = 不知道，数值筛选时不算命中）
  function likeNum(s) {
    var t = String(s == null ? '' : s).replace(/[,\s＋+]/g, '');
    var m = t.match(/^(\d+(?:\.\d+)?)(万|千|w|W)?/);
    if (!m) return null;
    var n = parseFloat(m[1]);
    if (!isFinite(n)) return null;
    if (m[2] === '万' || m[2] === 'w' || m[2] === 'W') n *= 10000;
    else if (m[2] === '千') n *= 1000;
    return Math.round(n);
  }

  // 明显不是正文的文案（导航、登录引导之类）
  function badText(t) {
    if (!t) return true;
    if (t.length > 2000) return true;
    return /猜你想搜|扫码|打开小红书|下载客户端|登录后查看|登录后评论|推荐\s*RED|穿搭\s*美食\s*彩妆|只看图文|剧集|\d{2}:\d{2}\d{2}:\d{2}/.test(t);
  }

  function readNotePage() {
    var root = noteRoot();
    var dd = document.querySelector('#detail-desc');
    if (!root && !dd) return null;        // 不是笔记详情页，别接管

    var scope = root || document.body;

    // 标题：只在详情容器里找。真实页面很多笔记压根没有标题元素
    var titleEl = document.querySelector('#detail-title');
    if (!titleEl && root) {
      titleEl = root.querySelector('.note-content .title') || root.querySelector('.title');
    }
    if (titleEl && titleEl.closest('[class*="comment"]')) titleEl = null;
    var title = titleEl ? txt(titleEl, 100) : '';
    if (badText(title) || /^(活动|推荐|首页|我|消息|通知|发布)$/.test(title)) title = '';

    // 正文：#detail-desc 最准，其次容器内的 .desc
    var descEl = dd || (root && (root.querySelector('.note-scroller .desc') || root.querySelector('.desc')));
    if (descEl && descEl.closest('[class*="comment"]')) descEl = null;
    var desc = descEl ? textWithEmoji(descEl, 4000) : '';
    if (badText(desc)) desc = '';

    // 作者
    var authorEl = (root && (root.querySelector('.author .name') || root.querySelector('.author-wrapper .name'))) ||
      document.querySelector('#noteContainer a.name') ||
      document.querySelector('[class*="author"] [class*="name"]') ||
      document.querySelector('[class*="username"]');
    var author = txt(authorEl, 20);
    if (badText(author)) author = '';

    // 赞 / 藏 / 评：按真实类名取，别用 [class*=like] 全页乱匹配
    var likeEl = (root && root.querySelector('.like-wrapper')) || document.querySelector('.like-wrapper');
    var collEl = (root && root.querySelector('.collect-wrapper')) || document.querySelector('.collect-wrapper');
    var chatEl = (root && root.querySelector('.chat-wrapper')) || document.querySelector('.chat-wrapper');
    var likes = likeEl ? pickNum(txt(likeEl, 16)) : '';
    var collects = collEl ? pickNum(txt(collEl, 16)) : '';
    var cmtCnt = chatEl ? pickNum(txt(chatEl, 16)) : '';

    // 时间：.note-scroller .date，去掉 IP 属地
    var dateEl = (root && (root.querySelector('.note-scroller .date') || root.querySelector('.date'))) ||
      document.querySelector('.date');
    var time = normTime(pickTime(dateEl ? txt(dateEl, 40) : ''));
    // 主贴的属地（v1.2：以前只有评论有，主贴那一行永远是空的）。
    // 只在 state 里找 ipLocation —— readStateNote() 要求"有图才返回"，视频笔记会拿不到；
    // 页面上那句话（"10-04" 或 "2天前上海"）格式不稳，只当最后的兜底，而且必须像地名。
    var ipText = '';
    try {
      var stIp = readInitialState();
      var mapIp = stIp && stIp.note && (stIp.note.noteDetailMap || stIp.note.note_detail_map);
      var pidX = (location.pathname.match(NOTE_PATH) || [])[1] || '';
      var nodeIp = mapIp && pidX && mapIp[pidX];
      nodeIp = nodeIp && (nodeIp.note || nodeIp.noteCard || nodeIp);
      if (nodeIp) ipText = nodeIp.ipLocation || nodeIp.ip_location || '';
    } catch (eIp) {}
    if (!ipText && dateEl) {
      var dt0 = (txt(dateEl, 40) || '').trim();
      var mIp = dt0.match(/^(?:\d+\s*(?:天|小时|分钟)前|昨天|今天|\d{2}-\d{2}|\d{4}-\d{2}-\d{2})\s*(.*)$/);
      var tail = mIp ? (mIp[1] || '').trim() : '';
      // 地名 2~8 个字、里面不能有数字（"10-04" 这种减完是空的就别写）
      if (tail && tail.length >= 2 && tail.length <= 8 && !/[0-9]/.test(tail)) ipText = tail;
    }

    var authorLink = (root && root.querySelector('a[href*="/user/"]')) || document.querySelector('a[href*="/user/"]');
    var uid = '';
    if (authorLink) {
      var um = (authorLink.getAttribute('href') || '').match(/\/user\/(?:profile\/)?([0-9a-zA-Z]+)/);
      if (um) uid = um[1];
    }
    // 主贴作者的头像（详情页"显示头像"时用）
    var avEl = (authorLink && authorLink.querySelector('img')) ||
      (root && root.querySelector('img[src*="sns-avatar"],img[src*="avatar"]'));
    var avatar = avEl ? (avEl.currentSrc || avEl.getAttribute('src') || '') : '';

    // 主贴图只从媒体区取
    var imgs = [];
    try { imgs = mediaImgs(); } catch (em) { imgs = []; }
    if (!imgs.length) imgs = imgList(scope, 9);
    // 视频笔记：封面在 video 的 poster 上
    if (!imgs.length) {
      var vd1 = (root && root.querySelector('video')) || document.querySelector('.note-scroller video,video');
      var ps1 = vd1 ? (vd1.getAttribute('poster') || vd1.getAttribute('data-poster') || '') : '';
      if (ps1) imgs = [{ src: ps1, w: 0, h: 0 }];
    }

    return {
      href: location.pathname + location.search,
      title: title,
      desc: desc,
      author: author,
      uid: uid,
      avatar: avatar,
      ip: ipText,
      likes: likes,
      collects: collects,
      cmtCount: cmtCnt,
      time: time,
      type: (function () {
        // 先信站点数据：图文笔记里的"实况图"在页面上也是 <video>，只看 DOM 会把图文认成视频
        // （2026-10-30 真机巡检抓到："见识到了大闸蟹真的很寒" 被标成视频）
        try {
          var pid0 = (location.pathname.match(/\/explore\/([0-9a-zA-Z]+)/) || [])[1];
          var st0 = readStateNote(pid0);
          if (st0 && st0.type) return st0.type;
        } catch (eT) {}
        // 站点数据没有时才看 DOM；只看媒体容器里的 video，其他位置（推荐位/悬浮播放器）不算
        var mr = mediaRoots()[0] || root;
        return (mr && mr.querySelector('video')) ? '视频' : '图文';
      })(),
      urls: imgs.map(function (o) { return o.src; }),
      dims: imgs.map(function (o) { return (o.w && o.h) ? o.w + '×' + o.h : ''; }),
      comments: readComments()
    };
  }

  // ---------- 单元格渲染 ----------
  // 图片链接的文字：只有第一张叫「封面图」，第二张起 图2 / 图3 / 图4 …
  //   - 首页那一行、详情主贴都按这条（v0.87 定稿）：封面就一张，第 2 张开始是同一篇的配图，
  //     继续叫「封面图2」是错的；
  //   - 评论里的配图本来就不是封面，从 图1 开始编号；
  //   - 不补零：以前写 图01 / 图02，看着像"第 01 页"，用户要的是 图2、图3。
  //   - `cover` 只影响第一张叫什么；第二张起两种来历写法一样（都是 图N）。
  // 链接上挂 data-cov="1"（第一张封面）：看图浮层的标题、图集翻页都照这个走，
  // 不然表格里写「封面图」、点开却写「图 01」，同一张图两个名字。
  function imgLinkLabel(i, n, cover) {
    return (cover && i === 0) ? '封面图' : ('图' + (i + 1));
  }

  function imgLinks(data, cover) {
    if (!data.urls || !data.urls.length) return '<span class="fz-mdim">—</span>';
    // 设置里关掉"图片变文字链接"：不再铺一排链接，只写有几张（想看图就开回来）
    if (!CFG.imgLink) return '<span class="fz-mdim">' + data.urls.length + ' 张图</span>';
    var out = "", shown = Math.min(data.urls.length, 30);
    for (var i = 0; i < shown; i++) {
      out += '<a class="fz-link"' + (cover ? ' data-cov="1"' : '') + ' data-i="' + i + '">' +
        imgLinkLabel(i, shown, cover) + '</a>';
    }
    if (data.urls.length > shown) out += '<span class="fz-mdim">+' + (data.urls.length - shown) + '</span>';
    return out;
  }

  function cellsHtml(data, idx, kind, kidCount, floor, kids) {
    var isCmt = kind === 'comment';
    var sub = [];   // 类型列已经写了"回复"，作者列不再重复

    var replyTo = (data.depth && data.parentAuthor && !/^回复\s*@/.test(data.desc || ''))
      ? ('回复 @' + stripEmoji(data.parentAuthor) + '：') : '';
    // 标题。列表页里它是唯一能进详情页的地方：整行、整张卡片都不再响应点击。
    // 没有标题的条目也得留一格能点的字，否则那条笔记就再也打不开了（真实数据里标题常为空）。
    // 先按设置去掉表情再判断空不空：整条标题只有 emoji 的那种，去了之后也该显示「无标题」。
    var titleTxt = stripEmoji(data.title).trim();
    var titleHtml;
    if (!kind) {
      titleHtml = '<a class="fz-link fz-et fz-title"' + (titleTxt ? '' : ' data-fz-untitled="1"') +
        ' data-fz-open="1" title="' + esc(titleTxt || '这条笔记没有标题，点这里打开') + '">' +
        esc(titleTxt || '无标题') + '</a>';
    } else {
      titleHtml = titleTxt ? '<span class="fz-et">' + esc(titleTxt) + '</span>' : '';
    }

    // 「展开 N 条回复 / 再加载几条」不在这一格里：它单独占一行（.fz-trow），
    // 由 cmtRowsHtml() 挂到这一楼最后一条回复的后面。
    var body = isCmt
      ? '<span class="fz-es">' + (data.depth ? '<i class="fz-reply">↳</i> ' : '') +
        (replyTo ? '<b class="fz-at">' + esc(replyTo) + '</b>' : '') + escT(data.desc || '') + '</span>' +
        ((data.urls && data.urls.length) ? '<span class="fz-el fz-el-inline">' + imgLinks(data, false) + '</span>' : '')
      : titleHtml +
        (data.desc
          ? (function () {
              // 折叠只管「太长」；设置里关掉折叠就整段铺出来（导出/复制一直是全文）
              var full = stripEmoji(data.desc);
              var cut = !!(CFG.foldText && full.length > 300);
              return '<span class="fz-es">' + esc(cut ? full.slice(0, 300) + '…' : full) + '</span>' +
                (cut ? '<span class="fz-el"><a class="fz-link fz-full" data-full="' + esc(full) + '">展开全文（' +
                  full.length + ' 字）</a></span>' : '');
            })()
          : '') +
        '<span class="fz-el' + (kind ? '' : ' fz-el-inline') + '">' + imgLinks(data, true) +
          ((kind === 'main' && data.type === '视频')
            ? '<a class="fz-link fz-vplay">视频</a>' : '') +
        '</span>';

    // 操作列：只在详情页出现（主楼：赞/收藏/回复；评论：赞/回复）；瀑布流不加
    var acts = '';
    if (kind === 'main') {
      acts = '<a class="fz-link fz-act" data-act="like" data-row="' + idx + '">赞</a>' +
        '<a class="fz-link fz-act" data-act="collect" data-row="' + idx + '">收藏</a>' +
        '<a class="fz-link fz-act" data-act="reply" data-row="' + idx + '">回复</a>';
    } else if (isCmt) {
      acts = '<a class="fz-link fz-act" data-act="like" data-row="' + idx + '">赞</a>' +
        '<a class="fz-link fz-act" data-act="reply" data-row="' + idx + '">回复</a>';
    }

    var likes = esc(/^\d/.test(String(data.likes || '')) ? data.likes : '');
    // 楼层徽标：只在详情页的一级评论上出现（回复行靠缩进 + ↳ 区分）；设置里可以整个关掉
    var floorTag = '';
    if (CFG.showFloor && isCmt && !data.depth && floor) {
      var kn = parseInt(kids, 10) || 0;
      floorTag = '<i class="fz-fl' + (kn ? ' has' : '') + '"' +
        ' title="第 ' + floor + ' 楼' + (kn ? '，有 ' + kn + ' 条回复' : '，没有回复') + '">' +
        floor + '楼</i>';
    }
    // 用户名（v0.98）：有 uid 就做成入口，点了在新标签页开这个人的主页。
    // 外面仍套一层 <b>：.fz-a b 的粗体、按内容调宽（textWidth 认 .fz-aname b）都靠它，
    // 换标签会让这两处一起塌。没有 uid 的（DOM 兜底读出来的评论）就当普通文字。
    var authorName = stripEmoji(data.author || '未知作者') || '未知作者';
    var nameInner = esc(authorName);
    if (data.uid) {
      nameInner = '<a class="fz-uname" data-fz-user="' + esc(data.uid) + '">' + esc(authorName) + '</a>';
    }
    // title 挂在 b 上而不是链接上：链接上的 title 会被"按钮别重复自己的标签"那条规矩挑出来。
    // 内容就是名字本身，不加"点开主页"这类后缀——悬停提示的规矩是"等于格子里那段字"。
    var nameHtml = '<b' + (data.uid ? ' title="' + esc(authorName) + '"' : '') + '>' +
      nameInner + '</b>';
    // 头像（v1.0）：设置里关掉「隐藏用户头像」才画出来。瀑布页画楼主，
    // 详情页画楼主 + 各楼层 + 回复的头像（数据里给了 avatar 才画）。
    var avHtml = (!CFG.hideAvatar && data.avatar)
      ? '<img class="fz-av" src="' + esc(data.avatar) + '" alt="" referrerpolicy="no-referrer">' : '';
    // 「楼主」标记：让看评论的人一眼认出哪个是他自己发的
    var opTag = (CFG.opMark && data.isOp)
      ? '<i class="fz-op" title="楼主：这篇笔记的作者">楼主</i>' : '';
    var authorCell = '<div class="fz-c fz-a"><span class="fz-aname">' +
      avHtml + floorTag + nameHtml + opTag + '</span>' +
      (kind ? '<span>' + esc(sub[0] || '') + '</span>' +
              '<span>' + esc(sub[1] || '') + '</span>' : '') +
      '</div>';
    var numCell = '<div class="fz-c fz-num">' + idx + '</div>';
    var likeCell = '<div class="fz-c fz-o">' + likes + '</div>';
    // 时间：卡片上有就用卡片的，没有就用 id 里带的创建时间（首页没有发布时间字段）
    var rowTime = timeTextOf(data);
    var timeCell = '<div class="fz-c fz-p">' + esc(rowTime) + '</div>';

    if (!kind) {
      // 瀑布流：行号 | 赞 | 类型 | 标题+图 | 作者 | 时间
      // （评论数/收藏数/发帖时间 首页卡片数据里没有，只有进详情才有）
      return numCell + likeCell +
        '<div class="fz-c fz-d">' + esc(data.type || '笔记') + '</div>' +
        '<div class="fz-c fz-e">' + body + '</div>' +
        authorCell + timeCell;
    }
    // 详情页：行号 | A赞 | D作者 | C内容 | F操作 | B属地 | E时间
    return numCell + likeCell + authorCell +
      '<div class="fz-c fz-e">' + body + '</div>' +
      '<div class="fz-c fz-x">' + acts + '</div>' +
      '<div class="fz-c fz-d">' + esc(data.ip || '') + '</div>' +
      timeCell;
  }

  // 列宽是固定的：标题长了会被省略号截掉，而站点自己的卡片被我们压成 opacity:0 + pointer-events:none，
  // 悬停什么都不会冒出来，想知道完整标题只能点进笔记。Excel 里列宽不够时鼠标停一下就能看到完整内容，
  // 这里补上同款。只在叶子元素上设 title：容器的 textContent 会把里面的东西全拼起来
  // （比如操作列会拼成「打开原图复制链接」），看着像内容其实是按钮标签。
  function cellTips(scope) {
    if (!CFG.tips) return;
    var cells = scope.querySelectorAll('.fz-c');
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      if (c.classList.contains('fz-num') || c.classList.contains('fz-x')) continue;   // 行号 / 操作列
      // 只给「内容」挂（b/span）。a/i 是按钮和图标（图01 / 展开全文 / 赞 / 收藏），
      // 给它们挂一个「等于自身文字」的 title 只是把按钮标签重复一遍，还挤掉了它们自己的说明
      var kids = c.querySelectorAll('b,span');
      if (!kids.length) {
        var tt = (c.textContent || '').trim();
        if (tt && !c.title) c.title = tt;
        continue;
      }
      for (var j = 0; j < kids.length; j++) {
        var el = kids[j];
        if (el.children.length) continue;              // 里面还有东西的容器不管
        if (el.title) continue;                        // 自己已经写了 title 的（比如图片链接）别覆盖
        var s = (el.textContent || '').trim();
        if (s) el.title = s;
      }
    }
    return cells.length;
  }

  function bindLinks(scope, data) {
    scope.addEventListener('click', function (e) {
      var a = e.target.closest ? e.target.closest('.fz-link') : null;
      if (!a || a.dataset.i === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      var i = parseInt(a.dataset.i, 10) || 0;
      // 是"笔记的封面图"还是"评论里的配图"，在生成链接时就定了（data-cov），
      // 别在这里按"在哪张表"再猜一次：详情页既有主贴的封面图，也有评论的配图。
      var cov = a.getAttribute('data-cov') === '1';
      var n = (data.urls || []).length;
      var cap = imgLinkLabel(i, n, cov);
      openImage(a, data.urls[i], cap + (data.dims[i] ? ' · ' + data.dims[i] : ''),
        cleanSrc(data.urls[i]), galleryOf(data.urls, data.dims, cov), i);
    });
  }

  // ---------- 首页：卡片 → 表格行 ----------
  function findCardGroups() {
    var anchors = document.querySelectorAll(NOTE_A_SEL);
    var groups = new Map();
    for (var i = 0; i < anchors.length; i++) {
      var el = anchors[i];
      for (var k = 0; k < 6 && el.parentElement; k++) {
        var p = el.parentElement, sibs = 0;
        for (var j = 0; j < p.children.length; j++) {
          if (p.children[j].querySelector && p.children[j].querySelector(NOTE_A_SEL)) sibs++;
        }
        if (sibs >= 3) {
          if (!groups.has(p)) groups.set(p, []);
          var arr = groups.get(p);
          if (arr.indexOf(el) === -1) arr.push(el);
          break;
        }
        el = p;
      }
    }
    var best = null;
    groups.forEach(function (arr, parent) {
      if (!best || arr.length > best.cards.length) best = { parent: parent, cards: arr };
    });
    return best;
  }

  // ---------- 从页面初始状态里挖 xsec_token ----------
  var tokenMap = null;

  function pageWin() {
    try { return (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window; }
    catch (e) { return window; }
  }

  // 小红书把 __INITIAL_STATE__ 挂成页面全局对象，直接读对象最省事
  // （脚本里 JSON.parse 文本经常失败：字面量里有 undefined / NaN）
  var stateCache = null, stateRef = null, stateAt = 0;
  function readInitialState() {
    var now = Date.now();
    var w = pageWin();
    try {
      var o = w.__INITIAL_STATE__;
      if (o && typeof o === 'object' && Object.keys(o).length) {
        // 同一个对象就复用；页面换了新对象（SPA 切页）立刻重取
        if (stateRef === o) return stateCache || o;
        stateRef = o; stateCache = o; stateAt = now;
        return o;
      }
    } catch (e) {}

    if (stateCache && now - stateAt < 3000) return stateCache;

    var ss = document.querySelectorAll('script');
    for (var i = 0; i < ss.length; i++) {
      var t = ss[i].textContent || '';
      var idx = t.indexOf('__INITIAL_STATE__');
      if (idx === -1) continue;
      var start = t.indexOf('{', idx);
      if (start === -1) continue;
      var txt = t.slice(start).replace(/;\s*$/, '');
      var cut = txt.lastIndexOf('}');
      if (cut > 0) txt = txt.slice(0, cut + 1);
      // 洗掉 JS 字面量里 JSON 不认的值
      var clean = txt
        .replace(/:\s*undefined\s*([,}\]])/g, ':null$1')
        .replace(/,\s*undefined\s*([,}\]])/g, ',null$1')
        .replace(/:\s*NaN\s*([,}\]])/g, ':null$1');
      try { stateCache = JSON.parse(clean); stateAt = now; return stateCache; } catch (e2) {}
      try { stateCache = JSON.parse(txt); stateAt = now; return stateCache; } catch (e3) {}
      // 最后兜底：当作表达式求值（CSP 允许时才行）
      try {
        var fn = new Function('return (' + clean + ')');
        var r = fn();
        if (r && typeof r === 'object') { stateCache = r; stateAt = now; return r; }
      } catch (e4) {}
    }
    return null;
  }

  function walkTokens(obj, out, depth) {
    if (!obj || typeof obj !== 'object' || depth > 9) return;
    if (Array.isArray(obj)) {
      for (var i = 0; i < obj.length && i < 300; i++) walkTokens(obj[i], out, depth + 1);
      return;
    }
    var id = obj.noteId || obj.note_id || obj.id;
    var tk = obj.xsecToken || obj.xsec_token;
    if (id && tk && typeof id === 'string' && typeof tk === 'string') out[id] = tk;
    for (var k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) walkTokens(obj[k], out, depth + 1);
    }
  }

  // ===== 拦截小红书接口，直接拿它的原始数据（图片/话题/互动数）=====
  var PAGE = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
  var apiNotes = {};

  var absorbBudget = 0;

  function absorbNote(o, depth) {
    if (!o || typeof o !== 'object' || depth > 9) return;
    if (++absorbBudget > 20000) return;
    if (Object.prototype.toString.call(o) === '[object Array]') {
      for (var i = 0; i < o.length && i < 200; i++) absorbNote(o[i], depth + 1);
      return;
    }
    // 接口返回形如 { data:{ items:[ { id, note_card:{ note_id, image_list:[...] } } ] } }
    var card = o.noteCard || o.note_card || null;
    var id = o.noteId || o.note_id || o.id ||
      (card && (card.noteId || card.note_id || card.id)) || '';
    if (id && typeof id === 'string') {
      var p = noteParts(o);
      if (p && p.images.length) {
        var old = apiNotes[id];
        // 只留更全的那份，避免后来的局部响应把 6 张覆盖成 1 张
        if (!old || p.images.length >= old.images.length) apiNotes[id] = p;
      }
    }
    for (var kk in o) {
      if (Object.prototype.hasOwnProperty.call(o, kk)) {
        var v = o[kk];
        if (v && typeof v === 'object') absorbNote(v, depth + 1);
      }
    }
  }

  // ===== 评论池：拦截评论接口，把完整回复收下来（state 里只有第一条）=====
  var cmtPool = {};
  // 评论 id → 它属于哪一篇笔记。翻页接口回的评论常常没有 noteId，
  // 那就用"这次请求是给哪篇笔记发的"顶上：不然后面认不出该不该进这张详情表，
  // 首页预取进来的别人的评论就会被当成"这篇的评论"混进去。
  var cmtPoolNote = {};
  // 站点一共发过多少次评论请求（排障用：点了"加载更多"之后它涨没涨，
  // 一眼分清"站点压根没理我们"和"回包拿到了但没入表"）
  var cmtReqN = 0;

  function absorbComments(j, depth, hint) {
    if (!j || typeof j !== 'object' || depth > 6) return;
    if (++absorbBudget > 26000) return;
    if (Object.prototype.toString.call(j) === '[object Array]') {
      for (var i = 0; i < j.length && i < 120; i++) absorbComments(j[i], depth + 1, hint);
      return;
    }
    var u = j.user_info || j.userInfo;
    if (j.id && typeof j.content === 'string' && u && (u.nickname || u.nick_name || u.nickName)) {
      cmtPool[j.id] = j;
      cmtPoolNote[j.id] = String(j.noteId || j.note_id || hint || '');
      var subs = j.sub_comments || j.subComments || j.sub_comment_list || [];
      for (var k = 0; k < subs.length && k < 60; k++) {
        if (subs[k] && subs[k].id) {
          cmtPool[subs[k].id] = subs[k];
          cmtPoolNote[subs[k].id] = String(subs[k].noteId || subs[k].note_id || hint || '');
        }
      }
    }
    for (var kk in j) {
      if (Object.prototype.hasOwnProperty.call(j, kk)) {
        var v = j[kk];
        if (v && typeof v === 'object') absorbComments(v, depth + 1, hint);
      }
    }
  }

  // 从响应 URL 里认这篇笔记：/comment/page?...note_id=xxx（也认 /note/ 里的 id）
  function noteIdFromUrl(url) {
    var u = String(url || '');
    var m = u.match(/[?&](?:note_id|noteId|note-id)=([0-9a-zA-Z]+)/);
    if (m) return m[1];
    m = u.match(/\/(?:explore|discovery\/item)\/([0-9a-zA-Z]{16,})/);
    if (m) return m[1];
    // 兜底：当前页就是某篇详情时，评论请求一定是给它发的
    var p = (location.pathname.match(NOTE_PATH) || [])[1] || '';
    return p;
  }

  // 池子里属于某条一级评论的子回复（给了 pid 就只认这篇笔记的，别的笔记的回复不许串进来）
  function pooledSubs(rootId, pid) {
    var out = [], cid;
    for (cid in cmtPool) {
      var o = cmtPool[cid];
      if (!o || o.id === rootId) continue;
      if (pid) {
        // 认得出是哪篇（记下来过）就必须是这篇；认不出的放行，父子关系靠评论 id 配，
        // 而 id 全局唯一，配得上就一定是这条评论的回复，不会串到别的笔记去
        var whose = String(cmtPoolNote[cid] || '');
        if (whose && whose !== String(pid)) continue;
      }
      var tc = o.target_comment || o.targetComment;
      var rid = (tc && (tc.id || tc.comment_id)) || o.root_comment_id || o.rootCommentId ||
        o.parent_comment_id || o.parentCommentId || '';
      if (rid && String(rid) === String(rootId)) out.push(o);
    }
    return out;
  }

  // 池子里属于某篇笔记的一级评论（翻页接口回来的、state 里还没出现的那些）。
  // 只认挂着这篇 noteId 的：别把首页预取/别的笔记的评论算进来，那正是"抓错页"的来源。
  function pooledRoots(pid) {
    var out = [], cid;
    if (!pid) return out;
    for (cid in cmtPool) {
      var o = cmtPool[cid];
      if (!o || !o.id) continue;
      if (String(cmtPoolNote[cid] || '') !== String(pid)) continue;
      if (o.target_comment || o.targetComment) continue;                 // 楼中楼走 pooledSubs
      if (o.parent_comment_id || o.parentCommentId) continue;
      if (o.invalid) continue;
      out.push(o);
    }
    return out;
  }

  function hookApi() {
    try {
      if (!PAGE.fetch || PAGE.fetch.__fzHooked) return;
      var orig = PAGE.fetch;
      var wrapped = function (input, init) {
        var p = orig.apply(this, arguments);
        try {
          var url = (typeof input === 'string') ? input : ((input && input.url) || '');
          if (url.indexOf('/api/') > -1) {
            p.then(function (res) {
              try {
                // 只解析"详情/评论"这类小响应：homefeed 一次几十条笔记，全量递归解析
                // 会把主线程按住，站点的翻页逻辑直接卡死（实测踩过）
                if (!/homefeed/i.test(url)) {
                  res.clone().json().then(function (j) {
                    absorbBudget = 0;
                    absorbNote(j, 0);
                    if (/comment|note/i.test(url)) { cmtReqN++; absorbComments(j, 0, noteIdFromUrl(url)); }
                  }).catch(function () {});
                }
              } catch (e) {}
              return res;
            }).catch(function () {});
          }
        } catch (e) {}
        return p;
      };
      wrapped.__fzHooked = 1;
      PAGE.fetch = wrapped;
    } catch (e) {}
    // XHR 也补一下
    try {
      if (PAGE.XMLHttpRequest && !PAGE.XMLHttpRequest.__fzHooked) {
        var XO = PAGE.XMLHttpRequest;
        var XN = function () {
          var x = new XO();
          x.addEventListener('load', function () {
            try {
              if (x.responseType === '' || x.responseType === 'text') {
                var t = x.responseText || '';
                var xu = String(x.responseURL || '');
                if (t.length > 40 && t.charAt(0) === '{' && !/homefeed/i.test(xu)) {
                  var jx = JSON.parse(t);
                  absorbBudget = 0;
                  absorbNote(jx, 0);
                  if (/comment|note/i.test(xu)) { cmtReqN++; absorbComments(jx, 0, noteIdFromUrl(xu)); }
                }
              } else if (x.responseType === 'json' && x.response) {
                absorbNote(x.response, 0);
                if (/comment|note/i.test(String(x.responseURL || ''))) {
                  cmtReqN++; absorbComments(x.response, 0, noteIdFromUrl(x.responseURL));
                }
              }
            } catch (e) {}
          });
          return x;
        };
        XN.__fzHooked = 1;
        XN.prototype = XO.prototype;
        PAGE.XMLHttpRequest = XN;
      }
    } catch (e) {}
  }

  function apiNote(id) {
    return (id && apiNotes[id]) || null;
  }

  // 图片数组统一解析：兼容 camelCase（页面 state）与 snake_case（接口返回）
  function normImgs(list) {
    var out = [];
    if (!list || !list.length) return out;
    for (var i = 0; i < list.length; i++) {
      var it = list[i] || {};
      var u = it.urlDefault || it.url_default || it.urlPre || it.url_pre || it.url ||
        (it.infoList && it.infoList[0] && (it.infoList[0].url || it.infoList[0].urlDefault)) ||
        (it.info_list && it.info_list[0] && (it.info_list[0].url || it.info_list[0].url_default)) ||
        it.masterUrl || it.master_url || '';
      if (!u || typeof u !== 'string') continue;
      u = u.trim().replace(/^\/\//, 'https://');
      if (!(u.indexOf('http') === 0 || u.indexOf('data:image/') === 0)) continue;
      out.push({ src: u, w: it.width || 0, h: it.height || 0 });
    }
    return out;
  }

  // ---------- 首页封面图取数（2026-11-13 加固）----------
  // 真机实测（CDP 抓的真实 __INITIAL_STATE__，2026-11-13）：
  //   首页 noteCard 的键是 [type, displayTitle, user, interactInfo, cover]，**没有 imageList**。
  //   cover 是对象：{ urlPre, urlDefault, url:"", infoList:[{imageScene,url}...], width, height }，
  //   其中 url 常是空串，真正有值的是 urlDefault / urlPre / infoList[0].url。
  // （以前误以为图文笔记有 imageList，实际首页没有；那条回退只在少数接口形态下有用。）
  // 除了 cover 对象，这里把「cover 直接是字符串 URL」「封面挂在 video 子对象」「图集第一张」
  // 几种形态一起兜住 —— 站点结构改一版就换一批字段名，单认一条路早晚还会空。
  function coverOf(nc) {
    if (!nc || typeof nc !== 'object') return null;
    function pickOne(v) {
      if (!v) return null;
      if (typeof v === 'string') {
        var s = v.trim().replace(/^\/\//, 'https://');
        return /^https?:\/\//.test(s) ? { src: s, w: 0, h: 0 } : null;
      }
      if (Array.isArray(v)) return normImgs(v)[0] || null;
      if (typeof v === 'object') return normImgs([v])[0] || null;
      return null;
    }
    // 1) noteCard.cover（最常见）
    var c = pickOne(nc.cover);
    if (c) return c;
    // 2) 平级的几种别名
    c = pickOne(nc.coverUrl || nc.cover_url || nc.coverImage || nc.cover_image);
    if (c) return c;
    // 3) 视频笔记：封面可能放在 video 子对象里（和 noteCard 同级）
    var vd = nc.video || nc.videoCard || nc.video_card || null;
    if (vd && typeof vd === 'object') {
      c = pickOne(vd.cover || vd.coverUrl || vd.cover_url || vd.image || vd.firstFrame || vd.first_frame);
      if (c) return c;
    }
    // 4) 图集第一张（少数形态下才有）
    c = pickOne(nc.imageList || nc.image_list || nc.images || null);
    if (c) return c;
    return null;
  }

  // 从任意节点上取图片数组 + 互动数 + 话题，键名两套都认
  function noteParts(node) {
    if (!node || typeof node !== 'object') return null;
    var card = node.noteCard || node.note_card || node;
    var list = card.imageList || card.image_list ||
      node.imageList || node.image_list || null;
    var inf = card.interactInfo || card.interact_info || node.interactInfo || node.interact_info || {};
    var tags = (card.tagList || card.tag_list || node.tagList || node.tag_list || [])
      .map(function (t) { return t && (t.name || t.tagName); }).filter(Boolean);
    var ty = card.type || node.type || '';
    return {
      images: normImgs(list),
      tags: tags,
      likes: inf.likedCount || inf.liked_count || '',
      collects: inf.collectedCount || inf.collected_count || '',
      comments: inf.commentCount || inf.comment_count || '',
      time: (function () {
        var t = card.time || node.time || card.createTime || node.create_time || '';
        return t ? fmtTs(t) : '';
      })(),
      ip: card.ipLocation || card.ip_location || node.ipLocation || node.ip_location || '',
      type: ty === 'video' ? '视频' : (ty === 'normal' ? '图文' : '')
    };
  }

  // 从 __INITIAL_STATE__ 里取这篇笔记的完整信息（轮播只渲染当前张）
  function readStateNote(id) {
    if (!id) return null;
    var st = readInitialState();
    if (!st) return null;

    // 快路：note.noteDetailMap[id].note
    var maps = [
      st.note && st.note.noteDetailMap,
      st.note && st.note.note_detail_map,
      st.noteDetailMap,
      st.note_detail_map
    ];
    for (var mi = 0; mi < maps.length; mi++) {
      var mp = maps[mi];
      if (!mp || typeof mp !== 'object') continue;
      var hit = mp[id];
      if (hit) {
        var n0 = noteParts(hit.note || hit.noteCard || hit.note_card || hit);
        if (n0 && n0.images.length) return n0;
      }
    }

    var withImg = null, anyNote = null;
    (function walk(o, d) {
      if (!o || typeof o !== 'object' || d > 9) return;
      if (o.noteId === id || o.note_id === id || o.id === id) {
        var p = noteParts(o);
        if (p && p.images.length) { if (!withImg) withImg = p; }
        else if (!anyNote) anyNote = p || null;
      }
      for (var k in o) {
        if (Object.prototype.hasOwnProperty.call(o, k)) {
          var v = o[k];
          if (v && typeof v === 'object') walk(v, d + 1);
        }
      }
    })(st, 0);

    return withImg || anyNote || null;
  }

  function readStateImages(id) {
    var r = readStateNote(id);
    return r ? r.images : [];
  }

  function buildTokenMap() {
    // 空结果不缓存：SPA 切页时 state 是后到的，第一遍可能什么都没抓到，
    // 把空表缓存住就等于这次会话再也拿不到 token（点行只能落到 404 风控页）
    if (tokenMap && Object.keys(tokenMap).length) return tokenMap;
    tokenMap = {};
    var st = readInitialState();
    if (st) walkTokens(st, tokenMap, 0);

    // 兜底：直接在脚本文本里抓相邻出现的一对
    if (!Object.keys(tokenMap).length) {
      var ss = document.querySelectorAll('script');
      for (var i = 0; i < ss.length; i++) {
        var t = ss[i].textContent || '';
        if (t.indexOf('xsecToken') === -1) continue;
        var re = /"([0-9a-f]{24})"[^{}]{0,160}?"xsecToken"\s*:\s*"([^"]{8,})"/g, m;
        while ((m = re.exec(t))) tokenMap[m[1]] = m[2];
      }
    }
    return tokenMap;
  }

  // token 三级兜底：state 表 → 卡片里的 xsec_token 链接 → 元素上的 xsec 属性
  function tokenFor(card, id) {
    var map = buildTokenMap();
    if (id && map[id]) return map[id];
    var el = card;
    for (var i = 0; el && i < 7; i++, el = el.parentElement) {
      if (el.querySelector) {
        var a = el.querySelector('a[href*="xsec_token="]');
        if (a) {
          var mm = (a.getAttribute('href') || '').match(/xsec_token=([^&]+)/);
          if (mm) return decodeURIComponent(mm[1]);
        }
      }
      var at = el.attributes || [];
      for (var k = 0; k < at.length; k++) {
        if (/xsec/i.test(at[k].name) && at[k].value) return at[k].value;
      }
    }
    return '';
  }

  function openNote(card, data, e) {
    var m = (data.href || '').match(NOTE_PATH);
    var id = m ? m[1] : '';
    var tk = tokenFor(card, id);
    e.preventDefault();
    e.stopPropagation();
    if (!id || !tk) {
      console.warn('[fishy] 这篇笔记没找到 xsec_token，已阻止裸跳转', id);
      return false;
    }
    try {
      sessionStorage.setItem('fz-note', JSON.stringify({
        id: id, title: data.title, author: data.author, likes: data.likes,
        uid: data.uid, urls: data.urls, dims: data.dims, type: data.type
      }));
    } catch (e) {}
    openInNewTab(noteHref(id, tk));
    return true;
  }

  // ---- 交互边界（v0.96）----
  // 进详情页只认标题那一段（.fz-title）。整行、整张卡片都不绑定点击：
  //   · 一行里还有 封面图 / 图2 / 赞 / 收藏 这些按钮，整行可点时点偏一下就跳走；
  //   · 点行号是"选中整行"，跟"打开这篇笔记"本来就是两件事。
  // 没有标题的条目也照样有这段（显示「无标题」），不然那条笔记就没有入口了。
  // 单独拎成函数是因为 rebuildCells() 会整块换掉单元格，换完要重新绑一次。
  function bindRowOpen(cells, card, data) {
    var a = cells && cells.querySelector('.fz-title');
    if (!a || a.__fzOpenBound) return;
    a.__fzOpenBound = 1;
    a.addEventListener('click', function (e) {
      // 先把"顺着表往下读"的队列写好：必须在开新标签页之前，快照是那一刻拍的
      saveQueue();
      if (DEMO) {
        e.preventDefault();
        if (typeof window.__fishyDemoOpen === 'function') window.__fishyDemoOpen(data);
        return;
      }
      // 自己补上 xsec_token 再跳；拿不到 token 就不跳（避免落到 404 风控页）。
      // 追加进来的行（appendBoardRow）手里只有 token、没有 href，那就走 openNoteById。
      if (!openNote(card, data, e) && data.token) openNoteById(data);
    });
  }

  function buildRow(card, data, idx) {
    card.classList.add('fz-row');
    card.dataset.fzRow = '1';
    card.__fzData = data;      // 重画单元格要用（现场 readCard 会丢掉图片：卡片已被我们藏起来）
    stampRow(card, data);

    var cells = document.createElement('div');
    cells.className = 'fz-cells';
    cells.innerHTML = cellsHtml(data, idx);
    card.appendChild(cells);
    markKeyboard(cells);      // 行里的"图01/展开回复"等：填完 HTML 再标（<span>/<a 无 href> 天生不可聚焦）

    bindLinks(cells, data);
    cellTips(cells);          // 标题/作者被列宽截掉时，悬停看全文
    bindRowOpen(cells, card, data);
  }

  var lastAnchorCount = -1;
  function reflowFeed() {
    if (!CFG.tableMode) return;
    var an = document.querySelectorAll(NOTE_A_SEL).length;
    if (an === lastAnchorCount && document.querySelectorAll('.fz-row').length > 0) return;
    lastAnchorCount = an;
    var g = findCardGroups();
    if (!g) return;

    if (!g.parent.classList.contains('fz-rows')) {
      g.parent.classList.add('fz-rows');
      document.documentElement.classList.add('fz-table');
    }
    var n = 0;
    g.cards.forEach(function (card) {
      n++;
      if (card.dataset.fzRow === '1' && card.querySelector(':scope > .fz-cells')) return;
      var stale = card.querySelector(':scope > .fz-cells');
      if (stale) stale.remove();
      buildRow(card, readCard(card), n);
    });
  }

  // 把表格从原容器里"撑"出来：宽度铺满、左边距和上边距清零
  var fitDone = false;
  function fitTable() {
    var rows = document.querySelector('.fz-rows');
    if (!rows) return;
    var vw = document.documentElement.clientWidth;
    var rr = rows.getBoundingClientRect();
    if (rr.width >= vw * 0.92 && rr.left <= 10) { fitDone = true; return; }
    if (fitDone) return;
    var el = rows, guard = 0;

    // 先清容器自己到 body 之间的布局约束
    while (el && el !== document.body && guard < 16) {
      var cs = getComputedStyle(el);
      var disp = cs.display || '';
      if (disp.indexOf('grid') === 0 || disp.indexOf('flex') === 0 || disp === 'table') {
        el.style.setProperty('display', 'block', 'important');
      }
      el.style.setProperty('width', '100%', 'important');
      el.style.setProperty('max-width', 'none', 'important');
      el.style.setProperty('min-width', '0', 'important');
      el.style.setProperty('margin', '0', 'important');
      el.style.setProperty('padding', '0', 'important');
      el.style.setProperty('left', 'auto', 'important');
      el.style.setProperty('box-sizing', 'border-box', 'important');
      el = el.parentElement;
      guard++;
    }

    // 再验证一次：还不到 92% 宽就继续往上推
    var r = rows.getBoundingClientRect();
    if (r.width < vw * 0.92 || r.left > 10) {
      el = rows.parentElement;
      guard = 0;
      while (el && el !== document.body && guard < 14) {
        el.style.setProperty('position', 'static', 'important');
        el.style.setProperty('transform', 'none', 'important');
        el.style.setProperty('display', 'block', 'important');
        el.style.setProperty('width', '100%', 'important');
        el.style.setProperty('max-width', 'none', 'important');
        el.style.setProperty('margin', '0', 'important');
        el.style.setProperty('padding', '0', 'important');
        el = el.parentElement;
        guard++;
      }
    }
  }

  // ============ 自有看板：数据驱动，不受站点虚拟滚动影响 ============
  var board = null;
  var noteMap = new Map();

  function ensureBoard() {
    if (board && document.body.contains(board)) return board;
    board = document.createElement('div');
    board.className = 'fz-board';
    document.body.appendChild(board);
    return board;
  }

  // 容器里是否有"真正的卡片"：只算不在隐藏数据源 .fz-src 里的链接。
  // 否则顶部搜索区/导航区因为包着 .fz-src，会被误判成卡片容器而不隐藏，把表格顶下去。
  function hasRealCards(el) {
    if (!el || !el.querySelectorAll) return false;
    var as = el.querySelectorAll(NOTE_A_SEL);
    for (var i = 0; i < as.length; i++) {
      if (!(as[i].closest && as[i].closest('.fz-src'))) return true;
    }
    return false;
  }

  // 列表源容器：不能只搬卡片网格（.feeds-container），必须连「加载哨兵」一起搬。
  // 站点用 IntersectionObserver(root=viewport) 盯那个哨兵来翻页；只搬网格会把哨兵
  // 留在被 display:none 的祖先里，观察器永远不触发，表现就是"列表加载不了更多"。
  var srcHome = null;

  function sourceOf(box) {
    var p = box.parentElement;
    for (var i = 0; i < 2 && p && p !== document.body; i++) {
      if (p.querySelector('header,nav')) return box;
      if (p.querySelectorAll(NOTE_A_SEL).length !== box.querySelectorAll(NOTE_A_SEL).length) return box;
      var sent = p.querySelector('[class*="loading"],[class*="load-more"],[class*="loadmore"],[class*="sentinel"]');
      var scrollable = /(auto|scroll)/.test(getComputedStyle(p).overflowY);
      if ((sent && !box.contains(sent)) || scrollable) return p;
      p = p.parentElement;
    }
    return box;
  }

  function markSource() {
    var cur = document.querySelector('.fz-src');
    if (cur && document.body.contains(cur) && cur.querySelectorAll(NOTE_A_SEL).length) {
      document.documentElement.classList.add('fz-table');
      return cur;
    }
    var g = findCardGroups();
    if (!g) return null;
    var src = sourceOf(g.parent);
    if (!src.classList.contains('fz-src')) srcHome = { parent: src.parentNode, next: src.nextSibling };
    src.classList.add('fz-rows', 'fz-src');
    // 挪到 body 下：它自己 fixed 不占空间，但祖先（main-container 等）可以整块隐藏，
    // 不会因为"隐藏祖先"把它一起干掉，也不会在顶部留残渣
    if (src.parentNode !== document.body) {
      try { document.body.appendChild(src); } catch (e) {}
    }
    document.documentElement.classList.add('fz-table');
    return src;
  }

  // 让位给原生界面时把源列表放回原位：站点的观察器/滚动监听都绑在原来那棵 DOM 树上，
  // 不还回去，用户就算亲手滚也不会触发加载
  function unmarkSource() {
    var src = document.querySelector('.fz-src');
    if (!src) return;
    src.classList.remove('fz-src');
    src.classList.remove('fz-rows');
    if (srcHome && srcHome.parent) {
      try { srcHome.parent.insertBefore(src, srcHome.next || null); }
      catch (e) { try { srcHome.parent.appendChild(src); } catch (e2) {} }
    }
    srcHome = null;
    document.documentElement.classList.remove('fz-table');
  }

  function noteIdOf(el) {
    var m = ((el && el.getAttribute && el.getAttribute('href')) || '').match(NOTE_PATH);
    return m ? m[1] : '';
  }

  // 卡片容器 = 一直往上，直到这个祖先里出现"别的笔记"为止
  function cardOf(a) {
    var id = noteIdOf(a);
    var el = a, best = a;
    for (var i = 0; i < 6 && el.parentElement; i++) {
      el = el.parentElement;
      if (el === document.body) break;
      var anchors = el.querySelectorAll(NOTE_A_SEL);
      var same = true;
      for (var k = 0; k < anchors.length; k++) {
        if (noteIdOf(anchors[k]) !== id) { same = false; break; }
      }
      if (!same) break;
      best = el;
    }
    return best;
  }

  // 行上要带筛选用的元信息（类型 / 赞数）。两条建行路径（DOM 卡片、数据看板）都得写，
  // 漏一条就会出现"筛选时所有行都算同一类"，真机上这两条路都可能走到
  function stampRow(el, d) {
    el.dataset.fzType = (d && d.type) || '笔记';
    el.dataset.fzLike = (d && d.likes) || '';
    el.dataset.fzAuthor = (d && d.author) || '';
    // 笔记 id：存"顺着表往下读"的队列要用（有的建行路径没有 <a href>，不能靠 DOM 找）
    var mm = String((d && (d.id || d.href)) || '').match(/([0-9a-f]{24})/i);
    el.dataset.fzNid = mm ? mm[1] : '';
    // 可比的时间戳（毫秒）：首页数据里没有发布时间，只能从 id 前 8 位 hex 推
    // （noteIdMs 有 2020-09~2100 的范围校验，推不出来就不写这个属性）
    var raw = d && (d.ts || d.timeMs);
    var ms = Number(raw) || 0;
    if (ms && ms < 1e12) ms *= 1000;
    if (!ms) ms = noteIdMs(el.dataset.fzNid);
    if (ms) el.dataset.fzMs = String(ms);
    return el;
  }

  // ---------- 键盘可达 ----------
  // 伪装成表格的东西大多是 <span> 或 <a 没有 href>，Tab 根本停不上去，鼠标能用、
  // 键盘用户一个都点不到。这里统一补 tabindex，回车/空格就等价于点一下。
  var KBD_SEL = '.fz-link,[data-fz-filter],[data-fz-sort],[data-fz-sortmenu],[data-fz-sval],' +
    '[data-fz-nodata],[data-fz-menu],[data-fz-export],[data-fz-fval],[data-fz-fmenu],[data-fz-fkey],' +
    // 注意：这里只放真能操作的东西。假工具条上那十几个装饰按钮（常规 / 字体 / ▨ / ⌕ / 冻结窗格…）
    // 曾经因为一个笼统的 .fz-tb 全都进了 Tab 序列，键盘用户从头 Tab 下来，前十几站全是死路。
    // 能用的那三个各有自己的 data 属性（⇅ / ⇩ / ⋯），照样在下面这几条里。
    '.fz-mi,[data-fz-clearfilter],[data-fz-clearsort],[data-fz-clearsel],[data-fz-set],.fz-v-x,.fz-v-nav i,' +
    '.fz-zoom,.fz-pct,.fz-authbtn,.fz-ns-x';   // pct 也是按钮（点一下回 100%），别把它漏在 Tab 序列外
  function kbdHit(el) {
    if (!el || !el.matches || el === document.body) return null;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable) return null;
    return el.matches(KBD_SEL) ? el : null;
  }
  function markKeyboard(root) {
    if (!root || !root.querySelectorAll) return root;
    var list = root.matches && root.matches(KBD_SEL) ? [root] : [];
    list = list.concat([].slice.call(root.querySelectorAll(KBD_SEL)));
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (el.getAttribute('tabindex') === null) el.setAttribute('tabindex', '0');
      if (!el.getAttribute('role') && !/^A$/.test(el.tagName)) el.setAttribute('role', 'button');
    }
    return root;
  }

  function appendBoardRow(d, idx) {
    ensureBoard();
    var row = document.createElement('div');
    row.className = 'fz-row fz-brow';
    row.dataset.fzId = d.id;
    row.__fzData = d;          // 和 buildRow 一样：重画单元格时要用这份数据
    stampRow(row, d);
    row.innerHTML = '<div class="fz-cells">' + cellsHtml(d, idx) + '</div>';
    markKeyboard(row);
    bindLinks(row.firstChild, d);
    cellTips(row);
    bindRowOpen(row.firstChild, row, d);   // 和 buildRow 同一条规矩：只有标题能进详情页
    board.appendChild(row);
    return row;
  }

  function openNoteById(d) {
    // 两条建行路径都要在此刻记队列（另一条在 buildRow 的卡片点击里，同一个理由）
    saveQueue();
    if (DEMO && typeof window.__fishyDemoOpen === 'function') { window.__fishyDemoOpen(d); return; }
    if (!d.token) { toast('这篇笔记暂时打不开（链接缺 token）'); return; }
    try {
      sessionStorage.setItem('fz-note', JSON.stringify({
        id: d.id, title: d.title, author: d.author, likes: d.likes,
        uid: d.uid, urls: d.urls, dims: d.dims, type: d.type
      }));
    } catch (e) {}
    openInNewTab(noteHref(d.id, d.token));
  }

  // 点用户名 → 这个人的主页（新标签页）。没 uid 的就别给入口（DOM 兜底读出来的评论偶尔没有）。
  function openUser(uid) {
    uid = String(uid == null ? '' : uid).trim();
    if (!uid) return false;
    var url = 'https://www.xiaohongshu.com/user/profile/' + encodeURIComponent(uid);
    // 设置里选了"用表格看"：当前页跳过去，脚本会把用户页也铺成表格
    if (CFG.userTable) { location.href = url; return true; }
    openInNewTab(url);
    return true;
  }

  // 详情页统一在新标签页打开：
  // SPA 直接切会被我们自己的隐藏规则连带 display:none，原生详情量不到尺寸，
  // 评论翻页就永远滚不动；新标签页是干净的整页加载，详情渲染在 body 层，天然可滚。
  function openInNewTab(url) {
    var w = null;
    // 注意：不能传 'noopener' 特性串，那样 window.open 按规范返回 null，
    // 会误触发下面的兜底跳转，结果新标签页开了、原页面也跳了。
    try { w = window.open(url, '_blank'); } catch (e) {}
    if (w) {
      try { w.opener = null; } catch (e1) {}     // 断掉 opener，效果等同 noopener
      try { w.focus(); } catch (e2) {}
      return;
    }
    try { location.href = url; } catch (e3) {}   // 真被弹窗拦截才退回本页跳
  }

  // 看板行被站点/我们自己弄丢单元格时重建
  function repairBoard() {
    var rows = document.querySelectorAll('.fz-brow');
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.querySelector('.fz-cells')) continue;
      var d = noteMap.get(r.dataset.fzId);
      if (!d) continue;
      r.innerHTML = '<div class="fz-cells">' + cellsHtml(d, i + 1) + '</div>';
      bindLinks(r.firstChild, d);
    }
  }

  // 列表卡片 DOM 里没有标题，标题和真实类型都在页面数据的 noteCard 里
  // （瀑布流卡片的 video 元素要鼠标悬停才创建，光看 DOM 会把视频全判成图文）
  function stateFeedItems() {
    var out = [];
    try {
      var st = readInitialState();
      var fd = st && st.feed;
      if (!fd) return out;
      var arr = fd.feeds ? (fd.feeds._rawValue || fd.feeds.value || fd.feeds) : [];
      if (!arr || !arr.length) return out;
      for (var i = 0; i < arr.length && i < 400; i++) {
        var it = arr[i];
        if (!it) continue;
        var id = it.id || it.noteId || it.note_id;
        if (!id) continue;
        var nc = it.noteCard || it.note_card || {};
        var inf = nc.interactInfo || nc.interact_info || {};
        // 封面图：真机首页 noteCard 只有 cover 对象（urlDefault/urlPre/infoList 里有值，url 常为空串），
        // 没有 imageList。cover 的各种形态（对象/字符串/数组/视频封面/图集）都由 coverOf 统一兜住。
        var cov = coverOf(nc);
        var u = cov ? cov.src : '';
        var cw = cov ? (cov.w || 0) : 0;
        var ch = cov ? (cov.h || 0) : 0;
        var us = nc.user || nc.author || {};
        out.push({
          id: String(id),
          token: it.xsecToken || it.xsec_token || '',
          title: String(nc.displayTitle || nc.display_title || nc.title || '').replace(/\s+/g, ' ').trim(),
          type: (nc.type === 'video') ? '视频' : (nc.type === 'normal' ? '图文' : ''),
          likes: String(inf.likedCount || inf.liked_count || ''),
          cmts: String(inf.commentCount || inf.comment_count || ''),
          collects: String(inf.collectedCount || inf.collected_count || ''),
          author: String(us.nickname || us.nickName || us.nick_name || us.name || ''),
          desc: '',
          time: '',
          urls: u ? [u] : [],
          dims: (cw && ch) ? [cw + '×' + ch] : ['']
        });
      }
    } catch (e) {}
    return out;
  }

  // 行序按站点数据（feed.feeds）的真实顺序排，避免虚拟滚动导致先后错乱
  function orderRows(items) {
    var b = document.querySelector('.fz-board');
    if (!b) return;
    var ord = {}, i;
    for (i = 0; i < items.length; i++) ord[items[i].id] = i;
    var rows = Array.prototype.slice.call(b.querySelectorAll('.fz-brow'));
    if (rows.length < 2) return;
    var BIG = 1e6;
    var want = rows.slice().sort(function (x, y) {
      var a = ord[x.dataset.fzId], c = ord[y.dataset.fzId];
      a = (a === undefined) ? BIG : a;
      c = (c === undefined) ? BIG : c;
      return a - c;
    });
    var same = true;
    for (i = 0; i < rows.length; i++) if (rows[i] !== want[i]) { same = false; break; }
    if (same) return;
    var frag = document.createDocumentFragment();
    for (i = 0; i < want.length; i++) frag.appendChild(want[i]);
    b.insertBefore(frag, b.firstChild);
  }


  function countAnchors() { return document.querySelectorAll(NOTE_A_SEL).length; }

  // 驱动站点自己翻页。
  // 实测（2026-10-28，真实站点）：
  //  1) 站点翻页是 window scroll 驱动的，必须"一段一段慢慢滚"（320px / 400ms），一步跳到底不认；
  //  2) 拉取期间绝不能改布局（position:fixed / transform / 占位块都会让站点测不准，直接不翻页），
  //     所以改成盖一层"计算中"的遮罩挡住滚动过程。
  var pullBusy = false, lastPull = 0, pullFail = 0, nextPullAt = 0, pullStartAt = 0;

  // 拉下一页：一次点击里跑两条路，谁先拿到新数据就用谁
  //   A 源列表临时入流 + 窗口慢滚（实测最容易触发站点翻页）
  //   B 回原生页滚一遍（A 不灵时兜底）
  // 全程用 clone 遮挡 + 「正在加载…」，用户看不到原生页面。
  function pullMore(force) {
    if (pullBusy) return false;
    if (!noteMap.size) return false;
    if (document.querySelector('.fz-notesheet')) return false;
    if (!document.querySelector('.fz-src')) return false;
    if (!force && (Date.now() - lastPull < 1500 || Date.now() < nextPullAt)) return false;
    lastPull = Date.now();

    var src = document.querySelector('.fz-src');
    var se = document.scrollingElement || document.documentElement;
    var y0 = Math.round(window.scrollY || se.scrollTop || 0);
    var beforeN = noteMap.size;
    var phase = 'a', steps = 0, grewAt = 0, yielded = false;

    pullBusy = true;
    pullStartAt = Date.now();
    try { makeCover('.fz-board', '正在加载…'); } catch (e0) {}
    busyShow('正在加载下一批笔记…', '从原站翻页取数据，画面会保持不动');

    function cleanup() {
      busyHide();
      if (yielded) { yielded = false; try { resumeFromSite(); } catch (e) {} }
      try { if (src) src.classList.remove('fz-src-flow'); } catch (e) {}
      try { dropCover(); } catch (e) {}
      try { window.scrollTo(0, y0); se.scrollTop = y0; } catch (e) {}
      try { collectCards(true); repairBoard(); fillBoard(); } catch (e) {}
      try { schedule(true); } catch (e) {}
    }

    function finish() {
      if (!pullBusy) return;
      pullBusy = false;
      cleanup();
      if (noteMap.size > beforeN) {
        pullFail = 0;
        nextPullAt = 0;
        setMoreState('新加载 ' + (noteMap.size - beforeN) + ' 条', 7000);
      } else {
        pullFail++;
        nextPullAt = Date.now() + Math.min(60000, 6000 * pullFail);
        setMoreState(pullFail >= 2 ? '站点暂时没给新内容，' + Math.round((nextPullAt - Date.now()) / 1000) + 's 后可再试' : '站点没给新内容，稍后再点一次', 9000);
      }
    }

    function tick() {
      if (!pullBusy) return;
      try { stepOnce(); } catch (eT) { finish(); }
      return;

      function stepOnce() {
        steps++;
        if (collectCards(true) > 0) {
          if (!grewAt) grewAt = steps;
          busySet('正在加载下一批笔记…', '已收到 ' + (noteMap.size - beforeN) + ' 条，正在整理');
        }
        if (grewAt && steps - grewAt >= 1) { setTimeout(finish, 300); return; }

        var limit = Math.max(se.scrollHeight, document.body.scrollHeight) - innerHeight;
        var y = Math.round(se.scrollTop || window.scrollY || 0);
        var next;

        if (phase === 'a') {
          if (src && !src.classList.contains('fz-src-flow')) {
            try { src.classList.add('fz-src-flow'); } catch (e1) {}
            limit = Math.max(se.scrollHeight, document.body.scrollHeight) - innerHeight;
          }
          next = (steps === 1) ? Math.max(0, limit - innerHeight * 2)
                               : Math.min(limit, y + Math.round(innerHeight * 0.5));
          try { window.scrollTo(0, next); se.scrollTop = next; window.dispatchEvent(new Event('scroll')); } catch (e2) {}
          if (steps >= 9) {
            try { src.classList.remove('fz-src-flow'); } catch (e3) {}
            phase = 'b'; steps = 0; grewAt = 0;
            setCoverTip('正在加载…（换个方式再试）');
            busySet('正在加载下一批笔记…', '第一种方式没拿到，换成让位重滚一次');
            try { yieldToSite(true); yielded = true; } catch (e4) {}
            setTimeout(tick, 150);
            return;
          }
        } else {
          next = (steps === 1) ? Math.max(0, limit - innerHeight * 3)
                               : Math.min(limit, y + Math.round(innerHeight * 0.55));
          try { window.scrollTo(0, next); se.scrollTop = next; window.dispatchEvent(new Event('scroll')); } catch (e5) {}
          if (steps >= 12) { setTimeout(finish, 300); return; }
        }
        setTimeout(tick, 330);
      }
    }

    setTimeout(tick, 150);
    setTimeout(finish, 11000);   // 看门狗
    return true;
  }

  // 空白行铺在自有看板末尾
  // 站点重渲染会把我们插进卡片的单元格冲掉，这里做自愈重建
  // 站点的无限加载挂在它自己的滚动容器上，这里主动向所有可滚动元素派发滚动
  // 把站点已经加载到手的笔记收回表格：DOM 一屏 + 站点数据里的全量
  var lastCollectAt = 0, lastCollectNav = -1;

  function collectCards(force) {
    var nav = countAnchors();
    var now = Date.now();
    if (!force && now - lastCollectAt < 1200 && nav === lastCollectNav) return 0;
    lastCollectAt = now;
    lastCollectNav = nav;
    ensureBoard();
    var items = stateFeedItems();
    var byId = {}, s;
    for (s = 0; s < items.length; s++) byId[items[s].id] = items[s];

    var anchors = document.querySelectorAll(NOTE_A_SEL);
    var added = 0, i;

    // 1) DOM 里的卡片：作者/赞数/封面最真实，优先用；缺的字段用站点数据补
    for (i = 0; i < anchors.length && added < 120; i++) {
      var a = anchors[i];
      var href = a.getAttribute('href') || '';
      var m = href.match(NOTE_PATH);
      if (!m) continue;
      var id = m[1];
      if (noteMap.has(id)) continue;
      var card = cardOf(a);
      var d = null;
      try { d = readCard(card); } catch (e) { d = null; }
      var si = byId[id];
      if (!d) {
        if (!si) continue;
        d = si;
      } else if (si) {
        if (!d.title && si.title) d.title = si.title;
        if (si.type) d.type = si.type;
        if (!d.likes && si.likes) d.likes = si.likes;
        if ((!d.urls || !d.urls.length) && si.urls && si.urls.length) { d.urls = si.urls; d.dims = si.dims; }
        if (!d.token && si.token) d.token = si.token;
      }
      // 占位/广告卡片：没标题、没图、没作者，留着只是一行"—"
      if (!d.title && !(d.urls && d.urls.length) && (!d.author || d.author === '未知作者')) continue;
      d.id = id;
      d.href = href;
      if (!d.token) { try { d.token = tokenFor(card, id) || (si && si.token) || ''; } catch (e1) { d.token = ''; } }
      noteMap.set(id, d);
      appendBoardRow(d, noteMap.size);
      added++;
    }

    // 2) 站点数据里已经加载、但还没渲染进 DOM 的（首页是虚拟滚动，DOM 永远只有一屏）
    for (s = 0; s < items.length && added < 400; s++) {
      var it = items[s];
      if (!it || noteMap.has(it.id)) continue;
      it.href = '/explore/' + it.id;
      noteMap.set(it.id, it);
      appendBoardRow(it, noteMap.size);
      added++;
    }

    // 3) 封面补漏（v1.23，2026-11-13 修"封面图大多数时候是横杠、偶尔有"）
    //    上面两遍都带 `noteMap.has(id) → continue`：行只建一次，之后不再重读。
    //    但页面刚打开那一瞬，卡片封面图往往还没懒加载完（img.src 还是空），readCard 拿到的
    //    urls 就是空数组 —— 于是这一行被永久缓存成"没封面"，之后图片明明加载出来了也不再补，
    //    「封面图」那格就一直是横杠「—」。图片恰好在采集前加载好时才有链接，所以"偶尔有"。
    //    这里对「已存在但 urls 为空」的行补一次：先看 state，state 没有就重读 DOM 卡片
    //    （此刻图片通常已经加载好了）。补上就把那一行重画。
    for (s = 0; s < items.length; s++) {
      var pi = items[s];
      if (!pi || !pi.urls || !pi.urls.length) continue;
      var pd = noteMap.get(pi.id);
      if (pd && (!pd.urls || !pd.urls.length)) {
        pd.urls = pi.urls;
        pd.dims = pi.dims;
        patchRowCover(pd, pi.id);
      }
    }
    noteMap.forEach(function (pd2, pid2) {
      if (pd2.urls && pd2.urls.length) return;
      var a2 = document.querySelector('a[href*="/explore/' + pid2 + '"]');
      if (!a2) return;
      var d2 = null;
      try { d2 = readCard(cardOf(a2)); } catch (e3) { d2 = null; }
      if (d2 && d2.urls && d2.urls.length) {
        pd2.urls = d2.urls;
        pd2.dims = d2.dims;
        patchRowCover(pd2, pid2);
      }
    });
    if (items.length) { try { orderRows(items); } catch (e2) {} }
    return added;
  }

  // 把某一行的封面格重画（补漏时用）。行找不到、或里面本来就没数据就跳过。
  function patchRowCover(d, id) {
    var row = document.querySelector('.fz-brow[data-fz-id="' + id + '"]');
    if (!row) return false;
    var numEl = row.querySelector('.fz-num');
    var idx = parseInt(numEl ? numEl.textContent : '1', 10) || 1;
    row.__fzData = d;          // 和 appendBoardRow 一致：重画后要让行拿着最新数据
    stampRow(row, d);          // 类型/赞数/作者/时间这些筛选用元信息也顺手刷一遍
    row.innerHTML = '<div class="fz-cells">' + cellsHtml(d, idx) + '</div>';
    markKeyboard(row);
    bindLinks(row.firstChild, d);
    cellTips(row);
    bindRowOpen(row.firstChild, row, d);
    return true;
  }

  // 空白行铺在自有看板末尾
  // 把站点的「加载哨兵」搬到表格末尾：站点靠 IntersectionObserver 盯它，
  // 但它原来的容器被我们 display:none 了（display:none 的元素观察器永不触发）
  function adoptSentinel() {
    var board = document.querySelector('.fz-board');
    if (!board) return;
    var cur = document.getElementById('fz-sentinel');
    if (cur && board.contains(cur)) return;          // 已经在位
    var cands = document.querySelectorAll('[class*="loading"],[class*="sentinel"],[class*="load-more"],[class*="spinner"]');
    var pick = null;
    for (var i = 0; i < cands.length && i < 40; i++) {
      var e = cands[i];
      if (!e.parentNode) continue;
      if (e.closest && e.closest('.fz-chrome,.fz-board,.fz-notesheet')) continue;
      // 太小的（图标）和太大的（整个容器）都跳过
      var r = e.getBoundingClientRect();
      if (r.width > 0 && (r.width < 8 || r.height > 120)) continue;
      pick = e;
      break;
    }
    if (!pick) return;
    pick.__fzHome = { p: pick.parentNode, n: pick.nextSibling };
    pick.id = 'fz-sentinel';
    pick.style.setProperty('position', 'static', 'important');
    pick.style.setProperty('opacity', '0', 'important');
    pick.style.setProperty('pointer-events', 'none', 'important');
    pick.style.setProperty('display', 'block', 'important');
    pick.style.setProperty('height', '2px', 'important');
    pick.style.setProperty('overflow', 'hidden', 'important');
    var tail = board.querySelector('.fz-nfill') || board.lastElementChild;
    try { board.insertBefore(pick, tail); } catch (e2) {}
  }

  function fillBoard() {
    var b = ensureBoard();
    var f = b.querySelector('.fz-nfill');
    if (!f) {
      f = document.createElement('div');
      f.className = 'fz-nfill';
      b.appendChild(f);
    }
    if (b.lastElementChild !== f) b.appendChild(f);
    // 固定补满一屏多一点：原来按"文档高度差"算，表格一长就只剩 2 行，
    // 滚到底会露出一大片空白，看着像卡死
    var need = Math.max(14, Math.ceil((innerHeight * 1.4) / 26));
    var base = b.querySelectorAll('.fz-brow').length;
    if (f.children.length < need) {
      var html = '';
      for (var i = f.children.length; i < need; i++) {
        html += '<div class="fz-frow"><i>' + (base + i + 1) + '</i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>';
      }
      f.insertAdjacentHTML('beforeend', html);
    }
    // 补白行的行号每次都按"当前数据行数"重排。它们是先铺出来的，数据一多就跟不上了，
    // 以前页面滚不动看不见，v0.97 能滚到底之后，就会看到行号从 1 重新开始这种穿帮。
    var fr = f.children;
    for (var j = 0; j < fr.length; j++) {
      var num0 = fr[j].firstElementChild;
      var wantNum = String(base + j + 1);
      if (num0 && num0.textContent !== wantNum) num0.textContent = wantNum;
    }
  }

  // 站点重渲染会把我们插进卡片的单元格冲掉，这里做自愈重建
  function repairRows() {
    var rows = document.querySelectorAll('.fz-row');
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.querySelector(':scope > .fz-cells')) continue;
      var data;
      try { data = readCard(r); } catch (e) { data = null; }
      if (!data) continue;
      if (!data.urls) data.urls = [];
      if (!data.dims) data.dims = [];
      r.dataset.fzRow = '';
      buildRow(r, data, i + 1);
    }
  }

  // ---------- 列表底部的「换一批」 ----------
  // 就是刷新页面。站点首页每次加载都给一批新的，比"借站点的手翻页"稳：
  // 那套要跟站点的懒加载赛跑，失败了还得给用户编一堆"没反应 / 稍后再点"的说明。
  // 详情页的「加载更多评论」不走这里，那边还是老老实实按评论翻页拉。
  var moreBusy = false, moreMsg = '', moreHold = 0;
  var reloadHook = null;   // 自测用：换成计数函数，别在用例里真把页面刷走

  function paintMoreState() {
    var st = document.getElementById('fz-more-state');
    if (st) {
      var txt = (moreMsg && Date.now() < moreHold) ? moreMsg : ('已载入 ' + noteMap.size + ' 条');
      if (st.textContent !== txt) st.textContent = txt;
    }
    var b = document.getElementById('fz-more-btn');
    if (b && b.textContent !== '换一批') b.textContent = '换一批';
  }

  function setMoreState(msg, holdMs) {
    moreMsg = msg || '';
    moreHold = msg ? Date.now() + (holdMs || 15000) : 0;
    paintMoreState();
  }

  // 换一批 = 重新加载这一页。刷新前先把"正在换"写出来，哪怕只有 200 毫秒。
  function reloadBatch() {
    if (moreBusy) return;
    moreBusy = true;
    setMoreState('正在换一批…', 60000);
    toast('换一批：重新加载页面', 1200);
    setTimeout(function () {
      if (reloadHook) { try { reloadHook(); } catch (e) {} moreBusy = false; return; }
      try { location.reload(); } catch (e2) { moreBusy = false; }
    }, 220);
  }

  function ensureMoreRow() {
    if (!CFG.tableMode) return;
    var b = ensureBoard();
    var el = document.getElementById('fz-more');
    if (!el) {
      el = document.createElement('div');
      el.id = 'fz-more';
      el.className = 'fz-morerow fz-morebar';
      markKeyboard(el);
      // 只有一个动作：换一批（刷新）。以前这里是"加载更多"，要跟站点赛跑，不稳。
      el.innerHTML = '<a class="fz-link" id="fz-more-btn">换一批</a>' +
        '<span class="fz-mdim" id="fz-more-state"></span>';
      el.addEventListener('click', function (e) {
        if (!e.target.closest || !e.target.closest('#fz-more-btn')) return;
        e.preventDefault(); e.stopPropagation();
        reloadBatch();
      });
    }
    var fill = b.querySelector('.fz-nfill');
    if (fill) { if (el.parentNode !== b || el.nextElementSibling !== fill) b.insertBefore(el, fill); }
    else if (b.lastElementChild !== el) b.appendChild(el);
    paintMoreState();
  }

  // 手动翻页那套（借站点的手往下拉一屏）列表页已经不用了，留着是因为它同时被
  // 巡检的"滚动能不能带出新行"那条断言踩着，删掉得连那条一起改，收益不大。
  function finishMore(ok, n) {
    moreBusy = false;
    try { collectCards(); repairBoard(); fillBoard(); } catch (e) {}
    if (ok) {
      setMoreState('新加载 ' + n + ' 条', 8000);
      toast('已加载 ' + n + ' 条');
    } else {
      setMoreState('站点没给新内容，稍后再点一次', 10000);
    }
  }

  function loadMore(manual) {
    if (moreBusy) return;
    nextPullAt = 0;                            // 手动点就给一次机会
    moreBusy = true;
    var before = noteMap.size;
    setMoreState('正在加载…', 60000);

    // 只试一次，失败就明说。绝不再自动重试、更不"让位到原生页面"
    // （那条兜底会露出原生小红书，还把按钮锁死 20s，是最差体验）
    var ok = pullMore(true);
    if (!ok) { finishMore(false); return; }

    var waited = 0;
    var iv = setInterval(function () {
      waited += 600;
      // pullMore 自己已经收尾了（成功/失败都写好了文案），这里别再多说一句
      if (!pullBusy) { clearInterval(iv); return; }
      if (waited >= 9500) { clearInterval(iv); if (moreBusy) finishMore(false); }
    }, 600);

    // 保险：无论如何 12s 后一定要解锁按钮
    setTimeout(function () {
      if (!moreBusy) return;
      clearInterval(iv);
      finishMore(false);
    }, 12000);
  }

  // 这里原来还有一个 autoMore()：表格滚到底就静默试一次。
  // v0.77 删了，v0.97 起表尾那个入口也换成了「换一批」（刷新），不再有"自动/点一下再多拉几条"。

  // 每次同步按 DOM 顺序重排序号，避免站点插入新卡片后号码重复
  function renumberRows() {
    var rows = document.querySelectorAll('.fz-row');
    for (var i = 0; i < rows.length; i++) {
      var num = rows[i].querySelector('.fz-num');
      if (num && num.textContent !== String(i + 1)) num.textContent = i + 1;
      var hash = rows[i].querySelector('.fz-hash');
      if (hash && hash.textContent !== '#' + (i + 1)) hash.textContent = '#' + (i + 1);
    }
  }

  function buildFiller() {
    var rows = document.querySelector('.fz-rows');
    if (!rows) return;
    var filler = document.querySelector('.fz-filler');
    if (!filler) {
      filler = document.createElement('div');
      filler.className = 'fz-filler';
      rows.parentNode.insertBefore(filler, rows.nextSibling);
    }
    var base = rows.querySelectorAll('.fz-row').length;
    // 至少铺 34 行：保证页面比视口高，滚动条存在，站点的无限加载才可能触发
    var docH2 = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    var need = Math.max(2, Math.ceil((innerHeight + 160 - docH2) / 26));
    if (filler.children.length >= need) return;

    var html = '';
    for (var i = filler.children.length; i < need; i++) {
      html += '<div class="fz-frow"><i>' + (base + i + 1) + '</i><i></i><i></i><i></i><i></i><i></i></div>';
    }
    filler.insertAdjacentHTML('beforeend', html);
  }

  // ---------- 详情页：铺一层同样的表格 ----------
  var noteSheet = null;
  // 自测用：把上面两个真函数暴露出去（本地测它们的行为，真机测评论重画之后选区还在不在）
  var probeSelIdx = null;
  var probeRerenderCmts = null;
  var cmtKeys = {};
  var cmtRoots = [];
  var closedPid = '';
  var noteSheetData = null;

  // 评论行 HTML：base 是主贴行号（主贴占 1，评论从 2 开始）
  // 详情表：楼层的"骨架"要一眼看得出来（v0.93），
  //   一级评论 = 一楼，行首给「N楼」徽标；这一楼有回复的，整行左边加一条绿边 + 浅绿底，
  //   回复行（.fz-lv1/2/3）照旧缩进 + ↳，不再挂楼层徽标。
  //   以前全靠缩进，几十楼滚下来根本分不清哪一行是新楼、哪一行是楼中楼。
  // 这一楼的「展开 N 条回复 / 再加载几条 / 收起回复」，单独一行，钉在本楼最后一条回复之后（v0.95）。
  //   以前它挂在楼主那一格的内容里，于是折叠状态（只显示第一条回复）下按钮压在那条回复上面，
  //   看着像"还没点回复就已经出来了"。用户要的是：它跟着这一楼走到底。
  //
  //   这一行不是数据行：不带 `.fz-nrow`，所以行号映射、键盘选区、CSV 导出、自动调宽
  //   （`scopeRows()` 只认 .fz-row/.fz-nrow）全都不会把它算进去，少写一个 class 比到处加排除条件稳。
  function floorToggleHtml(c, total) {
    var kn = parseInt(total, 10) || 0;
    if (!c || kn < 2) return '';
    return '<div class="fz-trow" data-haskid="1">' +
      '<div class="fz-cells"><div class="fz-c fz-tg">' +
        '<a class="fz-link fz-toggle" data-k="' + (c.rootKey || 0) +
          '" data-idx="' + (c.cIdx || 0) + '" data-more="' + (c.subHasMore ? '1' : '0') +
          '" data-total="' + kn +
          '" data-open="展开 ' + kn + ' 条回复" data-close="收起回复">展开 ' + kn + ' 条回复</a>' +
      '</div></div></div>';
  }

  function cmtRowsHtml(list, base) {
    var n = base || 1, out = '';
    // 「楼主」认人要用笔记作者的名字 / uid（昵称可能改过，所以两个都比）。
    // noteSheetData 是当前这张详情表的主贴数据，没有就退化成"认不出来"。
    var opName = '', opUid = '';
    try {
      opName = String((noteSheetData && noteSheetData.author) || '');
      opUid = String((noteSheetData && noteSheetData.uid) || '');
    } catch (eOp) {}
    // 先数一遍：每一楼后面跟了几条回复（决定要不要打"有回复"的标记）
    var kidOf = [], cur = -1, q;
    for (q = 0; q < list.length; q++) {
      if (!list[q].depth) { cur++; kidOf[cur] = 0; }
      else if (cur >= 0) kidOf[cur]++;
    }
    var floor = 0, pend = null;   // pend：当前这一楼还没收尾（等它最后一条回复之后的按钮行）
    function closeFloor() {
      if (!pend) return;
      out += floorToggleHtml(pend.c, pend.total);
      pend = null;
    }
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      var isRoot = !c.depth;
      if (isRoot) { closeFloor(); floor++; }   // 换楼 = 上一楼到底了，先把它的按钮补上
      n++;
      var kids = isRoot ? (kidOf[floor - 1] || 0) : 0;
      var total = isRoot ? (c.subTotal || (c.kids || []).length) : 0;
      // 「楼主」：名字或 uid 对得上笔记作者就是他自己。两个都试，昵称改过也能认出来
      var isOp = !!(c.isOp || (opName && c.author === opName) || (opUid && c.uid && c.uid === opUid));
      var attrs = (c.depth
        ? ' data-parent="' + (c.rootKey || 0) + '"'
        : ' data-root="' + (c.rootKey || 0) + '"') +
        (isRoot ? ' data-floor="' + floor + '"' : '') +
        ' data-fz-like="' + esc(c.likes || '') + '"' +
        ' data-fz-author="' + esc(c.author || '') + '"' +
        (function () { var ms = c.ms || timeTextMs(c.time); return ms ? ' data-fz-ms="' + ms + '"' : ''; })();
      var cls = 'fz-nrow' + (c.depth ? ' fz-lv' + Math.min(c.depth, 3)
        : (kids ? ' fz-haskid' : ' fz-floor')) +
        (CFG.opMark && isOp ? ' fz-oprow' : '');
      if (isOp && !c.isOp) c.isOp = true;      // 给 cellsHtml 用（它只认 data.isOp）
      out += '<div class="' + cls + '"' + attrs +
        '><div class="fz-cells">' + cellsHtml(c, n, 'comment', total, isRoot ? floor : 0, kids) +
        '</div></div>';
      if (isRoot) pend = { c: c, total: total };
    }
    closeFloor();   // 最后一楼
    return out;
  }

  // 一次性点掉页面上所有"展开 N 条回复"（精确点一条经常点不动，索性全点）
  function expandAllOnSite() {
    var hit = 0;
    var host = document.querySelector('#noteContainer') || document;
    var all = host.querySelectorAll('span,div,a,button');
    for (var i = 0; i < all.length && i < 4000; i++) {
      var el = all[i];
      if (el.children && el.children.length > 2) continue;   // 允许里面套一层 span
      var t = (el.textContent || '').replace(/\s+/g, '');
      if (t.length > 14 || !/展开.{0,4}回复|查看更多回复|更多回复/.test(t)) continue;
      // 我们的表格里的按钮不算
      if (el.closest && el.closest('.fz-notesheet,.fz-chrome,.fz-board')) continue;
      try {
        // 小红书的"展开"按钮常常是 hover 才挂上事件的，先给整条评论派发进入事件
        var host0 = el.closest('[class*="comment-item"]') || el.parentElement;
        if (host0) {
          ['pointerover', 'mouseover', 'mouseenter', 'mousemove'].forEach(function (ty) {
            try {
              host0.dispatchEvent(new MouseEvent(ty, { bubbles: true, cancelable: true, view: window }));
            } catch (e0) {}
          });
        }
        ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (ty) {
          var ev;
          if (ty.indexOf('pointer') === 0 && typeof PointerEvent === 'function') {
            ev = new PointerEvent(ty, { bubbles: true, cancelable: true, view: window, button: 0 });
          } else {
            ev = new MouseEvent(ty, { bubbles: true, cancelable: true, view: window, button: 0 });
          }
          el.dispatchEvent(ev);
        });
      } catch (e) {}
      try { el.click(); } catch (e2) {}
      hit++;
    }
    return hit;
  }

  // 点小红书自己的"展开 N 条回复"，把剩下的回复拉进 state
  function expandOnSite(idx) {
    var items = document.querySelectorAll('[class*="comment-item"]');
    var roots = [], i;
    for (i = 0; i < items.length; i++) {
      var it = items[i];
      var cls = String(it.className || '');
      if (/(comment-item-sub|sub-comment|reply-item)/i.test(cls)) continue;   // 楼中楼子评论
      var p = it.parentElement && it.parentElement.closest
        ? it.parentElement.closest('[class*="comment-item"]') : null;
      if (p && p !== it) continue;
      roots.push(it);
    }
    if (!roots.length) return false;
    if (idx >= roots.length) idx = roots.length - 1;
    var host = roots[idx];
    if (!host) return false;
    var cands = host.querySelectorAll('span,div,a');
    var best = null, bestLen = 1e9;
    for (var k = 0; k < cands.length; k++) {
      var txt = (cands[k].textContent || '').replace(/\s+/g, '');
      if (!(/展开.{0,3}条回复|展开更多回复|查看更多回复/.test(txt) && txt.length < 16)) continue;
      // 取最内层（同长度时后者更深），否则会点到外层容器、点不动
      if (txt.length <= bestLen) { best = cands[k]; bestLen = txt.length; }
    }
    if (best) {
      try { best.click(); } catch (e) {}
      return true;
    }
    return false;
  }

  // ===== 表格队列：顺着表往下读（v0.55）=====
  // 摸鱼时的真实动作是"看完这篇看下一篇"，可点行是开新标签页，看完得回来再找下一行，
  // 所以点行那一刻把"这一眼看到的可见顺序"（筛过、排过的顺序）存进 sessionStorage，
  // 笔记页就能给「上一篇 / 下一篇」。
  // 用 sessionStorage 而不是 localStorage：点行走的是 window.open('_blank')（没带 noopener），
  // 新标签页会继承一份副本，队列跟着过去；而且它不落盘，关了标签就没了（和"条件不写盘"一致）。
  var QUEUE_KEY = 'fz-queue';
  var QUEUE_CAP = 80;

  // 点行时调用（必须在 window.open 之前，副本是开标签那一刻拍的）
  function saveQueue() {
    try {
      var rows = document.querySelectorAll('.fz-board .fz-row:not(.fz-hide)');
      if (!rows.length) rows = document.querySelectorAll('.fz-row:not(.fz-hide)');
      var out = [], seen = {};
      for (var i = 0; i < rows.length && out.length < QUEUE_CAP; i++) {
        var id = rows[i].dataset ? (rows[i].dataset.fzNid || '') : '';
        if (!id || seen[id]) continue;
        var tk = tokenFor(rows[i], id);
        if (!tk) continue;              // 没 token 的话跳过去也是 404 风控页，不进队列
        seen[id] = 1;
        out.push([id, tk]);
      }
      if (!out.length) return 0;
      sessionStorage.setItem(QUEUE_KEY, JSON.stringify(out));
      return out.length;
    } catch (e) { return 0; }
  }

  function readQueue() {
    try {
      var v = JSON.parse(sessionStorage.getItem(QUEUE_KEY) || '[]');
      return Object.prototype.toString.call(v) === '[object Array]' ? v : [];
    } catch (e) { return []; }
  }

  // 当前这篇在队列里的位置；不在队列里就返回 null（导航条不出现，这也顺带挡住了
  // "翻历史记录进来"的情况：那会儿队列要么没有、要么是上一次的，本页 id 多半不在里面）
  function queueNav() {
    var pid = (location.pathname.match(NOTE_PATH) || [])[1] || '';
    if (!pid) return null;
    var q = readQueue();
    for (var i = 0; i < q.length; i++) {
      if (q[i] && q[i][0] === pid) {
        return { i: i, n: q.length, prev: q[i - 1] || null, next: q[i + 1] || null };
      }
    }
    return null;
  }

  // 目标网址单独拿出来：测试里能验"下一篇到底指向谁"，又不会真的把测试页跳走
  function queueHref(which) {
    var nav = queueNav();
    var item = nav && nav[which];
    return item ? noteHref(item[0], item[1]) : '';
  }

  function gotoQueue(which) {
    var u = queueHref(which);
    if (!u) return false;
    location.href = u;
    return true;
  }

  function openNoteSheet(data) {
    removeSheet();
    var el = document.createElement('div');
    el.className = 'fz-notesheet';
    try {
      var pid0 = (location.pathname.match(NOTE_PATH) || [])[1] || '';
      if (pid0 && !cmtStore[pid0] && data.comments && data.comments.length) cmtStore[pid0] = data.comments.slice();
    } catch (eSeed) {}

    // 「顺着表往下读」：只有"这篇是从表里点进来的"才出现（队列里有它）
    var qn = queueNav();
    var qbar = '';
    if (qn) {
      qbar = '<span class="fz-qnav">' +
        (qn.prev ? '<a class="fz-link" data-fz-qnav="prev" title="上一篇（Alt+↑）">‹ 上一篇</a>'
                 : '<span class="fz-qdim">‹ 到头了</span>') +
        (qn.next ? '<a class="fz-link" data-fz-qnav="next" title="下一篇（Alt+↓）">下一篇 ›</a>'
                 : '<span class="fz-qdim">已是最后一篇</span>') +
        '<span class="fz-qdim">第 ' + (qn.i + 1) + '/' + qn.n + ' 篇（按表格顺序）</span>' +
        '</span>';
    }
    data.isOp = true;          // 主贴就是楼主自己
    var html = '<div class="fz-ns-bar">' +
      // 从列表点进来的，这里得有一条明确的路回去；不靠"关掉"再点浏览器返回
      '<span class="fz-ns-back" data-fz-back="1" role="button" tabindex="0"' +
        ' title="回到列表（表格）">← 返回列表</span>' +
      '<span>笔记详情 · ' + esc(data.author || '') + '</span>' +
      '<span id="fz-ns-stat" class="fz-ns-dim"></span>' +
      '<span class="fz-ns-tags">' +
        (data.tags || []).slice(0, 6).map(function (t) { return '#' + esc(t); }).join(' ') +
      '</span>' +
      qbar +
      '<span class="fz-sp"></span>' +
      // Esc 不再关任何东西（v0.96），所以这里必须留一个看得见的出口
      '<span class="fz-ns-x" role="button" tabindex="0"' +
        ' title="关掉详情表，回到原生页面">✕ 关闭</span>' +
      '</div>' +
      // 每个属性单独拼：别把新属性插进上一个属性的引号里（v0.56 就是这么写坏过一次，
      // 结果主贴行的 data-fz-like 变成了「1.2万 data-fz-ms=」，作者属性也跟着被吃掉）
      '<div class="fz-nrow fz-main"' +
        ' data-fz-like="' + esc(data.likes || '') + '"' +
        (function () {
          var ms = noteIdMs(data.id || data.noteId || pid0) || timeTextMs(data.time);
          return ms ? ' data-fz-ms="' + ms + '"' : '';
        })() +
        ' data-fz-author="' + esc(data.author || '') + '"' +
        '><div class="fz-cells">' + cellsHtml(data, 1, 'main') + '</div></div>';

    var roots = (data.comments || []).filter(function (c) { return !c.depth; });
    var flat = data.comments || [];
    cmtRoots = roots;
    var roots1 = 0;
    for (var q1 = 0; q1 < flat.length; q1++) if (!flat[q1].depth) roots1++;
    var totalC1 = String((data.stats && data.stats.comments) || '');
    // 一条都没载入时别写"加载更多"（还没有"更多"）：直接叫"加载评论"，并说清要手动点
    var moreLabel1 = roots1 ? '加载更多评论' : '加载评论';
    var moreHint1 = roots1 ? '' : '（评论区还没初始化，点左边的链接拉第一批）';
    var rep1 = Math.max(0, flat.length - roots1);
    html += '<div class="fz-cmts">' + cmtRowsHtml(flat, 1) +
      '<div class="fz-morerow">' +
        '<a class="fz-link" data-cmore="1">' + moreLabel1 + '</a>' +
        // 「已展示」由 updateNsStat 统一刷（标题栏和这里必须是同一个数）
        '<span class="fz-mdim fz-cnote">共 ' + totalC1 + ' 条评论 · 已展示 ' +
          cmtLoadedText(cmtCountsOf(flat)) + '</span>' +
        // 加载诊断单独一格：以前它写进"第一个 .fz-mdim"，正好把上面那句"已展示"顶掉
        '<span class="fz-mdim fz-cdiag"></span>' +
        (moreHint1 ? '<span class="fz-mdim">' + moreHint1 + '</span>' : '') +
      '</div>' +
      '</div><div class="fz-nfill"></div>';

    el.innerHTML = html;
    markKeyboard(el);          // 详情表里的"图01 / 展开回复 / 加载更多评论"也要能 Tab 到
    cellTips(el);              // 评论正文/作者也一样：截住了就悬停看全文
    noteSheetData = data;
    document.body.appendChild(el);
    applyView();               // fz-hassheet：页面本身不滚，只留详情表这条

    // 折叠状态：rootKey -> 是否展开（默认只显示第一条回复，和站点一致）
    var expanded = {};
    function applyFold() {
      var cbox = el.querySelector('.fz-cmts');
      if (!cbox) return;
      var groups = {}, i;
      var rows = cbox.querySelectorAll('[data-parent]');
      for (i = 0; i < rows.length; i++) {
        var k = rows[i].getAttribute('data-parent');
        (groups[k] = groups[k] || []).push(rows[i]);
      }
      for (var g in groups) {
        var list = groups[g], open = !!expanded[g];
        for (var j = 0; j < list.length; j++) {
          list[j].style.display = (open || j === 0) ? '' : 'none';
        }
      }
      // 按钮文案跟着状态走
      var tgs = cbox.querySelectorAll('.fz-toggle');
      for (i = 0; i < tgs.length; i++) {
        var key = tgs[i].dataset.k;
        var total = parseInt(tgs[i].dataset.total, 10) || 0;
        var loaded = (groups[key] || []).length;
        if (!expanded[key]) {
          tgs[i].textContent = tgs[i].dataset.open || ('展开 ' + total + ' 条回复');
          tgs[i].dataset.mode = 'open';
        } else if (total && loaded < total) {
          // 站点分页加载，一次只给几条，再给一个"继续加载"的入口
          tgs[i].textContent = '再加载几条（已 ' + loaded + '/' + (tgs[i].dataset.total) + '）';
          tgs[i].dataset.mode = 'more';
        } else {
          tgs[i].textContent = tgs[i].dataset.close || '收起回复';
          tgs[i].dataset.mode = 'close';
        }
        tgs[i].dataset.expanded = expanded[key] ? '1' : '0';
      }
    }

    // 「加载更多评论」：走统一的评论翻页驱动
    function bindCmore(cbox) {
      var b = cbox.querySelector('[data-cmore]');
      if (!b || b.__fzBound) return;
      b.__fzBound = 1;
      b.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        doLoadCmts(b);
      });
    }

    // 重画评论区（保留展开状态）
    var lastCmtList = null;
    function renderCmt(cs) {
      if (!cs || !cs.length) return;
      lastCmtList = cs;
      var cbox = el.querySelector('.fz-cmts');
      if (!cbox) return;
      var roots0 = 0;
      for (var q0 = 0; q0 < cs.length; q0++) if (!cs[q0].depth) roots0++;
      var totalC = String((data.stats && data.stats.comments) || '');
      var keepSel = selIdxIn(cbox);       // 重画会把行整批换掉，先把选中的行号记下来
      var keepKeys = selKeysIn(cbox);     // 连同"是哪几条评论"一起记（评论一增一减时行号会指错）
      var rep0 = Math.max(0, cs.length - roots0);
      cbox.innerHTML = cmtRowsHtml(cs, 1) +
        '<div class="fz-morerow">' +
          '<a class="fz-link" data-cmore="1">加载更多评论</a>' +
          '<span class="fz-mdim fz-cnote">共 ' + totalC + ' 条评论 · 已展示 ' +
            cmtLoadedText(cmtCountsOf(cs)) + '</span>' +
          '<span class="fz-mdim fz-cdiag"></span>' +
        '</div>';
      markKeyboard(cbox);      // 评论重画之后也要能 Tab 到
      cellTips(cbox);
      bindCmore(cbox);
      var rowEls2 = cbox.querySelectorAll('.fz-nrow');
      for (var q = 0; q < cs.length && q < rowEls2.length; q++) rowEls2[q].__fz = cs[q];
      applyFold();
      updateNsStat(el, data);
      fillSheet(el);
      if (keepSel.length) selIdxBack(cbox, keepSel, keepKeys);   // 重建之后照原位（同一条评论）选回来
    }
    // 自测用：真的走一遍重画（不另写一份"假的"重画，否则测不到接线）
    probeRerenderCmts = function () {
      if (!lastCmtList || !el.isConnected) return false;
      renderCmt(lastCmtList);
      return true;
    };
    var cbox0 = el.querySelector('.fz-cmts');
    if (cbox0) bindCmore(cbox0);
    el.__fzApplyFold = applyFold;
    el.__fzRenderCmt = renderCmt;
    applyFold();

    // 视频类笔记进来时原生评论区常常还没初始化（表格里"已载入 0 条"）。
    // v0.77 起不再自动唤醒：进来就偷偷去滚原生页面，用户只看到表格自己变长。
    // 现在只在表尾写一句"点左边拉第一批"，要不要拉由人决定。

    // 逐行绑定各自的数据（之前整表都用了主贴数据，评论里的图全指向主贴图）
    var rowEls = el.querySelectorAll('.fz-nrow');
    if (rowEls[0]) rowEls[0].__fz = data;
    for (var ri = 0; ri < flat.length && ri + 1 < rowEls.length; ri++) {
      rowEls[ri + 1].__fz = flat[ri];
    }

    el.addEventListener('click', function (ev2) {
      var a = ev2.target.closest && ev2.target.closest('.fz-link');
      if (!a || a.dataset.i === undefined) return;
      var row = a.closest('.fz-nrow');
      var d = row && row.__fz;
      if (!d || !d.urls || !d.urls.length) return;
      ev2.preventDefault();
      ev2.stopPropagation();
      var i2 = parseInt(a.dataset.i, 10) || 0;
      var cov2 = a.getAttribute('data-cov') === '1';
      var nT = d.urls.length;
      openImage(a, d.urls[i2],
        imgLinkLabel(i2, nT, cov2) + (d.dims && d.dims[i2] ? ' · ' + d.dims[i2] : ''),
        cleanSrc(d.urls[i2]), galleryOf(d.urls, d.dims, cov2), i2);
    });

    el.addEventListener('click', function (e) {
      var t = e.target;
      if (!t.closest) return;

      var tg = t.closest('.fz-toggle');
      if (tg) {
        e.preventDefault(); e.stopPropagation();
        var k = tg.dataset.k;
        var mode = tg.dataset.mode || (expanded[k] ? 'close' : 'open');
        if (mode === 'close') {
          delete expanded[k];
          applyFold();
          return;
        }
        expanded[k] = 1;
        applyFold();
        // 站点的回复还没取全 → 去点它自己的"展开 N 条回复"，拉回来再重画
        if (tg.dataset.more === '1') {
          var idx = parseInt(tg.dataset.idx, 10) || 0;
          var pid2 = (location.pathname.match(NOTE_PATH) || [])[1] || '';
          tg.textContent = '加载回复中…';
          var anyHit = false;
          try { anyHit = expandAllOnSite() > 0; } catch (e) {}
          if (!anyHit) { try { anyHit = expandOnSite(idx); } catch (e2) {} }
          if (anyHit) {
            var reread = function (n) {
              if (noteSheet !== el) return;
              var fresh = [];
              try { fresh = readComments(pid2) || []; } catch (e) {}
              var got = 0;
              for (var q = 0; q < fresh.length; q++) if (+fresh[q].rootKey === idx && fresh[q].depth) got++;
              if (fresh.length) renderCmt(fresh);
              else applyFold();
              // 还是不够就再点一次站点的按钮、再等一轮（有的实现第一下只是加载外壳）
              if (n > 0 && got <= 1) {
                setTimeout(function () {
                  try { expandOnSite(idx); } catch (e) {}
                  reread(n - 1);
                }, 1600);
              }
            };
            setTimeout(function () { reread(2); }, 1200);
          } else {
            applyFold();
          }
        }
        return;
      }

      var cm = t.closest('[data-cmore]');
      if (cm) {
        e.preventDefault(); e.stopPropagation();
        doLoadCmts(cm);
        return;
      }

      var vp = t.closest('.fz-vplay');
      if (vp) {
        e.preventDefault(); e.stopPropagation();
        playMainVideo();
        return;
      }

      var act = t.closest('.fz-act');
      if (act) {
        e.preventDefault(); e.stopPropagation();
        siteAction(act.dataset.act, parseInt(act.dataset.row, 10) || 1, el);
        return;
      }

      var op = t.closest('[data-act="open"]');
      if (op) {
        e.preventDefault(); e.stopPropagation();
        var d0 = noteSheetData || {};
        var u = noteHref(d0.id, d0.token);
        window.open(u, '_blank');
        return;
      }

      var fl = t.closest('.fz-full');
      if (fl) {
        e.preventDefault(); e.stopPropagation();
        var cell = fl.closest('.fz-e');
        var es = cell && cell.querySelector('.fz-es');
        if (es) es.textContent = fl.dataset.full || '';
        if (fl.parentNode) fl.parentNode.removeChild(fl);
      }
    });

    noteSheet = el;
    try { retryMainImages(el, data, (location.pathname.match(NOTE_PATH) || [])[1] || ''); } catch (e6) {}
    updateNsStat(el, data);
    fillSheet(el);
    setTimeout(function () { if (noteSheet === el) fillSheet(el); }, 80);

    // 评论异步加载：多次尝试，整块重画（含层级），不做增量去重
    var lastSig = '';
    function sigOf(cs) {
      var s = '';
      for (var i = 0; i < cs.length; i++) s += (cs[i].depth || 0) + (cs[i].author || '') + '|' + (cs[i].desc || '').slice(0, 12) + ';';
      return cs.length + '#' + s.length + '#' + s.slice(0, 200);
    }

    [900, 1800, 3000, 4600, 6800, 9600, 13000].forEach(function (delay) {
      setTimeout(function () {
        if (noteSheet !== el) return;

        try { refreshMainMeta(el, data, (location.pathname.match(NOTE_PATH) || [])[1] || ''); } catch (e9) {}

        // 弹层晚加载时，标题/正文/时间可能一开始是空的，补一次
        if (!data.desc || !data.time || !data.title) {
          try {
            var d2 = readNotePage();
            if (d2) {
              var dirty = false;
              if (!data.desc && d2.desc && saneText(d2.desc)) { data.desc = d2.desc; dirty = true; }
              if (!data.time && d2.time) { data.time = d2.time; dirty = true; }
              if (!data.title && d2.title) { data.title = d2.title; dirty = true; }
              if (!data.author && d2.author) { data.author = d2.author; }
              if (dirty) {
                var mr0 = el.querySelector('.fz-nrow');
                var cl0 = mr0 && mr0.querySelector('.fz-cells');
                if (cl0) cl0.innerHTML = cellsHtml(data, 1, 'main');
              }
            }
          } catch (e5) {}
        }

        var cs = [];
        try { cs = readComments() || []; } catch (e2) { cs = []; }
        if (!cs.length) { try { pullComments(); } catch (e3) {} return; }

        var sig = sigOf(cs);
        if (sig === lastSig) return;
        lastSig = sig;

        renderCmt(cs);   // 整块重画，保留用户已经展开的那几条
      }, delay);
    });
  }

  // 用空白行把详情页铺满
  // 最后一招：点"下一张"把轮播翻一遍，把每张的地址都收下来
  function walkCarousel(scope, cb) {
    var box = detailScope();
    if (!box) return cb([]);
    var btns = box.querySelectorAll('button,div,span,a');
    var nextBtn = null;
    for (var i = 0; i < btns.length && i < 400; i++) {
      var b = btns[i];
      var cls = b.className && b.className.toString ? b.className.toString() : '';
      if (b.closest('[class*="comment"]')) continue;
      var t = (b.getAttribute('aria-label') || '') + ' ' + cls + ' ' + (b.textContent || '').slice(0, 4);
      if (/下一张|下一个|next|arrow-right|arrowRight|swiper-button-next|slider-next/i.test(t)) {
        nextBtn = b; break;
      }
    }
    if (!nextBtn) return cb([]);

    var seen = {}, out = [];
    function grab() {
      var ims = box.querySelectorAll('img');
      for (var k = 0; k < ims.length; k++) {
        var im = ims[k];
        if (im.closest('[class*="comment"]')) continue;
        if (isAvatarImg(im)) continue;
        var r = im.getBoundingClientRect();
        var u = origSrc(im);
        if (!u || seen[u]) continue;
        var big = (r.width >= 120 && r.height >= 120) || (im.naturalWidth || 0) >= 300;
        if (!big) continue;
        seen[u] = 1;
        out.push({ src: u, w: Math.round(r.width), h: Math.round(r.height) });
      }
    }
    grab();
    var steps = 0;
    var timer = setInterval(function () {
      try { nextBtn.click(); } catch (e) {}
      setTimeout(grab, 240);
      if (++steps >= 8) {
        clearInterval(timer);
        setTimeout(function () { cb(out); }, 280);
      }
    }, 420);
  }

  function fillSheet(el) {
    var box = el.querySelector('.fz-nfill');
    if (!box) return;
    var guard = 0;
    while (el.scrollHeight < el.clientHeight + 4 && guard < 40) {
      box.insertAdjacentHTML('beforeend',
        '<div class="fz-frow"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>');
      guard++;
    }
  }

  // 详情页主容器（弹层里那块），不依赖可见性
  function detailScope() {
    var r = noteRoot();
    if (r) return r;
    var t = document.querySelector('#detail-title');
    var box = t && t.closest
      ? t.closest('[class*="note"],[class*="modal"],[class*="container"],[class*="detail"]') : null;
    if (box) return box;
    var sels = ['#noteContainer', '[class*="note-container"]', '[class*="noteContainer"]',
      '[class*="note-detail"]', '[class*="noteDetail"]', '[class*="detail-container"]',
      '[class*="slider"]', '[class*="swiper"]'];
    for (var i = 0; i < sels.length; i++) {
      var e = document.querySelector(sels[i]);
      if (e) return e;
    }
    return null;
  }

  // 主贴图：只在媒体容器（轮播/播放器）里找，推荐位和评论一律不碰
  function mediaRoots() {
    var out = [];
    var sels = ['.media-container', '.swiper', '[class*="slider"]', '[class*="carousel"]',
      '[class*="media-container"]', '[class*="note-slide"]'];
    for (var i = 0; i < sels.length; i++) {
      var es = document.querySelectorAll(sels[i]);
      for (var j = 0; j < es.length && j < 6; j++) {
        var e = es[j];
        if (e.closest && e.closest('[class*="comment"]')) continue;
        if (e.closest && e.closest('.fz-notesheet')) continue;
        if (out.indexOf(e) === -1) out.push(e);
      }
    }
    return out;
  }

  // 主贴图：只认大图，跳过头像、表情、评论里的图
  function mediaImgs() {
    var roots = mediaRoots();
    var scope = roots.length ? null : (detailScope() || document);
    var all = [], i;
    if (roots.length) {
      roots.forEach(function (r) {
        var ims = r.querySelectorAll('img');
        for (var k = 0; k < ims.length; k++) all.push(ims[k]);
      });
    } else {
      all = Array.prototype.slice.call(scope.querySelectorAll('img'));
    }
    var out = [];
    for (i = 0; i < all.length; i++) {
      var im = all[i];
      if (im.closest('.fz-notesheet,.fz-chrome,.fz-viewer')) continue;
      if (im.closest('[class*="comment"]')) continue;
      if (im.closest('a[href*="/user/"]')) continue;
      if (isAvatarImg(im)) continue;
      var u = origSrc(im);
      if (!u) continue;
      var r = im.getBoundingClientRect();
      var w = Math.round(r.width) || im.naturalWidth || 0;
      var h = Math.round(r.height) || im.naturalHeight || 0;
      var nw = im.naturalWidth || 0;
      // 显示尺寸够大，或原始图本身够大（轮播里非当前张可能被缩成 0）
      if (!(w >= 120 && h >= 120) && !(nw >= 300)) continue;
      if (/emoji|avatar|sns-avatar/i.test(u)) continue;
      if (out.some(function (o) { return o.src === u; })) continue;
      out.push({ src: u, w: w, h: h });
    }
    return out;
  }

  // 主贴图片一开始可能没渲染出来，延迟补几次
  function retryMainImages(el, data, pid) {
    if (!data.diag) data.diag = { api: 0, state: 0, dom: 0 };
    var tries = [1200, 2600, 4200, 6500];
    tries.forEach(function (d) {
      setTimeout(function () {
        if (noteSheet !== el) return;
        if (data.imgLocked) return;   // 已经是 state/接口的权威数据，别用页面图覆盖
        var cur = (data.urls && data.urls.length) || 0;
        if (cur >= 2) return;   // 已经拿到多张，不用再补
        var imgs = [], src = '';

        try {
          var an = apiNote(pid);
          if (an && an.images && an.images.length) { imgs = an.images; src = 'api'; data.diag.api = an.images.length; }
        } catch (e0) {}

        if (!imgs.length) {
          try {
            var st = readStateNote(pid);
            data.diag.state = (st && st.images.length) || 0;
            if (st && st.images.length) { imgs = st.images; src = 'state'; }
          } catch (e) {}
        }

        if (!imgs.length) {
          try {
            imgs = mediaImgs();
            data.diag.dom = imgs.length;
            if (imgs.length) src = 'dom';
          } catch (e2) {}
        }

        if (!imgs.length) {
          updateNsStat(el, data);
          if (!data._walked) {
            data._walked = 1;
            walkCarousel(null, function (got) {
              if (!got || !got.length || noteSheet !== el) return;
              data.urls = got.map(function (o) { return o.src; });
              data.dims = got.map(function (o) { return (o.w && o.h) ? o.w + '×' + o.h : ''; });
              data.imgSrc = 'carousel';
              updateNsStat(el, data);
              paintMain(el, data);
            });
          }
          return;
        }
        if (imgs.length <= cur) return;   // 没变多就别动现有结果
        data.urls = imgs.map(function (o) { return o.src; });
        data.dims = imgs.map(function (o) { return (o.w && o.h) ? o.w + '×' + o.h : ''; });
        data.imgSrc = src;
        updateNsStat(el, data);
        paintMain(el, data);
      }, d);
    });
  }

  // 把主贴行的图片链接重画（数据后到时用）
  function paintMain(el, data) {
    var mainRow = el.querySelector('.fz-nrow');
    if (!mainRow) return;
    var cell = mainRow.querySelector('.fz-e');
    var slot = cell && cell.querySelector('.fz-el');
    if (slot) slot.innerHTML = imgLinks(data, true);
    mainRow.__fz = data;
  }

  // 互动区/视频播放器比正文晚挂载，隔一会儿补一次；补到就重画主贴行
  function refreshMainMeta(el, data, pid) {
    var before = [data.likes, data.collects, data.time, data.type, (data.desc || '').length].join('|');
    try {
      var st = apiNote(pid) || readStateNote(pid);
      if (st) {
        if (st.likes && !data.likes) data.likes = st.likes;
        if (st.collects && !data.collects) data.collects = st.collects;
        if (st.type) data.type = st.type;
        if (!data.stats || !data.stats.likes) {
          data.stats = { likes: st.likes || '', collects: st.collects || '', comments: st.comments || '' };
        }
      }
    } catch (e1) {}
    if (!data.likes || data.type === '图文') {
      try {
        var d = readNotePage();
        if (d) {
          if (d.likes && !data.likes) data.likes = d.likes;
          if (d.collects && !data.collects) data.collects = d.collects;
          if (d.type) data.type = d.type;
          if (d.time && !data.time) data.time = d.time;
          if (!data.desc && d.desc) data.desc = d.desc;
        }
      } catch (e2) {}
    }
    var after = [data.likes, data.collects, data.time, data.type, (data.desc || '').length].join('|');
    if (after === before) return;
    var mr = el.querySelector('.fz-nrow');
    var cl = mr && mr.querySelector('.fz-cells');
    if (cl) {
      cl.innerHTML = cellsHtml(data, 1, 'main');
      mr.__fz = data;
    }
    updateNsStat(el, data);
  }

  // 评论区现在到底"已展示"多少：一级评论几条、回复几条、各楼还挂着多少条没展开、合计。
  //
  // v0.82 定的口径是"一级评论 + 已载入的回复"（合计），标题栏和表尾必须是同一个数，
  // 不然一个报 14（只数一级评论）、一个报 21（连回复），用户只会觉得算错了。
  //
  // v0.86 用户又指出还少了一块：表里这些行只是"已经拉下来"的，每个一级评论上还挂着
  // 「展开 N 条回复」，那 N 条也是屏幕上明明白白告诉他的，一起算进"已展示"：
  //
  //     已展示 = 现在的评论行数 + 各楼「展开 N 条回复」里的 N
  //
  // 用户就是这么数的：17 行 + 3+22+6+17+11+4 = 80，标题要写「评论 80/265」。
  // 展开某一楼之后它不叫"展开"了，那 N 条落进 rows（`applyFold` 已把 mode 改成 close/more），
  // 所以 folded 只认 mode === 'open' 的楼，展开前后总数不会突然翻倍。
  // v0.95 起「展开 N 条回复」不再长在楼主那一行里，而是每楼单独一行（`floorToggleHtml`），
  // 所以这里直接数整个评论区的 `.fz-toggle`，别再顺着 `[data-root]` 往下找（那样会一条都找不着，
  // 已展示数会突然从 80 掉回 17）。
  function cmtFolded(el) {
    var out = 0;
    var tgs = el ? el.querySelectorAll('.fz-cmts .fz-toggle') : [];
    for (var i = 0; i < tgs.length; i++) {
      if ((tgs[i].dataset.mode || 'open') !== 'open') continue;   // 已展开/在加载：那几条已经进 rows
      out += parseInt(tgs[i].dataset.total, 10) || 0;
    }
    return out;
  }

  function cmtCounts(el) {
    var rows = el ? el.querySelectorAll('.fz-cmts .fz-nrow') : [];
    var roots = 0, replies = 0, i;
    for (i = 0; i < rows.length; i++) {
      if (/fz-lv[123]/.test(String(rows[i].className || ''))) replies++;
      else roots++;
    }
    var folded = 0;
    try { folded = cmtFolded(el); } catch (eFold) {}
    return { roots: roots, replies: replies, rows: roots + replies, folded: folded,
      all: roots + replies + folded };
  }

  // 同一套口径的"数据版"：表还没画出来时（拼 HTML 那一刻）用它，
  // 规则跟 DOM 版逐条对应，有「展开 N 条回复」的楼（N ≥ 2）才把 N 加进去
  function cmtCountsOf(list) {
    var roots = 0, replies = 0, folded = 0;
    for (var i = 0; i < (list || []).length; i++) {
      var c = list[i] || {};
      if (c.depth) { replies++; continue; }
      roots++;
      var n = parseInt(c.subTotal, 10) || (c.kids || []).length || 0;
      if (n >= 2) folded += n;
    }
    return { roots: roots, replies: replies, rows: roots + replies, folded: folded,
      all: roots + replies + folded };
  }

  function cmtLoadedText(cnt) {
    if (!cnt) return '0 条';
    var parts = [];
    if (cnt.roots) parts.push('评论 ' + cnt.roots);
    if (cnt.replies) parts.push('回复 ' + cnt.replies);
    if (cnt.folded) parts.push('未展开 ' + cnt.folded);
    return (cnt.all || 0) + ' 条' + (parts.length ? '（' + parts.join(' + ') + '）' : '');
  }

  function updateNsStat(el, data) {
    var span = el.querySelector('#fz-ns-stat');
    if (!span) return;
    var st = data.stats || {};
    var cnt0 = null;
    try { cnt0 = cmtCounts(el); } catch (eC0) {}
    var loaded = cnt0 ? cnt0.all : Math.max(0, el.querySelectorAll('.fz-nrow').length - 1);
    var parts = [];
    if (st.likes !== '' && st.likes !== undefined) parts.push('赞 ' + st.likes);
    if (st.collects !== '' && st.collects !== undefined) parts.push('藏 ' + st.collects);
    var total = (st.comments !== '' && st.comments !== undefined) ? st.comments : '';
    parts.push('评论 ' + (total !== '' ? (loaded + '/' + total) : loaded));
    if (span) {
      // 口径：表里的评论行 + 各楼「展开 N 条回复」写着的 N（v0.86）
      span.title = '已展示评论 ' + loaded + ' 条' +
        (cnt0 ? '（表里 ' + cnt0.rows + ' 行' +
          (cnt0.roots ? '：一级评论 ' + cnt0.roots + ' 条' + (cnt0.replies ? ' + 已载入回复 ' + cnt0.replies + ' 条' : '') : '') +
          (cnt0.folded ? '；另有 ' + cnt0.folded + ' 条挂在各楼「展开 N 条回复」里' : '') + '）' : '') +
        (total !== '' ? '，站点共 ' + total + ' 条' : '');
    }
    // 表尾那句「共 N 条评论 · 已展示 …」跟着同一个口径刷，两处永远一致
    var cnote = el.querySelector('.fz-cnote');
    if (cnote) {
      cnote.textContent = '共 ' + (total !== '' ? total : '?') + ' 条评论 · 已展示 ' + cmtLoadedText(cnt0);
    }
    var cnt = (data.urls && data.urls.length) || 0;
    var itxt = '图 ' + cnt;
    // 只在"一张都没取到"时才写来源，方便排查；正常状态绝不暴露内部信息
    if (!cnt && data.diag) {
      itxt += ' · 接口' + data.diag.api + '/状态' + data.diag.state + '/页面' + data.diag.dom;
    }
    parts.push(itxt);
    span.textContent = ' · ' + parts.join(' · ');
  }

  // 只把节点摘掉，不记"用户关过"（内部清理用）
  function removeSheet() {
    if (noteSheet && noteSheet.parentNode) noteSheet.parentNode.removeChild(noteSheet);
    noteSheet = null;
    try { document.documentElement.classList.remove('fz-hassheet'); } catch (e) {}
  }

  // 用户主动关闭：记住这篇别再自动弹出来
  function closeNoteSheet() {
    removeSheet();
    try {
      var m = location.pathname.match(NOTE_PATH);
      if (m) closedPid = m[1];
    } catch (e) {}
  }

  // 「返回列表」：从列表点进来的就退回去（保留原来的筛选/排序），
  // 直接开链接进来的（没有上一页）就去首页，别在这儿把用户卡住。
  function backToList() {
    var fromList = false;
    try {
      var q = [];
      q = readQueue();
      fromList = q.length > 0;
    } catch (eQ) {}
    if (!fromList) {
      try { fromList = /xiaohongshu\.com\/(explore|search)/.test(document.referrer || ''); } catch (eR) {}
    }
    closeNoteSheet();
    if (fromList && history.length > 1) { try { history.back(); return; } catch (eB) {} }
    location.href = 'https://www.xiaohongshu.com/explore';
  }

  function saneText(t) {
    if (!t || t.length < 12 || t.length > 900) return false;
    return !/猜你想搜|推荐|登录|扫一扫|打开小红书|下载|问答|答疑解惑|穿搭 美食 彩妆/.test(t);
  }

  // 调试用：把"为什么没接管详情页"写在 <html data-fz-why>
  function nsWhy(r) {
    try {
      var d = document.documentElement;
      // 值没变就不写，避免触发 MutationObserver 造成同步死循环
      if (d.getAttribute('data-fz-why') !== r) d.setAttribute('data-fz-why', r);
    } catch (e) {}
  }

  function maybeNoteSheet() {
    if (!CFG.detailSheet) { nsWhy('cfg'); return; }
    if (noteSheet) { nsWhy('busy'); return; }
    if (Date.now() - pageAt < 700) { nsWhy('warmup'); return; }

    var pid = (location.pathname.match(NOTE_PATH) || [])[1] || '';
    if (!pid) { nsWhy('list'); return; }   // 首页/列表页不做笔记详情接管
    if (closedPid === pid) { nsWhy('closed'); return; }   // 用户手动收起过，别立刻又弹出来
    var cached = null;
    try { cached = JSON.parse(sessionStorage.getItem('fz-note') || 'null'); } catch (e) {}
    if (!cached || (pid && cached.id && cached.id !== pid)) cached = null;

    var dom = null;
    try { dom = readNotePage(); } catch (e) { dom = null; }
    if (!cached && !dom) { nsWhy('no-data'); return; }

    var data = cached || dom;
    if (dom) {
      if (dom.comments && dom.comments.length) data.comments = dom.comments;
      if (dom.time) data.time = dom.time;
      if (!data.desc && dom.desc && !badText(dom.desc)) data.desc = dom.desc;
      if (!data.title && dom.title) data.title = dom.title;
      if (!data.author && dom.author) data.author = dom.author;
      // 属地：列表点进来时缓存里没有这一项（首页卡片压根没这东西），必须从页面/state 补
      if (!data.ip && dom.ip) data.ip = dom.ip;
      if (!data.type) data.type = dom.type;
      if (!data.likes && dom.likes) data.likes = dom.likes;
      if ((!data.urls || !data.urls.length) && dom.urls && dom.urls.length) {
        data.urls = dom.urls;
        data.dims = dom.dims;
      }
      // 互动数兜底用页面上的
      if (!data.stats && (dom.likes || dom.cmtCount || dom.collects)) {
        data.stats = { likes: dom.likes || '', collects: dom.collects || '', comments: dom.cmtCount || '' };
      }
    }
    if (!data.urls) data.urls = [];
    if (!data.dims) data.dims = [];

    // 轮播只渲染当前张，完整信息从接口/初始状态里取
    data.diag = { api: 0, state: 0, dom: 0 };
    try {
      var an0 = apiNote(pid);
      data.diag.api = (an0 && an0.images && an0.images.length) || 0;
      var stn = an0;
      if (!stn || !stn.images || !stn.images.length) {
        var s2 = readStateNote(pid);
        data.diag.state = (s2 && s2.images && s2.images.length) || 0;
        if (s2 && (!stn || !stn.images || !stn.images.length)) stn = s2;
      }
      if (stn) {
        // 只要拿到 state/接口的 imageList 就无条件采信：页面 DOM 会把推荐位、骨架图一起收进来
        if (stn.images && stn.images.length) {
          data.urls = stn.images.map(function (o) { return o.src; });
          data.dims = stn.images.map(function (o) { return (o.w && o.h) ? o.w + '×' + o.h : ''; });
          data.imgSrc = (data.diag.api ? 'api' : 'state');
          data.imgLocked = 1;
        }
        if (stn.type) data.type = stn.type;          // 站点数据里的类型最准
        if (stn.time) data.time = stn.time;          // 站点数据里是完整时间戳（页面上只有 08-12）
        data.tags = stn.tags || data.tags || [];
        if (stn.likes || stn.collects || stn.comments) {
          data.stats = { likes: stn.likes, collects: stn.collects, comments: stn.comments };
        }
      }
    } catch (e4) {}
    if (!data.imgSrc && data.urls && data.urls.length) data.imgSrc = cached ? '列表封面' : '页面';
    if (!data.token) { try { data.token = buildTokenMap()[pid] || ''; } catch (e5) {} }

    nsWhy('ok');
    try { openNoteSheet(data); }
    catch (e7) { nsWhy('throw:' + (e7 && e7.message)); console.error('[fishy] 详情表渲染失败：', e7); }
  }

  // ---------- 藏顶栏 / 弹层让位 ----------
  // 我们自己的浮层永远不在"藏站点元素"的范围内。
  // 踩过的坑：设置菜单是个固定在右上角的小面板，正好命中 hideSideBars() 里
  // 「右侧悬浮按钮组」那套启发式（fixed + left > vw-280 + 高度 < 500），
  // 打开约 600ms 后被当成站点控件藏掉，截图和另一张一模一样才发现。
  function isOurs(el) {
    return !!(el && el.closest &&
      el.closest('.fz-chrome,.fz-notesheet,.fz-viewer,.fz-board,.fz-menu,.fz-toast,.fz-setwrap'));
  }
  function hideEl(el) {
    if (!el || el.dataset.fzHide === '1') return;
    if (isOurs(el)) return;
    el.dataset.fzHide = '1';
    el.style.setProperty('display', 'none', 'important');
    hushVideos(el);      // 藏起来不等于不出声：视频/实况图还在播就是当场暴露
  }

  // ===== 不出声 =====
  // CSS 把站点元素 `display:none` 之后，里面的 <video> 照样在播、照样出声，
  // 摸鱼时突然冒出视频声音，比屏幕上多个表格危险得多。所以凡是被我们盖住/藏起来的，
  // 一律暂停 + 静音；用户自己打开播放器看视频那种（在 .fz-vbox 里）不碰。
  function videosIn(root) {
    if (!root) return [].slice.call(document.querySelectorAll('video'));
    var out = [];
    if (root.tagName === 'VIDEO') out.push(root);
    if (root.querySelectorAll) out = out.concat([].slice.call(root.querySelectorAll('video')));
    return out;
  }

  function hushVideos(root) {
    if (!CFG.hush) return 0;             // 设置里关掉：视频保持站点的原声（默认静音是怕突然出声）
    var vids = videosIn(root), n = 0;
    for (var i = 0; i < vids.length; i++) {
      var v = vids[i];
      try { if (v.closest && v.closest('.fz-vbox')) continue; } catch (eS) {}
      try {
        if (v.dataset.fzWasMuted === undefined) v.dataset.fzWasMuted = v.muted ? '1' : '0';
        if (!v.paused) v.pause();
        v.muted = true;
        v.dataset.fzHushed = '1';
        n++;
      } catch (e) {}
    }
    return n;
  }

  // 让位给原生界面 / 关掉表格模式时，把静音状态还回去（用户这会儿是真的在看原生页面）
  function unhushVideos(root) {
    var vids = videosIn(root), n = 0;
    for (var i = 0; i < vids.length; i++) {
      var v = vids[i];
      if (!v.dataset || v.dataset.fzHushed !== '1') continue;
      try {
        v.muted = v.dataset.fzWasMuted === '1';
        delete v.dataset.fzHushed;
        delete v.dataset.fzWasMuted;
        n++;
      } catch (e) {}
    }
    return n;
  }

  // 表格模式下每轮 sync 兜一遍：站点列表还有别的藏法（CSS 规则直接 display:none，不经 hideEl）
  function hushPage() {
    if (yieldMode) return 0;
    return hushVideos(document);
  }

  var headerDone = false;
  function hideSiteHeader() {
    if (headerDone) return;
    var h = document.querySelector('header');
    if (h && !h.closest('.fz-chrome') && !h.closest('.fz-viewer')) { hideEl(h); headerDone = true; return; }

    var vw = innerWidth, tried = 0;
    var queue = Array.prototype.slice.call(document.body.children, 0);
    while (queue.length && tried < 40) {
      var el = queue.shift();
      tried++;
      if (!el.getBoundingClientRect) continue;
      if (el.classList.contains('fz-chrome') || el.classList.contains('fz-viewer')) continue;
      if (el.dataset.fzHide === '1') continue;
      var r = el.getBoundingClientRect();
      if (r.height > 140 || r.width < vw * 0.7) {
        if (r.height > 140 && el.children.length && tried < 20) {
          queue = queue.concat(Array.prototype.slice.call(el.children, 0));
        }
        continue;
      }
      if (r.height > 30 && el.querySelector('a')) { hideEl(el); headerDone = true; return; }
    }
  }

  // 藏左侧导航栏
  var sideDone = false, sideCount = 0;
  function hideSideBars() {
    if (sideDone) return;
    var list = Array.prototype.slice.call(
      document.querySelectorAll('aside,nav,[class*="side-bar"],[class*="sidebar"],[class*="left-nav"],[class*="nav-bar"]')
    );
    var kids = document.body.children;
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      if (isOurs(el)) continue;
      list.push(el);
      if (el.children.length < 30) {
        for (var j = 0; j < el.children.length; j++) list.push(el.children[j]);
      }
    }
    var vw = innerWidth;
    for (var k = 0; k < list.length; k++) {
      var e = list[k];
      if (!e || !e.getBoundingClientRect) continue;
      if (isOurs(e)) continue;
      var r = e.getBoundingClientRect();
      if (r.width < 40 || r.width > 340 || r.height < 60) continue;
      var cs = getComputedStyle(e);
      // 左侧导航
      var leftRail = r.height > 220 && r.left < 260;
      // 右侧悬浮按钮组（"活动"之类）
      var rightRail = cs.position === 'fixed' && r.left > vw - 280 && r.height < 500;
      if (leftRail || rightRail) {
        if (cs.position === 'fixed' || e.tagName === 'ASIDE' || e.tagName === 'NAV' || rightRail) {
          hideEl(e);
          sideCount++;
          if (sideCount >= 4) { sideDone = true; return; }
        }
      }
    }
  }

  // 藏表格上方的搜索框、分类标签等（表格上方的都不该出现在表里）
  var aboveDone = false;
  // 把站点顶部的大搜索框、AI 两个按钮藏掉
  var searchDone = false;
  function hideTopSearch() {
    if (searchDone) return;
    var hit = 0;
    // 别把我们自己的浮层输入框当成站点的搜索框（面板里的搜索框也带 placeholder）
    var inp = document.querySelector('input[placeholder]:not(.fz-search):not(.fz-minput)');
    if (inp && inp.closest('[data-fz-menu-panel]')) inp = null;
    if (inp && inp.closest('.fz-chrome')) inp = null;
    if (inp) {
      var p = inp, g = 0;
      while (p && p !== document.body && g < 6) {
        var r = p.getBoundingClientRect();
        if (hasRealCards(p)) break;
        if (r.width > 280 && r.height > 20 && r.height < 220) { hideEl(p); hit++; break; }
        p = p.parentElement; g++;
      }
    }
    var words = ['做旅游攻略', '答疑解惑'];
    var all = document.querySelectorAll('div,span,a,button');
    for (var i = 0; i < all.length && i < 3000; i++) {
      var el = all[i];
      if (el.children.length) continue;
      var t = (el.textContent || '').trim();
      if (words.indexOf(t) === -1) continue;
      var q = el.parentElement;
      if (q && q.children.length <= 2 && q.parentElement) hideEl(q.parentElement);
      else if (q) hideEl(q);
      hit++;
    }
    if (hit) searchDone = true;
  }

  // 把站点的分类标签提取出来，重画成工具栏风格
  var catsDone = false;
  function setupCats() {
    if (catsDone) return;
    var box = document.querySelector('.fz-cats');
    if (!box) return;

    var links = [], host = null;
    var NAV_BAD = { '首页': 1, '直播': 1, '消息': 1, '点点': 1, '发布': 1, '通知': 1, '我': 1, '更多': 1, '创作中心': 1 };
    var as = document.querySelectorAll('a[href*="channel_id"],a[href*="channelId"]');
    for (var i = 0; i < as.length; i++) {
      var t = txt(as[i], 6);
      if (!t || t.length > 4 || NAV_BAD[t]) continue;
      if (links.length < 24) links.push({ t: t, h: as[i].getAttribute('href') });
    }
    if (links.length >= 5) host = as[0].parentElement;

    if (links.length < 5) {
      links = [];
      var all = document.querySelectorAll('div,span,a,li');
      for (var j = 0; j < all.length && j < 4000; j++) {
        var el = all[j];
        if (el.children.length) continue;
        var s2 = txt(el, 6);
        if (s2 !== '推荐' && s2 !== '穿搭') continue;
        var p2 = el.parentElement;
        if (!p2) continue;
        var tmp = [], ok = 0;
        for (var k = 0; k < p2.children.length; k++) {
          var kt = txt(p2.children[k], 6);
          if (kt && kt.length <= 4) { tmp.push({ t: kt, h: p2.children[k].getAttribute ? (p2.children[k].getAttribute('href') || '') : '' }); ok++; }
        }
        if (ok >= 5) { links = tmp; host = p2; break; }
      }
    }

    if (!links.length) return;
    // 最多画 8 个：站点分类一多就能把整条工具条撑爆（实测 24 个时宽到 494px），
    // 窄屏再靠 CSS 往下砍。工具栏是装饰，不是目录。
    box.innerHTML = links.slice(0, 8).map(function (x) {
      return x.h
        ? '<a class="fz-cat" href="' + esc(x.h) + '">' + esc(x.t) + '</a>'
        : '<span class="fz-cat">' + esc(x.t) + '</span>';
    }).join('');
    if (host) hideEl(host);
    catsDone = true;
  }

  var aboveDone = false;
  // 铁腕版：.fz-board 是 body 的直接子元素，排它前面的站点内容一律隐藏。
  // 不依赖类名/结构判断，登录态、游客态、不同窗口宽度都能清干净。
  // 游客态弹层：登录框遮罩、右下角客服/反馈悬浮球
  function hideOverlays() {
    if (yieldMode) return;   // 登录/登出让位时要留给用户看
    // 视口右侧贴边的小圆球（客服、回到顶部、用户菜单之类），滚动后才出现
    var bals = document.querySelectorAll('div,a,button');
    for (var n = 0; n < bals.length && n < 1500; n++) {
      var e4 = bals[n];
      if (e4.dataset.fzHide === '1') continue;
      if (e4.closest && e4.closest('.fz-chrome,.fz-board,.fz-notesheet,.fz-viewer')) continue;
      var g4 = e4.getBoundingClientRect();
      if (g4.width < 28 || g4.width > 90 || g4.height < 28 || g4.height > 90) continue;
      if (g4.left < innerWidth - 95) continue;      // 必须贴最右边
      if (g4.top < 60) continue;                    // 别碰顶部工具栏
      var cs4 = getComputedStyle(e4);
      if (cs4.position === 'static') continue;
      if (parseFloat(cs4.borderRadius) < 12) continue;   // 只处理圆形
      hideEl(e4);
    }

    // 视口右侧贴边的小圆球（客服、回到顶部、用户菜单之类），滚动后才出现
    var bals = document.querySelectorAll('div,a,button');
    for (var n = 0; n < bals.length && n < 1500; n++) {
      var e4 = bals[n];
      if (e4.dataset.fzHide === '1') continue;
      if (e4.closest && e4.closest('.fz-chrome,.fz-board,.fz-notesheet,.fz-viewer')) continue;
      var g4 = e4.getBoundingClientRect();
      if (g4.width < 28 || g4.width > 90 || g4.height < 28 || g4.height > 90) continue;
      if (g4.left < innerWidth - 95) continue;      // 必须贴最右边
      if (g4.top < 60) continue;                    // 别碰顶部工具栏
      var cs4 = getComputedStyle(e4);
      if (cs4.position === 'static') continue;
      if (parseFloat(cs4.borderRadius) < 12) continue;   // 只处理圆形
      hideEl(e4);
    }

    // 站点顶部导航残留（首页/直播/消息/点点），只在页面上方 220px 内动手，避免误伤正文
    var navWords = { '首页': 1, '直播': 1, '消息': 1, '点点': 1 };
    var cand = document.querySelectorAll('span,a,div,li');
    for (var k = 0; k < cand.length && k < 1500; k++) {
      var e2 = cand[k];
      if (e2.children && e2.children.length) continue;
      if (e2.closest && e2.closest('.fz-chrome,.fz-board,.fz-notesheet')) continue;
      var t2 = (e2.textContent || '').trim();
      if (!navWords[t2]) continue;
      var q2 = e2.getBoundingClientRect();
      if (q2.width < 5 || q2.height < 5 || q2.top > 220) continue;
      hideEl(e2.closest('li,a,[class*="nav"],[class*="item"],[class*="tab"]') || e2);
    }
    var sel = '.reds-mask,.login-container,[class*="login-modal"],[class*="loginModal"],' +
      '[class*="floating-btn"],[class*="customer-service"],[class*="side-bar-contact"]';
    var els = document.querySelectorAll(sel);
    for (var i = 0; i < els.length && i < 40; i++) {
      var el = els[i];
      if (el.closest && el.closest('.fz-chrome,.fz-notesheet,.fz-board,.fz-viewer')) continue;
      if (el.dataset.fzHide === '1') continue;
      var r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 20) continue;
      hideEl(el);
    }
  }

  function hideBeforeBoard() {
    var bd = document.querySelector('.fz-board');
    if (!bd || bd.parentNode !== document.body) return;
    var kids = document.body.children;
    for (var i = 0; i < kids.length; i++) {
      var ch = kids[i];
      if (ch === bd) break;
      var cl = ch.classList;
      // SVG 元素的 classList 是 SVGAnimatedString，没有 contains，直接跳过防崩
      if (!cl || typeof cl.contains !== 'function') continue;
      if (cl.contains('fz-chrome') || cl.contains('fz-board') ||
          cl.contains('fz-src') || cl.contains('fz-toast') ||
          cl.contains('fz-viewer') || cl.contains('fz-notesheet') ||
          cl.contains('fz-pullspacer') || cl.contains('fz-filler')) continue;
      if (ch.dataset.fzHide === '1') continue;
      if (ch.tagName === 'SCRIPT' || ch.tagName === 'STYLE' || ch.tagName === 'LINK') continue;
      // 笔记详情容器绝不能藏：里面还有我们要读的正文/评论/图片
      if (ch.querySelector && ch.querySelector(
        '#noteContainer,.note-detail-mask,[class*="note-detail"],#detail,#detail-title,#detail-desc')) continue;
      var r = ch.getBoundingClientRect();
      if (r.height <= 0 && r.width <= 0) continue;
      hideEl(ch);
    }
  }

  function hideAboveTable() {
    var board = document.querySelector('.fz-board');
    if (!board) return;
    var top = board.getBoundingClientRect().top;
    if (top <= (HEAD_H + 12)) { aboveDone = true; return; }   // 已经贴住工具栏，无需处理

    var el = board, hidden = 0;
    for (var lv = 0; lv < 5 && el && el.parentElement; lv++) {
      var p = el.parentElement;
      for (var i = 0; i < p.children.length; i++) {
        var ch = p.children[i];
        if (ch === el || (ch.contains && ch.contains(board))) continue;
        if (ch.classList && (ch.classList.contains('fz-chrome') || ch.classList.contains('fz-board') ||
            ch.classList.contains('fz-rows') || ch.classList.contains('fz-src') ||
            ch.classList.contains('fz-toast'))) continue;
        if (hasRealCards(ch)) continue;
        var r = ch.getBoundingClientRect();
        if (r.height > 4 && r.height < 400 && r.width > 200 && r.bottom <= top + 8) {
          hideEl(ch);
          hidden++;
        }
      }
      el = p;
    }
    if (hidden) aboveDone = true;
  }

  // 底部吸底浮层（"大家都在搜"这类）
  var bottomAt = 0;
  function hideBottomBars() {
    if (Date.now() - bottomAt < 1500) return;
    bottomAt = Date.now();
    var all = document.querySelectorAll('div,section,aside,footer');
    for (var i = 0; i < all.length && i < 2500; i++) {
      var el = all[i];
      if (el.dataset.fzHide === '1') continue;
      if (isOurs(el)) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 200 || r.height < 20 || r.height > 150) continue;
      if (r.bottom < innerHeight - 6) continue;
      var cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
      hideEl(el);
    }
  }

  // 按文案识别站点浮层（"大家都在搜""猜你想搜"）
  var textAt = 0;
  function hideTextPanels() {
    if (Date.now() - textAt < 1200) return;
    textAt = Date.now();
    var words = ['大家都在搜', '猜你想搜', '更多搜索'];
    var all = document.querySelectorAll('div,section,aside');
    for (var i = 0; i < all.length && i < 3000; i++) {
      var el = all[i];
      if (el.dataset.fzHide === '1') continue;
      if (isOurs(el)) continue;
      var t = (el.textContent || '').trim().slice(0, 30);
      var hit = false;
      for (var w = 0; w < words.length; w++) if (t.indexOf(words[w]) > -1) { hit = true; break; }
      if (!hit) continue;
      var box = el;
      for (var up = 0; up < 3 && box.parentElement && box.parentElement !== document.body; up++) {
        var cs = getComputedStyle(box);
        var r = box.getBoundingClientRect();
        if ((cs.position === 'fixed' || cs.position === 'absolute') && r.width < 520 && r.height < 640) break;
        box = box.parentElement;
      }
      hideEl(box);
    }
  }

  var modalSet = new WeakSet();
  function fitModals() {
    var cands = [], i, j;
    var kids = document.body.children;
    for (i = 0; i < kids.length; i++) {
      var el = kids[i];
      if (isOurs(el)) continue;
      cands.push(el);
      if (el.children.length < 40) {
        for (j = 0; j < el.children.length; j++) cands.push(el.children[j]);
      }
    }
    for (var k = 0; k < cands.length; k++) {
      var e = cands[k];
      if (!e || modalSet.has(e)) continue;
      var cs = getComputedStyle(e);
      if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
      var r = e.getBoundingClientRect();
      if (r.width < innerWidth * 0.85 || r.height < innerHeight * 0.75) continue;
      modalSet.add(e);
      e.style.setProperty('top', HEAD_H + 'px', 'important');
      e.style.setProperty('bottom', FOOT_H + 'px', 'important');
      e.style.setProperty('height', 'auto', 'important');
    }
  }

  // ---------- 外壳 ----------
  function tb(s, cls) {
    return '<span class="fz-tb' + (cls ? ' ' + cls : '') + '">' + s + '</span>';
  }
  var CARET = '<i class="fz-caret"></i>';

  // 列号条跟着当前视图走：列表 6 格（A~E），详情 7 格（A~F）
  function updateLetters() {
    var box = document.querySelector('.fz-letters');
    if (!box) return;
    var detail = !!document.querySelector('.fz-notesheet');
    // 列表 6 列（A~E）：赞 类型 标题 作者 时间
    // 详情 7 列（A~F）：赞 作者 内容 操作 IP 时间
    // ↑ 列数只有这一处说了算：行 / 表头 / 列号条都从这里出发，改一处必须三处一起改
    var LET = detail
      ? ['', 'A', 'B', 'C', 'D', 'E', 'F']
      : ['', 'A', 'B', 'C', 'D', 'E'];
    var HEAD = detail
      ? ['', '赞', '作者', '内容', '操作', 'IP', '时间']
      : ['', '赞', '类型', '标题', '作者', '时间'];
    var key = LET.length + '|' + (detail ? 1 : 0);
    if (box.dataset.fzKey === key) return;
    box.dataset.fzKey = key;
    var cols = detail ? COLW : COLW_LIST;
    box.style.gridTemplateColumns = cols;
    box.innerHTML = LET.map(function (ch, i) {
      var c = 'fz-letter' + (i === 0 ? ' fz-corner' : '') + (i === 1 ? ' on' : '');
      return '<span class="' + c + '">' + ch + '</span>';
    }).join('');

    // 表头行跟着一起换。可筛选的列挂 data-fz-filter，▾ 用 CSS ::after 画，
    // 这样 textContent 还是干净的列名（导出 CSV 的表头直接读这里，不能被符号污染）
    var th = document.querySelector('.fz-thead');
    if (th) {
      // 表头自己声明"我现在是哪张表的表头"。表头是共享的固定 chrome，永远在 .fz-notesheet 外面，
      // 所以"按祖先判视图"一定是错的（真机 R6v：详情页拖列宽被写进列表那一套，屏幕上没反应）。
      th.dataset.fzView = detail ? 'detail' : 'list';
      th.style.gridTemplateColumns = cols;
      // 列表：赞(1) / 类型(2) / 作者(4)；详情：赞(1) / 作者(2)
      // （详情没有类型列，类型条件不许跨表，见踩坑 57；作者两表都有 ✅ 所以两边都挂）
      var FILTERABLE = detail ? { 1: 'like', 2: 'author', 6: 'when' } : { 1: 'like', 2: 'type', 4: 'author', 5: 'when' };
      // 排序：列头挂 data-fz-sort。赞 也挂（为了在列头画 ▲▼），但它的点击归筛选面板
      //，click 处理里先判 [data-fz-filter]，所以点「赞 ▾」还是出筛选，排赞请走工具栏 ⇅
      var SORTABLE = detail
        ? { 1: 'like', 2: 'author', 3: 'text', 6: 'time' }
        : { 1: 'like', 3: 'text', 4: 'author', 5: 'time' };
      th.innerHTML = HEAD.map(function (t, i) {
        var fk = FILTERABLE[i], sk = SORTABLE[i];
        return '<span class="' + (i === 1 ? 'on' : '') + '"' +
          (fk ? ' data-fz-filter="' + fk + '" title="筛选：' + t + '（点一下出条件，回车也一样）"' +
            ' aria-expanded="false"' : '') +
          (sk ? ' data-fz-sort="' + sk + '" title="排序：' + t +
            '（点一下升序，再点降序，第三次回原序）"' : '') +
          '>' + t + '</span>';
      }).join('');
      markKeyboard(th);      // 表头是 <span>，不补 tabindex 键盘停不上去
      paintSort();           // 换视图（列表 ↔ 详情）后把 ▲▼ 画回当前那列
    }
  }

  // 页面上是不是还有另一份脚本在跑（油猴里装了两份、旧版没删、或者别的管理器也装了）：
  // 两份各有各的 click 处理器，谁先注册谁把 click 吃掉，用户看到的就是
  // "面板开着、点条件没反应/工具栏点不动"。我们只提示、不硬抢（抢也抢不过：注册晚了）。
  function checkDupScripts() {
    try {
      var heads = document.querySelectorAll('.fz-chrome.fz-head');
      if (heads.length <= 1) return false;
      document.documentElement.classList.add('fz-dup');
      setTimeout(function () {
        toast('页面上有两份脚本在跑（油猴里装了两份，或者旧版没删）。只留一份并更新到最新版，' +
          '不然按钮会被另一份抢走，点了没反应', 9000);
      }, 1200);
      return true;
    } catch (e) { return false; }
  }

  function buildChrome() {
    if (document.querySelector('.fz-chrome')) return;

    var head = document.createElement('div');
    head.className = 'fz-chrome fz-head';
    head.dataset.fzVer = FZ_VER;

    var tabs = ['开始', '插入'].map(function (t, i) {
      return '<span class="fz-tab' + (i === 0 ? ' on' : '') + '">' + t + '</span>';
    }).join('');

    head.innerHTML =
      '<div class="fz-t1">' +
        '<span class="fz-app"></span>' +
        '<span class="fz-file">' + esc(CFG.docTitle) + '</span>' +
        '<span class="fz-star">☆</span>' +
        '<span class="fz-hint">上次修改是在 2 小时前</span>' +
        '<span class="fz-sp"></span>' +
        '<span class="fz-authslot"></span>' +

        '<input class="fz-search" type="text" spellcheck="false"' +
          ' placeholder="搜索" title="按作者 / 标题 / 类型搜：空格分隔多个词，每个词都要命中；' +
          '回车去站内搜">' +
      '</div>' +
      '<div class="fz-t2">' +
        // ---- 左边这一整条是伪装：全是表格的样子货，点了没有任何反应 ----
        // 排法参考腾讯文档那种"一排等高小方块"：图标和文字同一个字号，分组之间一条细竖线。
        // 尺寸统一走 .fz-t2 上的几个变量（--fz-ctl-*），窄屏按优先级丢东西，不缩字号。
        '<span class="fz-deco">' +
          '<span class="fz-namebox">A1' + CARET + '</span>' +
          tabs +
          '<i class="fz-tsep"></i>' +
          '<span class="fz-cats"></span>' +
          '<i class="fz-tsep"></i>' +
          // 第一组：最像表格、也最该被眼睛扫到的那些（任何宽度都留着）
          '<span class="fz-deco-g">' +
            '<span class="fz-tb fz-pick">常规' + CARET + '</span>' +
            '<span class="fz-tb fz-pick">10' + CARET + '</span>' +
            '<i class="fz-tsep"></i>' +
            tb('B', 'fz-tbb') + tb('I', 'fz-tbi') + tb('U', 'fz-tbu') +
            '<span class="fz-tb">A<i class="fz-swatch"></i>' + CARET + '</span>' +
            '<span class="fz-tb">▨' + CARET + '</span>' +
          '</span>' +
          // 第二组：锦上添花。窗口不够宽的时候整组先没（1240px 以下）
          '<span class="fz-deco-x">' +
            '<i class="fz-tsep"></i>' +
            '<span class="fz-tb">≡' + CARET + '</span>' +
            '<span class="fz-tb">⊞' + CARET + '</span>' +
            '<span class="fz-tb">⌗</span>' +
            '<i class="fz-tsep"></i>' +
            '<span class="fz-tb" title="边框">▦</span>' +
            '<span class="fz-tb" title="百分比">%</span>' +
            '<span class="fz-tb" title="千位分隔">,</span>' +
            '<span class="fz-tb" title="查找">⌕</span>' +
            '<span class="fz-tb" title="冻结窗格">❄</span>' +
          '</span>' +
          '<i class="fz-tsep"></i>' +
          tb('格式刷', 'fz-weak') +
        '</span>' +
        // ---- 右边这一组是真的能用：绿色描边 + 「工具」二字，和伪装区分开 ----
        '<span class="fz-tools" role="group" aria-label="表格模式工具">' +
          // 排序和导出按钮都撤了（v1.2）：排序走列头，导出走设置菜单，右上角只留设置

          '<span class="fz-tb fz-menu-btn" data-fz-menu="1"' +
            ' title="设置：表格模式 / 详情页接管 / 文件名 / 导出 CSV">⚙ 设置</span>' +
        '</span>' +
      '</div>' +
      '<div class="fz-t3">' +
        '<span class="fz-ref">A1</span>' +
        '<span class="fz-fx">fx</span>' +
        '<span class="fz-input"></span>' +
      '</div>';

    var letters = document.createElement('div');
    letters.className = 'fz-chrome fz-letters';
    // 列号必须和表格列数严格一致（7 列：序号 + A~F），多一个就会掉到第二行被裁掉
    var LET = ['', 'A', 'B', 'C', 'D', 'E', 'F'];
    letters.innerHTML = LET.map(function (ch, i) {
      var c = 'fz-letter' + (i === 0 ? ' fz-corner' : '') + (i === 1 ? ' on' : '');
      return '<span class="' + c + '">' + ch + '</span>';
    }).join('');

    var foot = document.createElement('div');
    foot.className = 'fz-chrome fz-foot';
    foot.innerHTML =
      '<span class="fz-ready">就绪</span>' +
      '<span class="fz-sheet on">' + esc(CFG.sheetName) + '</span>' +
      '<span class="fz-addtab">+</span>' +
      '<span class="fz-sp"></span>' +
      '<span class="fz-sel-stat"></span>' +
      // 缩放：原来这三个就是死字（连点击处理都没有，Tab 还能停上去）。
      // 现在每 10% 一档（Excel 也是 10%），点中间那个数字回 100%，Ctrl+滚轮同样能缩
      '<span class="fz-zoom" data-fz-zoom="-1" title="缩小（Ctrl+滚轮也行）">−</span>' +
      '<span class="fz-pct" data-fz-zoom="0" title="点一下回到 100%">100%</span>' +
      '<span class="fz-zoom" data-fz-zoom="1" title="放大（Ctrl+滚轮也行）">+</span>';

    document.body.appendChild(head);
    zoomApply(ZOOM, true);      // 刷新后还是上次那个比例
    markKeyboard(head);
    // KBD_SEL 是主闸；这里再扫一遍（页眉 + 页脚，两个都要），防止以后有人又把 .fz-tb 塞回 Tab 序列
    // 注意用局部变量 foot：这时候它还没 appendChild，querySelector('.fz-foot') 会拿到 null
    markDecor(head);
    markDecor(foot);
    var li = detectLogin();
    if (li !== null) CFG.login = li;
    renderAuth();
    bindSearch();
    document.body.appendChild(letters);
    var thead = document.createElement('div');
    thead.className = 'fz-chrome fz-thead';
    document.body.appendChild(thead);
    document.body.appendChild(foot);
    markKeyboard(foot);
    document.documentElement.classList.add('fz');
  }

  function detectLogin() {
    try {
      var ss = document.querySelectorAll('script');
      for (var i = 0; i < ss.length; i++) {
        var t = ss[i].textContent || '';
        if (t.indexOf('loggedIn') === -1) continue;
        if (/"loggedIn"\s*:\s*true/.test(t)) return true;
        if (/"loggedIn"\s*:\s*false/.test(t)) return false;
      }
    } catch (e) {}
    return null;
  }

  // 登录用户名：优先站点 state，其次页面上那个头像菜单里的名字。
  // 拿不到就空着 —— 宁可只显示「登出」，也不要瞎编一个名字。
  function myNickname() {
    try {
      var st = window.__INITIAL_STATE__ || {};
      var u = st.user || {};
      var info = u.userInfo || u.user_info || (u.loggedIn && st.userInfo) || null;
      var n = info && (info.nickname || info.nickName || info.nick_name || info.name);
      if (n) return String(n).slice(0, 16);
      var el = document.querySelector('#userMe .name,.user .name,[class*="userName"],[class*="user-name"]');
      var t = el ? (el.textContent || '').trim() : '';
      if (t && t.length <= 16) return t;
    } catch (eN) {}
    return '';
  }

  // 我自己的头像：和昵称同源，拿不到就画一个灰底占位（不画破图）
  function myAvatar() {
    try {
      var st = window.__INITIAL_STATE__ || {};
      var u = st.user || {};
      var info = u.userInfo || u.user_info || null;
      var im = info && (info.image || info.avatar || info.avatarUrl);
      if (im) return String(im);
      var el = document.querySelector('#userMe img,[class*="userInfo"] img[src*="avatar"]');
      if (el) return el.currentSrc || el.getAttribute('src') || '';
    } catch (eA) {}
    return '';
  }

  function renderAuth() {
    var slot = document.querySelector('.fz-authslot');
    if (!slot) return;
    // 按站点真实登录态决定显示"登录"还是"登出"
    var logged = true;
    try { logged = isLoggedIn(); } catch (e) { logged = !!CFG.login; }
    var want = logged ? 'out' : 'in';
    var nick = logged ? myNickname() : '';
    // 头像跟着「隐藏用户头像」这个开关走：勾着就不画（连顶栏这一小块也不画）
    var av = (logged && !CFG.hideAvatar) ? myAvatar() : '';
    var cur = slot.querySelector('[data-fz-auth]');
    // 没变化就别重绘（昵称/头像也一起比，登录后名字出来要跟着刷）
    if (cur && cur.dataset.fzAuth === want && slot.dataset.fzNick === nick &&
        slot.dataset.fzAv === av) return;
    slot.dataset.fzNick = nick;
    slot.dataset.fzAv = av;
    slot.innerHTML = logged
      ? (av ? '<img class="fz-uav" alt="" referrerpolicy="no-referrer" src="' + esc(av) + '">' : '') +
        '<span class="fz-user" title="' + esc(nick || '已登录') + '">' + esc(nick) + '</span>' +
        '<span class="fz-t1item fz-authbtn" data-fz-auth="out">登出</span>'
      : '<span class="fz-t1item fz-authbtn" data-fz-auth="in">登录</span>';
  }

  // ---------- 标题 / 图标 ----------
  var titleTimer = null;
  var siteTitle = '';      // 站点自己的标题，关掉伪装时要还回去
  function applyTitle() {
    if (!CFG.tableMode) {                       // 伪装关掉 → 标签页也该是原样
      if (siteTitle && document.title !== siteTitle) document.title = siteTitle;
      return;
    }
    if (!siteTitle && document.title && document.title !== CFG.docTitle) siteTitle = document.title;
    if (document.title !== CFG.docTitle) document.title = CFG.docTitle;
  }
  function applyFavicon() {
    if (document.getElementById('fz-favicon')) return;
    var c = document.createElement('canvas');
    c.width = c.height = 32;
    var x = c.getContext('2d');
    x.fillStyle = '#217346';
    x.fillRect(0, 0, 32, 32);
    x.fillStyle = '#fff';
    x.fillRect(9, 8, 15, 16);
    x.fillStyle = '#217346';
    for (var r = 0; r < 3; r++) for (var q = 0; q < 3; q++) x.fillRect(11 + q * 4.5, 11 + r * 4.5, 3.2, 3.2);
    var link = document.createElement('link');
    link.id = 'fz-favicon';
    link.rel = 'icon';
    link.type = 'image/png';
    link.href = c.toDataURL('image/png');
    document.head.appendChild(link);
  }
  function dropFavicon() {
    var l = document.getElementById('fz-favicon');
    if (l && l.parentNode) l.parentNode.removeChild(l);
  }

  // ---------- 样式 ----------
  // 详情页按 A→D→C→F→B→E 重排：赞 | 作者 | 内容 | 操作 | IP | 时间
  // 列宽挂在 CSS 变量上：拖动只改一个变量，不用把整张样式表重注入一遍。
  // 弹性列（列表的标题 / 详情的内容）保留 minmax(...,1fr)，它自己会吃掉多余的空间，不参与拖动。
  var W_LIST = [30, 64, 52, null, 140, 92];        // 行号|赞|类型|标题(弹性)|作者|时间
  var W_DETAIL = [30, 74, 150, null, 108, 74, 118]; // 行号|赞|作者|内容(弹性)|操作|IP|时间
  // 注意：弹性列（列表的标题 / 详情的内容）在宽度表里是 null（不参与拖动），
  // 但在下限表里要写它真实的下限（280 / 300），totalOf() 要靠它算"这张表最少要占多少"，
  // 写成 null 会被当成 0，于是窗口宽度那道上限会松掉 280/300px，表格又被推出屏幕外（真机 R6w 抓到）。
  var WMIN_LIST = [30, 44, 40, 280, 60, 56];
  var WMIN_DETAIL = [30, 44, 60, 300, 60, 50, 56];
  var WMAX_PX = 900;
  function colWs(view) { return view === 'detail' ? W_DETAIL : W_LIST; }
  // 弹性列（列表的标题 / 详情的内容）的下限：默认 280 / 300，双击按内容调宽时会改它。
  // 这一格必须是活的：totalOf() / colRoom() / clampCols() 都得按当前下限算，
  // 否则把下限抬高之后再拖别的列，整张表又能被推出屏幕（第 45 节那个坑的另一个入口）。
  var FLEX_MIN = { list: 280, detail: 300 };
  var flexMin = { list: FLEX_MIN.list, detail: FLEX_MIN.detail };
  function colMin(view) {
    var v = view === 'detail' ? 'detail' : 'list';
    var lo = (v === 'detail' ? WMIN_DETAIL : WMIN_LIST).slice(), i;
    var ws = colWs(v);
    for (i = 0; i < lo.length; i++) if (ws[i] === null) lo[i] = flexMin[v];
    return lo;
  }
  function setColVar(view, i, w) {
    document.documentElement.style.setProperty('--fz-' + colVarNames(view)[i], w + 'px');
    if (colWs(view)[i] === null) flexMin[view] = w;   // 弹性列：改的是它的下限
  }
  // 这一套列宽"最少要占多少"：弹性列（标题 / 内容）按它的下限算，
  // 弹性列还在下限之上时会自己让出空间，表不会溢出；一旦它顶到下限，多出来的就真溢出屏幕了。
  function totalOf(view) {
    var ws = colWs(view), lo = colMin(view), t = 0, j;
    for (j = 0; j < ws.length; j++) t += ws[j] === null ? lo[j] : ws[j];
    return t;
  }
  // 这一列最宽能到多少：整张表不能比窗口宽。页面的 body 是 overflow-x:hidden，
  // 超出去的格子既滚不到也看不见（真机量过：窗口 1440，拖宽之后最后一列右边缘到 1458，
  // window.scrollTo(400,0) 之后 scrollX 还是 0，那截内容就永远够不着了）。
  function colRoom(view, i) {
    var vw = document.documentElement.clientWidth || 0;
    if (!vw) return WMAX_PX;
    return Math.max(colMin(view)[i], vw - (totalOf(view) - (colWs(view)[i] === null ? colMin(view)[i] : colWs(view)[i])));
  }
  // 窗口变小之后，之前拖宽的列要收回窗口里，从右往左收，收到各自的底线为止。
  function clampCols() {
    var vw = document.documentElement.clientWidth || 0;
    if (!vw) return false;
    var views = ['list', 'detail'], changed = false, v, j;
    for (v = 0; v < views.length; v++) {
      var view = views[v], ws = colWs(view), lo = colMin(view);
      var over = totalOf(view) - vw;
      for (j = ws.length - 1; j >= 0 && over > 0; j--) {
        if (ws[j] === null) continue;
        var cut = Math.min(ws[j] - lo[j], over);
        if (cut <= 0) continue;
        ws[j] -= cut;
        over -= cut;
        changed = true;
        setColVar(view, j, ws[j]);
      }
    }
    return changed;
  }
  function colVarNames(view) {
    var p = view === 'detail' ? 'wd' : 'wl', out = [], i;
    for (i = 0; i < colWs(view).length; i++) out.push(p + (i + 1));
    return out;
  }
  var COLW = 'var(--fz-wd1,30px) var(--fz-wd2,74px) var(--fz-wd3,150px) ' +
    'minmax(var(--fz-wd4,300px),1fr) var(--fz-wd5,108px) var(--fz-wd6,74px) var(--fz-wd7,118px)';
  // 瀑布流：行号 赞 评论 收藏 类型 标题 作者 时间
  var COLW_LIST = 'var(--fz-wl1,30px) var(--fz-wl2,64px) var(--fz-wl3,52px) ' +
    'minmax(var(--fz-wl4,280px),1fr) var(--fz-wl5,140px) var(--fz-wl6,92px)';

  var CSS = [
    'html.fz,html.fz body{background:#fff !important;}',
    'html.fz body{padding-top:' + HEAD_H + 'px !important;padding-bottom:' + FOOT_H + 'px !important;min-height:calc(100vh + 160px) !important;min-height:calc(100vh + 160px) !important;font-family:"Microsoft YaHei","PingFang SC",-apple-system,sans-serif !important;color:#222;font-size:12px;}',
    // 滚动条（v0.97）。站点把 html 和 body 都设成 overflow:hidden，表格长过一屏时既没有滚动条、
    // 滚轮也滚不动（只能靠键盘/脚本滚）。表格是我们自己的长列表，得能滚、而且看得见能滚到哪。
    // 这里只开竖向：横向我们自己按列宽处理，开了反而会多一条没用的横条。
    'html.fz{overflow-y:scroll !important;overflow-x:hidden !important;}',
    'html.fz body{overflow:visible !important;}',
    'html.fz{scrollbar-width:thin;scrollbar-color:#c8ccce #f3f4f4;}',
    'html.fz::-webkit-scrollbar{width:14px;height:14px;background:#f3f4f4;}',
    'html.fz::-webkit-scrollbar-track{background:#f3f4f4;}',
    'html.fz::-webkit-scrollbar-thumb{background:#c8ccce;border:3px solid #f3f4f4;border-radius:7px;}',
    'html.fz::-webkit-scrollbar-thumb:hover{background:#a9aeb1;}',
    // 详情表是自己的滚动容器（.fz-notesheet，position:fixed + overflow:auto），同样的条
    '.fz-notesheet{scrollbar-width:thin;scrollbar-color:#c8ccce #f3f4f4;}',
    '.fz-notesheet::-webkit-scrollbar{width:14px;height:14px;background:#f3f4f4;}',
    '.fz-notesheet::-webkit-scrollbar-track{background:#f3f4f4;}',
    '.fz-notesheet::-webkit-scrollbar-thumb{background:#c8ccce;border:3px solid #f3f4f4;border-radius:7px;}',
    '.fz-notesheet::-webkit-scrollbar-thumb:hover{background:#a9aeb1;}',
    'html.fz ::selection{background:#d7e7ff;}',
    // 隐藏用户头像（v0.98）：表格里本来就不画头像，这条兜住"哪行落了头像图"；
    // 主要是让位回原生界面时管用——那边是真的一屏头像。html 上有 .fz-showavatar 就整条失效。
    'html.fz:not(.fz-showavatar) .fz-cells img,html.fz:not(.fz-showavatar) .fz-a img{display:none !important;}',
    'html.fz:not(.fz-showavatar) img[src*="avatar"],html.fz:not(.fz-showavatar) img[src*="Avatar"],' +
      'html.fz:not(.fz-showavatar) [class*="avatar"] img,html.fz:not(.fz-showavatar) [class*="Avatar"] img' +
      '{visibility:hidden !important;}',

    '.fz-chrome{position:fixed;left:0;right:0;z-index:2147483000;background:#fff;box-sizing:border-box;}',
    '.fz-head{top:0;height:86px;}',
    '.fz-thead{position:fixed;left:0;right:0;top:104px;height:24px;display:grid;background:#eef1f5;border-bottom:1px solid #c9ced6;font-size:12px;color:#333;font-weight:600;}',
    '.fz-thead span{line-height:23px;padding:0 7px;border-right:1px solid #d9dee5;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;box-sizing:border-box;}',
    '.fz-thead span.on{background:#dbe5f1;}',
    '.fz-letters{top:86px;height:18px;display:grid;grid-auto-rows:18px;grid-template-columns:' + COLW + ';background:#f5f5f5;border-top:1px solid #d0d0d0;border-bottom:1px solid #d0d0d0;overflow:hidden;}',
    '.fz-letter{text-align:center;line-height:17px;font-size:10px;color:#777;border-right:1px solid #e2e2e2;box-sizing:border-box;overflow:hidden;}',
    '.fz-letter.on{background:#e2efda;color:#375623;font-weight:700;box-shadow:inset 0 0 0 1px #70ad47;}',
    '.fz-letter.fz-corner{background:#e9e9e9;position:relative;}',
    '.fz-letter.fz-corner::after{content:"";position:absolute;right:4px;bottom:4px;width:0;height:0;border-left:5px solid transparent;border-bottom:5px solid #9a9a9a;}',
    '.fz-ready{font-size:11px;color:#777;margin-right:8px;}',
    // Excel 的状态栏会在右下角报选区的平均值/计数/求和；这里是同一件事（只有赞这一列是数字）。
    // 没选中、或者选中的格子里一个数字都没有时，整块不占位。
    '.fz-sel-stat{font-size:11px;color:#666;padding-right:10px;white-space:nowrap;}',
    '.fz-sel-stat:empty{display:none;}',
    '.fz-foot{bottom:0;height:' + FOOT_H + 'px;border-top:1px solid #d0d0d0;display:flex;align-items:center;gap:6px;padding:0 8px;font-size:11px;color:#555;background:#f5f5f5;}',

    '.fz-t1{height:30px;display:flex;align-items:center;gap:8px;padding:0 10px;box-sizing:border-box;border-bottom:1px solid #e2e2e2;}',
    '.fz-app{width:15px;height:15px;border-radius:2px;background:#217346;flex:0 0 15px;position:relative;}',
    '.fz-app::after{content:"";position:absolute;left:3px;top:3px;right:3px;bottom:3px;border:1px solid rgba(255,255,255,.9);}',
    '.fz-file{font-size:12px;font-weight:600;color:#333;}',
    '.fz-star{color:#bbb;font-size:11px;}',
    '.fz-hint{font-size:11px;color:#999;}',
    '.fz-sp{flex:1;}',
    '.fz-user,.fz-t1item{font-size:11px;color:#666;}',
    '.fz-authslot{display:flex;align-items:center;gap:6px;}',
    // 顶栏那个小头像：16px 圆形，visibility 顶住站点给所有 img 盖的 inline hidden
    '.fz-uav{width:16px;height:16px;border-radius:50%;object-fit:cover;flex:0 0 16px;' +
      'visibility:visible !important;background:#e8ebee;}',
    '.fz-user{max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.fz-authbtn{cursor:pointer;padding:0 4px;border-radius:2px;}',
    '.fz-authbtn:hover{color:#217346;background:#eff6ef;}',
    '.fz-search{width:168px;height:20px;border:1px solid #dcdcdc;border-radius:2px;background:#fff;font-size:11px;color:#333;padding:0 6px;outline:none;box-sizing:border-box;font-family:inherit;}',
    '.fz-search::placeholder{color:#aaa;}',
    '.fz-search:focus{border-color:#217346;}',
    'html.fz.fz-table .fz-row.fz-hide{display:none !important;}',

    // ---- 左上角伪装工具条（v0.99）----
    // 排法照腾讯文档那一路：一排等高的小方块，图标和文字同一个字号，分组之间一条细竖线。
    // 尺寸只认下面这三个变量，改一处整条一起变；窄屏只丢东西、不缩字号（缩了就糊）。
    '.fz-t2{--fz-ctl-h:20px;--fz-ctl-fs:12px;--fz-ctl-pad:7px;height:26px;display:flex;align-items:center;gap:2px;padding:0 8px;box-sizing:border-box;border-bottom:1px solid #e2e2e2;overflow:hidden;}',
    '.fz-namebox{min-width:56px;height:var(--fz-ctl-h);line-height:calc(var(--fz-ctl-h) - 2px);box-sizing:border-box;border:1px solid #d0d0d0;border-radius:2px;font-size:var(--fz-ctl-fs);color:#333;padding:0 6px;text-align:center;margin-right:2px;background:#fff;white-space:nowrap;}',
    '.fz-tab{display:inline-flex;align-items:center;height:var(--fz-ctl-h);font-size:var(--fz-ctl-fs);color:#444;padding:0 var(--fz-ctl-pad);border-radius:2px;white-space:nowrap;}',
    '.fz-tab.on{color:#217346;font-weight:600;background:#eaf3ec;box-shadow:inset 0 -2px 0 #217346;}',
    '.fz-cats{display:inline-flex;align-items:center;gap:2px;min-width:0;overflow:hidden;}',
    '.fz-cat{display:inline-flex;align-items:center;height:var(--fz-ctl-h);font-size:var(--fz-ctl-fs);color:#555;padding:0 var(--fz-ctl-pad);border-radius:2px;text-decoration:none;white-space:nowrap;}',
    '.fz-cat:hover{background:#eaeaea;color:#217346;}',
    // 所有方块一套尺寸：高度、字号、圆角、竖直对齐完全一致；宽度随文字长短（工具栏本来就该这样）
    '.fz-tb{display:inline-flex;align-items:center;justify-content:center;min-width:var(--fz-ctl-h);height:var(--fz-ctl-h);box-sizing:border-box;font-size:var(--fz-ctl-fs);line-height:1;color:#444;padding:0 6px;border-radius:2px;white-space:nowrap;}',
    '.fz-tb:hover{background:#eaeaea;}',
    '.fz-deco-g,.fz-deco-x{display:inline-flex;align-items:center;gap:2px;}',
    // ---- 伪装区 vs 工具区（v0.92）----
    // 左边一整条是表格的样子货：不吃鼠标、看着就是装饰；右边一小撮才是真能用的。
    // 伪装区可以缩、可以裁：窗口窄的时候先牺牲它，绝不能把右边「工具」挤出去
    '.fz-deco{display:inline-flex;align-items:center;gap:2px;pointer-events:none;min-width:0;overflow:hidden;flex:0 1 auto;}',
    '.fz-deco .fz-tb:hover{background:transparent;}',
    '.fz-tools{margin-left:auto;display:inline-flex;align-items:center;gap:2px;height:22px;flex:0 0 auto;' +
      'padding:0 6px 0 2px;border:1px solid #b9d3bf;border-radius:3px;background:#f1f8f3;' +
      'box-shadow:inset 0 1px 0 #fff;}',
    // 「工具」两个字也跟按钮同字号：只靠颜色和竖线区分，不靠"字小一号"
    '.fz-tool-tag{font-size:12px;line-height:20px;color:#2f7a52;letter-spacing:.5px;' +
      'padding:0 5px 0 4px;margin-right:1px;border-right:1px solid #cfe3d6;}',
    // 工具组里的按钮和伪装区同高（20），只是颜色不同；容器 22 = 20 + 上下边框
    '.fz-tools .fz-tb{color:#1b5e3a;font-weight:600;height:20px;}',
    '.fz-tools .fz-tb:hover{background:#dcece2;}',
    '.fz-tools .fz-filtermk{padding:0 5px;}',
    '.fz-tools .fz-filtermk.on{background:#cfe8d8;box-shadow:inset 0 0 0 1px #8fbfa3;}',
    // ---- 窄屏：按优先级丢东西，绝不缩字号（v0.99）----
    // 1366 是最常见的办公本宽度，先把分类收到 5 个；再窄才整组丢掉第二组，最后连分类都不要。
    '@media (max-width:1440px){.fz-cats .fz-cat:nth-child(n+7){display:none;}}',
    '@media (max-width:1366px){.fz-cats .fz-cat:nth-child(n+6){display:none;}}',
    '@media (max-width:1240px){.fz-deco-x{display:none;}}',
    '@media (max-width:1080px){.fz-cats{display:none;}}',
    '.fz-filtermk{color:#217346;font-weight:600;padding:0 6px;}',
    '.fz-filtermk.on{background:#e3efe0;box-shadow:inset 0 0 0 1px #b9d3bf;}',
    // 加粗 / 斜体 / 下划线这三个按钮的类名**不能叫 .fz-b / .fz-i / .fz-u**：
    // .fz-b 是单元格"B 列"的类，那条规则写的是 calc(12.5px * 缩放)，会把按钮字号一起带跑
    // （缩到 80% 时 B 变成 10px，旁边 I/U 还是 11px —— 这就是"按钮大小不一样"的根）。
    '.fz-tbb{font-weight:700;}',
    '.fz-tbi{font-style:italic;font-family:Georgia,serif;}',
    '.fz-tbu{text-decoration:underline;}',
    '.fz-weak{color:#666;}',
    '.fz-pick{border:1px solid #dcdcdc;border-radius:2px;padding:0 5px;margin:0 3px;}',
    '.fz-tsep{width:1px;height:14px;background:#e2e2e2;margin:0 5px;flex:0 0 1px;}',
    '.fz-caret{display:inline-block;width:0;height:0;border-left:3px solid transparent;border-right:3px solid transparent;border-top:3px solid #aaa;margin-left:3px;vertical-align:middle;}',
    '.fz-swatch{display:inline-block;width:9px;height:2px;background:#c00;margin-left:1px;vertical-align:baseline;}',

    '.fz-t3{height:30px;display:flex;align-items:center;gap:6px;padding:0 8px;box-sizing:border-box;border-bottom:1px solid #d0d0d0;}',
    '.fz-ref{min-width:56px;height:20px;line-height:18px;text-align:center;border:1px solid #d0d0d0;border-radius:2px;font-size:11px;color:#333;}',
    '.fz-fx{color:#888;font-style:italic;font-family:Georgia,serif;font-size:11px;padding:0 4px;}',
    '.fz-input{flex:1;height:20px;border-bottom:1px solid #e8e8e8;}',

    '.fz-sheet{height:22px;line-height:22px;padding:0 10px;background:#fff;border:1px solid #d0d0d0;border-bottom:none;font-size:11px;color:#333;}',
    '.fz-sheet.on{box-shadow:inset 0 -2px 0 #217346;color:#217346;}',
    '.fz-addtab{width:18px;height:18px;line-height:16px;text-align:center;border:1px solid #dcdcdc;background:#fff;border-radius:2px;color:#666;}',
    '.fz-zoom,.fz-pct{color:#555;}',

    'html.fz.fz-table .fz-rows{display:block !important;position:static !important;height:auto !important;max-height:none !important;min-height:0 !important;overflow:visible !important;column-count:1 !important;column-gap:0 !important;column-width:auto !important;grid-template-columns:none !important;grid-auto-flow:row !important;flex-direction:column !important;flex-wrap:nowrap !important;align-items:stretch !important;padding:0 !important;margin:0 !important;transform:none !important;}',
    // 注意排除 .fz-src：源列表是被隐藏的"数据源"，必须保持它原本的瀑布流布局，
    // 否则容器高度会塌陷、滚不动，站点的"加载更多"就永远不触发
    'html.fz.fz-table .fz-rows:not(.fz-src) > *{display:block !important;position:static !important;left:auto !important;top:auto !important;right:auto !important;bottom:auto !important;transform:none !important;width:100% !important;max-width:none !important;min-width:0 !important;height:auto !important;max-height:none !important;margin:0 !important;float:none !important;clear:both !important;inset:auto !important;}',
    'html.fz.fz-table .fz-row{display:block !important;position:relative !important;left:auto !important;top:auto !important;right:auto !important;bottom:auto !important;transform:none !important;width:100% !important;max-width:none !important;min-width:0 !important;height:auto !important;min-height:0 !important;max-height:none !important;overflow:visible !important;border-bottom:1px solid #d0d0d0 !important;background:#fff !important;border-radius:0 !important;box-shadow:none !important;float:none !important;margin:0 !important;}',
    // 原卡片内容：透明但保留在行内，真实点击落上去，交给站点自己的跳转逻辑
    'html.fz.fz-table .fz-row > *:not(.fz-cells){position:absolute !important;left:0 !important;top:0 !important;right:auto !important;bottom:auto !important;width:100% !important;height:100% !important;margin:0 !important;padding:0 !important;opacity:0 !important;overflow:hidden !important;pointer-events:none !important;z-index:1 !important;transform:none !important;}',
    'html.fz.fz-table .fz-row > *:not(.fz-cells) a{display:block !important;width:100% !important;height:100% !important;}',

    // 缩放：全表尺寸都乘一个 --fz-z（默认 1）。用 calc 而不是改 px 字面量，
    // 自测就能比较"缩放前后 .fz-cells 的实际字号"来判断它是不是真的动了
    '.fz-cells{display:grid;position:relative;z-index:2;pointer-events:auto;grid-template-columns:' + COLW + ';align-items:stretch;font-size:calc(14px * var(--fz-z,1));color:#222;cursor:cell;min-height:calc(46px * var(--fz-z,1));}',
    'html.fz-demo .fz-cells{pointer-events:auto;}',
    '.fz-c{padding:calc(6px * var(--fz-z,1)) calc(7px * var(--fz-z,1));border-right:1px solid #d0d0d0;box-sizing:border-box;overflow:hidden;line-height:1.55;word-break:break-all;}',
    '.fz-num{color:#888;text-align:center;background:#f7f7f7;padding:calc(6px * var(--fz-z,1)) 2px;}',
    '.fz-a b{display:block;font-weight:400;color:#1a1a1a;font-size:calc(13.5px * var(--fz-z,1));margin-bottom:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    // 用户名（v0.98）：能点，但别把整张表刷成蓝色。平时深色 + 虚线底，悬停才变蓝，
    // 和标题那种"一眼就是链接"的入口区分开。
    '.fz-a .fz-uname{color:#1a1a1a;text-decoration:none;border-bottom:1px dashed #c3ccd6;cursor:pointer;}',
    '.fz-a .fz-uname:hover{color:#0563c1;border-bottom-color:#0563c1;background:#eef4fb;}',
    '.fz-a .fz-uname:focus{outline:2px solid #217346;outline-offset:1px;}',
    '.fz-a span{display:block;font-size:calc(11.5px * var(--fz-z,1));line-height:1.35;color:#888;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.fz-b,.fz-c,.fz-d,.fz-hash{font-size:calc(12.5px * var(--fz-z,1));color:#555;}',
    '.fz-e{display:flex;flex-direction:column;gap:3px;}',
    '.fz-brow .fz-c.fz-e{display:block;}',
    '.fz-brow .fz-cells{grid-template-columns:' + COLW_LIST + ';min-height:calc(34px * var(--fz-z,1));}',
    '.fz-brow .fz-c.fz-e{display:block;}',
    '.fz-reply{font-style:normal;color:#b8bcc4;margin-right:2px;}',
    '.fz-et{font-weight:400;color:#1a1a1a;font-size:14px;}',
    // 列表里的标题是唯一入口，得看得出能点：链接色 + 下划线，悬停给一块浅蓝底。
    // 不加粗：标题和同一格里的「封面图 / 图2」一样是细体蓝字，靠位置和悬停区分，
    // 整张表看起来更像真的表格。padding/margin 一正一负，点击区比文字宽一点但不撑高行。
    '.fz-c .fz-title{display:inline-block;max-width:100%;padding:1px 4px;margin:-1px -4px;border-radius:2px;color:#0563c1;font-weight:400;cursor:pointer;}',
    '.fz-c .fz-title:hover{background:#e8f1fd;}',
    '.fz-c .fz-title[data-fz-untitled]{color:#5b6b7a;border-bottom-style:dashed;}',
    '.fz-es{color:#555;font-size:14px;line-height:1.45;max-height:42px;overflow:hidden;white-space:pre-wrap;}',
    '.fz-at{font-weight:400;color:#0563c1;}',
    '.fz-el{display:flex;flex-wrap:wrap;gap:10px;font-size:13px;}',
    '.fz-el.fz-el-inline{display:inline;margin-left:8px;}',
    '.fz-el.fz-el-inline .fz-link{margin-right:6px;}',
    '.fz-o,.fz-p{font-size:12.5px;color:#666;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '@keyframes fzblink{50%{border-color:transparent;}}',
    '.fz-vbox{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.82);display:flex;align-items:center;justify-content:center;}',
    '.fz-vwrap{position:relative;width:min(880px,88vw);height:min(560px,78vh);background:#000;border-radius:6px;overflow:hidden;box-shadow:0 10px 44px rgba(0,0,0,.55);}',
    '.fz-vclose{position:absolute;right:10px;top:4px;color:#fff;font-size:24px;line-height:1;cursor:pointer;z-index:3;text-shadow:0 1px 3px rgba(0,0,0,.8);}',
    '.fz-vtip{position:absolute;left:12px;bottom:6px;color:rgba(255,255,255,.6);font-size:12px;z-index:3;pointer-events:none;}',
    '.fz-link.fz-vplay{color:#0563c1;}',
    '.fz-x{display:flex;gap:8px;align-items:center;font-size:12.5px;color:#888;white-space:nowrap;}',
    '.fz-x .fz-act{font-size:11px;}',
    '.fz-row:hover .fz-c{background:#f4f9ff;}',
    '.fz-row:hover .fz-num{background:#eef4ea;}',
    // 选中的整行（点行号）：Excel 里行号会被填成深绿、整行淡绿
    '.fz-selrow .fz-c{background:#e8f2e2;}',
    '.fz-row.fz-selrow .fz-num,.fz-nrow.fz-selrow .fz-num{background:#217346 !important;color:#fff;font-weight:600;}',
    '.fz-selrow{box-shadow:inset 0 0 0 2px #217346;}',

    '.fz-board{display:block !important;width:100% !important;margin:0 !important;padding:0 !important;}',
    // 源列表必须留在视口内：小红书用 IntersectionObserver 观察底部哨兵来加载更多，
    // 放到视口外（left:-20000px）就永远不会触发，表现为"滚到 30 行就不动了"。
    // 特异性必须压过上面的 .fz-rows{position:static !important}
    // 源列表平时收成一个隐形的 240px 窗口：不占位、不会在表格下面留出一大片空白，
    // 但卡片仍然完整渲染（作者/赞数这些还得从 DOM 读）。
    // 只有"拉取下一页"的那几秒才临时放进文档流（.fz-src-flow），因为站点翻页靠 window 滚动。
    'html.fz.fz-table .fz-rows.fz-src{position:fixed !important;left:0 !important;top:0 !important;right:auto !important;bottom:auto !important;width:100% !important;height:240px !important;max-height:none !important;overflow:auto !important;display:block !important;opacity:0 !important;pointer-events:none !important;z-index:-1 !important;}',
    'html.fz.fz-table .fz-rows.fz-src.fz-src-flow{position:static !important;height:auto !important;max-height:none !important;overflow:visible !important;z-index:0 !important;}',
    // 拉取下一页时把表格钉住，窗口在底下滚，画面不动
    // 拉取时盖住滚动过程：画成"空表格 + 计算中"，比纯白屏稳当得多
    '.fz-cover{position:fixed;left:0;right:0;top:' + HEAD_H + 'px;bottom:' + FOOT_H + 'px;background:#fff;z-index:2147483000;overflow:hidden;pointer-events:none;}',
    '.fz-cover-inner{position:absolute;left:0;right:0;top:0;pointer-events:none;}',
    // 以前那句小药丸被现在的 .fz-busy 卡片取代了：留着它只会在顶上飘一句没头没尾的话
    '.fz-cover-tip{display:none;}',
    // 让位期间（点赞/收藏/回复/登录）浮一个"回到表格"：
    // 让位是我们主动把伪装层收起来的，用户这时候手里必须有个明确的回头路。
    // 位置取屏幕正中：右下角那片会被站点自己的浮标（头像/客服/发布）压住，
    // 而且回复框在下方，中间这块是唯一"一眼就看见、又不会挡住输入"的地方。
    // z-index 必须比 #fz-dim（压暗层 2147483646）高一档，否则按钮被半透明黑盖暗。
    // 尺寸给足（14px / padding 12×20）：这是个"逃生口"，要一眼看见，不能像个小标签
    '.fz-back{position:fixed;left:50%;top:50%;z-index:2147483647;display:flex;align-items:center;gap:9px;' +
      'background:#217346;color:#fff;font-size:14px;font-weight:600;line-height:1;padding:12px 20px;' +
      'border-radius:24px;box-shadow:0 8px 24px rgba(0,0,0,.32);cursor:pointer;' +
      'user-select:none;-webkit-user-select:none;' +
      // 居中靠 translate(-50%,-50%)，所以 hover/active 的位移必须叠在它上面，不能直接写 translateY
      'transform:translate(-50%,-50%);transition:background .12s,transform .12s;}',
    '.fz-back:hover{background:#1b5e3a;transform:translate(-50%,calc(-50% - 2px));}',
    '.fz-back:active{transform:translate(-50%,-50%);}',
    '.fz-back:focus{outline:2px solid #fff;outline-offset:2px;}',
    '.fz-pullmask{position:fixed;left:0;right:0;top:' + HEAD_H + 'px;bottom:' + FOOT_H + 'px;z-index:2147482000;' +
      'background-color:#fff;' +
      'background-image:repeating-linear-gradient(to bottom,#fff 0,#fff 24px,#ededed 24px,#ededed 25px),' +
      'linear-gradient(to right,#f6f6f6 0,#f6f6f6 56px,#e0e0e0 56px,#e0e0e0 57px,#fff 57px);' +
      'background-repeat:repeat,no-repeat;background-position:0 0,0 0;' +
      'padding:6px 0 0 70px;font-size:12px;color:#b0b0b0;letter-spacing:.5px;}',
    '.fz-nfill{display:block !important;}',
    '.fz-frow{display:grid;grid-template-columns:' + COLW + ';height:26px;border-bottom:1px solid #e8e8e8;background:#fff;}',
    '.fz-frow > i{font-style:normal;height:26px;line-height:26px;border-right:1px solid #e8e8e8;font-size:11px;color:#bbb;text-align:center;box-sizing:border-box;}',
    '.fz-frow > i:first-child{background:#f7f7f7;}',

    '.fz-link{color:#0563c1;cursor:pointer;text-decoration:none;border-bottom:1px solid rgba(5,99,193,.25);pointer-events:auto;}',
    '.fz-link:hover{color:#0a4b96;border-bottom-color:#0a4b96;}',
    '.fz-imglink{display:inline-block;font-size:11.5px;padding:0 1px;}',
    '.fz-mdim{color:#aaa;font-size:11px;}',

    '.fz-notesheet{position:fixed;left:0;right:0;top:' + HEAD_H + 'px;bottom:' + FOOT_H + 'px;background:#fff;z-index:2147482000;overflow:auto;border-top:1px solid #d0d0d0;}',
    '.fz-ns-bar{display:flex;align-items:center;height:28px;padding:0 8px;border-bottom:1px solid #e2e2e2;background:#f7f7f7;font-size:11px;color:#666;}',
    '.fz-ns-x{color:#0563c1;cursor:pointer;margin-left:14px;}',
    '.fz-ns-dim{color:#999;}',
    '.fz-ns-back{color:#0563c1;cursor:pointer;margin-right:10px;white-space:nowrap;}',
    '.fz-ns-back:hover{text-decoration:underline;}',
    // 头像（v1.0）：默认不画，关掉「隐藏用户头像」才出现
    // visibility 必须 !important：站点给页面上每张 img 都盖了 inline 的 visibility:hidden
    // （和看图浮层那个白框是同一个坑），不顶回来头像就是"有尺寸但看不见"。
    '.fz-av{width:14px;height:14px;border-radius:2px;object-fit:cover;vertical-align:-2px;margin-right:4px;background:#eef1f3;visibility:visible !important;}',
    '.fz-a .fz-aname{display:flex;align-items:center;gap:3px;min-width:0;}',
    '.fz-a .fz-aname b{min-width:0;}',
    // 「楼主」标记：淡黄底 + 棕字，和绿色的「N楼」区分开
    '.fz-op{font-style:normal;font-size:10px;line-height:13px;padding:0 3px;border-radius:2px;' +
      'background:#fff1d6;color:#a05a00;border:1px solid #f0d9a8;margin-left:3px;flex:0 0 auto;}',
    '.fz-nrow.fz-oprow{background:#fffaf0;}',
    '.fz-nrow.fz-oprow .fz-num{color:#a05a00;}',
    // 详情页三个开关走 html 上的类，改完不用重画整张表
    // 「详情页不着色」：有回复楼层的浅绿底、楼主的淡黄底和棕标一起去掉（只留左边那条绿线）
    'html.fz-notint .fz-nrow.fz-haskid,html.fz-notint .fz-nrow.fz-oprow{background:transparent !important;}',
    'html.fz-notint .fz-op{background:transparent !important;color:#666 !important;border-color:#ddd !important;}',
    'html.fz-notint .fz-nrow.fz-oprow .fz-num{color:#777 !important;}',
    'html.fz-nofloor .fz-nrow .fz-fl{display:none !important;}',
    // 不标蓝：两条独立规则（标题一条、图片/视频一条）
    'html.fz-plaintitle .fz-c .fz-title{color:inherit !important;border-bottom-color:transparent !important;}',
    'html.fz-plainimg .fz-c .fz-link[data-i],html.fz-plainimg .fz-c .fz-vplay' +
      '{color:inherit !important;border-bottom-color:transparent !important;}',
    // 详情表打开时页面本身不滚：只留详情表那条滚动条
    'html.fz-hassheet{overflow:hidden !important;}',
    // 兜底：表格模式下，body 底下不是我们自己的东西一律看不见（visibility 保留布局，
    // 站点自己的懒加载/翻页还要靠这些盒子的尺寸）。让位给原生界面时不套这条。
    // 以前是逐个 hideEl，站点一重渲染新节点就会闪一下（banner 文字偶尔冒出来就是这么来的）。
    // 判据就是"类名里带 fz-"：我们自己的壳、弹层（.fz-filtmenu / .fz-menu / .fz-set / .fz-ctx …）
    // 全带，站点的东西不带。别写成一个个 :not() 白名单 —— 漏掉一个弹层就会变成
    // "看不见也点不动"（隐藏元素是没法 focus 的，筛选面板当场就用键盘走不了）。
    'html.fz.fz-table:not(.fz-yield) body > *:not([class*="fz-"])' +
      '{visibility:hidden !important;}',

      '.fz-qnav{margin-left:14px;white-space:nowrap;}',
      '.fz-qnav .fz-link{margin-right:10px;}',
      '.fz-qdim{color:#999;margin-right:10px;}',
    '.fz-ns-tags{color:#0563c1;margin-left:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:38%;}',
    '.fz-nrow{border-bottom:1px solid #d0d0d0;}',
    // ---- 楼层骨架（v0.93）：楼与楼之间拉开、有回复的楼整行标出来 ----
    // 用 inset box-shadow 而不是 border：border 会把整行往右推 1~3px，和表头对不齐
    '.fz-nrow.fz-floor,.fz-nrow.fz-haskid{box-shadow:inset 0 2px 0 #e3e8ee;}',
    '.fz-nrow.fz-haskid{background:#eef8f2;box-shadow:inset 4px 0 0 #217346, inset 0 2px 0 #cfe6d8;}',
    // 徽标 + 作者名放同一行（作者名还是 block，塞进 flex 里当弹性项）
    // 注意选择器要写成 .fz-a .fz-aname：`.fz-a span{display:block}` 比单个类名更具体，
    // 只写 .fz-aname 会被它按回 block（徽标就又被挤到上一行了）
    '.fz-a .fz-aname{display:flex;align-items:center;min-width:0;}',
    '.fz-aname b{flex:1 1 auto;min-width:0;}',
    '.fz-nrow.fz-haskid .fz-num{color:#2f8a58;font-weight:600;}',
    // 「N楼」徽标：没回复是灰的，有回复变绿（和左边那条绿边呼应）
    '.fz-fl{display:inline-block;font-style:normal;font-size:10px;line-height:14px;padding:0 4px;' +
      'margin-right:5px;border-radius:3px;background:#eef2f5;color:#7b8794;font-weight:600;' +
      'vertical-align:1px;white-space:nowrap;}',
    '.fz-fl.has{background:#dcecdf;color:#1b5e3a;}',
    '.fz-nrow.fz-haskid .fz-a b{color:#123f27;}',
    '.fz-nrow .fz-cells{min-height:0;}',
    '.fz-nrow.fz-main .fz-cells{min-height:104px;}',
    '.fz-nrow .fz-es{max-height:none;}',
    '.fz-cmts{display:block !important;}',
    '.fz-nrow:hover .fz-c{background:#f4f9ff;}',
    '.fz-nrow.fz-lv1 .fz-e{padding-left:20px;border-left:2px solid #d9e6f2;}',
    '.fz-nrow.fz-lv2 .fz-e{padding-left:38px;border-left:2px solid #cfe0ef;}',
    '.fz-nrow.fz-lv3 .fz-e{padding-left:56px;border-left:2px solid #c6d9ea;}',
    '.fz-nrow.fz-lv1 .fz-a b,.fz-nrow.fz-lv2 .fz-a b,.fz-nrow.fz-lv3 .fz-a b{font-weight:400;color:#555;}',
    '.fz-nrow.fz-lv1 .fz-num,.fz-nrow.fz-lv2 .fz-num,.fz-nrow.fz-lv3 .fz-num{color:#a8b3bd;}',

    // 每楼最底部那条「展开 N 条回复 / 再加载几条 / 收起回复」（v0.95）。
    //   左边那条浅绿竖线是故意接在 .fz-haskid 的绿边下面的：一眼看得出这行属于上面那一楼。
    //   用 grid-column 把按钮钉在第 4 列（内容列）的起点，这样用户拖列宽时它会跟着走，不用算像素。
    '.fz-trow{border-bottom:1px solid #d0d0d0;background:#f7fbf9;box-shadow:inset 4px 0 0 #cfe6d8;}',
    '.fz-trow .fz-cells{min-height:0;align-items:center;}',
    '.fz-trow .fz-tg{grid-column:4 / -1;display:flex;align-items:center;gap:8px;padding:2px 8px 3px 20px;background:none;border-right:0;overflow:visible;}',
    '.fz-trow .fz-toggle{font-size:calc(12px * var(--fz-z,1));line-height:1.9;}',

    '.fz-viewer{position:fixed;z-index:2147483002;background:#fff;border:1px solid #d0d0d0;border-radius:3px;padding:6px;box-sizing:border-box;overflow:auto;box-shadow:0 4px 18px rgba(0,0,0,.18);font-size:11px;}',
    '.fz-v-hd{display:flex;align-items:center;gap:10px;padding:0 2px 5px;color:#666;border-bottom:1px solid #eee;margin-bottom:6px;}',
    '.fz-v-hd b{font-weight:600;color:#222;}',
    '.fz-v-x{margin-left:auto;color:#0563c1;cursor:pointer;}',
    '.fz-v-nav{display:flex;align-items:center;gap:2px;margin-left:8px;color:#888;font-size:12px;}',
    '.fz-v-nav i{font-style:normal;cursor:pointer;color:#0563c1;padding:0 5px;border-radius:3px;font-size:14px;}',
    '.fz-v-nav i:hover{background:#eef4fb;}',
    '.fz-v-pos{min-width:30px;text-align:center;font-variant-numeric:tabular-nums;}',
    '.fz-morerow{display:block !important;padding:7px 10px;border-bottom:1px solid #d0d0d0;background:#fff;font-size:12px;color:#666;}',
    '.fz-morebar{display:flex !important;align-items:center;gap:10px;}',
    '.fz-morerow .fz-link{margin-right:12px;}',
    // 登录/登出时临时让位：藏起伪装层，露出原生界面
    'html.fz-yield .fz-chrome,html.fz-yield .fz-board,html.fz-yield .fz-notesheet,' +
    'html.fz-yield .fz-morerow,html.fz-yield .fz-filler,html.fz-yield .fz-src,html.fz-yield .fz-viewer{display:none !important;}',
    'html.fz-yield body{padding-top:0 !important;}',
    'html.fz-yield body .fz-toast{display:block !important;}',
    '.fz-toast{position:fixed;left:50%;transform:translateX(-50%);bottom:60px;z-index:2147483647;background:rgba(30,30,30,.9);color:#fff;font-size:12px;padding:8px 16px;border-radius:4px;}',
    // 让位期间表头/列号条/表尾（都挂 .fz-chrome）整层被藏起来了，遮罩却只铺中间那一条：
    // 顶上 HEAD_H 和底下 FOOT_H 会露出原生网页，一眼就穿帮。铺满整屏。
    'html.fz-yield .fz-cover{top:0 !important;bottom:0 !important;}',
    // 拉取时"让位"只是为了让站点量得准，用户完全不需要看见原生界面：
    // 保留工具条/列号条/表尾，遮罩就还铺原来那一条中间带，屏幕一点都不变
    // 逐个还回各层自己的 display：一刀切成 block 会把表头的 grid 打散
    // （列宽全塌，表头挤成一小撮，真机上就是这么露馅的）
    'html.fz-yield.fz-keepchrome .fz-head{display:block !important;}',
    'html.fz-yield.fz-keepchrome .fz-letters{display:grid !important;}',
    'html.fz-yield.fz-keepchrome .fz-thead{display:grid !important;}',
    'html.fz-yield.fz-keepchrome .fz-foot{display:flex !important;}',
    'html.fz-yield.fz-keepchrome .fz-cover{top:' + HEAD_H + 'px !important;bottom:' + FOOT_H + 'px !important;}',
    // 遮罩里那份"表格克隆"本身就是给用户看的画面，不能跟着 .fz-board 一起被藏
    'html.fz-yield .fz-cover .fz-board{display:block !important;}',
    // 「正在加载」：整屏半透明幕 + 居中的卡片（转圈 + 主文案 + 小字），
    // 让位期间也照样显示（所以不能挂 .fz-chrome/.fz-board 这类会被 yield 藏掉的类）
    '.fz-busy{position:fixed;left:0;right:0;top:0;bottom:0;z-index:2147483400;background:rgba(255,255,255,.62);' +
      'display:flex;align-items:center;justify-content:center;pointer-events:none;}',
    '.fz-busy-card{background:#fff;border:1px solid #c9ced6;border-radius:4px;box-shadow:0 8px 28px rgba(0,0,0,.18);' +
      'min-width:268px;max-width:min(420px,86vw);padding:14px 18px 13px;display:flex;align-items:flex-start;gap:11px;' +
      'font-size:12.5px;color:#222;box-sizing:border-box;}',
    '.fz-busy-spin{flex:0 0 18px;width:18px;height:18px;margin-top:1px;border:2px solid #d8e6dc;' +
      'border-top-color:#217346;border-radius:50%;animation:fzspin .75s linear infinite;}',
    '@keyframes fzspin{to{transform:rotate(360deg);}}',
    '.fz-busy-txt{font-weight:600;line-height:1.35;}',
    '.fz-busy-sub{color:#8a8a8a;font-size:11.5px;line-height:1.45;margin-top:3px;}',
    '.fz-busy-bar{margin-top:9px;height:3px;border-radius:2px;background:#e8efe9;overflow:hidden;position:relative;}',
    '.fz-busy-bar i{position:absolute;left:-40%;top:0;bottom:0;width:40%;background:#217346;border-radius:2px;' +
      'animation:fzslide 1.15s ease-in-out infinite;}',
    '@keyframes fzslide{0%{left:-40%;}100%{left:100%;}}',
    '.fz-v-err{padding:24px 12px;color:#999;font-size:12px;text-align:center;}',
    // visibility 必须 !important：站点会给页面上任何 <img> 盖一记 inline 的 visibility:hidden
    // （它自己的懒加载保护），我们浮层里的图也被一起藏了，表现就是"点开是个白框"。
    // inline 样式不带 !important，所以这里一句 !important 就能赢。
    '.fz-v-bd img{display:block;max-width:100%;max-height:56vh;width:auto;height:auto;border:1px solid #eee;visibility:visible !important;}',
    // 设置菜单（工具栏「⚙ 设置」）：做成 Excel 那种下拉菜单的样子
    // ---------- 设置面板（v0.89）：暖白卡片 + 左右两栏开关 ----------
    // ---- 设置面板（v0.94 起跟整张表统一风格：白底、方角、Excel 绿）----
    // 之前是照着一张暖白卡片做的（米色 + 大圆角 + 蓝勾），跟表格本体（白底灰线、绿点缀）是两套语言。
    '.fz-setwrap{position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483647;' +
      'font-size:12.5px;line-height:1.5;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;' +
      'color:#333;}',
    '.fz-set-mask{position:absolute;left:0;top:0;right:0;bottom:0;background:rgba(0,0,0,.42);}',
    '.fz-set{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:720px;max-width:94vw;' +
      'max-height:86vh;overflow:auto;background:#fff;border:1px solid #b9bec7;border-radius:3px;' +
      'box-shadow:0 10px 34px rgba(0,0,0,.3);padding:0;box-sizing:border-box;}',
    // 标题条：左边一条绿边 + 浅灰底，和工具条那条「工具」是同一个绿
    '.fz-set-hd{position:relative;display:flex;align-items:center;height:34px;padding:0 36px 0 10px;' +
      'background:#f4f6f5;border-bottom:1px solid #d6dade;border-left:3px solid #217346;' +
      'border-radius:2px 2px 0 0;}',
    '.fz-set-tt{font-size:14px;font-weight:700;color:#1f2d24;letter-spacing:.2px;}',
    '.fz-set-tt i{font-style:normal;font-size:11px;font-weight:400;color:#8d97a0;margin-left:7px;}',
    '.fz-set-x{position:absolute;right:6px;top:6px;width:22px;height:22px;border:0;border-radius:2px;' +
      'background:transparent;color:#6b7681;font-size:12px;line-height:22px;cursor:pointer;padding:0;}',
    '.fz-set-x:hover{background:#e4e8ea;color:#2b3540;}',
    '.fz-set-bd{display:grid;grid-template-columns:1fr 1fr;gap:4px 30px;padding:14px 16px 6px;}',
    // 栏目标题：左边一小段绿竖条，跟表头的强调色一致
    '.fz-set-col h4{margin:0 0 6px;font-size:12.5px;font-weight:700;color:#2f3a33;' +
      'padding-left:7px;border-left:3px solid #217346;line-height:1.2;}',
    '.fz-set-row{display:flex;align-items:center;gap:8px;padding:4px 6px;cursor:pointer;border-radius:2px;}',
    '.fz-set-row:hover{background:#f1f6f3;}',
    // 原生勾的样子不可靠（站点 reset / 不同浏览器差很多）→ 自己画一个：input 只留语义
    '.fz-set-row input[type=checkbox]{position:absolute;width:1px;height:1px;margin:0;opacity:0;pointer-events:none;}',
    '.fz-set-cb{position:relative;flex:0 0 auto;width:15px;height:15px;box-sizing:border-box;' +
      'border:1.5px solid #b7bdc6;border-radius:2px;background:#fff;}',
    '.fz-set-row:hover .fz-set-cb{border-color:#8fbfa3;}',
    '.fz-set-row input:checked + .fz-set-cb{background:#217346;border-color:#217346;}',
    '.fz-set-row input:checked + .fz-set-cb::after{content:"";position:absolute;left:3.5px;top:0.5px;' +
      'width:5px;height:9px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(42deg);}',
    '.fz-set-row input:focus + .fz-set-cb{outline:2px solid rgba(33,115,70,.4);outline-offset:1px;}',
    '.fz-set-tx{color:#333;}',
    '.fz-set-adv{margin:8px 16px 0;border-top:1px solid #e2e5e8;padding:6px 0 2px;}',
    '.fz-set-advb{display:flex;align-items:center;gap:7px;border:0;background:transparent;padding:3px 0;' +
      'font-size:12.5px;font-weight:700;color:#2f3a33;cursor:pointer;font-family:inherit;}',
    '.fz-set-advb:hover{color:#1b5e3a;}',
    '.fz-set-advb i{font-style:normal;width:15px;height:15px;line-height:13px;text-align:center;' +
      'border:1px solid #c9ced6;border-radius:2px;background:#fbfbfb;font-size:11px;color:#556;}',
    '.fz-set-advbox{display:none;grid-template-columns:1fr 1fr;gap:2px 26px;padding:4px 0 2px;}',
    '.fz-set-advbox.on{display:grid;}',
    '.fz-set-inp{margin-left:auto;width:150px;padding:2px 6px;border:1px solid #c9ced6;border-radius:2px;' +
      'background:#fff;font-size:12.5px;font-family:inherit;color:#333;line-height:18px;}',
    '.fz-set-inp:focus{outline:none;border-color:#217346;box-shadow:0 0 0 2px rgba(33,115,70,.14);}',
    '.fz-set-ft{display:flex;align-items:center;gap:8px;margin-top:10px;background:#f7f8f9;' +
      'border-top:1px solid #dfe3e7;padding:9px 14px;}',
    '.fz-set-ft button{padding:4px 13px;border:1px solid #c9ced6;border-radius:2px;background:#fdfdfd;' +
      'font-size:12.5px;font-family:inherit;color:#333;cursor:pointer;line-height:18px;}',
    '.fz-set-ft button:hover{background:#eef1f3;}',
    '.fz-set-ft button:active{background:#e3e7ea;}',
    '.fz-set-sp{flex:1;}',
    // 主按钮：Excel 绿的那颗（保存）
    '.fz-set-ft .fz-set-save{font-weight:700;background:#217346;border-color:#1b5e3a;color:#fff;}',
    '.fz-set-ft .fz-set-save:hover{background:#1b5e3a;}',
    // 设置里关掉"键盘描边"：整块都不画（只影响我们自己的控件）
    // 关掉"键盘描边"：按控件本身点名单，不靠容器，行有时挂在站点卡片上（.fz-row），
    // 有时挂在数据看板里（.fz-brow），容器类名不止一个
    'html.fz-nokbd .fz-link:focus,html.fz-nokbd [data-fz-filter]:focus,html.fz-nokbd [data-fz-sort]:focus,' +
      'html.fz-nokbd .fz-mi:focus,html.fz-nokbd .fz-tb:focus,html.fz-nokbd .fz-tab:focus,' +
      'html.fz-nokbd .fz-zoom:focus,html.fz-nokbd .fz-authbtn:focus,html.fz-nokbd .fz-ns-x:focus,' +
      'html.fz-nokbd .fz-v-x:focus,html.fz-nokbd [data-fz-export]:focus,html.fz-nokbd [data-fz-menu]:focus,' +
      'html.fz-nokbd .fz-empty-x:focus{outline:none !important;background:transparent !important;}',
    '.fz-menu{position:fixed;z-index:2147483600;min-width:194px;background:#fff;border:1px solid #c9ced6;' +
    'border-radius:2px;box-shadow:0 3px 12px rgba(0,0,0,.16);padding:4px 0;font-size:12px;color:#222;' +
    'max-height:calc(100vh - 24px);overflow:auto;}',   // 小窗口下菜单比屏幕还高，底下几项点不到
    '.fz-mi{display:flex;align-items:center;padding:5px 10px 5px 6px;cursor:pointer;white-space:nowrap;}',
    '.fz-mi:hover{background:#eef4fb;}',
    '.fz-mi .fz-mk{width:14px;flex:0 0 14px;color:#217346;font-weight:700;}',
    '.fz-mi .fz-mt{flex:1;padding-right:12px;}',
    '.fz-mi .fz-mv{color:#888;font-size:11px;max-width:96px;overflow:hidden;text-overflow:ellipsis;}',
    '.fz-msep{height:1px;background:#e4e8ee;margin:4px 0;}',
    '.fz-mhint{padding:4px 10px 2px;color:#999;font-size:11px;line-height:1.6;}',
    '.fz-mhint b{color:#555;font-weight:600;}',
    '.fz-filtmenu .fz-mi.fz-mcur{background:#e8f0fe;}',
    // 筛到一条不剩时的提示：别让人对着空表格发愣
    '.fz-empty,.fz-nodata{display:flex;align-items:center;gap:10px;padding:12px 14px;background:#fffdf5;' +
      'border-bottom:1px solid #d0d0d0;color:#666;font-size:13px;}',
    '.fz-nodata{background:#fff8e6;}',
    '.fz-nd-t{color:#8a5a00;font-weight:600;}',
    '.fz-nd-tip{color:#7a7a7a;}',
    '.fz-empty-x{color:#217346;text-decoration:underline;cursor:pointer;}',
    // 状态栏上的一键清掉：和空表提示里那个「清掉筛选」长得一样（同一类动作同一张脸）
    '.fz-fltclear{color:#217346;text-decoration:underline;cursor:pointer;font-size:11px;margin-right:8px;}',
    '.fz-fltclear:hover{color:#124b2d;}',
    '.fz-empty-x:hover{color:#124b2d;}',
    // 表头的筛选箭头：用 ::after 画，textContent 保持纯列名（导出 CSV 直接读表头）
    '.fz-thead span[data-fz-filter]{cursor:pointer;padding-right:16px;position:relative;}',
    '.fz-thead span[data-fz-filter]:hover{background:#dbe5f1;}',
    '.fz-thead span[data-fz-filter]::after{content:"▾";position:absolute;right:5px;top:0;color:#9aa4b0;font-size:9px;}',
    '.fz-thead span[data-fz-filter].fz-fon::after{content:"▾";color:#217346;font-weight:700;}',
    '.fz-thead span[data-fz-filter].fz-fon{background:#e3efe0;}',
    // 排序箭头：同样用 ::after，没排的时候给个很淡的 ⇅ 提示"这列能点"
    '.fz-thead span[data-fz-sort]{cursor:pointer;padding-right:15px;position:relative;}',
    '.fz-thead span[data-fz-sort]:hover{background:#dbe5f1;}',
    '.fz-thead span[data-fz-sort]::after{content:"⇅";position:absolute;right:3px;top:0;color:#c3c9d1;font-size:9px;}',
    '.fz-thead span[data-fz-sort].fz-sasc::after{content:"▲";color:#217346;font-weight:700;}',
    '.fz-thead span[data-fz-sort].fz-sdesc::after{content:"▼";color:#217346;font-weight:700;}',
    '.fz-thead span[data-fz-sort].fz-sasc,.fz-thead span[data-fz-sort].fz-sdesc{background:#e3efe0;}',
    // 「赞」这一格既是筛选入口又是排序列，两个箭头要能同时看见（▾ 是筛选、⇅/▲/▼ 是排序）
    '.fz-thead span[data-fz-filter][data-fz-sort]{padding-right:28px;}',
    '.fz-thead span[data-fz-filter][data-fz-sort]::after{content:"⇅▾";color:#c3c9d1;}',
    '.fz-thead span[data-fz-filter][data-fz-sort].fz-sasc::after{content:"▲▾";color:#217346;font-weight:700;}',
    '.fz-thead span[data-fz-filter][data-fz-sort].fz-sdesc::after{content:"▼▾";color:#217346;font-weight:700;}',
    '.fz-sortmenu .fz-mi .fz-mt{min-width:132px;}',
    '.fz-filtmenu .fz-mi .fz-mv{color:#999;}',
    // 面板里的搜索框（作者太多时用它找，Excel 的下拉框也有这一格）
    '.fz-filtmenu .fz-minput{display:block;width:calc(100% - 14px);margin:2px 7px 6px;padding:3px 6px;' +
    'box-sizing:border-box;font:inherit;font-size:12px;line-height:16px;color:#333;background:#fff;' +
    'border:1px solid #c9d2dc;border-radius:2px;}',
    '.fz-filtmenu .fz-minput:focus{outline:none;border-color:#217346;box-shadow:0 0 0 2px rgba(33,115,70,.12);}',
    // 详情页的评论行也要能被筛掉（首页行那条规则挂在 html.fz-table 下）
    '.fz-nrow.fz-hide{display:none !important;}',
    // 设置里关掉表格模式：伪装层整块收掉，露出原生页面（body 的留白也要还回去）
    'html.fz.fz-off .fz-chrome,html.fz.fz-off .fz-board,html.fz.fz-off .fz-notesheet,' +
    'html.fz.fz-off .fz-morerow,html.fz.fz-off .fz-filler,html.fz.fz-off .fz-viewer{display:none !important;}',
    'html.fz.fz-off body{padding-top:0 !important;padding-bottom:0 !important;}'
  ].join('\n');

  function injectCSS() {
    if (document.getElementById('fz-style')) return;
    var s = document.createElement('style');
    s.id = 'fz-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  // ---------- 主循环 ----------
  var lastPath = location.pathname + location.search;
  var pageAt = Date.now();

  function sync() {
    if (!document.body) return;
    if (yieldMode) return;   // 登录/登出期间露出原生界面，什么都别做
    if (pullBusy) return;    // 拉取下一页时 DOM 高频变化，再跑全套同步会把主线程打满
    var p = location.pathname + location.search;
    if (p !== lastPath) { lastPath = p; pageAt = Date.now(); lastAnchorCount = -1; fitDone = false; aboveDone = false; removeSheet(); closedPid = ''; clearSel(); clearSearch(); }

    if (!CFG.tableMode) {
      // 表格模式关掉（设置菜单里切的）：原生页面的元素一个都别碰，
      // 否则原生页面会缺头少sidebar 变得不能用。只留住"详情页接管"这一项，两个开关独立。
      try { unhushVideos(document); } catch (eU) {}   // 站点露出来了，声音也还给它
      if (CFG.detailSheet) maybeNoteSheet();
      else { try { removeSheet(); } catch (e0) {} }
      updateLetters();
      applyTitle();
      renderAuth();
      return;
    }

    hushPage();          // 藏起来的东西不许出声（视频/实况图）：每轮兜一遍，见 §26
    hideSiteHeader();
    hideSideBars();
    hideTopSearch();
    setupCats();
    hideBottomBars();
    hideTextPanels();
    fitModals();
    if (CFG.tableMode) {
      markSource();
      collectCards();
      repairBoard();
      fillBoard();
    }
    hideBeforeBoard();
    hideOverlays();
    updateLetters();
    hideAboveTable();
    ensureMoreRow();
    maybeNoteSheet();
    // 详情表是 maybeNoteSheet 里才建出来的，列号条/表头必须当场跟着换，
    // 否则会有一拍（≥150ms）"详情行顶着列表表头"露出破绽
    updateLetters();
    if (DEMO) {
      try {
        var v = !noteSheet ? 'none'
          : 'cls=' + noteSheet.className + ',kids=' + noteSheet.childElementCount +
            ',in=' + document.contains(noteSheet) +
            ',q=' + document.querySelectorAll('.fz-notesheet').length;
        if (document.documentElement.getAttribute('data-fz-ns') !== v) {
          document.documentElement.setAttribute('data-fz-ns', v);
        }
      } catch (e) {}
    }
    degradeAll();
    applyTitle();
    applyView();          // 头像 / 纯文字链接 / 详情页三个开关 / 单滚动条，每拍同步一次（只改 class，很便宜）
    renderAuth();
    bindSearch();
    applyFilter();
    // 面板开着的时候，新加载进来的行也要反映到候选/条数里（不然"还有 N 位"会停在开门那一刻）
    if (filtEl) renderFilterItems(false);
    dropCurtain();
  }

  // sync 限频：站点滚动时 DOM 每秒能变上百次，原来每个动画帧都跑一遍全套同步，
  // 主线程直接被占满（实测 50% CPU、单次卡顿 400ms+）。现在最少间隔 150ms + 末尾补一次。
  // 看门狗：遮罩残留、pullBusy 卡死，统一在这里兜底（这是"只剩一个正在计算"那类死锁的保险）
  setInterval(function () {
    try {
      var mask = document.querySelector('.fz-pullmask');
      if (mask && !pullBusy) { mask.parentNode.removeChild(mask); }
      if (pullBusy && Date.now() - pullStartAt > 16000) {
        pullBusy = false;
        var m2 = document.querySelector('.fz-pullmask');
        if (m2 && m2.parentNode) m2.parentNode.removeChild(m2);
        try { schedule(true); } catch (e) {}
      }
    } catch (e) {}
  }, 1500);

  var schedule = (function () {
    var pending = false, logged = false, lastRun = 0, trailing = 0;
    function run() {
      pending = false;
      lastRun = Date.now();
      try { sync(); } catch (e) {
        if (!logged || DEMO) { logged = true; console.error('[fishy] sync 出错：', e); }
      }
    }
    return function (force) {
      if (pending) return;
      var wait = force ? 0 : Math.max(0, 150 - (Date.now() - lastRun));
      pending = true;
      if (wait <= 0) requestAnimationFrame(run);
      else {
        clearTimeout(trailing);
        trailing = setTimeout(function () { requestAnimationFrame(run); }, wait);
      }
    };
  })();

  function hookHistory() {
    ['pushState', 'replaceState'].forEach(function (k) {
      var orig = history[k];
      history[k] = function () {
        var r = orig.apply(this, arguments);
        setTimeout(schedule, 80);
        return r;
      };
    });
    addEventListener('popstate', function () { setTimeout(schedule, 80); });
  }

  function watch() {
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    addEventListener('scroll', thumb(schedule, 500), { passive: true });
    addEventListener('scroll', function () {
      if (document.querySelector('.fz-notesheet')) return;     // 详情页不触发列表加载
      if (pullBusy) return;
      // 不再自动拉取：加载下一页只由「加载更多」按钮触发
    }, { passive: true });
    addEventListener('resize', thumb(schedule, 400), { passive: true });
  }

  // ===== 筛选：Excel 的"自动筛选"那一套（点表头 ▾ 出条件），只活在内存里 =====
  // 不持久化的理由：筛选是"当前看什么"，刷新后还留着上次的筛选条件，看起来就像数据丢了
  var FILT = { type: '', minLike: 0, author: '', when: '' };
  var LIKE_STEPS = [['', '全部'], ['100', '≥ 100'], ['1000', '≥ 1000'], ['10000', '≥ 1万']];

  // 状态栏只报数字（筛选 3/34 行）是不够的：门槛、时间窗、作者都是用户自己设的，
  // 隔一会儿回来只看到三行，第一反应是数据没了。所以把生效的条件写成一句人话，
  // 挂在 title 上（鼠标停一下就能看见），清掉的那个链接上也挂着同样一句。
  function filterSummary() {
    var parts = [];
    var inp = document.querySelector('.fz-search');
    var q = inp ? (inp.value || '').trim() : '';
    if (q) parts.push('搜「' + q + '」');
    if (FILT.type) parts.push('类型 ' + FILT.type);
    if (FILT.minLike) {
      var lab = '≥ ' + FILT.minLike;
      for (var i = 0; i < LIKE_STEPS.length; i++) {
        if (LIKE_STEPS[i][0] && String(FILT.minLike) === LIKE_STEPS[i][0]) lab = LIKE_STEPS[i][1];
      }
      parts.push('赞 ' + lab);
    }
    if (FILT.author) {
      // 同一个 author 条件，在列表里是「只看这位作者的笔记」、在评论里是「只看这个人的评论」
      // 判断看屏幕（有没有评论表）而不是内部变量：等价的，但自测能从外面把这个条件摆出来验
      parts.push(document.querySelector('.fz-notesheet')
        ? ('只看「' + FILT.author + '」的评论') : ('作者「' + FILT.author + '」'));
    }
    if (FILT.when) {
      var w = FILT.when;
      for (var j = 0; j < WHEN_STEPS.length; j++) {
        if (WHEN_STEPS[j][0] === w) { w = WHEN_STEPS[j][1]; break; }
      }
      parts.push(w);
    }
    return parts.join(' · ');
  }

  function filterOn() {
    var inp = document.querySelector('.fz-search');
    return !!(FILT.type || FILT.minLike || FILT.author || FILT.when || (inp && (inp.value || '').trim()));
  }

  // 行的可见文本：不含行号，不然搜"1"会把第 1 行也捞出来
  function rowText(el) {
    var cs = el.querySelectorAll('.fz-c'), out = '';
    for (var i = 0; i < cs.length; i++) {
      if (cs[i].classList.contains('fz-num')) continue;
      out += (cs[i].textContent || '') + ' ';
    }
    return out.toLowerCase();
  }

  // 搜索框的口径：空格分词，每个词都得命中（"小鹿 通勤" = 作者或标题里两个词都有）。
  // 单个词就是原来的子串匹配，所以老习惯不变；两个词以上才体现差别。
  function searchTerms() {
    var inp = document.querySelector('.fz-search');
    var v = ((inp && inp.value) || '').trim().toLowerCase();
    return v ? v.split(/\s+/) : [];
  }

  // 换页就把搜索框清掉：搜索是"在这张表里找"，进了单篇整张表的行全换了。
  // 更麻烦的是评论表，搜索词多半命不中评论，评论全被藏起来，而"没有符合条件的行"
  // 又不会出来（列表那几行还可见，show≠0），看着就像评论没加载出来。
  // ▾ 筛选里只有「赞」跟着走（详情表的行也有赞数，T22b）；「类型」是列表专有的列，
  // 详情表压根没这一列，所以 rowHit 里只让它筛列表行（踩坑 57）。搜索不跟。
  function clearSearch() {
    var inp = document.querySelector('.fz-search');
    if (inp && inp.value) inp.value = '';
  }

  function rowHit(el, terms) {
    // 「类型」是列表专有的一列：详情表（主贴 + 评论）压根没有类型这一列，
    // 拿列表的类型条件去卡详情行，会把整张详情表清空，看着就像评论没加载出来。
    // 所以只对列表行生效（详情表里生效的是赞/搜索，见 §24、T22b）。
    if (FILT.type && el.classList.contains('fz-row') &&
        (el.dataset.fzType || '') !== FILT.type) return false;
    if (FILT.minLike) {
      var n = likeNum(el.dataset.fzLike);
      if (n === null || n < FILT.minLike) return false;   // 赞数不知道的，不算命中
    }
    // 「作者」两张表都有（列表是笔记作者，详情是主贴作者 + 评论作者），所以不加作用域：
    // 在详情表里筛作者 = "只看这个人的评论"，正是想要的
    if (FILT.author && (el.dataset.fzAuthor || '') !== FILT.author) return false;
    // 时间列两张表都有（列表=笔记、详情=主贴和评论），所以不加作用域；
    // 但时间推不出来的行（fzMs 缺失）不许被藏，不知道不等于不符合
    if (FILT.when) {
      var ms = Number(el.dataset.fzMs || 0);
      if (ms && ms < whenFloor(FILT.when)) return false;
    }
    if (terms && terms.length) {
      var t = rowText(el);
      for (var i = 0; i < terms.length; i++) {
        if (t.indexOf(terms[i]) === -1) return false;
      }
    }
    return true;
  }

  // 返回 {show,total}：筛选之后还剩几行，状态栏和测试都看这个
  function applyFilter() {
    var terms = searchTerms();
    sortRows();                       // 先就位再判可见：新加进来的行也跟着排（排序是"视图"的一部分）
    var rows = document.querySelectorAll('.fz-row, .fz-nrow');
    var show = 0;
    for (var i = 0; i < rows.length; i++) {
      var hit = rowHit(rows[i], terms);
      rows[i].classList.toggle('fz-hide', !hit);
      if (hit) show++;
    }
    paintSort();
    paintFilter(show, rows.length);
    return { show: show, total: rows.length };
  }

  // 筛到一条都不剩时，表格只剩补白的空行，看着像坏了。给一句人话 + 一键清掉
  var emptyEl = null;
  // 状态栏上的「清掉」入口：只有真的有事可清时才出现（没筛选就不该多两个链接占地方）。
  // 分成三个：清掉筛选、取消排序、取消选择。用户经常只想退掉其中一个。
  var chipFilterEl = null, chipSortEl = null, chipSelEl = null;
  function chipOf(which, cls, label, attr) {
    var foot = document.querySelector('.fz-foot');
    if (!foot) return null;
    var cur = which === 'filter' ? chipFilterEl : (which === 'sort' ? chipSortEl : chipSelEl);
    if (cur && cur.parentNode === foot) {
      if (cur.textContent !== label) cur.textContent = label;
      return cur;
    }
    var el = document.createElement('span');
    el.className = 'fz-fltclear ' + cls;
    el.textContent = label;
    el.setAttribute(attr, '1');
    el.setAttribute('tabindex', '0');
    el.setAttribute('role', 'button');
    // 放在缩放那组之前，看着就是这条状态的操作
    var sp = foot.querySelector('.fz-sp');
    if (sp) foot.insertBefore(el, sp); else foot.appendChild(el);
    if (which === 'filter') chipFilterEl = el;
    else if (which === 'sort') chipSortEl = el;
    else chipSelEl = el;
    return el;
  }
  function paintClearChips(on, sum) {
    var foot = document.querySelector('.fz-foot');
    if (!foot) return;
    var f = chipOf('filter', 'fz-fltclear-f', '✕ 清掉筛选', 'data-fz-clearfilter');
    var s = chipOf('sort', 'fz-fltclear-s', '✕ 取消排序', 'data-fz-clearsort');
    if (f) {
      f.style.display = on ? '' : 'none';
      var ft = '清掉筛选' + (sum ? '：' + sum : '') + '（首页和评论的筛选条件一起清）';
      if (f.getAttribute('title') !== ft) f.setAttribute('title', ft);
    }
    if (s) {
      s.style.display = sortOn() ? '' : 'none';
      var stt = '取消排序：' + sortLabel() + '（回到原来的顺序）';
      if (s.getAttribute('title') !== stt) s.setAttribute('title', stt);
    }
    paintSelChip();
  }
  // 选中的行只有点行号才出现，取消以前靠 Esc。Esc 去掉了，状态栏就补一个明确入口。
  function paintSelChip() {
    var c = chipOf('sel', 'fz-fltclear-l', '✕ 取消选择', 'data-fz-clearsel');
    if (!c) return;
    c.style.display = SEL.length ? '' : 'none';
    var t = '取消选中这 ' + SEL.length + ' 行';
    if (c.getAttribute('title') !== t) c.setAttribute('title', t);
  }

  function paintEmpty(show) {
    var need = filterOn() && show === 0;
    var b = document.querySelector('.fz-board');
    if (!need) {
      if (emptyEl && emptyEl.parentNode) emptyEl.parentNode.removeChild(emptyEl);
      emptyEl = null;
      return;
    }
    // 把搜索的词也写进去：不然用户只看到"没有符合条件的行"，不知道是自己刚搜的那两个词太窄
    var terms = searchTerms();
    var q = terms.join(' ');
    // 说实话：我们只在已经加载进来的这几行里找过。真机实测（2026-10）：滚到底 6 次，
    // 34 行还是 34 行，站点这一轮只给这么多。所以这里绝不能写"往下滚会加载更多"，
    // 那不是安慰，是骗人；只说清作用域，用户自己知道该怎么办（比如去站点搜一次）。
    var loaded = allRows().length;
    var html = '<span>没有符合条件的行' +
      (q ? '（搜索「' + esc(q) + '」）' : '') + '</span>' +
      '<span class="fz-mv">· 只在已加载的 ' + loaded + ' 行里找过（站点这一轮只给这么多）</span>' +
      '<span class="fz-empty-x" data-fz-clearfilter="1">清掉筛选</span>' +
      '<span class="fz-mv">' + (terms.length > 1
        ? '（多个词要都命中：去掉一个再试）'
        : '（也可以换个条件：点表头的 ▾）') + '</span>';
    // 已经挂在树上了：只在位置/文案不对时动一下（paintFilter 每轮 sync 都跑，
    // 每次都删了重插会把 MutationObserver 转成死循环）
    if (emptyEl && emptyEl.parentNode) {
      if (b && emptyEl.parentNode === b && b.firstChild !== emptyEl) {
        b.insertBefore(emptyEl, b.firstChild);
      }
      // 判据里带上 loaded：行数变了这句话也得跟着变（只比 q 的话数字会一直停在第一次那版）
      var key = q + '|' + loaded;
      if (emptyEl.dataset.fzQ !== key) {
        emptyEl.dataset.fzQ = key;
        emptyEl.innerHTML = html;
        markKeyboard(emptyEl);       // 重写了 HTML 就得重新补 tabindex（见踩坑 6 / K6）
      }
      return;
    }
    emptyEl = document.createElement('div');
    emptyEl.className = 'fz-empty';
    emptyEl.dataset.fzQ = q + '|' + loaded;
    emptyEl.innerHTML = html;
    if (b) b.insertBefore(emptyEl, b.firstChild);
    else document.body.appendChild(emptyEl);
    markKeyboard(emptyEl);
  }

  // 一行都没有（不是筛没的，是真的没抓到）：空表格 + "就绪" 看着就像脚本坏了。
  // 真机实测最常见的两种原因，下一步完全不同，所以要分清：
  //   游客态（/search_result 天生不给游客数据；刷十几页后额度用完）→ 去登录
  //   已登录还抓不到（站点改版）→ 再试一次 + 让人能拿到报错
  var nodataEl = null;
  var nodataTimer = 0;

  // 防闪那 2 秒里如果页面一个变化都没有，就没人再喊 sync 了，空表提示会永远不出现
  // （本地 test-empty.html 第一次跑就是这么红的：真机游客搜索页正是"没有任何变化"）。
  // 所以自己定个闹钟，防闪期结束时补一次 sync，一次就够。
  function planNoDataCheck(total) {
    if (nodataTimer || total > 0 || !CFG.tableMode) return;
    if (document.querySelector('.fz-notesheet') || filterOn()) return;
    var wait = 2000 - (Date.now() - pageAt);
    if (wait <= 0) return;
    nodataTimer = setTimeout(function () {
      nodataTimer = 0;
      // 直接 sync，不走 schedule：schedule 末尾是 requestAnimationFrame，
      // 无头 + virtual-time 下 rAF 不一定跑（"加载更多"那套也踩过），
      // 真机静态空页面更没有下一帧来救场
      try { sync(); } catch (e) {}
    }, wait + 150);
  }

  function emptyReason() {
    var logged = false;
    try { logged = isLoggedIn(); } catch (e) { logged = !!CFG.login; }
    if (!logged) {
      if (/^\/search/.test(location.pathname || '')) {
        return { kind: 'guest-search', why: '搜索结果要登录才给',
          tip: '本站限制：游客态的搜索页没有内容', act: 'login', actText: '去登录',
          after: '登录后表格自动回来' };
      }
      return { kind: 'guest', why: '游客态没内容了',
        tip: '本站对游客有额度限制（连刷十几页后常见）', act: 'login', actText: '去登录',
        after: '登录后表格自动回来' };
    }
    return { kind: 'shy', why: '没抓到内容',
      tip: '站点可能改版了：按 F12 搜 [fishy] 看报错', act: 'retry', actText: '再试一次',
      after: '也可以滚到底点「加载更多」' };
  }

  // 提示的时机：表格模式在、列表页、没有筛选条件（筛到空有它自己的提示）、
  // 一行都没有、不在加载/让位中；并且至少跑过一轮收集、进页面超过 2 秒，
  // 首屏慢的时候别闪一下"没抓到内容"吓人
  function needNoData(total) {
    if (!CFG.tableMode || total > 0) return false;
    if (document.querySelector('.fz-notesheet')) return false;
    if (filterOn() || yieldMode || pullBusy || moreBusy) return false;
    if (!lastCollectAt || Date.now() - pageAt < 2000) return false;
    return true;
  }

  function paintNoData(need) {
    var b = document.querySelector('.fz-board');
    if (!need || !b) {
      if (nodataEl && nodataEl.parentNode) nodataEl.parentNode.removeChild(nodataEl);
      nodataEl = null;
      return;
    }
    var r = emptyReason();
    if (nodataEl && nodataEl.parentNode === b) {
      if (b.firstChild !== nodataEl) b.insertBefore(nodataEl, b.firstChild);
      // 原因没变就一个字都不改（每轮 sync 都写会喂 MutationObserver）
      if (nodataEl.dataset.fzWhy !== r.kind) {
        nodataEl.dataset.fzWhy = r.kind;
        nodataEl.innerHTML = nodataHtml(r);
        markKeyboard(nodataEl);
      }
      return;
    }
    nodataEl = document.createElement('div');
    nodataEl.className = 'fz-nodata';
    nodataEl.dataset.fzWhy = r.kind;
    nodataEl.innerHTML = nodataHtml(r);
    b.insertBefore(nodataEl, b.firstChild);
    markKeyboard(nodataEl);
  }

  function nodataHtml(r) {
    return '<span class="fz-nd-t">' + esc(r.why) + '</span>' +
      '<span class="fz-nd-tip">' + esc(r.tip) + '</span>' +
      '<span class="fz-empty-x" data-fz-nodata="' + r.act + '">' + esc(r.actText) + '</span>' +
      '<span class="fz-mv">（' + esc(r.after) + '）</span>';
  }

  // 「再试一次」：再驱动一次站点的加载，再自己同步一轮
  function retryFetch() {
    toast('再去要一次…');
    setMoreState('再去要一次…', 8000);
    try { nudgeSource(true); } catch (e) {}
    schedule(true);
  }

  // ---------- 选中 + 复制：Excel 里最常用的那条路（选几行 → Ctrl+C → 贴到别处） ----------
  // 点行号 = 选中整行（Excel 的行号就这么用），Shift+点行号 = 连着选一段；
  // 键盘等价物是 Shift+Space（Excel 原样），所以行号不进 Tab 序列
  // （一屏 30 多行就多 30 多个 Tab 站，换来的是每次都要多按几十下，不值；见 DEV §22）。
  // 名称框和公式栏本来就装着"选中单元格"的样子，现在真的用起来了。
  var SEL = [], SELROW = null, SELFOCUS = null, selTold = false;

  function allRows() { return [].slice.call(document.querySelectorAll('.fz-row, .fz-nrow')); }

  // 一格的"内容文本"：导出 CSV 和复制都用它，两条路必须同一个口径。
  // 两处和 textContent 不一样，都是真实痛点：
  //   ① 长正文为了省地方只画前 300 字（后面跟个"展开全文"链接），但导出去的是给人事后看的，
  //      半截正文等于没用 → 这里换成全文（`data-full` 里存着）。
  //   ② "展开全文（1234 字）"/"展开 3 条回复"是按钮，不是内容，直接 textContent
  //      会导出成"……展开全文（1234 字）"这种怪话（真机上就是这样的）。
  function cellText(c) {
    if (!c) return '';
    var t = (c.textContent || '').replace(/\s+/g, ' ').trim();
    var fl = c.querySelector('.fz-full');
    if (fl && fl.dataset.full) {
      var es = c.querySelector('.fz-es');
      var shown = es ? (es.textContent || '').replace(/\s+/g, ' ').trim() : '';
      var full = String(fl.dataset.full).replace(/\s+/g, ' ').trim();
      if (shown && full && t.indexOf(shown) > -1) t = t.replace(shown, full);
    }
    var junk = c.querySelectorAll('.fz-full, .fz-toggle, .fz-fl');
    for (var i = 0; i < junk.length; i++) {
      var jt = (junk[i].textContent || '').replace(/\s+/g, ' ').trim();
      if (jt && t.indexOf(jt) > -1) t = t.replace(jt, ' ').replace(/\s+/g, ' ').trim();
    }
    return t;
  }

  function cellsOf(row) {
    var wrap = row.querySelector('.fz-cells');
    if (!wrap) return [];
    var out = [];
    for (var i = 0; i < wrap.children.length; i++) {
      var c = wrap.children[i];
      if (c.classList.contains('fz-x')) continue;   // "操作"那列是按钮，复制它没意义（也跟 CSV 一个口径）
      out.push(cellText(c));
    }
    return out;
  }

  function selRef() {
    if (!SEL.length) return 'A1';
    var a = rowOrd(SEL[0]), b = rowOrd(SEL[SEL.length - 1]);
    return a === b ? (a + ':' + a) : (a + ':' + b);
  }

  function selTsv() {
    var out = [];
    for (var i = 0; i < SEL.length; i++) {
      // 所见即所得：筛掉的行不复制（和 CSV 导出同一个口径）
      if (SEL[i].classList.contains('fz-hide')) continue;
      var cells = cellsOf(SEL[i]);
      if (cells.length) out.push(cells.join('\t'));
    }
    return out.join('\n');
  }

  function clearSel() {
    SEL = []; SELROW = null; SELFOCUS = null;
    paintSel();
  }

  // 选区唯一的写入点：三条路（点/拖、Shift 连选、Ctrl+A 全选）都从这儿进，
  // 免得"锚点是谁、活口是谁、提示怎么报"各写一份（见踩坑 71 的教训）
  function setSel(list, anchor, focus) {
    SEL = list.slice();
    SELROW = anchor || list[0] || null;
    SELFOCUS = focus || list[list.length - 1] || null;
    paintSel();
    if (!selTold && SEL.length) {
      selTold = true;
      toast('已选中 ' + SEL.length + ' 行 · Ctrl+C 复制（粘到 Excel 就是一张表）');
    }
  }

  function selectRows(row, to) {
    if (!row) return clearSel();
    // 一段选区只能在同一张表里：列表和详情表不能混着选（但同一张详情表里的主贴行和评论行
    // 是连着的，Shift 点过去要能连成一段）
    var all = scopeRows(rowScope(row));
    var i = all.indexOf(row);
    if (i < 0) return clearSel();
    var j = to ? all.indexOf(to) : -1;
    if (j < 0) j = i;
    var lo = Math.min(i, j), hi = Math.max(i, j);
    setSel(all.slice(lo, hi + 1), row, to || row);   // 锚点不动；活口是 to
  }

  // Excel 的 Ctrl+A（表格里叫"全选"）。筛掉的行不选：Excel 筛选之后 Ctrl+A 也只选看得见的那些，
  // 而且我们自己的 ↑↓ / Ctrl+End 也是这个口径。
  function selectAllVisible() {
    var all = navRows();
    if (!all.length) return false;
    setSel(all, all[0], all[all.length - 1]);
    return true;
  }

  // 容器被重画时保住选区：先记下"第几行是选中的"，重建之后照原位选回来。
  // 评论表是整块 innerHTML 重画的（站点那边评论一直在流进来），重建后选区里握着的旧元素
  // 一个个都 disconnected，paintSel 会把它们全剪掉，用户看着就是"选了一半突然没了"，
  // 想 Ctrl+C 复制评论的时候尤其难受。行是按同一顺序铺的，所以按行号认回来是准的。
  function selIdxIn(box) {
    var rows = box ? box.querySelectorAll('.fz-row, .fz-nrow') : [], out = [], i;
    for (i = 0; i < rows.length; i++) if (SEL.indexOf(rows[i]) >= 0) out.push(i);
    return out;
  }
  probeSelIdx = function (box, idx) {
    if (arguments.length > 1) return selIdxBack(box, idx);
    return selIdxIn(box);
  };
  // 选中的那些行"是谁"（评论 id）：整块重画后光按行号找回，站点的评论一增一减就指到别人身上了
  function selKeysIn(box) {
    var rows = box ? box.querySelectorAll('.fz-row, .fz-nrow') : [], out = [], i;
    for (i = 0; i < rows.length; i++) {
      if (SEL.indexOf(rows[i]) < 0) continue;
      var n = rows[i].__fz;
      out.push({ i: i, cid: (n && n.cid) ? String(n.cid) : '' });
    }
    return out;
  }
  function selIdxBack(box, idx, keys) {
    if (!box || !idx || !idx.length) return false;
    var rows = box.querySelectorAll('.fz-row, .fz-nrow'), back = [], byCid = null, i;
    if (keys && keys.length) {
      byCid = {};
      for (i = 0; i < rows.length; i++) {
        var nd = rows[i].__fz;
        if (nd && nd.cid) byCid[String(nd.cid)] = rows[i];
      }
    }
    for (i = 0; i < idx.length; i++) {
      var k = keys && keys[i] ? String(keys[i].cid || '') : '';
      var hit = (k && byCid && byCid[k]) ? byCid[k] : null;   // 认 id：同一条评论就跟过去
      if (!hit && idx[i] < rows.length) hit = rows[idx[i]];    // 认不出才退回行号
      if (hit && back.indexOf(hit) < 0) back.push(hit);
    }
    if (!back.length) return false;
    setSel(back, back[0], back[back.length - 1]);
    return true;
  }

  function paintSel() {
    var rows = allRows();
    // 选中的行可能被重建或换页换掉了：只留还在页面上的
    if (SEL.length) {
      SEL = SEL.filter(function (r) { return r.isConnected && rows.indexOf(r) >= 0; });
      if (!SEL.length) SELROW = null;
    }
    for (var i = 0; i < rows.length; i++) {
      rows[i].classList.toggle('fz-selrow', SEL.indexOf(rows[i]) >= 0);
    }
    var ref = selRef();
    var rf = document.querySelector('.fz-ref');
    if (rf && rf.textContent !== ref) rf.textContent = ref;
    // 名称框里除了文字还有个下拉小三角，只能改那个文本节点
    var nb = document.querySelector('.fz-namebox');
    var t0 = nb && nb.firstChild;
    if (t0 && t0.nodeType === 3 && t0.nodeValue !== ref) t0.nodeValue = ref;
    var inp = document.querySelector('.fz-input');
    if (inp) {
      var txt = SEL.length ? cellsOf(SEL[0]).join(' | ').slice(0, 110) : '';
      if (inp.textContent !== txt) inp.textContent = txt;
    }
    paintSelChip();   // 状态栏那个「✕ 取消选择」跟着选区一起亮灭
    paintSelStats();  // 中间那串「平均值/计数/求和」同理：取消选中后要立刻空掉
  }

  // 写剪贴板：现代 API 优先，失败退回老办法（headless 里两个都可能失败，所以返回值要如实）
  function copyText(txt) {
    var done = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(function () {}, function () {
          if (!copyFallback(txt)) toast('复制失败：浏览器不让写剪贴板，手动选中复制吧');
        });
        return true;
      }
    } catch (e) {}
    try { done = copyFallback(txt); } catch (e2) { done = false; }
    return done;
  }

  function copyFallback(txt) {
    var ta = document.createElement('textarea');
    ta.value = txt;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    if (ta.parentNode) ta.parentNode.removeChild(ta);
    return ok;
  }

  function copySel() {
    if (!SEL.length) return null;
    var txt = selTsv();
    var lines = txt ? txt.split('\n') : [];
    if (!lines.length) {
      toast('选中的行都被筛掉了，没什么可复制');
      return { text: '', lines: 0, cols: 0, ref: selRef() };
    }
    var cols = lines[0].split('\t').length;
    var ok = copyText(txt);
    if (ok) toast('已复制 ' + lines.length + ' 行 × ' + cols + ' 列（可直接粘进 Excel）');
    return { text: txt, lines: lines.length, cols: cols, ok: ok, ref: selRef() };
  }

  // ↑↓ 移动选中行（Excel 里选完就用方向键走）；Shift+↑↓ 从锚点连成一段。
  // 被筛掉的行要跳过，选到一个看不见的行，用户只会以为"选中丢了"。
  // 当前视图里"看得见的行"：有选中就跟着选区的父节点走，没选中就挑当前视图的容器
  // （Ctrl+Home / Ctrl+End 不需要先选中，Excel 里总有个活动单元格）
  // 一行属于"哪张表"：列表是 .fz-board，详情是 .fz-notesheet（评论行在它里面的 .fz-cmts 里）。
  // 以前这里比的是 r.parentNode === root，列表是平铺的所以碰巧对；详情表里评论行的父节点是
  // .fz-cmts，于是"当前视图的行"只剩主贴那一行：Ctrl+A 只选到 1 行、↑↓ 也走不动、Ctrl+End 到不了
  // 最后一条评论。要按容器取后代，而且 DOM 顺序正好就是视觉顺序（主贴在前、评论在后）。
  function rowScope(row) {
    if (!row || !row.closest) return null;
    return row.closest('.fz-notesheet') || row.closest('.fz-board') || row.parentNode || null;
  }
  function scopeRows(scope) {
    if (!scope || !scope.querySelectorAll) return [];
    return [].slice.call(scope.querySelectorAll('.fz-row, .fz-nrow')).filter(function (r) {
      return !r.classList.contains('fz-hide');
    });
  }

  function navRoot() {
    if (SEL.length) return rowScope(SEL[0]);
    return document.querySelector('.fz-notesheet') || document.querySelector('.fz-board') ||
      ((document.querySelector('.fz-row') || {}).parentNode) || null;
  }
  function navRows(root) {
    return scopeRows(root || navRoot());
  }
  // 跳到第 i 行并选中 + 滚到看得见的位置
  function navTo(all, i, block) {
    if (!all.length) return false;
    i = Math.max(0, Math.min(all.length - 1, i));
    selectRows(all[i]);
    try { all[i].scrollIntoView({ block: block || 'nearest' }); }
    catch (e) { try { all[i].scrollIntoView(); } catch (e2) {} }
    return true;
  }
  // 一屏大概几行（跟着缩放走：行高是从 DOM 上量的，不是写死的 34px）
  function screenStep(all) {
    var h = 34;
    try { h = all[0].getBoundingClientRect().height || 34; } catch (e) {}
    var per = Math.floor((window.innerHeight || 800) / (h || 34));
    return Math.max(3, per - 1);
  }

  function moveSel(step, keep) {
    if (!SEL.length) return false;
    // 这里以前写的是 navRows(SEL[0].parentNode)：主贴行的父节点是 notesheet，没问题；
    // 但评论行的父节点是 .fz-cmts，于是从第一条评论按 ↑ 就再也回不到主贴行（↓ 却走得过去，
    // 单向的）。和 Ctrl+A / Ctrl+C / 统计共用 navRows()，一张表就只有一套"当前视图"。
    var all = navRows();
    if (!all.length) return false;
    var from = keep ? (SELFOCUS || SELROW || SEL[0])
                    : (step > 0 ? SEL[SEL.length - 1] : SEL[0]);
    var i = all.indexOf(from);
    if (i < 0) {                       // 锚点被筛掉了：从选区的另一头接着走
      i = all.indexOf(step > 0 ? SEL[SEL.length - 1] : SEL[0]);
      if (i < 0) return false;
    }
    var j = i + step;
    if (j < 0 || j >= all.length) return false;      // 到头了：不拦按键，让 ↑↓ 继续管滚动
    var row = all[j];
    if (keep) selectRows(SELROW || from, row);        // 锚点那头不动，活口这一头挪
    else selectRows(row);
    try { row.scrollIntoView({ block: 'nearest' }); } catch (e) { try { row.scrollIntoView(); } catch (e2) {} }
    return true;
  }

  // 假工具条上的装饰按钮：长得像 Excel 的按钮，但点了什么也不该发生。
  // 既然点不动，Tab 就不该停在上面（KBD_SEL 是主闸，这里是一道保险丝 + 给读屏标上"装饰"）。
  function markDecor(root) {
    var deco = root.querySelectorAll('.fz-tb:not([data-fz-sortmenu]):not([data-fz-export]):not([data-fz-menu]):not([data-fz-fmenu])');
    for (var i = 0; i < deco.length; i++) {
      deco[i].removeAttribute('tabindex');
      deco[i].setAttribute('aria-hidden', 'true');
    }
    ['fz-addtab', 'fz-tab', 'fz-pick'].forEach(function (c) {
      var els = root.querySelectorAll('.' + c);
      for (var j = 0; j < els.length; j++) {
        els[j].removeAttribute('tabindex');
        els[j].setAttribute('aria-hidden', 'true');
      }
    });
    return deco.length;
  }

  // ===== 缩放：Excel 右下角那个 "100%" =====
  // 全表尺寸都挂在 --fz-z 上（见 CSS），这里只管改这个变量 + 记住它。
  var ZOOM_MIN = 60, ZOOM_MAX = 160, ZOOM_STEP = 10;
  function zoomClamp(v) {
    v = Math.round((Number(v) || 100) / ZOOM_STEP) * ZOOM_STEP;
    return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, v));
  }
  var ZOOM = zoomClamp(store.get('zoom', 100));
  function zoomApply(pct, keep) {
    ZOOM = zoomClamp(pct);
    document.documentElement.style.setProperty('--fz-z', String(ZOOM / 100));
    var el = document.querySelector('.fz-pct');
    if (el && el.textContent !== ZOOM + '%') el.textContent = ZOOM + '%';
    if (!keep) store.set('zoom', ZOOM);
    return ZOOM;
  }
  function zoomBy(step) { return zoomApply(ZOOM + step * ZOOM_STEP); }

  // Excel 的口径：右下角报的是看得见的选中格子，被筛选藏起来的行不进统计
  // （和 Ctrl+A、Ctrl+C、Ctrl+End 一个口径，见 DEV §39）。
  // 赞这一列认不出来的格子（"—"、空）不计入平均值/求和，但会在 title 里说清有几个。
  function selStats() {
    // 下面这段留着当参考：真要恢复统计，把上面那行 return 去掉就行。
    // 只看当前这张表里看得见、而且被选中的行。navRows() 一次给齐两件事：
    // 排除被筛选藏起来的行、并且只取当前视图的容器（列表 ↔ 详情/评论表）。
    var all = navRows(), nums = [], unknown = 0, i, cell, v;
    for (i = 0; i < all.length; i++) {
      if (!all[i].classList.contains('fz-selrow')) continue;
      cell = all[i].querySelector('.fz-c.fz-o');
      v = likeNum(cell ? cell.textContent : '');
      if (v === null) unknown++; else nums.push(v);
    }
    if (!nums.length) return null;
    var sum = 0;
    for (i = 0; i < nums.length; i++) sum += nums[i];
    return { count: nums.length, unknown: unknown, sum: sum, avg: sum / nums.length };
  }
  function statNum(n) {
    // Excel 里数字也常按"万"显示；这里跟着站点那套写法走
    n = Math.round(n);
    if (n >= 10000) {
      var w = n / 10000;
      return (w >= 10 ? Math.round(w) : Math.round(w * 10) / 10) + '万';
    }
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function paintSelStats() {
    var el = document.querySelector('.fz-sel-stat');
    if (!el) return;
    var s = selStats();
    var txt = s ? ('平均值: ' + statNum(s.avg) + '  计数: ' + s.count +
                   (s.unknown ? '（另有 ' + s.unknown + ' 格没写赞数）' : '') +
                   '  求和: ' + statNum(s.sum)) : '';
    if (el.textContent !== txt) el.textContent = txt;
    var tip = s ? '选中的行里，赞这一列能认出来的格子：共 ' + s.count + ' 格' +
      (s.unknown ? '，另有 ' + s.unknown + ' 格是空的或没写数字（没算进平均值）' : '') : '';
    if (el.getAttribute('title') !== tip) el.setAttribute('title', tip);
  }

  function paintFilter(show, total) {
    var on = filterOn();
    var nd = needNoData(total);
    var mk = document.querySelector('.fz-filtermk');
    if (mk) mk.classList.toggle('on', on);
    var st = document.querySelector('.fz-ready');
    // 只在文本真的变了才写：applyFilter 每轮 sync 都会跑，写同样的字也会触发
    // MutationObserver → schedule → sync，能自己把自己转起来
    var sum = on ? filterSummary() : '';
    var txt = (on ? ('筛选 ' + show + '/' + total + ' 行') : (nd ? '没有内容' : '就绪')) +
      (sortOn() ? (' · 排序：' + sortLabel()) : '');
    if (st && st.textContent !== txt) st.textContent = txt;
    // 为什么只剩这几行：鼠标停在状态栏上就能看见条件；想还原就点旁边那个链接
    if (st) {
      var tip = (sum ? '筛选条件：' + sum : '') +
        (sortOn() ? (sum ? '\n' : '') + '排序：' + sortLabel() : '');
      if (st.getAttribute('title') !== tip) st.setAttribute('title', tip);
    }
    paintClearChips(on, sum);
    paintEmpty(show);
    paintNoData(nd);
    planNoDataCheck(total);
    paintSel();
    paintSelStats();          // 重建过的行要把选中样式补回来（选的是"行"本身，不是它的内容）
    // 第一次装上：真抓到内容了才提一句"脚本在工作 + 去哪设置 + 怎么收起"
    if (!helpShownThisPage && !on && total > 0 && !yieldMode && needHelp()) {
      helpShownThisPage = true;
      firstRunHint();
    }
    // 表头 ▾ 变绿表示这一列有筛选条件
    var marks = document.querySelectorAll('[data-fz-filter]');
    for (var i = 0; i < marks.length; i++) {
      var k = marks[i].dataset.fzFilter;
      var active = (k === 'type' && FILT.type) || (k === 'like' && FILT.minLike) ||
                   (k === 'author' && FILT.author) || (k === 'when' && FILT.when);
      marks[i].classList.toggle('fz-fon', !!active);
    }
  }

  // 当前数据里有哪些类型（带条数）：筛选选项跟着数据走，不写死"图文/视频"
  function typeOptions() {
    var rows = document.querySelectorAll('.fz-row');
    var seen = {}, order = [];
    for (var i = 0; i < rows.length; i++) {
      var t = rows[i].dataset.fzType || '笔记';
      if (!seen[t]) { seen[t] = 0; order.push(t); }
      seen[t]++;
    }
    return order.map(function (t) { return { value: t, label: t, count: seen[t] }; });
  }

  var filtEl = null, filtKey = '', filtQuery = '';   // filtQuery：面板里那个搜索框的内容（作者太多时用）

  function closeFilter() {
    if (filtEl && filtEl.parentNode) filtEl.parentNode.removeChild(filtEl);
    setFilterAria(false);
    filtEl = null; filtKey = '';
    return false;
  }

  // 表头上的"折叠状态"：读屏/键盘用户看不到 ▾ 是不是亮着
  function setFilterAria(on) {
    var all = document.querySelectorAll('[data-fz-filter]');
    for (var i = 0; i < all.length; i++) {
      all[i].setAttribute('aria-expanded', (on && all[i].dataset.fzFilter === filtKey) ? 'true' : 'false');
    }
  }

  // ---- 面板的键盘操作：↑↓ 选、回车确认（手势用户无所谓，键盘用户少一次瞄准）----
  function filterMark(idx) {
    if (!filtEl) return null;
    var its = filtEl.querySelectorAll('.fz-mi');
    if (!its.length) return null;
    idx = ((idx % its.length) + its.length) % its.length;   // 循环
    for (var i = 0; i < its.length; i++) its[i].classList.toggle('fz-mcur', i === idx);
    try { its[idx].scrollIntoView({ block: 'nearest' }); } catch (e) {}
    return its[idx];
  }

  // 高亮当前生效的那一项（没有就第一项）：一打开就能直接按回车
  function filterCurVal() {
    return filtKey === 'type' ? FILT.type
         : filtKey === 'author' ? FILT.author
         : filtKey === 'when' ? FILT.when
         : String(FILT.minLike || '');
  }
  // doFocus：要不要顺手把焦点挪到高亮项上。开门（openFilter）和用户自己操作时给 true；
  // 后台同步时给 false，面板会因为新行到达而重画，那时候抢焦点会把用户正在打的字打断
  function markFilterCur(doFocus) {
    if (!filtEl) return null;
    var its = filtEl.querySelectorAll('.fz-mi'), cur = -1;
    var now = filterCurVal();
    for (var i = 0; i < its.length; i++) {
      if (its[i].dataset.fzFval === now) { cur = i; break; }
    }
    var el = filterMark(cur < 0 ? 0 : cur);
    // 高亮和键盘焦点保持同一个：Tab 进来的人按回车点的是"亮着的那一项"。
    // 但面板里有搜索框时，焦点得留在框里（不然打第二个字就打到条目上了）
    if (filtEl.querySelector('.fz-minput')) {
      if (doFocus) focusFilterInput();
    } else if (doFocus !== false) {
      try { if (el) el.focus({ preventScroll: true }); } catch (e2) {}
    }
    return el;
  }

  function filterMove(d) {
    var its = filtEl ? filtEl.querySelectorAll('.fz-mi') : [];
    var cur = -1;
    for (var i = 0; i < its.length; i++) if (its[i].classList.contains('fz-mcur')) { cur = i; break; }
    var el = filterMark(cur < 0 ? (d > 0 ? 0 : its.length - 1) : cur + d);
    if (!(filtEl && filtEl.querySelector('.fz-minput'))) {
      try { if (el) el.focus({ preventScroll: true }); } catch (e2) {}
    }
    return el;
  }

  function filterCommit() {
    if (!filtEl) return false;
    var it = filtEl.querySelector('.fz-mi.fz-mcur') || filtEl.querySelector('.fz-mi');
    if (!it) return false;
    if (it.dataset.fzSortask) return applyPanelSort(it.dataset.fzSortask);   // 面板顶上的排序两项
    setFilter(filtKey, it.dataset.fzFval);
    return true;
  }

  // 面板里的「升序 / 降序 / 取消排序」：和 ⇅ 排序面板、点列头排序都是同一个 setSort
  function applyPanelSort(spec) {
    var p = String(spec || '').split(':');
    if (!p[0]) return false;
    if (p[1] === 'off') setSort('', 1);          // 回原顺序（就是"取消排序"）
    else setSort(p[0], p[1] === 'asc' ? 1 : -1);
    closeFilter();                     // Excel 也是选完就收起下拉
    return true;
  }
  function filterCurValue() {
    var it = filtEl ? filtEl.querySelector('.fz-mi.fz-mcur') : null;
    return it ? it.dataset.fzFval : null;
  }

  // 当前数据里有哪些作者（带条数）：和类型一样跟着数据长出来，不写死。
  // 视图不同候选也不同：列表看笔记作者，详情看评论作者（主贴作者也在里面）
  function authorRows() {
    return document.querySelector('.fz-notesheet')
      ? document.querySelectorAll('.fz-nrow')
      : document.querySelectorAll('.fz-row');
  }
  var AUTHOR_CAP = 30;
  // q：面板里那格的搜索词（子串匹配，不区分大小写）。先筛再截断，这样"第 31 位作者"
  // 也能靠打字找出来，不然「还有 N 位」就是一句空话（v0.57）
  function authorOptions(q) {
    var rows = authorRows(), seen = {}, order = [], i;
    for (i = 0; i < rows.length; i++) {
      var a = rows[i].dataset ? (rows[i].dataset.fzAuthor || '') : '';
      if (!a) continue;                       // 没作者的行不当候选（筛它没有意义）
      if (!seen[a]) { seen[a] = 0; order.push(a); }
      seen[a]++;
    }
    order.sort(function (x, y) { return seen[y] - seen[x] || (x < y ? -1 : x > y ? 1 : 0); });
    var all = order.length, needle = String(q == null ? '' : q).trim().toLowerCase();
    if (needle) order = order.filter(function (a) { return a.toLowerCase().indexOf(needle) >= 0; });
    var matched = order.length;
    var list = order.slice(0, AUTHOR_CAP).map(function (a) {
      return { value: a, label: a, count: seen[a] };
    });
    return { opts: list, more: Math.max(0, matched - list.length), total: all, matched: matched, q: needle };
  }

  // 时间筛选（v0.56）：今天 / 最近 N 天。就看行上的 fzMs（毫秒），比大小。
  // "今天"按本地 0 点起算（合人的直觉），其余按"现在往前推 N×24 小时"。
  var WHEN_STEPS = [['today', '今天'], ['3d', '最近 3 天'], ['7d', '最近 7 天'], ['30d', '最近 30 天']];
  var DAY_MS = 86400000;
  function whenFloor(when) {
    if (!when) return 0;
    if (when === 'today') {
      var d = new Date();
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    }
    var n = parseInt(String(when), 10);
    return n > 0 ? Date.now() - n * DAY_MS : 0;
  }
  // Excel 的自动筛选下拉框里，排序和筛选是同一张菜单：点列头出下拉，前两项是升/降序。
  // 我们照抄这个：能排的列（赞 / 作者 / 时间）在筛选面板顶上放两条排序，点列头这件事就完整了。
  var PANEL_SORT = {
    like:   { key: 'like',   labels: ['↑ 赞少的在前', '↓ 赞多的在前', '✕ 取消排序'] },
    author: { key: 'author', labels: ['↑ 作者 A → Z', '↓ 作者 Z → A', '✕ 取消排序'] },
    when:   { key: 'time',   labels: ['↑ 早的在前', '↓ 新的在前', '✕ 取消排序'] }
  };

  function filterSortItemsHtml(key) {
    var ps = PANEL_SORT[key];
    if (!ps) return '';
    var s = SO();
    var dirs = ['asc', 'desc', 'off'];
    var cur = s.key === ps.key ? (s.dir > 0 ? 'asc' : 'desc') : 'off';   // 没在按这列排 = 高亮「取消排序」
    return ps.labels.map(function (lb, i) {
      var d = dirs[i];
      return '<div class="fz-mi" data-fz-sortask="' + ps.key + ':' + d + '">' +
        '<span class="fz-mk">' + (cur === d ? '✓' : '') + '</span>' +
        '<span class="fz-mt">' + esc(lb) + '</span>' +
        '<span class="fz-mv">' + (cur === d ? '当前' : '') + '</span>' +
      '</div>';
    }).join('') + '<div class="fz-msep"></div>';
  }

  function filterItemsHtml(key) {
    var cur = key === 'type' ? FILT.type
            : key === 'author' ? FILT.author
            : key === 'when' ? FILT.when
            : String(FILT.minLike || '');
    var items = [], head = '';
    if (key === 'type') {
      items.push({ value: '', label: '全部类型', count: document.querySelectorAll('.fz-row').length });
      items = items.concat(typeOptions());
      head = '只看某一类';
    } else if (key === 'author') {
      var ao = authorOptions(filtQuery);
      var allRows = authorRows().length;
      items.push({ value: '', label: '全部作者', count: allRows });
      items = items.concat(ao.opts);
      head = '只看某位作者';
      if (ao.q && !ao.matched) head = '没有匹配「' + ao.q + '」的作者（清掉搜索框就都回来了）';
      else if (ao.q) head = '搜「' + ao.q + '」：' + ao.matched + ' 位作者' +
        (ao.more ? ' · 只显示前 ' + AUTHOR_CAP + ' 位，把词写长一点' : '');
      else if (ao.more) head += ' · 共 ' + ao.total + ' 位，还有 ' + ao.more + ' 位没显示，用下面的搜索框找';
    } else if (key === 'when') {
      // 条数是"按这个台阶筛完还剩几行"，所以一定是越来越大的（今天 ≤ 3 天 ≤ 7 天 ≤ 30 天）
      var wsz = document.querySelectorAll('.fz-row, .fz-nrow');
      var known = 0, cnt = [];
      for (var w = 0; w < WHEN_STEPS.length; w++) cnt.push(0);
      Array.prototype.forEach.call(wsz, function (r) {
        var ms = Number((r.dataset || {}).fzMs || 0);
        if (!ms) return;                     // 时间推不出来的行：不计进任何台阶（但也不会被藏）
        known++;
        for (var w2 = 0; w2 < WHEN_STEPS.length; w2++) {
          if (ms >= whenFloor(WHEN_STEPS[w2][0])) cnt[w2]++;
        }
      });
      items.push({ value: '', label: '全部时间', count: wsz.length });
      for (var s = 0; s < WHEN_STEPS.length; s++) {
        items.push({ value: WHEN_STEPS[s][0], label: WHEN_STEPS[s][1], count: cnt[s] });
      }
      head = '只看这段时间发的 / 评的（今天按 0 点起算）' +
        (known < wsz.length ? ' · 有 ' + (wsz.length - known) + ' 行没有时间，不会被藏' : '');
    } else {
      for (var i = 0; i < LIKE_STEPS.length; i++) {
        items.push({ value: LIKE_STEPS[i][0], label: LIKE_STEPS[i][1], count: '' });
      }
      head = '只看赞数够的';
    }
    // 作者面板给一格搜索框（Excel 的下拉框里也有）：选项太多时不用一个个滚
    var srch = key === 'author'
      ? '<input class="fz-minput" type="text" spellcheck="false" autocomplete="off" ' +
        'placeholder="搜作者…" value="' + esc(filtQuery) + '">'
      : '';
    return '<div class="fz-mhint">' + head + '</div>' + filterSortItemsHtml(key) + srch + items.map(function (it) {
      return '<div class="fz-mi" data-fz-fval="' + esc(it.value) + '">' +
        '<span class="fz-mk">' + (String(it.value) === String(cur) ? '✓' : '') + '</span>' +
        '<span class="fz-mt">' + esc(it.label) + '</span>' +
        '<span class="fz-mv">' + (it.count === '' ? '' : it.count) + '</span>' +
      '</div>';
    }).join('') +
      '<div class="fz-msep"></div><div class="fz-mhint">点一项就生效 · ↑↓ 选、回车确认<br>' +
      '条件不写盘，刷新即清</div>';
  }

  // ---------- 点击兜底（v0.91）----------
  // 全局只有一个捕获阶段的 click 处理器，它是"单点"：
  //   · 被更早注册的捕获处理器（别的扩展 / 站点自己的 click-outside）停掉，就整条哑火；
  //   · 它自己在 `hdrGraceUntil`（表头兜底那 500ms）和"列宽拖动余波"两条分支里会提前 return。
  // 一旦哑火，用户看到的就是"面板开着、点条件没反应；工具栏按钮也点不动"。
  // 所以再给面板和工具栏各自挂一层：正常情况全局那条会先 stopPropagation，这里根本不会触发；
  // 只有全局那条没办成事时才由它接手，不会点一次生效两次。
  function bindPanelClicks(el) {
    if (!el || el.__fzClickBound) return el;
    el.__fzClickBound = 1;
    // 条件项兜底：按下之后 120ms 还没生效才由这里补一刀。
    // 为什么不直接在 pointerdown 里办：`setFilter()` 会把面板重画一遍（每项要更新"当前 N 条"），
    // 按下就重画等于把正要 click 的那个节点换掉，手一抖就会点到别的项上。
    // 为什么要它：click 可能被别的东西吃掉（页面上跑着两份脚本 / 别的扩展在捕获阶段
    // stopPropagation），那时 click 永远到不了这里，用户报的"点条件没反应"就是这种。
    el.addEventListener('pointerdown', function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      var b = t.closest('[data-fz-fval]');
      if (b) {
        var k = filtKey, v = b.getAttribute('data-fz-fval');
        setTimeout(function () {
          try {
            // 'like' 存在 FILT.minLike 里（数字），别的列就是同名字段
            var cur = (k === 'like') ? String(FILT.minLike || '') : String(FILT[k] == null ? '' : FILT[k]);
            if (cur !== String(v)) setFilter(k, v);
          } catch (e0) {}
        }, 120);
        return;
      }
      // 排序项同理：setSort / applyPanelSort 都是"设成某个确定状态"，重复执行结果一样
      var sv = t.closest('[data-fz-sval]');
      if (sv) {
        var sk = sv.dataset.fzSval, sd = parseInt(sv.dataset.fzSdir, 10);
        setTimeout(function () {
          try {
            var st0 = SO();
            if (String(st0.key || '') !== String(sk || '') || (sk && st0.dir !== sd)) {
              setSort(sk, sd);
              closeSort();
            }
          } catch (e1) {}
        }, 120);
        return;
      }
      var ask = t.closest('[data-fz-sortask]');
      if (ask) {
        var spec = ask.getAttribute('data-fz-sortask');
        setTimeout(function () {
          try { applyPanelSort(spec); } catch (e2) {}
        }, 120);
        return;
      }
    }, true);
    el.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      var b;
      if ((b = t.closest('[data-fz-fval]'))) {
        ev.preventDefault(); ev.stopPropagation();
        setFilter(filtKey, b.getAttribute('data-fz-fval'));
        return;
      }
      if ((b = t.closest('[data-fz-sortask]'))) {
        ev.preventDefault(); ev.stopPropagation();
        applyPanelSort(b.getAttribute('data-fz-sortask'));
        return;
      }
      if ((b = t.closest('[data-fz-sval]'))) {
        ev.preventDefault(); ev.stopPropagation();
        try { setSort(b.dataset.fzSval, parseInt(b.dataset.fzSdir, 10)); } catch (e1) {}
        closeSort();
        return;
      }
      if ((b = t.closest('[data-fz-fkey]'))) {
        ev.preventDefault(); ev.stopPropagation();
        var k2 = b.getAttribute('data-fz-fkey');
        var cell2 = document.querySelector('.fz-thead [data-fz-filter="' + k2 + '"]');
        closeMenu();
        openFilter(k2, cell2 || b);
        return;
      }
      if ((b = t.closest('[data-fz-nodata]'))) {
        ev.preventDefault(); ev.stopPropagation();
        if (b.dataset.fzNodata === 'login') doLogin(); else retryFetch();
        return;
      }
    });
    return el;
  }

  // 工具栏那几个按钮（筛选 ▾ / ⇅ / ⇩ / ⋯）：同样各挂一层，理由同上
  function bindChromeClicks(el) {
    if (!el || el.__fzChromeClick) return el;
    el.__fzChromeClick = 1;
    // 工具栏按钮的 pointerdown 兜底：click 被别的处理器（或另一份脚本）吃掉时，
    // 面板根本不会开。按下 150ms 后看一眼"该开的面板开了没"，没开就自己开。
    // 只做"开"不做"关"，所以就算重复也不会把面板刚开就关掉。
    el.addEventListener('pointerdown', function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      var b;
      if ((b = t.closest('[data-fz-fmenu]'))) {
        setTimeout(function () { if (!document.querySelector('.fz-pickmenu')) openFilterPicker(b); }, 150);
        return;
      }
      if ((b = t.closest('[data-fz-sortmenu]'))) {
        setTimeout(function () { if (!document.querySelector('.fz-sortmenu')) openSortMenu(b); }, 150);
        return;
      }
      if ((b = t.closest('[data-fz-menu]'))) {
        setTimeout(function () { if (!document.querySelector('.fz-menu,.fz-set')) toggleMenu(b); }, 150);
        return;
      }
    }, true);
    el.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      var b;
      if ((b = t.closest('[data-fz-fmenu]'))) { ev.preventDefault(); ev.stopPropagation(); openFilterPicker(b); return; }
      if ((b = t.closest('[data-fz-sortmenu]'))) { ev.preventDefault(); ev.stopPropagation(); toggleSortMenu(b); return; }
      if ((b = t.closest('[data-fz-export]'))) { ev.preventDefault(); ev.stopPropagation(); exportCsv(); return; }
      if ((b = t.closest('[data-fz-menu]'))) { ev.preventDefault(); ev.stopPropagation(); toggleMenu(b); return; }
    });
    return el;
  }

  function openFilter(key, anchor) {
    closeMenu();
    closeFilter();
    closeSort();                   // 三个面板互斥，别叠着
    var m = document.createElement('div');
    m.className = 'fz-menu fz-filtmenu';
    m.setAttribute('data-fz-menu-panel', '1');   // 点面板里面不算"点别处"
    m.setAttribute('data-fz-filter-panel', '1');
    filtQuery = '';                    // 每次开面板都是干净的搜索框（条件本身不写盘，这个也不写）
    m.innerHTML = filterItemsHtml(key);
    document.body.appendChild(m);
    bindPanelClicks(m);
    placePanel(m, anchor);
    markKeyboard(m);
    filtEl = m; filtKey = key;
    wireFilterInput();
    markFilterCur();
    setFilterAria(true);
    return m;
  }

  // 面板里的搜索框：打字就重画列表（搜索词记在 filtQuery 里，重画后要放回原处）
  function wireFilterInput() {
    if (!filtEl) return null;
    var inp = filtEl.querySelector('.fz-minput');
    if (!inp) return null;
    inp.addEventListener('input', function () {
      filtQuery = inp.value;
      refreshFilter();
    });
    return inp;
  }
  function focusFilterInput() {
    var inp = filtEl ? filtEl.querySelector('.fz-minput') : null;
    if (!inp) return false;
    try {
      inp.focus({ preventScroll: true });
      var v = inp.value;
      inp.setSelectionRange(v.length, v.length);   // 光标放末尾，接着打字
    } catch (e) {}
    return true;
  }

  // 重画面板内容。doFocus=true 是用户自己操作引起的（开门、点条目、打字）；
  // 后台同步（新行到达）走 doFocus=false，只更新列表，绝不抢焦点。
  // 焦点会被"还原"：本来在搜索框里就还在框里（连光标位置一起），本来在某个条目上就还回那个条目
  function renderFilterItems(doFocus) {
    if (!filtEl) return;
    var inpOld = filtEl.querySelector('.fz-minput');
    var inputHad = !!inpOld && document.activeElement === inpOld;
    var ae = document.activeElement;
    var navVal = (ae && filtEl.contains(ae) && ae.classList && ae.classList.contains('fz-mi'))
      ? ae.dataset.fzFval : null;
    filtEl.innerHTML = filterItemsHtml(filtKey);
    if (inpOld || filtKey === 'author') wireFilterInput();
    markFilterCur(doFocus);     // 重建 innerHTML 会丢高亮，重挑一遍当前项
    if (inputHad) focusFilterInput();
    else if (navVal !== null) {
      var back = filtEl.querySelector('.fz-mi[data-fz-fval="' + navVal + '"]');
      try { if (back) back.focus({ preventScroll: true }); } catch (e) {}
    }
  }

  function refreshFilter() {
    renderFilterItems(true);
    applyFilter();
  }

  function setFilter(key, val) {
    if (key === 'type') FILT.type = String(val == null ? '' : val);
    else if (key === 'author') FILT.author = String(val == null ? '' : val);
    else if (key === 'when') FILT.when = String(val == null ? '' : val);
    else if (key === 'like') FILT.minLike = parseInt(val, 10) || 0;
    refreshFilter();
    return { type: FILT.type, minLike: FILT.minLike, author: FILT.author, when: FILT.when };
  }

  function clearFilter() {
    FILT.type = ''; FILT.minLike = 0; FILT.author = ''; FILT.when = '';
    var inp = document.querySelector('.fz-search');
    if (inp) inp.value = '';
    refreshFilter();
    return applyFilter();
  }

  // ===== 排序：Excel 里点列头就能排 =====
  // 列表和详情各记各的（详情表按"赞"排是排评论，和首页列表不是一回事，
  // 一路带过去会让人打开笔记发现评论顺序被改了）；赞 / 时间 默认降序（看最火的、看最新的），
  // 文本列默认升序（A→Z）。排序只在 applyFilter 里跑，所以新加载进来的行也自动就位。
  var SORTS = { list: { key: '', dir: 1 }, detail: { key: '', dir: 1 } };
  var SORT_CELL = { like: '.fz-o', time: '.fz-p', author: '.fz-a', text: '.fz-e' };
  var SORT_NAME = { like: '赞', time: '时间', author: '作者', text: '标题' };

  function sortView() { return document.querySelector('.fz-notesheet') ? 'detail' : 'list'; }
  function SO() { return SORTS[sortView()]; }
  function sortOn() { return !!SO().key; }
  function defaultDir(key) { return (key === 'like' || key === 'time') ? -1 : 1; }
  function sortLabel() {
    var s = SO();
    return s.key ? ((SORT_NAME[s.key] || s.key) + (s.dir > 0 ? ' ↑' : ' ↓')) : '';
  }

  // 时间列只写 MM/DD HH:MM（年份不在这一列里），补零成 MMDDHHMM 就能直接比大小
  function sortTimeKey(t) {
    var m = String(t == null ? '' : t).match(/^(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/);
    if (!m) return -1;
    return (+m[1] * 100 + +m[2]) * 10000 + (+(m[3] || 0)) * 100 + (+(m[4] || 0));
  }
  function sortVal(row, key) {
    if (key === 'like') {
      var n = likeNum(row.dataset.fzLike);
      return n === null ? -1 : n;          // 赞数认不出来的排最后，不瞎猜
    }
    var c = row.querySelector(SORT_CELL[key]);
    var t = c ? (c.textContent || '').replace(/\s+/g, ' ').trim() : '';
    return key === 'time' ? sortTimeKey(t) : t;
  }
  // 行号列就是"原顺序"：同值（赞数一样、都是空时间）时按它兜底 → 排序结果稳定，
  // 不会每轮 sync 都换个样（换了样 MutationObserver 会把自己转起来）
  function rowOrd(row) {
    var c = row.querySelector('.fz-num');
    var n = c ? parseInt((c.textContent || '').replace(/\D/g, ''), 10) : NaN;
    return isNaN(n) ? 0 : n;
  }
  function cmpRows(a, b) {
    var x = sortVal(a, SO().key), y = sortVal(b, SO().key);
    var d;
    if (typeof x === 'number' || typeof y === 'number') d = (x < y) ? -1 : (x > y ? 1 : 0);
    else d = String(x).localeCompare(String(y), 'zh-Hans-CN');
    if (d === 0) d = rowOrd(a) - rowOrd(b);
    return SO().dir > 0 ? d : -d;
  }
  // 只排"当前这张表"：详情页开着时排的是评论区，首页表格（在背后）不能跟着动，
  // 否则关掉笔记一看，首页顺序被评论的顺序替换了（本地 S19 就是钉这个）
  function sortScope() {
    if (sortView() === 'detail') return document.querySelector('.fz-notesheet');
    return document.querySelector('.fz-board') || document;
  }
  // 按"父容器"分组排：首页行在 .fz-board 里、评论行在评论区里、主贴行单独一格，
  // 分组排就不会把主贴行排到评论后面去。
  // 没排序时也要跑：按行号把顺序还原（"第三次点列头回原序"就是靠这一步），
  // 但只有在顺序真的不对时才动 DOM，每次 sync 都白动一下会喂 MutationObserver，自己转自己。
  function sortRows() {
    var scope = sortScope();
    if (!scope) return 0;
    var rows = [].slice.call(scope.querySelectorAll('.fz-row, .fz-nrow'));
    if (rows.length < 2) return 0;
    var key = SO().key;
    var groups = new Map();
    for (var i = 0; i < rows.length; i++) {
      var p = rows[i].parentNode;
      if (!p) continue;
      if (!groups.has(p)) groups.set(p, []);
      groups.get(p).push(rows[i]);
    }
    var moved = 0;
    // 每行后面可能跟着一条「展开 N 条回复」（.fz-trow，v0.95）：它不是数据行、不参与排序，
    // 但它是这一楼的一部分。搬行时要把它一起搬走，否则排序一跑，所有按钮行会被留在原地，
    // 在表格顶上堆成一坨（真机 R39 就是这么红的：T T T T 楼7 楼11 楼1 楼9…）。
    function unitOf(row) {
      var u = [row], n = row.nextElementSibling;
      while (n && n.classList && n.classList.contains('fz-trow')) {
        u.push(n);
        n = n.nextElementSibling;
      }
      return u;
    }
    groups.forEach(function (list) {
      if (list.length < 2) return;
      var want = list.slice().sort(key ? cmpRows : function (a, b) { return rowOrd(a) - rowOrd(b); });
      var same = true;
      for (var k = 0; k < want.length; k++) { if (want[k] !== list[k]) { same = false; break; } }
      if (same) return;
      var tailUnit = unitOf(list[list.length - 1]);
      var last = tailUnit[tailUnit.length - 1];
      var anchor = last.nextSibling;    // 行后面跟着的东西（多半是「加载更多」）留在最后
      for (var j = 0; j < want.length; j++) {
        var u2 = unitOf(want[j]);       // 先取整体，再往里搬（搬完 nextElementSibling 就变了）
        for (var uu = 0; uu < u2.length; uu++) last.parentNode.insertBefore(u2[uu], anchor);
      }
      moved++;
    });
    return moved;
  }
  // 列头那个 ▲▼ 用 class 画，不写进文字：表头 textContent 必须是干净的列名（导出 CSV 读它）
  function paintSort() {
    var s = SO();
    var hs = document.querySelectorAll('[data-fz-sort]');
    for (var i = 0; i < hs.length; i++) {
      var on = !!s.key && hs[i].dataset.fzSort === s.key;
      hs[i].classList.toggle('fz-sasc', on && s.dir > 0);
      hs[i].classList.toggle('fz-sdesc', on && s.dir < 0);
    }
  }
  function sortNow() {
    sortRows();
    paintSort();
    return applyFilter();
  }
  function setSort(key, dir) {
    var s = SO();
    s.key = key || '';
    s.dir = s.key ? ((dir === 1 || dir === -1) ? dir : defaultDir(s.key)) : 1;
    return sortNow();
  }
  function clearSort() { return setSort('', 1); }
  // 点列头：换一列 → 用这列的默认方向；同一列再点 → 反向；第三次 → 回原顺序
  function cycleSort(key) {
    if (!key) return clearSort();
    var s = SO();
    if (s.key !== key) { s.key = key; s.dir = defaultDir(key); }
    else if (s.dir === defaultDir(key)) s.dir = -defaultDir(key);
    else { s.key = ''; s.dir = 1; }
    return sortNow();
  }
  function sortState() {
    var s = SO(), key = s.key;
    var scope = sortScope();
    var rows = scope ? [].slice.call(scope.querySelectorAll('.fz-row, .fz-nrow')) : [];
    return {
      view: sortView(), on: sortOn(), key: key, dir: s.dir, label: sortLabel(),
      order: rows.map(function (r) {
        var c = r.querySelector('.fz-num');
        return c ? (c.textContent || '').trim() : '';
      }),
      vals: key ? rows.map(function (r) { return sortVal(r, key); }) : []
    };
  }

  // ---- 排序面板：工具栏那个 ⇅（Excel 的「排序和筛选」就在这一排）----
  // 赞 的排序只能从这里进：直接点「赞 ▾」是筛选，一个点击不能既筛又排
  var sortEl = null;
  var SORT_ITEMS = [
    ['like', -1, '赞 ↓ 从多到少'],
    ['like', 1, '赞 ↑ 从少到多'],
    ['time', -1, '时间 ↓ 最新在前'],
    ['time', 1, '时间 ↑ 最早在前'],
    ['author', 1, '作者 ↑ 按名字'],
    ['', 1, '恢复原顺序']
  ];
  function sortItemsHtml() {
    var s = SO();
    var head = '<div class="fz-mhint">排序（' + (sortView() === 'detail' ? '详情表' : '首页表') + '）</div>';
    return head + SORT_ITEMS.map(function (it) {
      var on = s.key === it[0] && (!it[0] || s.dir === it[1]);
      return '<div class="fz-mi" data-fz-sval="' + it[0] + '" data-fz-sdir="' + it[1] + '"' +
        ' title="' + it[2] + '">' +
        '<span class="fz-mk">' + (on ? '✓' : '') + '</span>' +
        '<span class="fz-mt">' + it[2] + '</span>' +
      '</div>';
    }).join('') +
      '<div class="fz-msep"></div><div class="fz-mhint">点表头（标题 / 作者 / 时间）也能排<br>' +
      '排序只改显示顺序，行号还是原来的 · 新加载的行自动就位</div>';
  }
  function closeSort() {
    if (sortEl && sortEl.parentNode) sortEl.parentNode.removeChild(sortEl);
    sortEl = null;
    return false;
  }
  function openSortMenu(anchor) {
    closeMenu(); closeFilter(); closeSort();
    var m = document.createElement('div');
    m.className = 'fz-menu fz-sortmenu';
    m.setAttribute('data-fz-menu-panel', '1');    // 点面板里面不算"点别处"
    m.setAttribute('data-fz-sort-panel', '1');
    m.innerHTML = sortItemsHtml();
    document.body.appendChild(m);
    bindPanelClicks(m);
    placePanel(m, anchor);
    markKeyboard(m);
    sortEl = m;
    return m;
  }
  function toggleSortMenu(anchor) {
    if (sortEl) { closeSort(); return false; }
    openSortMenu(anchor);
    return true;
  }

  function toast(msg, ms) {
    var d = document.getElementById('fz-toast');
    if (d) d.remove();
    d = document.createElement('div');
    d.id = 'fz-toast';
    d.className = 'fz-toast';
    d.textContent = msg;
    document.body.appendChild(d);
    setTimeout(function () { if (d.parentNode) d.remove(); }, ms || 2400);
  }

  // ---------- 「正在加载」提示 ----------
  // 回原生页面取数据的那几秒，光靠一句小字（以前的 fz-cover-tip）根本看不出在忙：
  // 屏幕一动不动，用户只会以为卡死了。这里给一张固定在屏幕正中的卡片（转圈 + 文案 + 进度条），
  // 整屏加一层很淡的白幕，让"我确实在干活"这件事一眼可见。
  var busyEl = null, busyKill = null;
  function busyShow(txt, sub) {
    if (!CFG.busy) return null;          // 设置里关掉：加载不再弹卡片（按钮上的文字照样变）
    if (!document.body) return null;
    if (!busyEl || !busyEl.isConnected) {
      busyEl = document.createElement('div');
      busyEl.className = 'fz-busy';
      busyEl.setAttribute('role', 'status');
      busyEl.setAttribute('aria-live', 'polite');
      busyEl.innerHTML = '<div class="fz-busy-card"><i class="fz-busy-spin"></i>' +
        '<div><div class="fz-busy-txt"></div><div class="fz-busy-sub"></div>' +
        '<div class="fz-busy-bar"><i></i></div></div></div>';
      try { document.body.appendChild(busyEl); } catch (e) { busyEl = null; return null; }
    }
    busySet(txt, sub);
    // 保险丝：万一哪条路径没收尾（异常/中途 return），25 秒后自己撤掉，绝不把"加载中"焊在屏幕上
    clearTimeout(busyKill);
    busyKill = setTimeout(busyHide, 25000);
    return busyEl;
  }
  function busySet(txt, sub) {
    if (!CFG.busy) return false;
    if (!busyEl || !busyEl.isConnected) return false;
    var t = busyEl.querySelector('.fz-busy-txt');
    var s = busyEl.querySelector('.fz-busy-sub');
    if (t && t.textContent !== (txt || '')) t.textContent = txt || '';
    if (s) {
      var v = sub || '';
      if (s.textContent !== v) s.textContent = v;
      s.style.display = v ? '' : 'none';
    }
    return true;
  }
  function busyHide() {
    clearTimeout(busyKill);
    busyKill = null;
    if (busyEl && busyEl.parentNode) busyEl.parentNode.removeChild(busyEl);
    busyEl = null;
  }

  // 第一次装上的人最需要的三件事：脚本接管了、设置在哪儿、最常用的键是哪个。
  // 只弹一次（存起来），而且只在"真的抓到内容"时弹，空表格上弹这个更让人困惑（见 §23）。
  var helpShownThisPage = false;
  function needHelp() { return !store.get('helpSeen', false); }
  function firstRunHint() {
    if (!needHelp()) return false;
    store.set('helpSeen', 1);
    toast('这张表接管好了。设置在工具栏右边的「⚙ 设置」，Ctrl+Shift+X 收起浮层', 6000);
    return true;
  }

  // Ctrl+滚轮缩放：Excel 里就是这个手势。必须 preventDefault，不然浏览器会缩放整个页面，
  // 伪装出来的表格和站点的元素会一起变大变小，看着就不像表格了
  document.addEventListener('wheel', function (e) {
    if (!e.ctrlKey) return;
    if (!document.documentElement.classList.contains('fz-table')) return;
    var inSheet = e.target && e.target.closest && e.target.closest('.fz-board,.fz-notesheet,.fz-chrome');
    if (!inSheet) return;
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  // ===== 导出 CSV：装成 Excel，最实在的出口就是真的给一份 Excel 能打开的文件 =====
  function csvQuote(s) {
    s = String(s == null ? '' : s);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  // 纯函数：二维数组 + 表头 → CSV 文本（带 BOM，Excel 直接认 UTF-8 中文）
  function csvOf(rows, head) {
    var lines = [];
    if (head && head.length) lines.push(head.map(csvQuote).join(','));
    for (var i = 0; i < rows.length; i++) lines.push(rows[i].map(csvQuote).join(','));
    return '\ufeff' + lines.join('\r\n') + (lines.length ? '\r\n' : '');
  }
  function exportScope() {
    var ns = document.querySelector('.fz-notesheet');
    return {
      detail: !!ns,
      rows: (ns || document.querySelector('.fz-board') || document).querySelectorAll(ns ? '.fz-nrow' : '.fz-row')
    };
  }
  function exportHead() {
    var th = document.querySelector('.fz-thead');
    var head = th ? Array.prototype.map.call(th.children, function (e) {
      return (e.textContent || '').replace(/\s+/g, ' ').trim();
    }) : [];
    if (head.length) head[0] = head[0] || '行号';   // 表头左上角是空的（Excel 的选择角）
    return head;
  }
  function buildCsv() {
    var sc = exportScope();
    var head = exportHead();
    var skip = head.indexOf('操作');        // "赞 收藏 回复"是给人点的，导出去没有意义
    var rows = [];
    for (var i = 0; i < sc.rows.length; i++) {
      var r = sc.rows[i];
      if (r.classList.contains('fz-hide')) continue;   // 被搜索过滤掉的行不导出
      var cs = r.querySelectorAll('.fz-c');
      var line = [];
      for (var j = 0; j < cs.length; j++) {
        if (j === skip) continue;
        line.push(cellText(cs[j]));       // 长正文要给全文、按钮文案不要（和复制同一个口径）
      }
      rows.push(line);
    }
    var h2 = skip > -1 ? head.filter(function (_, k) { return k !== skip; }) : head;
    var d = new Date();
    var stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
    return {
      name: (CFG.docTitle || '表格') + '-' + stamp + (sc.detail ? '-笔记' : '') + '.csv',
      text: csvOf(rows, h2),
      count: rows.length,
      detail: sc.detail
    };
  }
  function exportCsv() {
    var d;
    try { d = buildCsv(); } catch (e) { toast('导出失败：' + ((e && e.message) || e)); return; }
    if (!d.count) { toast('没有可导出的行'); return; }
    try {
      var blob = new Blob([d.text], { type: 'text/csv;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = d.name;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        try { a.remove(); URL.revokeObjectURL(url); } catch (e2) {}
      }, 0);
      toast('已导出 ' + d.count + ' 行 → ' + d.name);
    } catch (e3) { toast('导出失败：' + ((e3 && e3.message) || e3)); }
  }

  // ---------- 设置菜单（工具栏右侧的「⚙ 设置」）----------
  // 以前要改 tableMode/detailSheet/文件名 只能去改代码或记住快捷键，这个菜单就是给它们一个入口。
  // 改动立刻生效并落到 GM_setValue / localStorage，刷新后还在。
  var TITLE_PRESETS = ['工作簿1', '销售数据', '会议纪要', '考勤表', '季度报表'];
  var menuEl = null;

  // 快捷键卡片的唯一来源。
  // 原来是手写的一串 HTML：v0.56 加了「时间 ▾」、v0.57 给作者面板加了搜索框，
  // 卡片里一个字都没跟上，而这是用户唯一能看到快捷键的地方，说的还是上个版本的事。
  // 现在卡片从这张表渲染出来，自测 H1 逐条真的按一遍（写了按不出来的，红）。
  // H2 还盯着下面这几条："新功能必须有名字"
  // v1.2：用户点名删掉的那几条提示（导出 / 查找 / 点行号 / Tab / 头像表情快捷键）
  // 连同对应键位一起撤了，卡片只留还在用的。
  var SHORTCUTS = [
    ['Ctrl+Shift+X', '收起浮层 · 回顶部'],
    ['Alt+Shift+R', '表格模式开关'],
    ['Alt+Shift+T', '本页临时关掉'],
    ['笔记页 Alt+↑/↓', '上一篇 / 下一篇'],
    ['看图 ←/→', '翻同一篇的下一张']
  ];
  function shortsHtml() {
    var out = [];
    for (var i = 0; i < SHORTCUTS.length; i++) {
      out.push('<b>' + esc(SHORTCUTS[i][0]) + '</b> ' + esc(SHORTCUTS[i][1]));
    }
    return out.join('<br>');
  }

  function menuHtml() {
    function item(key, on, text, value) {
      return '<div class="fz-mi" data-fz-set="' + key + '">' +
        '<span class="fz-mk">' + (on ? '✓' : '') + '</span>' +
        '<span class="fz-mt">' + esc(text) + '</span>' +
        '<span class="fz-mv">' + esc(value) + '</span>' +
      '</div>';
    }
    // 表格模式 / 详情页接管 都搬进设置面板了，菜单只留"日常会点"的几项
    return item('docTitle', false, '换个文件名', CFG.docTitle) +
      item('export', false, '导出 CSV', '') +
      item('settings', false, '设置…', (function () {
        // 数字从 SET_DEFS 里数出来（写死会像以前那样停在「8 个开关」不动），
        // 再加上「高级设置」里那两个（总开关 / 登录伪装）—— 面板里能勾的一共就这么多
        var n = 0;
        for (var i = 0; i < SET_DEFS.length; i++) n += SET_DEFS[i][1].length;
        n += 2;
        return n + ' 个开关';
      })()) +
      '<div class="fz-msep"></div>' +
      // 快捷键只写在 README 里等于没有（最常用的"收起浮层"没人知道）；
      // 但写在两处就会走样，所以内容来自 SHORTCUTS，这里只负责摆位置
      '<div class="fz-mhint">' + shortsHtml() + '</div>';
  }

  function closeMenu() {
    if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
    menuEl = null;
  }

  function refreshMenu() {
    if (menuEl) menuEl.innerHTML = menuHtml();
  }

  // 面板贴在触发它的控件下方，别跑出视口（设置菜单、筛选面板共用）
  // 表头容错：有些浏览器扩展 / 输入法 / AI 侧栏会往页面上压一层透明遮罩，
  // 点击被它接走，e.target 不是我们的表头，可坐标底下就是。这里用坐标反查一次。
  // 只在"点到的不是表头自己"时才走这条路，正常点击不受影响。
  // 表头兜底刚处理过的一次点击：随后的 click 会走"点别处关面板"那条路，
  // 必须放它一次，否则面板刚开就被自己人关掉（实测就是这个原因）
  var hdrGraceUntil = 0;

  function eatNextClick() {
    var h = function (ev) {
      try { ev.stopPropagation(); ev.preventDefault(); } catch (e) {}
      removeEventListener('click', h, true);
    };
    addEventListener('click', h, true);
    setTimeout(function () { try { removeEventListener('click', h, true); } catch (e) {} }, 700);
  }

  function headerHitAt(x, y) {
    // 快速短路：表头只是一条 24px 的横带，y 不在里面就别做命中测试（每次点击都会走到这里）
    var th = document.querySelector('.fz-thead');
    if (!th) return null;
    var tr = th.getBoundingClientRect();
    if (!tr.height || y < tr.top - 2 || y > tr.bottom + 2) return null;
    var list = null;
    try { list = document.elementsFromPoint(x, y); } catch (e) { return null; }
    for (var i = 0; i < list.length && i < 10; i++) {
      var el = list[i];
      if (!el || !el.closest) continue;
      if (el.closest('.fz-notesheet,.fz-menu,.fz-viewer')) return null;   // 弹层里的不算
      var h = el.closest('[data-fz-filter],[data-fz-sort]');
      if (h && h.closest && h.closest('.fz-thead')) return h;
    }
    return null;
  }

  function placePanel(m, anchor) {
    var r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
    var w = m.offsetWidth, h = m.offsetHeight;
    var left = r ? r.right - w : 8;
    var top = r ? r.bottom + 2 : 8;
    m.style.left = Math.round(Math.max(4, Math.min(left, innerWidth - w - 4))) + 'px';
    m.style.top = Math.round(Math.max(4, Math.min(top, innerHeight - h - 4))) + 'px';
  }

  // 工具栏「筛选 ▾」：先列出当前这张表能筛的列（读的就是表头自己挂的 data-fz-filter），
  // 选一个再开对应的条件面板，表头被别的浮层挡住时，这条永远能用。
  function filterMenuHtml() {
    var th = document.querySelector('.fz-thead');
    var cells = th ? [].slice.call(th.querySelectorAll('[data-fz-filter]')) : [];
    if (!cells.length) {
      return '<div class="fz-mi"><span class="fz-mt">这张表没有可筛选的列</span></div>';
    }
    return cells.map(function (c) {
      var k = c.getAttribute('data-fz-filter');
      return '<div class="fz-mi" data-fz-fkey="' + esc(k) + '">' +
        '<span class="fz-mk"></span><span class="fz-mt">' + esc((c.textContent || '').trim()) + '</span></div>';
    }).join('');
  }

  function openFilterPicker(anchor) {
    if (menuEl && menuEl.isConnected) { closeMenu(); return false; }
    closeFilter(); closeSort();
    var m = document.createElement('div');
    m.className = 'fz-menu fz-pickmenu';
    m.setAttribute('data-fz-menu-panel', '1');
    m.innerHTML = filterMenuHtml();
    document.body.appendChild(m);
    bindPanelClicks(m);
    placePanel(m, anchor);
    markKeyboard(m);
    menuEl = m;
    return m;
  }

  function openMenu(anchor) {
    closeMenu();
    closeFilter();                 // 两个面板互斥，别叠在一起
    closeSort();
    var m = document.createElement('div');
    m.className = 'fz-menu';
    m.setAttribute('data-fz-menu-panel', '1');
    m.innerHTML = menuHtml();
    document.body.appendChild(m);
    placePanel(m, anchor);
    markKeyboard(m);
    menuEl = m;
    return m;
  }

  function toggleMenu(anchor) {
    if (menuEl && menuEl.isConnected) { closeMenu(); return false; }
    openMenu(anchor);
    return true;
  }

  // 表格模式：关掉时连伪装层一起收掉，把源列表还给站点，否则原生页面是空的
  function applyTableMode(on) {
    if (on === undefined) on = !CFG.tableMode;
    CFG.tableMode = !!on;
    store.set('tableMode', CFG.tableMode);
    document.documentElement.classList.toggle('fz-off', !CFG.tableMode);
    if (!CFG.tableMode) {
      try { unmarkSource(); } catch (e) {}
      try { unhideSite(); } catch (eU) {}      // 之前被藏起来的站点元素全都还回去
      Array.prototype.forEach.call(document.querySelectorAll('.fz-rows'), function (el) {
        el.classList.remove('fz-rows');
      });
      var f = document.querySelector('.fz-filler');
      if (f) f.remove();
      var mk = document.querySelector('.fz-pullmask');
      if (mk && mk.parentNode) mk.parentNode.removeChild(mk);
      dropFavicon();
      applyTitle();
    } else {
      document.documentElement.classList.add('fz-table');
      lastAnchorCount = -1;              // 让 reflowFeed 重新扫一遍，别被缓存挡回去
      try { markSource(); } catch (e2) {}
      try { applyFavicon(); } catch (e4) {}
      try { schedule(true); } catch (e3) {}
    }
    refreshMenu();
    return CFG.tableMode;
  }

  function applyDetailSheet(on) {
    if (on === undefined) on = !CFG.detailSheet;
    CFG.detailSheet = !!on;
    store.set('detailSheet', CFG.detailSheet);
    if (!CFG.detailSheet) {
      // 只把表收掉，不记 closedPid：那是"用户自己关过这篇"的意思，
      // 记了的话在设置里重新打开也回不来（同一个笔记页会一直不弹）
      try { removeSheet(); } catch (e2) {}
    } else {
      closedPid = '';                 // 重新打开：连"这篇关过"的记忆一起清掉
      try { schedule(true); } catch (e3) {}
      setTimeout(function () { try { maybeNoteSheet(); } catch (e4) {} }, 60);
    }
    refreshMenu();
    return CFG.detailSheet;
  }

  function setDocTitle(t) {
    if (t === undefined) {              // 不给参数就轮到下一个预设
      var i = TITLE_PRESETS.indexOf(CFG.docTitle);
      t = TITLE_PRESETS[(i + 1) % TITLE_PRESETS.length];
    }
    t = String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
    CFG.docTitle = (t || TITLE_PRESETS[0]).slice(0, 28);
    store.set('docTitle', CFG.docTitle);
    var f = document.querySelector('.fz-file');
    if (f) f.textContent = CFG.docTitle;
    try { applyTitle(); } catch (e) {}
    refreshMenu();
    return CFG.docTitle;
  }

  // 真正的设置入口：菜单、快捷键、控制台（__fzProbe.setCfg）都走这里
  // ---------- 设置面板（v0.89）----------
  // 参考用户给的那张 NGA 设置图：居中一张暖白卡片，左边「显示优化」、右边「功能增强」，
  // 一行一个开关，底下一排按钮 + 右下角「保存设置」。开关默认全是开的。
  // 为什么要它：以前这些功能写死在代码里，想关一个得去改脚本；菜单里也只有 4 个入口。
  var setEl = null;

  var SET_DEFS = [
    ['显示优化', [
      ['foldText', '折叠过长正文（超过 300 字）'],
      ['imgLink', '图片变成文字链接（点开看原图）'],
      ['linkPlainTitle', '标题不标蓝（当普通文字，照样能点）'],
      ['linkPlainImg', '封面图 / 图2 / 视频不标蓝'],
      ['tips', '单元格悬停显示全文'],
      ['hideAvatar', '隐藏用户头像（关掉就画回来：楼主 / 楼层 / 回复）'],
      ['hideEmoji', '隐藏表情符号（😀🍩 这类，会改文字）']
    ]],
    ['功能增强', [
      ['detailSheet', '详情页接管（点笔记在表格里看）'],
      ['busy', '加载时的进度卡片'],
      ['hush', '视频默认静音'],
      ['opMark', '详情页标出楼主（作者列加「楼主」）'],
      ['floorTint', '详情页有回复的楼层用浅绿底'],
      ['showFloor', '详情页显示「N楼」'],
      ['userTable', '点用户名用表格看（关掉 = 开原生用户页）']
    ]]
  ];

  // 复选框自己画：站点的 reset 会把原生 checkbox 的外观整个抹掉（实测整排看不见勾），
  // 所以 input 只留语义和 .checked，样子交给后面的 <i>
  function setRow(key, text) {
    return '<label class="fz-set-row"><input type="checkbox" data-fz-cfg="' + key + '"' +
      (CFG[key] ? ' checked' : '') + '><i class="fz-set-cb"></i>' +
      '<span class="fz-set-tx">' + esc(text) + '</span></label>';
  }

  function settingsHtml() {
    var cols = SET_DEFS.map(function (g) {
      return '<div class="fz-set-col"><h4>' + esc(g[0]) + '</h4>' +
        g[1].map(function (r) { return setRow(r[0], r[1]); }).join('') + '</div>';
    }).join('');
    return '<div class="fz-set-mask" data-fz-set-mask="1"></div>' +
      '<div class="fz-set" role="dialog" aria-modal="true" aria-label="设置">' +
        '<div class="fz-set-hd"><div class="fz-set-tt">小红书 · 表格模式 <i>v' + FZ_VER + '</i></div>' +
          '<button class="fz-set-x" data-fz-set-close="1" aria-label="关闭">✕</button></div>' +
        '<div class="fz-set-bd">' + cols + '</div>' +
        '<div class="fz-set-adv">' +
          '<button class="fz-set-advb" data-fz-set-adv="1"><i>+</i><span>高级设置</span></button>' +
          '<div class="fz-set-advbox">' +
            setRow('tableMode', '首页表格模式（总开关）') +
            setRow('login', '标题栏显示「已登录」伪装') +
            '<label class="fz-set-row fz-set-inline"><span class="fz-set-tx">文件名</span>' +
              '<input class="fz-set-inp" data-fz-cfg="docTitle" value="' + esc(CFG.docTitle) + '"></label>' +
          '</div>' +
        '</div>' +
        '<div class="fz-set-ft">' +
          '<button data-fz-set-def="1">恢复默认</button>' +
          '<button data-fz-set-out="1">导出设置</button>' +
          '<button data-fz-set-csv="1">导出 CSV</button>' +
          '<span class="fz-set-sp"></span>' +
          '<button class="fz-set-save" data-fz-set-save="1">保存设置</button>' +
        '</div>' +
      '</div>';
  }

  function openSettings() {
    closeMenu();
    if (!document.body) return null;
    if (setEl && setEl.isConnected) { closeSettings(); return null; }
    setEl = document.createElement('div');
    setEl.className = 'fz-setwrap';
    setEl.innerHTML = settingsHtml();
    setEl.addEventListener('click', onSettingsClick);
    try { document.body.appendChild(setEl); } catch (e) { setEl = null; return null; }
    var first = setEl.querySelector('.fz-set-row input');
    if (first) setTimeout(function () { try { first.focus(); } catch (e2) {} }, 40);
    return setEl;
  }

  function closeSettings() {
    if (setEl && setEl.parentNode) setEl.parentNode.removeChild(setEl);
    setEl = null;
  }

  function onSettingsClick(e) {
    var t = e.target;
    if (!t || !t.closest || !setEl) return;
    if (t.closest('[data-fz-set-mask],[data-fz-set-close]')) { closeSettings(); return; }
    if (t.closest('[data-fz-set-adv]')) {
      var box = setEl.querySelector('.fz-set-advbox');
      var wasOn = box.classList.contains('on');
      box.classList.toggle('on', !wasOn);
      var b = t.closest('[data-fz-set-adv]');
      b.classList.toggle('on', !wasOn);
      var i = b.querySelector('i');
      if (i) i.textContent = wasOn ? '+' : '−';
      return;
    }
    if (t.closest('[data-fz-set-save]')) { saveSettings(); return; }
    if (t.closest('[data-fz-set-def]')) { resetSettingsForm(); return; }
    if (t.closest('[data-fz-set-out]')) { exportSettings(); return; }
    if (t.closest('[data-fz-set-csv]')) { closeSettings(); try { exportCsv(); } catch (e3) {} return; }
  }

  function readSetForm() {
    var out = {};
    if (!setEl) return out;
    Array.prototype.forEach.call(setEl.querySelectorAll('[data-fz-cfg]'), function (inp) {
      var k = inp.getAttribute('data-fz-cfg');
      out[k] = inp.type === 'checkbox' ? !!inp.checked : String(inp.value || '');
    });
    return out;
  }

  // 头像：CSS 里默认就是"藏"（html 上没有 fz-showavatar 就藏），这里只负责加/去那个例外类
  function applyHideAvatar() {
    try { document.documentElement.classList.toggle('fz-showavatar', !CFG.hideAvatar); } catch (e) {}
  }

  // 这几个开关改的是"整张表怎么看"，用 html 上的类控制，改完不用重画单元格。
  // 详情页的三个（楼主、楼层底色、楼层徽标）也在这里一起同步。
  function applyView() {
    var de = document.documentElement;
    try {
      de.classList.toggle('fz-showavatar', !CFG.hideAvatar);
      de.classList.toggle('fz-plaintitle', !!CFG.linkPlainTitle);
      de.classList.toggle('fz-plainimg', !!CFG.linkPlainImg);
      de.classList.toggle('fz-notint', !CFG.floorTint);
      de.classList.toggle('fz-nofloor', !CFG.showFloor);
      de.classList.toggle('fz-opmark', !!CFG.opMark);
      // 详情表开着的时候页面自己不滚（否则会同时出现两条滚动条）
      de.classList.toggle('fz-hassheet', !!document.querySelector('.fz-notesheet'));
    } catch (e) {}
  }
  function applyOpMark() { applyView(); }

  // 列表行是"建好就不再重建"的（reflowFeed 会跳过已经有 .fz-cells 的卡片），
  // 所以改到单元格内容的开关必须自己把每一行的 .fz-cells 换掉。
  // 注意：只换 .fz-cells 这个子节点，卡片上的 click 不动，再走一遍 buildRow 会把
  // openNote 又绑一次，点一下开两个标签页。
  function rebuildCells() {
    var rows = document.querySelectorAll('.fz-row');
    for (var i = 0; i < rows.length; i++) {
      var card = rows[i];
      var old = card.querySelector(':scope > .fz-cells');
      if (!old) continue;
      // 只认建行时存下来的那份数据：现场 readCard() 时卡片已经被藏了，图会量成 0 张
      var d = card.__fzData;
      if (!d) continue;
      var fresh = document.createElement('div');
      fresh.className = 'fz-cells';
      fresh.innerHTML = cellsHtml(d, i + 1);
      card.replaceChild(fresh, old);
      try { markKeyboard(fresh); bindLinks(fresh, d); cellTips(fresh); bindRowOpen(fresh, card, d); } catch (e2) {}
    }
  }

  // 改了"影响单元格内容"的开关：表格要重画一次（折叠/图片/悬停都是拼 HTML 时决定的）
  function rerenderAfterCfg() {
    try { rebuildCells(); } catch (e0) {}
    try { lastAnchorCount = -1; schedule(true); } catch (e) {}
    if (noteSheet) {
      try {
        removeSheet();
        closedPid = '';
        setTimeout(function () { try { maybeNoteSheet(); } catch (e2) {} }, 80);
      } catch (e3) {}
    }
  }

  function saveSettings() {
    if (!setEl) return false;
    var v = readSetForm();
    var reRender = false;
    // 改了"影响单元格内容"的开关：表格要重画一次
    ['foldText', 'imgLink', 'tips', 'hideEmoji', 'linkPlainTitle', 'linkPlainImg',
      'hideAvatar', 'opMark', 'floorTint', 'showFloor', 'userTable'].forEach(function (k) {
      if ((k in v) && !!v[k] !== !!CFG[k]) reRender = true;
    });
    // 三个特殊的走各自的入口：要顺手改标题 / 拆伪装层 / 重开详情表
    if (('tableMode' in v) && !!v.tableMode !== !!CFG.tableMode) applyTableMode(v.tableMode);
    if (('detailSheet' in v) && !!v.detailSheet !== !!CFG.detailSheet) applyDetailSheet(v.detailSheet);
    if (('docTitle' in v) && v.docTitle && v.docTitle !== CFG.docTitle) setDocTitle(v.docTitle);
    ['foldText', 'imgLink', 'tips', 'busy', 'hush', 'login', 'hideAvatar', 'hideEmoji',
      'linkPlainTitle', 'linkPlainImg', 'opMark', 'floorTint', 'showFloor', 'userTable']
      .forEach(function (k) {
        if (!(k in v)) return;
        CFG[k] = v[k];
        store.set(k, v[k]);
      });
    applyHideAvatar();
    applyOpMark();
    closeSettings();
    if (reRender) rerenderAfterCfg();
    toast('设置已保存');
    return true;
  }

  // 恢复默认：只改面板上的勾（点保存才真的写进去），免得"点一下全变了"
  function resetSettingsForm() {
    if (!setEl) return;
    var D = { foldText: true, imgLink: true, tips: true, detailSheet: true, busy: true, hush: true,
      hideAvatar: true, hideEmoji: false, linkPlainTitle: false, linkPlainImg: false,
      opMark: true, floorTint: true,
      showFloor: true, userTable: false, tableMode: true, login: true };
    Array.prototype.forEach.call(setEl.querySelectorAll('[data-fz-cfg]'), function (inp) {
      var k = inp.getAttribute('data-fz-cfg');
      if (k === 'docTitle') { inp.value = '工作簿1'; return; }
      if (k in D) inp.checked = !!D[k];
    });
    toast('已恢复默认，点「保存设置」生效');
  }

  function exportSettings() {
    var v = readSetForm();
    var txt = JSON.stringify(v, null, 2);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt);
        toast('设置已复制到剪贴板');
        return;
      }
    } catch (e) {}
    try { window.prompt('复制这段设置：', txt); } catch (e2) {}
  }

  function setCfg(key, val) {
    if (key === 'settings') { closeMenu(); openSettings(); return true; }
    if (key === 'tableMode') return applyTableMode(val);
    if (key === 'detailSheet') return applyDetailSheet(val);
    if (key === 'docTitle') return setDocTitle(val);
    if (key === 'export') { exportCsv(); return true; }
    return CFG[key];
  }

  // 小红书的登出接口需要签名，脚本无法直接调用；改为打开不带脚本的原生页面
  // ===== 登录 / 登出：直接借用小红书自己的界面 =====
  var yieldMode = false;

  function isLoggedIn() {
    // 有 .login-btn 就是没登录（登录后这个按钮会消失）
    return !document.querySelector('.login-btn');
  }

  // 把"藏起来"的站点元素原样还回去（让位给原生界面时，以及关闭表格模式时都要用）
  function unhideSite() {
    var hidden = document.querySelectorAll('[data-fz-hide="1"]');
    for (var i = 0; i < hidden.length; i++) {
      try { hidden[i].style.removeProperty('display'); } catch (e) {}
      hidden[i].dataset.fzHide = '0';
    }
    try { document.body.style.removeProperty('padding-top'); } catch (e2) {}
  }

  // 让位那一刻停在哪篇笔记 / 详情表在不在：回来时要照着还回去
  var yieldPid = '', yieldHadSheet = false;

  function yieldToSite(keepChrome) {
    yieldMode = true;
    if (!keepChrome) {
      try { yieldPid = (location.pathname.match(NOTE_PATH) || [])[1] || ''; } catch (eYP) { yieldPid = ''; }
      yieldHadSheet = !!noteSheet;
    }
    document.documentElement.classList.add('fz-yield');
    try { document.documentElement.classList.toggle('fz-keepchrome', !!keepChrome); } catch (eKC) {}
    // 给用户一条明确的回头路（拉取用的让位不算：那会儿屏幕还是我们的表格）
    if (!keepChrome) showBackBtn();
    unhideSite();
    try { unhushVideos(document); } catch (eU2) {}   // 原生界面回来了，声音也还给它
    // 源列表要还回原位，站点的观察器才认（不然原生页面里列表是空的）
    try { unmarkSource(); } catch (e2) {}
  }

  function resumeFromSite() {
    yieldMode = false;
    hideBackBtn();
    document.documentElement.classList.remove('fz-yield');
    try { document.documentElement.classList.remove('fz-keepchrome'); } catch (eKC2) {}
    clearHighlight();
    if (DEMO) { window.__fzResumed = true; return; }   // 测试页别 reload，否则结果全丢
    // 不 reload：sync 会把站点元素重新藏起来、表格立刻回来（比刷新快，也不丢滚动位置）
    try { sync(); } catch (e) {}
  }

  // 让位时给目标按钮套个红框，让人一眼看到点哪
  function highlightEl(el) {
    clearHighlight();
    if (!el) return;
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    var box = document.createElement('div');
    box.id = 'fz-hl';
    box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;' +
      'left:' + (r.left - 8) + 'px;top:' + (r.top - 8) + 'px;' +
      'width:' + (r.width + 16) + 'px;height:' + (r.height + 16) + 'px;' +
      'border:3px solid #ff2442;border-radius:8px;' +
      'box-shadow:0 0 0 9999px rgba(0,0,0,.45);animation:fzblink .65s ease-in-out 6;';
    document.body.appendChild(box);
    try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
  }

  function clearHighlight() {
    var b = document.getElementById('fz-hl');
    if (b && b.parentNode) b.parentNode.removeChild(b);
    var d = document.getElementById('fz-dim');
    if (d && d.parentNode) d.parentNode.removeChild(d);
  }

  // 整屏压暗（和点赞/收藏那层黑是一样的 45% 黑）：
  // 回复框那种"框一大片"的目标用 highlightEl 的 9999px 外阴影不合适，拆成两层更稳：
  //   一层负责压暗整屏，一层只负责红框，找不到目标框时，至少"压暗 + 提示"还在。
  function dimSite() {
    clearHighlight();
    if (!document.body) return null;
    var d = document.createElement('div');
    d.id = 'fz-dim';
    d.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483646;' +
      'background:rgba(0,0,0,.45);pointer-events:none;';
    try { document.body.appendChild(d); } catch (e) { return null; }
    return d;
  }

  // 找到目标框之后：只压暗框外边（框心留一个洞），再套一圈红框。
  // v0.88 用户提的："回复的时候（回复框）内不应该有遮罩"，之前是整屏 45% 黑 + 一个透明红框，
  // 输入框自己被盖在这层黑底下，看着像"不能打字"。改成 9999px 外阴影（和点赞/收藏同一个做法）：
  // 阴影只画在 border box 之外，框心天然是透明的，正好是"聚光灯"。
  function frameEl(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    var old = document.getElementById('fz-hl');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    // 整屏那层黑要撤掉：留着它，洞也没意义（黑在上、洞在下）
    var dim = document.getElementById('fz-dim');
    if (dim && dim.parentNode) dim.parentNode.removeChild(dim);
    var box = document.createElement('div');
    box.id = 'fz-hl';
    box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;' +
      'left:' + (r.left - 8) + 'px;top:' + (r.top - 8) + 'px;' +
      'width:' + (r.width + 16) + 'px;height:' + (r.height + 16) + 'px;' +
      'border:3px solid #ff2442;border-radius:8px;' +
      'box-shadow:0 0 0 9999px rgba(0,0,0,.45);animation:fzblink .65s ease-in-out 6;';
    try { document.body.appendChild(box); } catch (e) { return false; }
    return true;
  }

  // ---------- 让位期间的"回到表格" ----------
  // 点赞 / 收藏 / 回复 / 登录 都要先把伪装层收起来，让用户在原生的界面上操作。
  // 以前这一步是"单向"的：脚本能自己回来就回来（点赞成功），回不来（回复、卡住、超时）
  // 用户就只剩一个原生小红书页面，表格没了、也不知道怎么回去。所以让位期间必须有一个
  // 明确、一直看得见的回头路：屏幕正中那个绿药丸。
  var backEl = null;

  function showBackBtn(tip) {
    if (!document.body) return null;
    if (!backEl || !backEl.isConnected) {
      backEl = document.createElement('div');
      backEl.className = 'fz-back';
      backEl.setAttribute('role', 'button');
      backEl.setAttribute('tabindex', '0');
      backEl.setAttribute('aria-label', '返回表格模式');
      backEl.innerHTML = '<span>返回表格模式</span>';
      backEl.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); });
      backEl.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        backToTable();
      });
      backEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
          e.preventDefault(); e.stopPropagation();
          backToTable();
        }
      });
      try { document.body.appendChild(backEl); } catch (e) { backEl = null; return null; }
    }
    var t = backEl.querySelector('span');
    if (t && tip && t.textContent !== tip) t.textContent = tip;
    return backEl;
  }

  function hideBackBtn() {
    if (backEl && backEl.parentNode) backEl.parentNode.removeChild(backEl);
    backEl = null;
  }

  // 手动回到表格：恢复伪装层，顺便把"刚才那一下"同步进详情表（新回复 / 新赞数）
  function backToTable(quiet) {
    if (!yieldMode) return false;
    resumeFromSite();
    if (!quiet) toast('已回到表格模式');
    var pid0 = '';
    try { pid0 = (location.pathname.match(NOTE_PATH) || [])[1] || ''; } catch (eP) {}

    // 从详情页让位出去的，回来必须还是那篇笔记的详情表。
    // 站点在这期间重渲染、或者它自己把详情节点收掉时，sync() 只会把首页表格建出来，
    // 用户看到的就是"回复完跳回瀑布页了"。所以这里主动把详情表要回来（最多试 4 次）。
    function ensureSheet(tries) {
      if (!yieldHadSheet || !pid0) return;
      if (noteSheet && noteSheet.isConnected) return;
      // 详情表节点被站点连根拔走时，noteSheet 是个脱离文档的幽灵：
      // 不清掉它，maybeNoteSheet 第一行就 `if (noteSheet) return`，永远重建不出来
      if (noteSheet && !noteSheet.isConnected) noteSheet = null;
      if (closedPid === pid0) closedPid = '';      // 是我们让位出去的，不该被"用户手动关过"拦住
      try { maybeNoteSheet(); } catch (e0) {}
      if ((!noteSheet || !noteSheet.isConnected) && tries > 0) {
        setTimeout(function () { ensureSheet(tries - 1); }, 320);
      }
    }
    setTimeout(function () { ensureSheet(3); }, 140);

    setTimeout(function () {
      if (!noteSheet || !pid0) return;
      try {
        var fresh = readComments(pid0, true);
        if (fresh && fresh.length && noteSheet.__fzRenderCmt) noteSheet.__fzRenderCmt(fresh);
      } catch (e) {}
      try { if (noteSheetData) refreshMainMeta(noteSheet, noteSheetData, pid0); } catch (e2) {}
      yieldHadSheet = false;
      yieldPid = '';
    }, 820);
    return true;
  }


  function pollUntil(cond, cb, timeoutMs) {
    var t0 = Date.now();
    var iv = setInterval(function () {
      var ok2 = false;
      try { ok2 = cond(); } catch (e) {}
      if (ok2) { clearInterval(iv); cb(true); return; }
      if (Date.now() - t0 > (timeoutMs || 180000)) { clearInterval(iv); cb(false); }
    }, 800);
  }

  function doLogin() {
    if (isLoggedIn()) { toast('已经是登录状态了'); return; }
    yieldToSite();                       // 先露原生界面，登录框才看得见
    toast('已切到小红书原生界面，请在弹出的登录框里登录');
    setTimeout(function () {
      var b = document.querySelector('.login-btn');
      if (b) { try { b.click(); } catch (e) {} }
    }, 200);
    pollUntil(isLoggedIn, function (ok2) {
      if (ok2) {
        toast('登录成功，正在恢复表格…');
        setTimeout(resumeFromSite, 1000);
      } else {
        toast('登录超时，已恢复表格');
        setTimeout(resumeFromSite, 800);
      }
    });
  }

  // 直接调小红书的登出接口（能成就真退出，不用手工点）
  function apiLogout(cb) {
    if (DEMO) { cb(false); return; }
    var done = false;
    function fin(ok) { if (!done) { done = true; cb(ok); } }
    try {
      fetch('/api/sns/web/v1/logout', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json;charset=UTF-8' },
        body: '{}'
      }).then(function (r) { return r.json(); })
        .then(function (j) { fin(!!(j && (j.code === 0 || j.success === true || j.result === 'success'))); })
        .catch(function () { fin(false); });
    } catch (e) { fin(false); }
    setTimeout(function () { fin(false); }, 2500);
  }

  function doLogout() {
    if (!isLoggedIn()) { toast('当前没有登录'); return; }
    toast('正在退出登录…');
    apiLogout(function (ok) {
      if (ok) {
        toast('已退出登录');
        try { sessionStorage.removeItem('fz-note'); } catch (e) {}
        setTimeout(resumeFromSite, 700);
        return;
      }
      // 接口不行就露原生界面，让用户点一下真的"退出登录"
      yieldToSite();
      toast('已切到原生界面：点右上角头像 → 退出登录');
      pollUntil(function () { return !isLoggedIn(); }, function (done2) {
        if (done2) {
          toast('已退出登录，正在恢复表格…');
          setTimeout(resumeFromSite, 1000);
        } else {
          toast('已恢复表格');
          setTimeout(resumeFromSite, 800);
        }
      });
    });
  }

  // 详情页一级评论分页：滚站点评论容器到底，触发它自己加载下一页
  // ---------- 详情页：驱动站点自己翻评论 ----------
  // 和瀑布流同一个规律：评论要"滚到底才加载"，而且一步跳到底它不认，必须一点点滚。
  // 原生详情被我们的表格盖住，滚它对画面没有任何影响。
  var cmtBusy = false, cmtFail = 0, cmtNextAt = 0;

  function cmtRoot() {
    return document.querySelector('#noteContainer') || document.querySelector('.note-detail-mask') ||
           document.querySelector('[class*="note-detail"]');
  }

  // 详情这棵子树的根（.note-detail-mask 罩着 #noteContainer）。滚动范围一律不许出这个圈。
  function cmtScope() {
    var m = document.querySelector('.note-detail-mask');
    if (m) return m;
    var r = cmtRoot();
    if (r) {
      // 没有 mask 的老版式：往上找最近的那个"note-detail*"外壳，别再往外退到 body
      try { return r.closest('[class*="note-detail"]') || r; } catch (e) { return r; }
    }
    return null;
  }

  // 页面级的滚动者：html / body。绝对不能算进评论的滚动容器。
  // 详情页下面压着的就是瀑布页（.feeds-page 一直在 DOM 里），把 html 滚一下，
  // 站点就当成"首页到底了"，去发 homefeed，拉回来的是更多笔记，一条评论都不会多
  // （2026-10-31 实测：点一次「加载更多评论」，homefeed ×4，评论 17→17、feed 45→194）。
  function cmtPageLevel(el) {
    return !el || el === document.documentElement || el === document.body ||
           el === document.scrollingElement || el === window;
  }

  // 是不是"详情这棵子树里的"元素
  function cmtInScope(el) {
    if (!el || cmtPageLevel(el)) return false;
    var sc = cmtScope();
    if (!sc) return true;
    try { return sc === el || sc.contains(el); } catch (e) { return false; }
  }

  // 评论区自己的滚动容器：从 .comments-el 往上找最内层那个能滚的祖先
  // （实测结构：.comments-el > .note-scroller(内部滚动) > .interaction-container >
  //   #noteContainer > .note-detail-mask，真正滚的是 .note-scroller）
  function cmtScrollers() {
    var out = [], el = document.querySelector('.comments-el') ||
                        document.querySelector('[class*="comment-item"]') || cmtRoot();
    if (!el) return out;
    for (var i = 0; i < 14 && el; i++, el = el.parentElement) {
      if (cmtPageLevel(el) || !cmtInScope(el)) break;      // 到页面级/出圈就收手
      try {
        var d = el.scrollHeight - el.clientHeight;
        if (d > 60 && el.clientHeight > 120) out.push(el);
      } catch (e0) {}
    }
    // 兜底：评论区还没渲染出来时祖先链是断的，只认 .note-scroller（仍然不许出圈）
    var ns = document.querySelector('.note-scroller');
    if (ns && cmtInScope(ns) && out.indexOf(ns) < 0 &&
        ns.scrollHeight - ns.clientHeight > 60 && ns.clientHeight > 120) out.push(ns);
    return out.slice(0, 3);
  }

  // 评论区自己的"到底加载"哨兵：.comments-el 里的 .loading（可见时站点会拉下一页）
  function cmtSentinel() {
    var box = document.querySelector('.comments-el') || cmtRoot();
    if (!box) return null;
    return box.querySelector('.loading') || box.querySelector('[class*="loading"]') || box.lastElementChild;
  }

  // 站点评论分页状态：hasMore / 已载入条数
  function cmtState(pid) {
    try {
      var st = readInitialState();
      var dm = st && st.note && (st.note.noteDetailMap || st.note.note_detail_map);
      var e = dm && (dm[pid] || dm[String(pid)]);
      var cs = e && (e.comments || e.comment);
      if (!cs) return null;
      return { hasMore: cs.hasMore !== false, loading: !!cs.loading, n: (cs.list || []).length };
    } catch (e2) { return null; }
  }

  var cmtDiag = '', cmtLastReqD = -1;

  // 原生详情在 .main-container 里，会被我们自己的隐藏规则连带 display:none，
  // 尺寸变 0 后就滚不动了（诊断里表现为"容器0"）。驱动前临时把它恢复出来，
  // 但设成 visibility:hidden，保留布局与尺寸，屏幕上看不见（表格是整屏浮层）。
  function cmtShowNative() {
    var root = cmtRoot();
    if (!root) return null;
    var restore = [], el = root;
    // 祖先可能是被内联 display:none 藏的，也可能是被 CSS 规则藏的，两种都恢复
    while (el && el !== document.body) {
      var hidden = false, inline = '';
      try { hidden = (getComputedStyle(el).display === 'none'); } catch (e0) {}
      try { inline = el.style.display || ''; } catch (e1) {}
      if (hidden || (el.dataset && el.dataset.fzHide === '1')) {
        restore.push({ el: el, inline: inline });
        try { el.style.setProperty('display', 'block', 'important'); } catch (e2) {}
      }
      el = el.parentElement;
    }
    var prev = '';
    try { prev = root.style.cssText || ''; } catch (e3) {}
    // 只有它确实量不到尺寸（被藏 / 尺寸为 0）才套离屏盒子；
    // 新标签页直开的详情本来就是可见的，套上去反而会打乱它自己的滚动布局。
    var needBox = true;
    try {
      var rr = root.getBoundingClientRect();
      needBox = !(rr.width > 50 && rr.height > 50);
    } catch (e3b) {}
    if (!needBox) return { list: restore, root: root, css: null };
    // 给原生详情一个"离屏但真实"的盒子：内部滚动容器才有尺寸，评论才能被驱动
    try {
      root.style.setProperty('position', 'fixed', 'important');
      root.style.setProperty('left', '-20000px', 'important');
      root.style.setProperty('top', '0', 'important');
      root.style.setProperty('width', '1200px', 'important');
      root.style.setProperty('height', '900px', 'important');
      root.style.setProperty('visibility', 'hidden', 'important');
      root.style.setProperty('z-index', '0', 'important');
      root.style.setProperty('pointer-events', 'none', 'important');
    } catch (e4) {}
    return { list: restore, root: root, css: prev };
  }

  function cmtHideNative(tok) {
    if (!tok) return;
    if (tok.css !== null) { try { tok.root.style.cssText = tok.css || ''; } catch (e) {} }
    for (var i = 0; i < tok.list.length; i++) {
      var it = tok.list[i];
      try {
        if (it.inline) it.el.style.setProperty('display', it.inline);
        else it.el.style.removeProperty('display');
      } catch (e2) {
        try { it.el.style.removeProperty('display'); } catch (e3) {}
      }
      if (it.el.dataset && it.el.dataset.fzHide === '1') {
        try { it.el.style.setProperty('display', 'none', 'important'); } catch (e4) {}
      }
    }
  }

  // 评论仓：站点每轮会从第一页重新给，直接覆盖会把已加载的冲掉，所以按 cid 去重合并、只增不减
  var cmtStore = {};

  function mergeCmts(pid, list) {
    var key = pid || '_';
    var store = cmtStore[key] || (cmtStore[key] = []);
    var seen = {}, i;
    for (i = 0; i < store.length; i++) {
      var c0 = store[i];
      seen[c0.cid || (c0.author + '|' + (c0.desc || '').slice(0, 24) + '|' + c0.depth)] = 1;
    }
    var added = 0;
    for (i = 0; i < (list || []).length; i++) {
      var c = list[i];
      if (!c) continue;
      var k = c.cid || (c.author + '|' + (c.desc || '').slice(0, 24) + '|' + c.depth);
      if (seen[k]) continue;
      seen[k] = 1;
      store.push(c);
      added++;
    }
    return added;
  }

  // 站点未登录时会把评论锁住：底部显示"登录查看全部评论内容"
  // 必须看"画得出来的"那一条：登录态下 DOM 里也常留着隐藏的登录引导文案，
  // 只读 textContent 会把登录用户误判成"被锁"，于是点了加载更多什么都不做。
  function cmtLoginWall() {
    var box = document.querySelector('.comments-el') || cmtRoot();
    if (!box) return false;
    var all = box.querySelectorAll('div,span,p,a,button');
    for (var i = 0; i < all.length && i < 500; i++) {
      var el = all[i];
      var t = (el.textContent || '').replace(/\s+/g, '');
      if (t.length > 24) continue;
      if (!/登录查看全部评论|登录后查看|登录查看更多/.test(t)) continue;
      try {
        if (el.getClientRects().length === 0) continue;                 // 藏着的
        var cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05) continue;
        var r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 6) continue;                      // 量不到 = 没画出来
      } catch (e) {}
      return true;
    }
    // 老结构：提示直接是一段裸文本，没有自己的元素，退回整体读，但要求盒子本身画得出来
    try {
      if (box.getClientRects().length === 0) return false;
      var bt = (box.textContent || '').replace(/\s+/g, '');
      return /登录查看全部评论|登录后查看|登录查看更多/.test(bt) && !box.querySelector('[class*="comment-item"]');
    } catch (e2) { return false; }
  }

  // 拉评论这几秒，把首页那几层按下不表。
  // 理由：站点的 homefeed 是由 `feeds-loading` 这个哨兵"进入视口"驱动的，而详情页底下就压着首页。
  // 只要评论容器需要恢复祖先才能量到尺寸（老版式/SPA 弹层），首页就会被连带放出来、哨兵立刻进视口，
  // 于是"加载更多评论"变成"加载更多笔记"。把首页本身 display:none 掉，这条线就断了。
  function cmtFreezeFeed() {
    var tok = [], boxes = document.querySelectorAll('.feeds-page,.feeds-container,.fz-src');
    for (var i = 0; i < boxes.length && i < 4; i++) {
      try {
        var el = boxes[i];
        tok.push({ el: el, css: el.style.cssText || '' });
        el.style.setProperty('display', 'none', 'important');
      } catch (e) {}
    }
    return tok;
  }

  function cmtThawFeed(tok) {
    for (var i = 0; tok && i < tok.length; i++) {
      try { tok[i].el.style.cssText = tok[i].css || ''; } catch (e) {}
    }
  }

  function cmtMoreButtons() {
    var root = cmtScope() || document;
    var all = root.querySelectorAll('div,span,a,button');
    var out = [];
    for (var i = 0; i < all.length && out.length < 3; i++) {
      var e = all[i];
      if (e.children && e.children.length > 1) continue;
      if (!cmtInScope(e)) continue;
      if (e.closest && e.closest('.fz-notesheet,.fz-chrome,.fz-board')) continue;
      var t = (e.textContent || '').trim();
      if (!t || t.length > 14) continue;
      if (!/^(加载更多|加载更多评论|查看更多评论|查看全部评论|点击加载更多|点击查看更多|展开更多|展开更多评论|展开更多回复|更多评论|查看剩余评论)$/.test(t)) continue;
      out.push(e);
    }
    return out;
  }

  function pullMoreComments(cb) {
    if (cmtBusy) { if (cb) cb(0); return false; }
    var pid = (location.pathname.match(NOTE_PATH) || [])[1] || '';
    if (!pid) { if (cb) cb(0); return false; }
    var sheet = document.querySelector('.fz-notesheet');
    var sheetTop = sheet ? sheet.scrollTop : 0;
    // 页面本身（底下那层瀑布页）的滚动位置：全程要保住，一点都不能动
    var pageTop = 0;
    try { pageTop = window.scrollY || document.documentElement.scrollTop || 0; } catch (ePT) {}
    var req0 = cmtReqN;

    // 未登录时站点把评论锁了（"登录查看全部评论内容"）：滚也只会滚瀑布页，
    // 直接说清楚，别白滚 10 秒
    if (cmtLoginWall()) {
      cmtDiag = '评论区被锁（未登录）·未驱动滚动';
      if (cb) cb(0);
      return true;
    }

    // ★ 这里不再 yieldToSite()。
    // 详情页的原生评论区一直渲染在表格底下（hideBeforeBoard 特意放过了 #noteContainer），
    // 滚它对画面毫无影响，而一旦让位，整层瀑布页（.fz-src / .feeds-page）就被还回文档流，
    // 站点的滚动/可见性观察器立刻接手：于是一边"加载评论"，一边在背后拉 homefeed，
    // 评论一条没来、笔记来了一百多篇（v0.74 就是这么踩的，详见 DEV §47）。
    busyShow('正在加载评论…', '从原站取下一批评论，表格稍后自动刷新');
    var feedTok = cmtFreezeFeed();     // 首页先按下不表，免得它抢着去拉 homefeed
    var tok = cmtShowNative();
    // 只滚"这篇笔记自己的评论区容器"：从 .comments-el 往上最近的能滚祖先（实测是 .note-scroller）。
    // 绝不把 html/body 算进来。
    var els = cmtScrollers();
    var sent = cmtSentinel();
    if (!els.length && !sent) {
      cmtHideNative(tok);
      cmtThawFeed(feedTok);
      busyHide();
      if (cb) cb(0);
      return false;
    }

    cmtBusy = true;
    var before = 0;
    try { before = (readComments(pid, true) || []).length; } catch (e) {}
    var srcTops = [];
    for (var st0 = 0; st0 < els.length; st0++) {
      try { srcTops.push(els[st0].scrollTop || 0); } catch (eST) { srcTops.push(0); }
    }
    var steps = 0, grewAt = 0, lastN = before, seen = null, wiggleN = 0;

    function finish() {
      if (!cmtBusy) return;
      cmtBusy = false;
      var now = before, stt = null;
      try { now = (readComments(pid, true) || []).length; } catch (e) {}
      try { stt = cmtState(pid); } catch (e2) {}
      cmtHideNative(tok);
      cmtThawFeed(feedTok);
      busyHide();
      // 收工前把原生详情的滚动位置摆回原处（下次滚还是从原地儿开始）
      for (var q = 0; q < els.length; q++) {
        try { els[q].scrollTop = srcTops[q] || 0; } catch (e0s) {}
      }
      try {
        if (pageTop && Math.abs((window.scrollY || 0) - pageTop) > 4) window.scrollTo(0, pageTop);
      } catch (ePT2) {}
      if (sheet) {
        try {
          var sh2 = document.querySelector('.fz-notesheet');
          if (sh2) sh2.scrollTop = sheetTop;
        } catch (eR3) {}
      }
      // 诊断里把"站点到底有没有回评论"分开讲：请求数没涨 = 站点压根没理我们；
      // 请求涨了但条数没涨 = 回包被别处接走了（或这篇真没更多）
      var reqD = cmtReqN - req0;
      cmtLastReqD = reqD;
      cmtDiag = '容器' + els.length + '·哨兵' + (sent ? '有' : '无') +
        '·hasMore' + (stt ? (stt.hasMore ? '1' : '0') : '?') +
        '·' + before + '→' + now +
        '·评论请求+' + reqD +
        (seen ? '·' + seen : '');
      if (now > before) { cmtFail = 0; cmtNextAt = 0; }
      else { cmtFail++; cmtNextAt = Date.now() + Math.min(30000, 4000 * cmtFail); }
      if (cb) cb(now - before);
    }

    // 把哨兵滚进容器的六成高处：只动这个滚动容器，不碰页面（scrollIntoView 会顺带滚 document）
    function scrollSentinelIn(sc, sen) {
      if (!sc || !sen) return;
      try {
        if (!sc.contains(sen)) return;
        var sr = sc.getBoundingClientRect(), er = sen.getBoundingClientRect();
        if (!sr.height) return;
        // 哨兵得在"当前视野的下方"才拉过去：评论区顶部那个 loading 容器也算 [class*=loading]，
        // 不管方向地滚它，每轮都会被拽回上面，正往下扫的位移就白费了
        if (er.top < sr.top + sr.height) return;
        var top = (sc.scrollTop || 0) + (er.top - sr.top) - Math.round(sc.clientHeight * 0.6);
        var lim = Math.max(0, sc.scrollHeight - sc.clientHeight);
        sc.scrollTop = Math.max(0, Math.min(lim, top));
      } catch (e) {}
    }

    function tick() {
      if (!cmtBusy) return;
      steps++;
      // 页面（底下那层瀑布页）一动，站点就会去拉 homefeed，每轮把它按回去
      try {
        if (pageTop && Math.abs((window.scrollY || 0) - pageTop) > 4) window.scrollTo(0, pageTop);
      } catch (ePT3) {}
      // 优先把"加载哨兵"滚进容器的可视区：站点是它露头才拉下一页
      var s2 = cmtSentinel();
      if (s2 && cmtInScope(s2) && els.length) scrollSentinelIn(els[0], s2);
      // 同时把可滚容器一点点往下推（一步跳到底站点不认）
      for (var i = 0; i < els.length; i++) {
        var e = els[i];
        if (!cmtInScope(e)) continue;          // 出了详情这棵子树一律不碰
        try {
          var limit = Math.max(0, e.scrollHeight - e.clientHeight);
          var next;
          if (steps === 1) {
            // 每次点击都先退回上方三屏，再一段段扫下来：停在底部没有新位移，站点不会发请求
            next = Math.max(0, limit - Math.round(e.clientHeight * 3));
          } else if ((e.scrollTop || 0) >= limit - 4) {
            // 已经贴底：退一点再回底，制造"又有东西进入视口"。
            // 站点有时要看到好几次才肯发下一页，所以这条可以反复用（以前只许一次）
            wiggleN++;
            next = Math.max(0, limit - Math.round(e.clientHeight * (0.4 + (wiggleN % 3) * 0.45)));
          } else {
            next = Math.min(limit, (e.scrollTop || 0) + Math.round(e.clientHeight * 0.55));
          }
          e.scrollTop = next;
          e.dispatchEvent(new Event('scroll', { bubbles: true }));
          // wheel 不冒泡：冒泡到 window 会被瀑布页的滚轮监听接住，又把首页带着翻页
          e.dispatchEvent(new WheelEvent('wheel', { deltaY: 700, bubbles: false, cancelable: true }));
          if (steps === 1) {
            seen = String(e.className || e.tagName || '').slice(0, 18) + '(' + limit + ')';
          }
        } catch (e2) {}
      }
      cmtMoreButtons().forEach(function (b) { try { b.click(); } catch (e3) {} });

      var n = before;
      try { n = (readComments(pid, true) || []).length; } catch (e4) {}
      if (n > lastN) {
        lastN = n; grewAt = steps;
        busySet('正在加载评论…', '已取到 ' + (n - before) + ' 条新评论，正在整理');
      }
      var stt = cmtState(pid);
      var done = stt && stt.hasMore === false;
      // 站点只要回过一次评论请求，就多给它几轮（网络慢/回包晚很常见）；
      // 一次都没回 = 点位不对，早点收手，别让用户干等
      var answered = (cmtReqN - req0) > 0;
      if (done || (grewAt && steps - grewAt >= 2) || steps >= (answered ? 40 : 24)) { finish(); return; }
      setTimeout(tick, 300);
    }

    setTimeout(tick, 60);
    setTimeout(function () { if (cmtBusy) finish(); }, (cmtReqN - req0) > 0 ? 20000 : 10000);
    return true;
  }

  // （原来这里还有个 toasyCmtKick()：进详情页 0.9 秒后偷偷唤醒一次评论区。
  //   v0.77 删掉了，详情页的加载也只认「加载评论 / 加载更多评论」这一个按钮。）

  // 详情表里的「加载更多评论」
  function doLoadCmts(btn) {
    var pid = (location.pathname.match(NOTE_PATH) || [])[1] || '';
    // 每次点都先把"此刻已读到的"并进仓里：
    // 以前只在仓是空的时候灌一次，之后拿旧快照重画，会把站点后来自己加载的评论缩回去。
    // mergeCmts 只增不减、按 cid 去重，所以并进去永远是超集。
    try { mergeCmts(pid, readComments(pid, true) || []); } catch (e0) { if (!cmtStore[pid]) cmtStore[pid] = []; }
    if (!cmtStore[pid]) cmtStore[pid] = [];
    var before = cmtStore[pid].length;
    if (btn.__fzBusy) return;
    btn.__fzBusy = 1;
    var old = btn.textContent;
    btn.textContent = '加载中…';
    // 兜底（v1.1）：未登录时站点经常压根不回应，按钮就永远停在"加载中…"，
    // 用户只会以为脚本卡死。9 秒没回来就把按钮救回来，并说清是不是没登录。
    var settled = false;
    var guard = setTimeout(function () {
      if (settled) return;
      settled = true;
      var lv = (noteSheet && noteSheet.querySelector('[data-cmore]')) || btn;
      lv.__fzBusy = 0;
      lv.textContent = !isLoggedIn()
        ? '没登录：站点不给更多评论了（点右上角「登录」）'
        : '站点没回应，过会儿再点一次';
      setTimeout(function () { if (!lv.__fzBusy) lv.textContent = old; }, 9000);
    }, 9000);
    var ok = pullMoreComments(function () {
      settled = true;
      clearTimeout(guard);
      var fresh = null;
      try { fresh = readComments(pid, true); } catch (e2) {}
      var added = 0;
      if (fresh && fresh.length) added = mergeCmts(pid, fresh);
      // 同上：没新增就不重画
      if (added && noteSheet && noteSheet.__fzRenderCmt) {
        try { noteSheet.__fzRenderCmt(cmtStore[pid].slice()); } catch (e3) {}
      }
      // 重画会换掉按钮节点，状态要写到"当前活着的那个"
      var live = (noteSheet && noteSheet.querySelector('[data-cmore]')) || btn;
      live.__fzBusy = 0;
      var now = cmtStore[pid].length;
      var tip = live.parentNode && live.parentNode.querySelector('.fz-cdiag');
      var wall = cmtLoginWall();
      if (now > before) live.textContent = '这只是新增 ' + added + ' 条，已累计 ' + now + ' 条';
      // 没登录就是没登录，别拿"站点没回请求 / 回了但没新评论"糊过去 —— 那两种说法会把人带偏
      else if (!isLoggedIn()) live.textContent = '没登录：站点不给更多评论了（点右上角「登录」）';
      else if (wall) live.textContent = '站点要求登录才给更多评论（hasMore=1 但被锁）';
      // 把"站点点没点我们"和"点了但没新东西"分开说，这两种毛病修法完全不同
      else if (cmtLastReqD === 0) live.textContent = '站点没回评论请求（评论区可能到底了）';
      else if (Date.now() < cmtNextAt) live.textContent = '站点暂时没给新评论，' + Math.round((cmtNextAt - Date.now()) / 1000) + 's 后可再试';
      else live.textContent = '站点回了请求，但没新评论';
      if (tip && cmtDiag) tip.textContent = cmtDiag;
      setTimeout(function () { if (!live.__fzBusy) live.textContent = old; }, 5000);
    });
    if (!ok) { settled = true; clearTimeout(guard); btn.__fzBusy = 0; btn.textContent = '没找到评论容器'; setTimeout(function () { btn.textContent = old; }, 2200); }
  }

  // 主楼视频播放：小红书用 blob(MSE) 播放，拿不到直链，
  // 所以把原生 <video> 元素整个搬进浮层里播，关掉再搬回去
  function playMainVideo() {
    var v = document.querySelector('#noteContainer video') || document.querySelector('video');
    if (!v) { toast('没找到视频元素'); return; }

    var box = document.createElement('div');
    box.className = 'fz-vbox';
    box.innerHTML = '<div class="fz-vwrap"><span class="fz-vclose">×</span>' +
      '<span class="fz-vtip">空格播放/暂停 · 点右上角关闭</span></div>';
    document.body.appendChild(box);

    var wrap = box.querySelector('.fz-vwrap');
    var home = v.parentNode, next = v.nextSibling;   // 记原位置，关掉时搬回去
    wrap.insertBefore(v, wrap.firstChild);
    var oldStyle = v.getAttribute('style') || '';
    v.setAttribute('style', 'width:100%;height:100%;object-fit:contain;background:#000;display:block;');
    v.controls = true;
    try { v.play(); } catch (e) {}

    function close() {
      try { v.pause(); } catch (e) {}
      v.controls = false;
      if (oldStyle) v.setAttribute('style', oldStyle); else v.removeAttribute('style');
      try { home.insertBefore(v, next); } catch (e2) { try { home.appendChild(v); } catch (e3) {} }
      if (box.parentNode) box.parentNode.removeChild(box);
      document.removeEventListener('keydown', onKey, true);
    }
    function onKey(e3) {
      if (e3.code === 'Space') { e3.preventDefault(); if (v.paused) { try { v.play(); } catch (e4) {} } else { try { v.pause(); } catch (e5) {} } }
    }
    document.addEventListener('keydown', onKey, true);
    box.addEventListener('click', function (e6) {
      if (e6.target === box || (e6.target.classList && e6.target.classList.contains('fz-vclose'))) close();
    });
    toast('视频按空格播放/暂停，右上角 × 关闭');
  }

  // 直接点小红书的原生控件（赞 / 收藏 / 回复），不碰它的接口
  function findActHost(row) {
    if (row <= 1) return document.querySelector('#noteContainer') || document.body;
    var items = document.querySelectorAll('[class*="comment-item"]');
    return items[row - 2] || null;
  }

  function press(el) {
    var r = el.getBoundingClientRect();
    var x = Math.round(r.left + r.width / 2) || 1;
    var y = Math.round(r.top + r.height / 2) || 1;
    try {
      ['pointerover', 'pointerenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (ty) {
        var ev;
        if (ty.indexOf('pointer') === 0 && typeof PointerEvent === 'function') {
          ev = new PointerEvent(ty, {
            bubbles: true, cancelable: true, view: window, button: 0,
            clientX: x, clientY: y, screenX: x, screenY: y,
            pointerId: 1, pointerType: 'mouse', isPrimary: true, bubbles: true,
          });
        } else {
          ev = new MouseEvent(ty, {
            bubbles: true, cancelable: true, view: window, button: 0,
            clientX: x, clientY: y, screenX: x, screenY: y,
          });
        }
        el.dispatchEvent(ev);
      });
      el.click();
    } catch (e) {}
  }

  // 这一下到底生效了没有：只看"赞/藏"这个语义状态。
  // 踩过的坑：press() 先派发 pointerover/mouseover，站点 hover 就会改 className（换图标/加 hover 类），
  // 拿"className 变了"当成功会在 hover 那一拍就误判成功，点赞因此既没让位也没红框。
  function actOn(el, what) {
    var s = String((el && el.className) || '');
    return what === 'like' ? /liked|like-active/.test(s) : /collect-active|collected/.test(s);
  }

  // 从外层往里逐层试（有的实现把手势绑在 svg 或它爸身上）
  function tryPress(el, isDone, onDone) {
    var targets = [el];
    var svg = el.querySelector && el.querySelector('svg');
    if (svg && svg.parentElement) targets.push(svg.parentElement);
    if (svg) targets.push(svg);
    // 直接子元素也试一遍（有的实现把 onClick 绑在内部 icon 上）
    if (el.children) {
      for (var ci = 0; ci < el.children.length && ci < 5; ci++) targets.push(el.children[ci]);
    }
    if (el.parentElement) targets.push(el.parentElement);
    var before = String(el.className || '');
    var i = 0;
    (function next() {
      if (i >= targets.length) { onDone(false, String(el.className || before)); return; }
      var t = targets[i++];
      press(t);
      setTimeout(function () {
        if (isDone()) onDone(true, String(el.className || ''));
        else next();
      }, 260);
    })();
  }

  // 回复输入框：站点的类名换过好几版（.engage-bar / .comment-input / contenteditable…），
  // 所以按"能不能打字 + 是不是画得出来"来找，而不是死认一个选择器。
  function replyBox() {
    var sel = '#noteContainer textarea, .engage-bar textarea, .engage-bar input,' +
      '[class*="comment"] textarea, [class*="reply"] textarea, [class*="content-edit"],' +
      '[class*="comment"] [contenteditable="true"], [contenteditable="true"]';
    var all = document.querySelectorAll(sel);
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.closest && el.closest('.fz-notesheet,.fz-menu,.fz-viewer,.fz-board,.fz-chrome')) continue;
      var r = el.getBoundingClientRect();
      if (r.width > 60 && r.height > 16) return el;
    }
    // 一个都量不到：退一步，只要能打字就行（画不出来也不至于没反应）
    for (var j = 0; j < all.length; j++) {
      if (!(all[j].closest && all[j].closest('.fz-notesheet,.fz-menu,.fz-chrome'))) return all[j];
    }
    return null;
  }

  function siteAction(what, row, sheetEl) {
    if (what === 'reply') {
      yieldToSite();
      try { dimSite(); } catch (eD) {}      // 立刻压暗：和点赞/收藏同一层黑，不等输入框出来
      var tries = 0;
      var findBox = function () {
        var box = replyBox();
        if (box) {
          try { box.focus(); box.click(); } catch (e) {}
          try { frameEl(box); } catch (e2) {}
          return;
        }
        // 站点常常是"点了才渲染"回复框：找不到就再等一拍（最多 8 次 ≈ 2s）
        if (++tries < 8) setTimeout(findBox, 250);
      };
      setTimeout(findBox, 260);
      toast('已切到原生界面，直接输回复；要回表格点屏幕正中「返回表格模式」', 6000);
      return true;
    }
    var host = findActHost(row);
    if (!host) { toast('没找到这一行的原生元素'); return false; }
    var el = host.querySelector(what === 'like' ? '.like-wrapper' : '.collect-wrapper');
    if (!el) { toast('原生按钮不存在'); return false; }
    var before = String(el.className);
    var beforeTxt = (el.textContent || '').replace(/\s+/g, '');
    var wasOn = actOn(el, what);
    tryPress(el, function () { return actOn(el, what) !== wasOn; }, function (changed, after) {
      after = after || String(el.className);
      var label = what === 'like' ? '点赞' : '收藏';
      var nowTxt = (el.textContent || '').replace(/\s+/g, '');
      var numChanged = nowTxt !== beforeTxt;      // 数字变了也算成功（未登录时只会弹提示、类名不变）
      var on = actOn(el, what);
      if (changed) toast(on ? ('已' + label) : ('已取消' + label));
      else if (numChanged) toast('已' + label);
      else {
        // 脚本点不动（站点校验 event.isTrusted）→ 让位 + 红框圈住按钮，等真人点一下
        toast('红框就是' + label + '按钮，点一下即可（表格会自动回来；不想点了就按屏幕正中「返回表格模式」）', 6000);
        yieldToSite();
        setTimeout(function () {
          highlightEl(el);
          // 鼠标划过按钮站点也会换 class（hover），所以这里同样只认"赞/藏"的状态
          pollUntil(function () { return actOn(el, what) !== wasOn; }, function (ok3) {
            if (ok3) { toast('已' + label); setTimeout(resumeFromSite, 500); }
            else { toast('没检测到' + label); resumeFromSite(); }
          }, 25000);
        }, 150);
        return;
      }
      // 刷新这一行的显示（赞数/时间）
      try {
        var pid = (location.pathname.match(NOTE_PATH) || [])[1] || '';
        if (row <= 1 && sheetEl) refreshMainMeta(sheetEl, noteSheetData || {}, pid);
        else if (sheetEl && sheetEl.__fzRenderCmt) {
          var fresh = readComments(pid);
          if (fresh && fresh.length) sheetEl.__fzRenderCmt(fresh);
        }
      } catch (e2) {}
    });
    return true;
  }

  function bindSearch() {
    var inp = document.querySelector('.fz-search');
    if (!inp || inp.dataset.fzBound) return;
    inp.dataset.fzBound = '1';
    inp.addEventListener('input', applyFilter);
    inp.addEventListener('click', function (e) { e.stopPropagation(); });
    inp.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') {
        var q = (inp.value || '').trim();
        if (q) location.href = location.origin + '/search_result?keyword=' +
          encodeURIComponent(q) + '&source=web_explore_feed';
        return;
      }
    });
  }

  // 幕布什么时候能掀：有表格了才掀。>3000ms 是安全阀，但"到点就掀"是有代价的：
  // 这时候页面里可能还是原生小红书（表格没建出来），等于漏光。所以把时间线记下来（R6p 盯着）。
  var curtainLog = { droppedAt: 0, why: '', hadShell: false, hadRow: false, at: 0 };
  // 原生页面被我们藏住了吗？幕布一掀露出来的就是它，所以掀之前必须能证明它藏住了。
  // 认得的根节点全都是隐藏状态才算数（只藏住一个不算：站点可能把内容放在另一棵子树里）。
  function siteHidden() {
    var probes = ['#app', '#main-container', '.main-container'];
    var found = 0, hidden = 0;
    for (var i = 0; i < probes.length; i++) {
      var el = document.querySelector(probes[i]);
      if (!el) continue;
      found++;
      try {
        // 关键：不能只看它自己的 display，父节点被 display:none 时，孩子自己的 computed display
        // 还是 block，可它一个像素都画不出来。getClientRects 为空才是"真的不在画面上"。
        // （第一版就是这么写的，于是在真机上永远等不到"站点藏好了"，只能等表格出来。）
        var cs = getComputedStyle(el);
        var gone = el.getClientRects().length === 0 || cs.visibility === 'hidden' ||
                   parseFloat(cs.opacity) < 0.05;
        if (gone) hidden++;
      } catch (e) {}
    }
    return found > 0 && hidden === found;
  }
  function curtainCheck() {
    var hasShell = !!document.querySelector('.fz-chrome');
    var hasRow = !!document.querySelector('.fz-row');
    var hasSheet = !!document.querySelector('.fz-notesheet');
    var hid = siteHidden();
    var safe = hasShell && hid;
    return {
      hasShell: hasShell, hasRow: hasRow || hasSheet,
      siteHidden: hid, safe: safe,
      wouldDrop: hasRow || hasSheet || safe,
      why: hasRow ? 'rows' : (hasSheet ? 'notesheet' : (safe ? 'shell' : 'wait'))
    };
  }
  function dropCurtain(force) {
    var el = document.documentElement;
    if (!el.classList.contains('fz-boot')) return false;
    var c = curtainCheck();
    // 只靠"外壳在 + 站点藏住"就掀的话，可能掀在"一帧都还没画"的时候：
    // 幕布撤掉之后到第一次绘制之间，屏幕上可能是空的（甚至露一下原生页面）。
    // 所以这条额外要求：要么表格/详情表已经就绪，要么至少画过一帧。
    // 只要还没画过第一帧，就先别掀（不管表格在不在），
    // 页面忙的时候主线程一堵就是几百毫秒，期间 document 里早就有 .fz-row 了，
    // 可屏幕上还什么都没有；这时候撤幕布，等真画出来的时候幕布已经不在了。
    // 真·兜底还是靠 3.8s 那次 force（那时候有没有画过都得掀，不然一直白屏）。
    // 只有"光有外壳、表格还没好"那条（why=shell）要等首帧：
    // 那时候屏幕上还什么都没有，提前撤幕布，真画出来的第一帧可能就是原生页面。
    // 表格/详情表已经在了就不用等，第一帧画的就是我们的表格，不露馅。
    if (!force && !c.hasRow && !c.hasSheet) {
      var fp = firstPaintAt();
      if (fp < 0 || (Date.now() - (performance.timeOrigin || bootAt)) < fp) return false;
    }
    if (c.wouldDrop || force) {
      curtainLog = {
        droppedAt: Date.now(),
        why: c.wouldDrop ? c.why : 'fallback',
        hadShell: c.hasShell,
        hadRow: c.hasRow,
        at: Date.now() - bootAt
      };
      el.classList.remove('fz-boot');
      return true;
    }
    return false;
  }

  // ---------- 安全阀 ----------
  var idleTimer = null;
  function resetIdle() {
    clearTimeout(idleTimer);
    if (!viewer) return;
    idleTimer = setTimeout(closeViewer, CFG.idleCollapseMs);
  }

  // Ctrl+Shift+X = 收起浮层：以前漏了筛选面板 / 排序面板 / 设置菜单，
  // 而卡片上写着"收起浮层（最常用）"，按一下菜单还杵在那儿。
  // ---- 右键菜单（Excel 里右键是最顺手的入口）----
  // 只做"这一格/这一行"能做的事：复制、只复制这一格、按这列筛、导出、打开笔记。
  // 不做插入/删除行那种会改数据的操作，伪装表格里改不动站点数据，摆了就是骗人。
  var ctxEl = null;
  var ctxRow = null;

  function ctxInfo(cell, row) {
    // 这一格属于哪一列：往上找带 .fz-thead 的那个盒子，表头孩子和单元格是一一对应的
    var key = '', label = '';
    if (cell && cell.parentNode && row) {
      var box = row;
      while (box && box !== document.body && !(box.querySelector && box.querySelector('.fz-thead'))) {
        box = box.parentNode;
      }
      var th = box && box.querySelector ? box.querySelector('.fz-thead') : null;
      var i = [].indexOf.call(cell.parentNode.children, cell);
      var h = th && th.children ? th.children[i] : null;
      if (h && h.getAttribute) {
        key = h.getAttribute('data-fz-filter') || '';
        label = String(h.textContent || '').replace(/[▾▼⇅↕]/g, '').replace(/\s+/g, ' ').trim();
      }
    }
    return {
      key: key,
      label: label,
      row: row,
      txt: cell ? String(cellText(cell) || '').replace(/\s+/g, ' ').trim() : ''
    };
  }

  function closeCtx() {
    if (ctxEl && ctxEl.parentNode) ctxEl.parentNode.removeChild(ctxEl);
    ctxEl = null;
    ctxRow = null;
  }

  function ctxItem(kind, arg, title, value) {
    return '<div class="fz-mi" data-fz-ctx="' + kind + '" data-fz-arg="' + esc(arg || '') + '">' +
      '<span class="fz-mk"></span>' +
      '<span class="fz-mt">' + esc(title) + '</span>' +
      '<span class="fz-mv">' + esc(value || '') + '</span></div>';
  }

  function openCtx(x, y, cell, row) {
    var info = ctxInfo(cell, row);
    var html = '';
    if (SEL.length) html += ctxItem('copy', '', '复制选中的 ' + SEL.length + ' 行', 'Ctrl+C');
    if (info.txt) html += ctxItem('cell', info.txt, '只复制这一格',
      info.txt.length > 12 ? info.txt.slice(0, 12) + '…' : info.txt);
    if (info.key) html += ctxItem('filter', info.key, '按这一列筛选…', info.label);
    html += ctxItem('csv', '', '导出成 CSV', 'Ctrl+Shift+E');
    if (row && row.__fz && row.__fz.token) {
      html += ctxItem('open', '', '在新标签页打开这篇笔记', '');
    }
    if (filterOn()) html += ctxItem('clear', '', '清掉筛选', '');
    closeCtx();
    closeMenu();
    closeFilter();
    closeSort();
    var m = document.createElement('div');
    m.className = 'fz-menu fz-ctx';
    m.setAttribute('data-fz-menu-panel', '1');   // 点菜单里面不算"点别处"
    m.setAttribute('data-fz-txt', info.txt.slice(0, 40));
    m.innerHTML = html;
    document.body.appendChild(m);
    // 贴在鼠标右下角，别跑出视口
    var w = m.offsetWidth, h = m.offsetHeight;
    m.style.left = Math.round(Math.max(4, Math.min(x + 2, innerWidth - w - 4))) + 'px';
    m.style.top = Math.round(Math.max(4, Math.min(y + 2, innerHeight - h - 4))) + 'px';
    markKeyboard(m);
    ctxEl = m;
    ctxRow = row || null;
    return m;
  }

  // （SG4 就是用"卡片说什么就按什么"这条断言抓出来的）
  function escapeAll() {
    // 让位状态下先回表格：不然"一键收起"会把用户留在一个原生小红书上
    if (yieldMode) { try { backToTable(true); } catch (eR) {} }
    clearSel();
    closeViewer();
    if (filtEl) closeFilter();
    if (sortEl) closeSort();
    if (menuEl) closeMenu();
    if (ctxEl) closeCtx();
    if (noteSheet) closeNoteSheet();
    scrollTo({ top: 0 });
  }

  // 鼠标划过单元格时，名称框和公式栏跟着变（看起来像真的在选中单元格）；
  // 已经有选区时就不抢了，那是用户刚选好的，不能被鼠标划过擦掉
  function bindHover() {
    document.addEventListener('mouseover', function (e) {
      if (SEL.length) return;
      var cell = e.target.closest && e.target.closest('.fz-c');
      if (!cell) return;
      var wrap = cell.parentElement;
      if (!wrap || !wrap.classList || !wrap.classList.contains('fz-cells')) return;
      var row = wrap.closest('.fz-row, .fz-nrow');
      if (!row) return;
      var idx = Array.prototype.indexOf.call(wrap.children, cell);
      var numEl = wrap.querySelector('.fz-num');
      var rowNo = (numEl && parseInt(numEl.textContent, 10)) || '';
      // 名称框的列字母要跟当前视图一致：列表 A~E，详情 A~F（详情多一个"操作"列）
      var LET = row.classList.contains('fz-nrow')
        ? ['', 'A', 'B', 'C', 'D', 'E', 'F']
        : ['', 'A', 'B', 'C', 'D', 'E'];
      var ref = document.querySelector('.fz-ref');
      var inp = document.querySelector('.fz-input');
      if (ref) ref.textContent = (LET[idx] || 'A') + rowNo;
      if (inp) inp.textContent = (cell.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    }, true);
  }

  // 主表格滚到底 → 顺手把隐藏的源列表滚到底，触发站点自己的加载更多
  var lastNudge = 0;
  // 分步滚到底：一次跳到底站点经常不认，慢慢滑才像真人
  function scrollStep(el, done) {
    if (!el) { if (done) done(false); return; }
    var h = el.scrollHeight, cur = el.scrollTop, guard = 0;
    var timer = setInterval(function () {
      guard++;
      cur = Math.min(cur + 520, h);
      try { el.scrollTop = cur; } catch (e) {}
      try { el.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (e2) {}
      if (cur >= h - 2 || guard > 24) {
        clearInterval(timer);
        if (done) done(true);
      }
    }, 55);
  }

  function nudgeSource(force) {
    var now = Date.now();
    if (!force && now - lastNudge < 1500) return;
    lastNudge = now;
    var src = document.querySelector('.fz-src');
    if (!src) return;
    try { src.scrollTop = src.scrollHeight; } catch (e) {}
    try { src.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (e) {}
  }

  // 注：v0.77 起没有"滚到底自动加载"了。
  // 以前这里会在接近底部时 nudgeSource() 一下，站点于是自己发 homefeed、行数悄悄变多，
  // 用户眼里就是"我什么都没点，表格自己在长"。现在加载下一批只有一条路：
  // 点表格末尾那个「加载更多」。（nudgeSource 只剩「再试一次」那种明确点击在用。）

  // ===== 拖表头右边缘改列宽（Excel 原样）=====
  // 一次绑定挂在 document 上（表头会随视图/筛选重建），用捕获阶段免得被别人先吃掉。
  // 宽度只记在内存里 + CSS 变量上：刷新/换页回默认（和第 30 条一个规矩，这类状态不落盘）。
  var colDrag = null, colDragMoved = false, colDragBound = false, colEdgeDown = false;
  // 这一列属于哪张表，只认表头/字母行自己盖的章（同一个 detail 标记写下来的），
  // 不去猜祖先：表头不在 .fz-notesheet 里，猜必错。
  function headView(el) {
    var th = el && el.closest ? el.closest('.fz-thead') : null;
    if (th && th.dataset && th.dataset.fzView) return th.dataset.fzView;
    var lt = el && el.closest ? el.closest('.fz-letters') : null;
    if (lt && lt.dataset && lt.dataset.fzKey) {
      return lt.dataset.fzKey.split('|')[1] === '1' ? 'detail' : 'list';
    }
    return '';
  }
  function bindColDrag() {
    if (colDragBound) return;
    colDragBound = true;
    document.addEventListener('mousedown', function (e) {
      colDragMoved = false;
      colEdgeDown = false;
      if (e.button) return;
      var th = e.target && e.target.closest && e.target.closest('.fz-thead > *, .fz-letters > *');
      if (!th || !th.parentNode) return;
      var r = th.getBoundingClientRect();
      if (r.width < 12) return;
      // 只在右边缘那一小条上（3px）：宽了会跟「点表头筛 ▾」抢，6px 时最后 6px 点不动
      if (r.right - e.clientX > 3 || e.clientX - r.left < 8) return;
      var cells = [].slice.call(th.parentNode.children);
      var i = cells.indexOf(th);
      var view = headView(th);
      if (view !== 'list' && view !== 'detail') return;
      var ws = colWs(view), vars = colVarNames(view);
      if (i < 0 || i >= ws.length || ws[i] === null) return;           // 弹性列不拖
      colDrag = { i: i, view: view, x: e.clientX, w0: ws[i], varName: vars[i] };
      colEdgeDown = true;   // 这一下点的是列边缘：别让后面的 click 去开筛选面板
      try { e.preventDefault(); } catch (eP) {}
      try { e.stopPropagation(); } catch (eS) {}
    }, true);
    document.addEventListener('mousemove', function (e) {
      if (!colDrag) return;
      var d = Math.round(e.clientX - colDrag.x);
      if (!colDragMoved && Math.abs(d) < 3) return;       // 抖动不算拖动，免得抢了"点表头筛选"
      colDragMoved = true;
      var ws = colWs(colDrag.view), lo = colMin(colDrag.view)[colDrag.i];
      var w = Math.max(lo, Math.min(WMAX_PX, colDrag.w0 + d, colRoom(colDrag.view, colDrag.i)));
      ws[colDrag.i] = w;
      setColVar(colDrag.view, colDrag.i, w);
      document.documentElement.style.cursor = 'col-resize';
      try { e.preventDefault(); } catch (eM) {}
    }, true);
    document.addEventListener('mouseup', function () {
      if (!colDrag) return;
      colDrag = null;
      document.documentElement.style.cursor = '';
      // colDragMoved 留着：紧接着那一下 click 要被吃掉（下一次 mousedown 才清，
      // 浏览器在 mouseup 之后一般都会补一下 click）。
      // 万一松手落在窗口外、压根没有 click，就靠这个兜底清掉：
      // 只吃紧跟着的那一下，不能把用户"下一次"真正的点击也吃掉。
      setTimeout(function () { colDragMoved = false; colEdgeDown = false; }, 250);
    }, true);
    addEventListener('resize', function () { clampCols(); });
    // 双击列边缘：按内容自适应（Excel 原样）。双击前后那两下 click 都不该开筛选面板，
    // 所以上面 mousedown 里认了边缘就置 colEdgeDown，click 处理里会吞掉。
    document.addEventListener('dblclick', function (e) {
      if (colDragMoved) return;
      var th = e.target && e.target.closest && e.target.closest('.fz-thead > *, .fz-letters > *');
      if (!th || !th.parentNode) return;
      var r = th.getBoundingClientRect();
      if (r.width < 12) return;
      if (r.right - e.clientX > 6 || e.clientX - r.left < 8) return;
      var view = headView(th);
      if (view !== 'list' && view !== 'detail') return;
      var i = [].slice.call(th.parentNode.children).indexOf(th);
      var w = autoFitCol(view, i);
      if (!w) return;
      colEdgeDown = false;
      try { e.preventDefault(); } catch (eP) {}
      try { e.stopPropagation(); } catch (eS) {}
      toast('这一列已按内容调宽');
    }, true);
    document.addEventListener('mousemove', function (e) {
      if (colDrag) return;
      var th = e.target && e.target.closest && e.target.closest('.fz-thead > *, .fz-letters > *');
      var near = false;
      if (th) {
        var r = th.getBoundingClientRect();
        near = r.width >= 12 && r.right - e.clientX <= 6 && e.clientX - r.left >= 8;
        if (near) {
          var j = [].slice.call(th.parentNode.children).indexOf(th);
          var vw = headView(th);
          if (j < 0 || (vw !== 'list' && vw !== 'detail') ||
              j >= colWs(vw).length || colWs(vw)[j] === null) near = false;
        }
      }
      document.documentElement.style.cursor = near ? 'col-resize' : '';
    }, true);
  }

  // 一张表"看得见的行"：详情看 .fz-notesheet 里，列表看 .fz-board 里（两张表的单元格不能混着量）
  function fitRows(view) {
    var box = view === 'detail' ? document.querySelector('.fz-notesheet')
      : document.querySelector('.fz-board');
    var rows = box ? scopeRows(box) : [];
    if (rows.length) return rows;
    return [].slice.call(document.querySelectorAll('.fz-row')).filter(function (r) {
      return !r.classList.contains('fz-hide');
    });
  }
  // 双击表头右边缘 = 把这一列调到刚好装下内容（Excel 原样）。
  // "内容多宽"用的是和 cellTips 同一条判断：叶子的 b/span 的 scrollWidth（见 1194 行 cellTips）。
  // 一格内容有多宽：逐个文本节点用 Range 量文字。两个理由：
  //   1) 不受"元素现在多宽"影响，读 scrollWidth 会读到盒子宽度（它至少等于 clientWidth），
  //      于是双击一次宽 1px、越量越宽（WD9 / 真机 R6x 都踩过）；
  //   2) 不套用 cellTips 那条"有子元素的容器不管"，那是给 tooltip 的规则，
  //      拿来量宽度会漏掉"标题里套了个 <a> / 图徽标"的格子，弹性列会量出 0、双击没反应。
  // 会折行的文字不算：加宽它也不会变整齐（它本来就是按容器宽度折的）。
  var measureCtx = null;
  function textWidth(scope) {
    var w = 0, it;
    try {
      if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
      var walk = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, null);
      while ((it = walk.nextNode())) {
        var s = (it.nodeValue || '').replace(/\s+/g, ' ').trim();
        if (!s) continue;
        var pe = it.parentNode, cs = null;
        try { cs = pe && pe.nodeType === 1 ? getComputedStyle(pe) : null; } catch (eC) {}
        if (cs) {
          measureCtx.font = (cs.fontStyle || 'normal') + ' ' + (cs.fontWeight || '400') + ' ' +
            (cs.fontSize || '13px') + ' ' + (cs.fontFamily || 'sans-serif');
        }
        var rw = Math.ceil(measureCtx.measureText(s).width);
        if (rw > w) w = rw;
      }
    } catch (eR) {}
    // 「N楼」徽标 + 作者名是同一行的两个节点：上面按文本节点取的是"最长的那一段"，
    // 这里要的是"两段加起来"。不补这一下，双击列边缘按内容调宽后会正好差一个徽标的宽度，
    // 名字还是被截住（真机 R6x 就是这么红的）。
    try {
      var an = scope.querySelector && scope.querySelector('.fz-aname');
      if (an) {
        var nb = an.querySelector('b');
        var tg = an.querySelector('.fz-fl');
        var av = an.querySelector('.fz-av');       // 头像：16px 图标 + 右边距
        var op = an.querySelector('.fz-op');       // 「楼主」标记
        var need = (nb ? textWidth(nb) : 0) +
          (tg ? Math.ceil(tg.getBoundingClientRect().width) + 5 : 0) +
          (av ? 18 : 0) +
          (op ? Math.ceil(op.getBoundingClientRect().width) + 5 : 0);
        if (need > w) w = need;
      }
    } catch (eAn) {}
    // 量不到就是没有可量的文字（图标 / 头像这类）。不要退回 scrollWidth：那是盒子宽度。
    return w;
  }
  function autoFitCol(view, i) {
    var ws = colWs(view), lo = colMin(view);
    if (i < 0 || i >= ws.length) return 0;
    var flex = ws[i] === null;   // 弹性列：没有固定宽度可改，改的是它的下限
    var rows = fitRows(view), z = (ZOOM || 100) / 100, pad = Math.round(14 * z) + 2;
    var want = 0, n = 0, r, j;
    for (r = 0; r < rows.length; r++) {
      var box = rows[r].querySelector('.fz-cells');
      var cell = box && box.children[i];
      if (!cell) continue;
      n++;
      var w = textWidth(cell);
      if (w > want) want = w;
    }
    if (!want || !n) return 0;
    if (flex) {
      // 弹性列照样吃多余空间，只是不再缩到把内容截住。下限不低于默认值：
      // 双击两次是"调到刚好"，内容自己变短了就退回默认。
      var nf = Math.max(FLEX_MIN[view], Math.min(WMAX_PX, colRoom(view, i), want + pad));
      if (Math.abs(nf - flexMin[view]) <= 2) return 0;
      setColVar(view, i, nf);
      return nf;
    }
    var next = Math.max(lo[i], Math.min(WMAX_PX, colRoom(view, i), want + pad));
    // 和现在差不多就别动：这一列本来就装得下（按内容自适应是"调一次就停"，不是每点一次涨一点）
    if (Math.abs(next - ws[i]) <= 2) return 0;
    ws[i] = next;
    setColVar(view, i, next);
    return next;
  }

  // 表头兜底（捕获阶段）：扩展/输入法的透明层要是连 click 都 stopPropagation 了，
  // 上面那个坐标反查根本轮不到，这里在 pointerdown 就认，认得出来就直接办。
  function bindHeaderFallback() {
    addEventListener('pointerdown', function (e) {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      var t = e.target;
      if (t && t.closest && t.closest('[data-fz-filter],[data-fz-sort]')) return;   // 正常路径，交给 click
      var hit = headerHitAt(e.clientX, e.clientY);
      if (!hit) return;
      var fk = hit.getAttribute('data-fz-filter');
      var sk = hit.getAttribute('data-fz-sort');
      if (!fk && !sk) return;
      e.preventDefault();
      e.stopPropagation();
      hdrGraceUntil = Date.now() + 500;
      eatNextClick();
      if (fk) {
        if (filtEl && filtEl.isConnected && filtKey === fk) closeFilter();
        else openFilter(fk, hit);
        return;
      }
      cycleSort(sk);
    }, true);
  }

  function bindKeys() {
    addEventListener('keydown', function (e) {
      // 光标是不是在输入框里（顶部搜索框 / 筛选面板的搜索框 / 任何 input）。
      // 放在最上面算一次：原来只在"筛选面板开着"那个分支里算，别处引用到的 typing 全是 undefined，
      // 新增的 Ctrl+Home 守卫就是这么被绕过去的（自测 NG6 抓到）。
      var typing = (function () {
        var ae0 = document.activeElement;
        return !!(ae0 && (/^(INPUT|TEXTAREA)$/.test(ae0.tagName) || ae0.isContentEditable));
      })();
      // Shift+空格 = 选中光标所在的那一行（Excel 原样）。必须排在下面"空格=点按钮"前面
      if (e.shiftKey && !e.ctrlKey && !e.altKey && (e.key === ' ' || e.key === 'Spacebar')) {
        var se = document.activeElement;
        var styping = se && (/^(INPUT|TEXTAREA|SELECT)$/.test(se.tagName) || se.isContentEditable);
        var srow = !styping && se && se.closest && se.closest('.fz-row, .fz-nrow');
        if (srow) { e.preventDefault(); selectRows(srow); return; }
      }
      // 选中之后 Ctrl+C = 复制成一张表（TSV，Excel 直接吃）
      if (!typing && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey &&
          (e.key === 'c' || e.key === 'C' || e.key === 'Insert')) {
        var tsel = '';
        try { tsel = String(window.getSelection ? window.getSelection() : ''); } catch (err) {}
        // 用户自己划了字就先紧着浏览器（别抢人家复制正文）
        if (SEL.length && !tsel) { e.preventDefault(); copySel(); return; }
      }
      // Ctrl+A = 全选整张表（Excel 原样）。光标在输入框里、或者用户自己划了字，都让给浏览器。
      // 以前没有这一条，也没有上面那个 typing 守卫：在搜索框里选好字按 Ctrl+C，
      // 会被我们抢去复制选中的行（自测 SA7 抓到的真 bug）。
      if (!typing && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey &&
          (e.key === 'a' || e.key === 'A')) {
        var tselA = '';
        try { tselA = String(window.getSelection ? window.getSelection() : ''); } catch (errA) {}
        if (!tselA && navRows().length) {
          e.preventDefault();
          selectAllVisible();
          return;
        }
      }
      // v1.2：Ctrl+F 不接管了，交回浏览器自己的查找（顶部搜索框照旧可用）
      // Ctrl+S = Excel 的"保存"：拦下来给个回执，别让浏览器把"保存网页"对话框糊在表格上
      // （那个对话框里带着网址和文件名，是比查找条更响的一次穿帮）。光标在输入框里时让给浏览器。
      if (!typing && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey &&
          (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        toast('已保存（表格模式里没有什么要存的）');
        return;
      }
      // 键盘走到某个"按钮"上按回车/空格 = 点它一下（Tab 能把整张表走完）
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        var ke = kbdHit(document.activeElement);
        // 筛选面板自己处理回车（下面那段），别点两次
        if (ke && !(filtEl && ke.classList.contains('fz-mi'))) {
          e.preventDefault();
          ke.click();
          return;
        }
      }
      // 筛选面板开着：↑↓ 选、回车确认。正在输入框里打字时不抢键（否则搜索框里按方向键会跳选项）
      if (filtEl) {
        var ae = document.activeElement;
        // 面板自己的搜索框：↑↓/回车 还是面板的（Excel 里就是边打字边用方向键挑）；
        // 页面别处的输入框（顶部搜索框）照旧一律不抢键
        var inPanelInput = typing && filtEl.contains(ae);
        if ((!typing || inPanelInput) && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
          e.preventDefault();
          filterMove(e.key === 'ArrowDown' ? 1 : -1);
          return;
        }
        if ((!typing || inPanelInput) && (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar')) {
          e.preventDefault();
          filterCommit();
          return;
        }
      }
      if (e.ctrlKey && e.shiftKey && (e.key === 'X' || e.key === 'x')) {
        e.preventDefault();
        escapeAll();
        return;
      }
      // 选中之后 ↑↓ 上下走、Shift+↑↓ 连成一段（Excel 就这么选一片）。
      // 浮层开着时让给浮层：筛选面板的 ↑↓ 是选条件、排序/菜单面板各有各的
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && SEL.length &&
          !filtEl && !sortEl && !menuEl && !viewer) {
        if (moveSel(e.key === 'ArrowDown' ? 1 : -1, e.shiftKey)) { e.preventDefault(); return; }
      }
      // Excel 的跳转键：Ctrl+Home 回 A1、Ctrl+End 跳到最后有内容的地方（列表三四十行时最省事）；
      // PageDown/PageUp 一屏一屏走，和 ↑↓ 一样只在"没开浮层、没在输入框里打字"时接管。
      // Ctrl+Home/End 不需要先选中（Excel 里总有个活动单元格）；PageDown 没选中就让浏览器自己滚。
      if (!typing && !filtEl && !sortEl && !menuEl && !viewer) {
        if (e.ctrlKey && !e.altKey && (e.key === 'Home' || e.key === 'End')) {
          var jAll = navRows();
          var jTo = e.key === 'Home' ? 0 : jAll.length - 1;
          if (jAll.length && e.shiftKey && SEL.length) {
            // Excel：Ctrl+Shift+End = 从锚点一直选到最后一个有内容的格子（锚点那头不动）
            var jA = jAll.indexOf(SELROW || SEL[0]);
            if (jA < 0) jA = jAll.indexOf(SEL[SEL.length - 1]);
            if (jA >= 0) {
              selectRows(jAll[jA], jAll[jTo]);
              try { jAll[jTo].scrollIntoView({ block: e.key === 'Home' ? 'start' : 'end' }); } catch (eS) {}
              e.preventDefault();
              return;
            }
          } else if (jAll.length &&
                     navTo(jAll, jTo, e.key === 'Home' ? 'start' : 'end')) {
            e.preventDefault();
            return;
          }
        }
        if (!e.ctrlKey && !e.altKey && (e.key === 'PageDown' || e.key === 'PageUp') && SEL.length) {
          var pAll = navRows();
          var at = pAll.indexOf(SELROW || SEL[0]);
          if (at < 0) at = pAll.indexOf(SEL[SEL.length - 1]);
          if (pAll.length && at >= 0) {
            var stepP = screenStep(pAll) * (e.key === 'PageDown' ? 1 : -1);
            navTo(pAll, at + stepP, e.key === 'PageDown' ? 'end' : 'start');
            e.preventDefault();
            return;
          }
        }
      }
      // 看图时 ←/→ 翻同一组图（循环），只有一张就什么都不做
      if (viewer && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        if (viewerGo(e.key === 'ArrowRight' ? 1 : -1)) e.preventDefault();
        return;
      }
      // Esc 什么都不做（v0.96 去掉了）：浮层点外面或右上角 ✕ 关，回表格点屏幕正中那个按钮，
      // 取消选中点状态栏的「✕ 取消选择」。键盘上还留着 Ctrl+Shift+X 一键收起。
      // v1.2：Ctrl+Shift+E 不接键了（用户要求把快捷键撤掉，功能还在设置菜单里）
      if (e.altKey && e.shiftKey && (e.key === 'R' || e.key === 'r')) {
        e.preventDefault();
        applyTableMode();
        return;
      }
      // v1.2：Alt+Shift+E / Alt+Shift+A 撤了（开关还在设置面板里）
      if (e.altKey && e.shiftKey && (e.key === 'T' || e.key === 't')) {
        e.preventDefault();
        var off = false;
        try { off = sessionStorage.getItem('fz-off') === '1'; } catch (err) {}
        try {
          if (off) sessionStorage.removeItem('fz-off');
          else sessionStorage.setItem('fz-off', '1');
        } catch (err) {}
        console.info('[fishy] ' + (off ? '已恢复，刷新中…' : '已关闭（本标签页），刷新中…'));
        location.reload();
        return;
      }
      // Alt+↑ / Alt+↓：顺着表读上一篇 / 下一篇（只在笔记页且有队列时接管）
      if (e.altKey && !e.shiftKey && !e.ctrlKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        var nav2 = queueNav();
        if (!nav2 || !document.querySelector('.fz-notesheet')) return;
        var dir = e.key === 'ArrowUp' ? 'prev' : 'next';
        if (!nav2[dir]) { e.preventDefault(); toast(dir === 'prev' ? '已经是第一篇' : '已经是最后一篇'); return; }
        e.preventDefault();
        gotoQueue(dir);
        return;
      }
    });

    // v1.2：右键不再接管（自定义菜单用户用不上），右键完全还给浏览器

    addEventListener('click', function (e) {
      // 这一次点击已经在 pointerdown 兜底里办过了（表头被别的浮层盖住时）：
      // 整条 click 一律不处理，否则"点别处关面板"会当场把刚开的面板关掉
      if (Date.now() < hdrGraceUntil) {
        try { e.stopPropagation(); } catch (eG) {}
        return;
      }
      // 刚拖完列宽：这一下 click 是拖动的余波，别拿它去开筛选面板
      if (colDragMoved || colEdgeDown) {
        colDragMoved = false;
        colEdgeDown = false;
        try { e.preventDefault(); } catch (eD) {}
        try { e.stopPropagation(); } catch (eD2) {}
        return;
      }
      // 右键菜单里点了一项
      var cx = e.target.closest && e.target.closest('[data-fz-ctx]');
      if (cx) {
        e.preventDefault();
        e.stopPropagation();
        var kind = cx.dataset.fzCtx;
        var arg = cx.dataset.fzArg || '';
        var rowRef = ctxRow;
        if (kind === 'copy') copySel();
        else if (kind === 'cell') {
          if (!arg) toast('这一格是空的，没什么可复制');
          else if (copyText(arg)) {
            toast('已复制这一格：「' + (arg.length > 16 ? arg.slice(0, 16) + '…' : arg) + '」');
          }
        } else if (kind === 'filter') {
          openFilter(arg, cx);                 // 先开面板再关菜单：面板要贴着菜单的位置放
        } else if (kind === 'csv') exportCsv();
        else if (kind === 'open') {
          if (rowRef && rowRef.__fz && rowRef.__fz.token) openNoteById(rowRef.__fz);
          else toast('这一行没有能打开的笔记');
        } else if (kind === 'clear') { clearFilter(); closeFilter(); }
        closeCtx();
        return;
      }
      // 用户名（v0.98）：点开这个人的主页，新标签页
      var ub = e.target.closest && e.target.closest('[data-fz-user]');
      if (ub) {
        e.preventDefault();
        e.stopPropagation();
        if (!openUser(ub.getAttribute('data-fz-user'))) toast('这条没有用户 id，打不开主页');
        return;
      }
      // 点行号 = 选中整行（Excel 的行号）；Shift+点 = 从上次那行连到这里
      var nc = e.target.closest && e.target.closest('.fz-num');
      var nrow = nc && nc.closest('.fz-row, .fz-nrow');
      if (nrow) {
        e.preventDefault();
        e.stopPropagation();     // 选中就是选中，别把这一下再传给标题那类入口
        if (e.shiftKey && SELROW) selectRows(SELROW, nrow);
        else selectRows(nrow);
        return;
      }
      var mb = e.target.closest && e.target.closest('[data-fz-menu]');
      if (mb) {
        e.preventDefault();
        e.stopPropagation();
        toggleMenu(mb);
        return;
      }
      // 笔记页的「上一篇 / 下一篇」：顺着表往下读
      var qb = e.target.closest && e.target.closest('[data-fz-qnav]');
      if (qb) {
        e.preventDefault();
        e.stopPropagation();
        if (!gotoQueue(qb.dataset.fzQnav)) toast('这一篇不在刚才那张表的顺序里');
        return;
      }
      // 表头 ▾：点一下出筛选条件（Excel 的自动筛选）
      var fb = e.target.closest && e.target.closest('[data-fz-filter]');
      if (!fb && Date.now() >= hdrGraceUntil) {
        // 正常点击没打到表头（多半被别的浮层挡了一层）→ 按坐标再认一次。
        // 宽限期里说明 pointerdown 兜底已经办过这一次了，别再 toggle 一遍（会刚开就关）
        var hitH = headerHitAt(e.clientX, e.clientY);
        if (hitH && hitH.getAttribute('data-fz-filter')) fb = hitH;
      }
      if (fb) {
        e.preventDefault();
        e.stopPropagation();
        var fk = fb.dataset.fzFilter;
        if (filtEl && filtEl.isConnected && filtKey === fk) closeFilter();
        else openFilter(fk, fb);
        return;
      }
      // 表头（没有 ▾ 的那几列）：点一下排序，再点反向，第三次回原序
      var sb = e.target.closest && e.target.closest('[data-fz-sort]');
      if (!sb && Date.now() >= hdrGraceUntil) {
        var hitS = headerHitAt(e.clientX, e.clientY);
        if (hitS && hitS.hasAttribute('data-fz-sort')) sb = hitS;
      }
      if (sb) {
        e.preventDefault();
        e.stopPropagation();
        cycleSort(sb.dataset.fzSort);
        return;
      }
      // 工具栏「筛选 ▾」下拉里选了一列 → 开这一列的条件面板
      var fk2 = e.target.closest && e.target.closest('[data-fz-fkey]');
      if (fk2) {
        e.preventDefault();
        e.stopPropagation();
        var key2 = fk2.getAttribute('data-fz-fkey');
        var cell2 = document.querySelector('.fz-thead [data-fz-filter="' + key2 + '"]');
        closeMenu();
        openFilter(key2, cell2 || fk2);
        return;
      }
      // 工具栏「筛选」：先出列名（表头点不动时的第二条路）
      var fm = e.target.closest && e.target.closest('[data-fz-fmenu]');
      if (fm) {
        e.preventDefault();
        e.stopPropagation();
        openFilterPicker(fm);
        return;
      }
      // 工具栏 ⇅：排序面板（赞 的排序从这里进）
      var km = e.target.closest && e.target.closest('[data-fz-sortmenu]');
      if (km) {
        e.preventDefault();
        e.stopPropagation();
        toggleSortMenu(km);
        return;
      }
      var sv = e.target.closest && e.target.closest('[data-fz-sval]');
      if (sv) {
        e.preventDefault();
        e.stopPropagation();
        setSort(sv.dataset.fzSval, parseInt(sv.dataset.fzSdir, 10));
        closeSort();                  // 选完就收，别挡着表
        return;
      }
      var fv = e.target.closest && e.target.closest('[data-fz-fval]');
      if (fv) {
        e.preventDefault();
        e.stopPropagation();
        setFilter(filtKey, fv.dataset.fzFval);   // 选完不关面板，能连着看条数
        return;
      }
      var sa = e.target.closest && e.target.closest('[data-fz-sortask]');
      if (sa) {
        e.preventDefault();
        e.stopPropagation();
        applyPanelSort(sa.dataset.fzSortask);
        return;
      }
      var z = e.target.closest && e.target.closest('[data-fz-zoom]');
      if (z) {
        e.preventDefault();
        e.stopPropagation();
        var zv = parseInt(z.dataset.fzZoom, 10) || 0;
        zoomApply(zv === 0 ? 100 : ZOOM + zv * ZOOM_STEP);
        return;
      }
      if (e.target.closest && e.target.closest('[data-fz-clearsort]')) {
        e.preventDefault();
        e.stopPropagation();
        clearSort();
        closeSort();
        return;
      }
      if (e.target.closest && e.target.closest('[data-fz-clearsel]')) {
        e.preventDefault();
        e.stopPropagation();
        clearSel();
        return;
      }
      if (e.target.closest && e.target.closest('[data-fz-clearfilter]')) {
        e.preventDefault();
        e.stopPropagation();
        clearFilter();
        closeFilter();
        return;
      }
      // 空表提示上的那个入口：游客态去登录，已登录就再要一次
      var nd = e.target.closest && e.target.closest('[data-fz-nodata]');
      if (nd) {
        e.preventDefault();
        e.stopPropagation();
        if (nd.dataset.fzNodata === 'login') doLogin();
        else retryFetch();
        return;
      }
      var mi = e.target.closest && e.target.closest('[data-fz-set]');
      if (mi) {
        e.preventDefault();
        e.stopPropagation();
        setCfg(mi.dataset.fzSet);        // 点完不关菜单，方便连着调
        return;
      }
      if (Date.now() >= hdrGraceUntil &&
          !(e.target.closest && e.target.closest('[data-fz-menu-panel]'))) {
        closeMenu(); closeFilter(); closeSort(); closeCtx();
      }
      if (e.target.closest && e.target.closest('[data-fz-export]')) {
        e.preventDefault();
        e.stopPropagation();
        exportCsv();
        return;
      }
      var t = e.target.closest && e.target.closest('[data-fz-auth]');
      if (!t) return;
      e.preventDefault();
      e.stopPropagation();
      if (t.dataset.fzAuth === 'out') doLogout();
      else doLogin();
    }, true);

    // 详情表滚到底不再自动拉评论（v0.77）：
    // 表格是拿来"读"的，滚到底只说明读到这里了，不等于"再给我来一批"。
    // 加载下一批只认表尾那个「加载更多评论」按钮。

    addEventListener('blur', closeViewer);
    addEventListener('mousemove', thumb(resetIdle, 400), { passive: true });
    addEventListener('wheel', function (e) {
      if (e.deltaY < -16 && viewer) closeViewer();
    }, { passive: true });
    addEventListener('click', function (e) {
      if (viewer && !e.target.closest('.fz-viewer') && !e.target.closest('.fz-link')) closeViewer();
      if (e.target.closest && e.target.closest('.fz-ns-back')) { backToList(); return; }
      if (e.target.closest && e.target.closest('.fz-ns-x')) closeNoteSheet();
    }, true);
  }

  // ---------- 启动 ----------
  function boot() {
    if (!document.body) return setTimeout(boot, 60);
    if (DEMO) document.documentElement.classList.add('fz-demo');
    // 只读探针：自测与排障用，不影响页面
    try {
      window.__fzProbe = {
        readStateNote: readStateNote,
        normImgs: normImgs,
        noteParts: noteParts,
        readInitialState: readInitialState,
        apiNote: apiNote,
        readNotePage: readNotePage,
        readComments: readComments,
        readCommentsDom: readCommentsDom,
        stateComments: stateComments,
        noteRoot: noteRoot,
        pickTime: pickTime,
        pickNum: pickNum,
        badText: badText,
        apiNotes: apiNotes,
        noteCount: function () { return noteMap.size; },
        expandOnSite: expandOnSite,
        expandAllOnSite: expandAllOnSite,
        absorbComments: absorbComments,
        pooledSubs: pooledSubs,
        cmtRowsHtml: cmtRowsHtml,
        cellsHtml: cellsHtml,
        stateFeedItems: stateFeedItems,
        collectCards: collectCards,
        loadMore: loadMore,
        reloadBatch: reloadBatch,
        setReloadHook: function (fn) { reloadHook = fn || null; },
        moreBtnText: function () {
          var b = document.getElementById('fz-more-btn');
          return b ? b.textContent : '';
        },
        yieldToSite: yieldToSite,
        resumeFromSite: resumeFromSite,
        pullMore: pullMore,
        countAnchors: countAnchors,
        csv: buildCsv,
        csvOf: csvOf,
        exportCsv: exportCsv,
        noteIdTime: noteIdTime,
        shortTime: shortTime,
        idOf: idOf,
        timeTextOf: timeTextOf,
        cfg: function () {
          // 设置面板里的开关也要能读到（自测要断言"存进去了没有"）
          return { tableMode: CFG.tableMode, detailSheet: CFG.detailSheet,
            docTitle: CFG.docTitle, login: CFG.login,
            foldText: CFG.foldText, imgLink: CFG.imgLink, tips: CFG.tips,
            busy: CFG.busy, hush: CFG.hush,
            hideAvatar: CFG.hideAvatar, hideEmoji: CFG.hideEmoji,
            linkPlainTitle: CFG.linkPlainTitle, linkPlainImg: CFG.linkPlainImg,
            opMark: CFG.opMark, floorTint: CFG.floorTint,
            showFloor: CFG.showFloor, userTable: CFG.userTable };
        },
        setCfg: setCfg,
        // 直接改一个开关（控制台/自测用）：写 CFG、写存储，需要重画的当场重画
        setCfgVal: function (k, v) {
          if (!(k in CFG)) return false;
          CFG[k] = v;
          try { store.set(k, v); } catch (e) {}
          applyView();     // 头像 / 纯文字链接 / 详情页三个开关都靠 html 上的类，改完立刻同步
          if (k === 'hideEmoji' || k === 'foldText' || k === 'imgLink' || k === 'tips' ||
              k === 'linkPlainTitle' || k === 'linkPlainImg' || k === 'hideAvatar' || k === 'floorTint' ||
              k === 'showFloor' || k === 'opMark') rerenderAfterCfg();
          return true;
        },
        menuHtml: menuHtml,
        openMenu: openMenu,
        closeMenu: closeMenu,
        menuOpen: function () { return !!menuEl; },
        isOurs: isOurs,
        hideEl: hideEl,
        cmtCounts: cmtCounts,
        cmtCountsOf: cmtCountsOf,
        hushVideos: hushVideos,
        rebuildCells: rebuildCells,
        rerenderAfterCfg: rerenderAfterCfg,
        openSettings: openSettings,
        closeSettings: closeSettings,
        saveSettings: saveSettings,
        dimSite: dimSite,
        frameEl: frameEl,
        clearHighlight: clearHighlight,
        actOn: actOn,
      whenFloor: whenFloor,
      timeTextMs: timeTextMs,
      noteIdMs: noteIdMs,
      saveQueue: saveQueue,
      readQueue: readQueue,
      queueNav: queueNav,
      queueHref: queueHref,
        likeNum: likeNum,
        filterState: function () { return { type: FILT.type, minLike: FILT.minLike, author: FILT.author, when: FILT.when }; },
        applyFilter: applyFilter,
        selIdx: probeSelIdx,
        colWidths: function () { return { list: W_LIST.slice(), detail: W_DETAIL.slice() }; },
        setColWidth: function (view, i, w) {
          var v = view === 'detail' ? 'detail' : 'list';
          var ws = colWs(v);
          if (!(i >= 0 && i < ws.length)) return false;
          if (ws[i] === null) {                 // 弹性列：设的是它的下限
            setColVar(v, i, Math.max(1, w | 0));
            return true;
          }
          ws[i] = Math.max(1, w | 0);
          setColVar(v, i, ws[i]);
          return true;
        },
        colFloors: function () { return { list: flexMin.list, detail: flexMin.detail, def: { list: FLEX_MIN.list, detail: FLEX_MIN.detail } }; },
        clampCols: clampCols,
        rerenderCmts: function () { return probeRerenderCmts ? probeRerenderCmts() : false; },
        setFilter: setFilter,
        clearFilter: clearFilter,
        openFilter: openFilter,
        closeFilter: closeFilter,
        filterOpen: function () { return !!filtEl; },
        filterKey: function () { return filtKey; },
      // 自测用：卡片上的快捷键清单（H1 逐条按一遍；H2 检查新功能有没有名字）
      shortcuts: function () { return SHORTCUTS.map(function (s) { return { k: s[0], t: s[1] }; }); },
      filterQuery: function () { return filtQuery; },
      filterSummary: filterSummary,
      // Tab 序列审计：假工具条上停得下来的每一站，都必须"点得动"
      // 列宽 vs 实际内容：自测要能确认"确实被截住了"，不然 tooltip 断言是空转
      cellWidth: function () {
        var c = document.querySelector('.fz-row .fz-e');
        if (!c) return null;
        var t = c.querySelector('b') || c;
        return { cell: c.clientWidth, inner: t.clientWidth, scroll: t.scrollWidth,
                 text: (t.textContent || '').length };
      },
      overflowCells: function (max) {
        var out = [];
        var cells = document.querySelectorAll('.fz-c');
        for (var i = 0; i < cells.length && out.length < (max || 20); i++) {
          var c = cells[i];
          if (c.classList.contains('fz-num') || c.classList.contains('fz-x')) continue;   // 这两列本来就不设 title
          var targets = c.querySelectorAll('b,span');   // 和 cellTips 的规则保持一致
          if (targets.length) {
            for (var j = 0; j < targets.length; j++) {
              var el = targets[j];
              if (el.children.length) continue;
              if (el.scrollWidth > el.clientWidth + 1) {
                out.push({ cls: el.className || el.tagName, text: (el.textContent || ''),
                           title: el.getAttribute('title') || '', cut: true });
              }
            }
          } else if (c.scrollWidth > c.clientWidth + 1) {
            out.push({ cls: c.className, text: (c.textContent || ''), title: c.getAttribute('title') || '', cut: true });
          }
        }
        return out;
      },
      tipCount: function () {
        var all = document.querySelectorAll('.fz-c [title],.fz-c[title]');
        return all.length;
      },
      visibleRows: function () { return navRows().length; },
      curtainCheck: curtainCheck,
      installCurtain: installCurtain,
      curtainInstall: function () { return curtainInfo; },
      curtain: function () {
        var paints = [];
        try {
          paints = performance.getEntriesByType('paint').map(function (p) {
            return { name: p.name, at: Math.round(p.startTime) };
          });
        } catch (eP) {}
        return {
          on: document.documentElement.classList.contains('fz-boot'),
          sinceBoot: Date.now() - bootAt,
          log: curtainLog,
          paints: paints,
          timeOrigin: Math.round(performance.timeOrigin || 0)
        };
      },
      bootAtMs: function () { return bootAt; },
      selectAll: function () { return selectAllVisible(); },
      selInfo: function () {
        var vis = navRows();
        return {
          sel: SEL.length,
          visible: vis.length,
          all: allRows().length,
          // 锚点用行号格里的数字（=用户看到的行号）。别用 data-fz-row：那玩意儿在行上是空串，
          // 自测里会变成 "?"，于是「锚点没动」的断言两边都是 "?"，白绿一条（SA5 红检发现的）
          anchor: SELROW ? (String((SELROW.querySelector('.fz-num') || {}).textContent || '').trim() || '?') : '',
          selIdx: SEL.length ? vis.indexOf(SEL[0]) : -1,
          selEnd: SEL.length ? vis.indexOf(SEL[SEL.length - 1]) : -1
        };
      },
      ctxMenu: function () {
        var el = document.querySelector('.fz-ctx');
        if (!el) return { shown: false };
        var r = el.getBoundingClientRect();
        return {
          shown: true,
          items: [].map.call(el.querySelectorAll('[data-fz-ctx]'), function (x) { return x.dataset.fzCtx; }),
          titles: [].map.call(el.querySelectorAll('[data-fz-ctx]'), function (x) {
            var mt = x.querySelector('.fz-mt'); return mt ? mt.textContent : '';
          }),
          txt: el.getAttribute('data-fz-txt') || '',
          at: { left: Math.round(r.left), top: Math.round(r.top),
                right: Math.round(r.right), bottom: Math.round(r.bottom),
                vw: innerWidth, vh: innerHeight }
        };
      },
      filterOpenKey: function () { return filtEl ? filtKey : null; },
      emptyNote: function () {
        var el = document.querySelector('.fz-empty');
        return { shown: !!el, text: el ? (el.textContent || '') : '',
                 loaded: allRows().length, key: el ? (el.dataset.fzQ || '') : '' };
      },
      selIndex: function () {
        var all = navRows();
        var sel = document.querySelector('.fz-selrow');
        return { index: sel ? all.indexOf(sel) : -1, total: all.length,
                 first: all.length ? all[0].dataset.fzRow : null };
      },
      tabStops: function () {
        var out = { total: 0, deco: [], ok: [] };
        var deco = document.querySelectorAll(
          '.fz-tb:not([data-fz-sortmenu]):not([data-fz-export]):not([data-fz-menu]):not([data-fz-fmenu]),' +
          '.fz-addtab,.fz-tab,.fz-pick');
        for (var i = 0; i < deco.length; i++) {
          out.deco.push({ cls: deco[i].className, tab: deco[i].getAttribute('tabindex'),
                          ariaHidden: deco[i].getAttribute('aria-hidden'),
                          where: deco[i].closest('.fz-foot') ? 'foot' :
                                 (deco[i].closest('.fz-head') ? 'head' : 'other') });
        }
        var stops = document.querySelectorAll('.fz-chrome [tabindex="0"]');
        for (var j = 0; j < stops.length; j++) {
          var el = stops[j];
          out.total++;
          var NAME = ['data-fz-sortmenu', 'data-fz-export', 'data-fz-menu', 'data-fz-fmenu', 'data-fz-fkey',
            'data-fz-filter', 'data-fz-sort',
            'data-fz-zoom', 'data-fz-clearfilter', 'data-fz-clearsort', 'data-fz-clearsel', 'fz-pct', 'data-fz-auth', 'fz-search',
            'data-fz-set', 'data-fz-vnav', 'fz-v-x', 'fz-ns-x', 'fz-link'];
          var hit = '';
          for (var k = 0; k < NAME.length && !hit; k++) {
            var sel = NAME[k].indexOf('data-') === 0 ? '[' + NAME[k] + ']' : '.' + NAME[k];
            if (el.matches(sel)) hit = NAME[k];
          }
          var label = (el.textContent || '').trim().slice(0, 6) + '(' + (hit || '?') + ')';
          if (hit) out.ok.push(label); else out.bad = (out.bad || []).concat(label + '|' + el.className);
        }
        out.okCount = out.ok.length;
        return out;
      },
      zoom: function () {
        var cells = document.querySelector('.fz-cells');
        var pct = document.querySelector('.fz-pct');
        return {
          pct: ZOOM,
          label: pct ? pct.textContent : '',
          varVal: (getComputedStyle(document.documentElement).getPropertyValue('--fz-z') || '').trim(),
          stored: store.get('zoom', null),
          fontSize: cells ? getComputedStyle(cells).fontSize : '',
          rowMin: cells ? getComputedStyle(cells).minHeight : '',
          min: ZOOM_MIN, max: ZOOM_MAX, step: ZOOM_STEP
        };
      },
      zoomSet: function (p) { return zoomApply(p); },     // 状态栏那句「为什么只剩这几行」
      clearSel: clearSel,
      selStats: selStats,
      selStatText: function () { var el = document.querySelector('.fz-sel-stat'); return el ? el.textContent : ''; },
      statusText: function () { var st = document.querySelector('.fz-ready'); return st ? st.textContent : ''; },
      statusTip: function () { var st = document.querySelector('.fz-ready'); return st ? (st.getAttribute('title') || '') : ''; },
      clearChips: function () {
        var f = document.querySelector('.fz-foot [data-fz-clearfilter]');
        var s = document.querySelector('.fz-foot [data-fz-clearsort]');
        var vis = function (el) { return !!el && el.style.display !== 'none'; };
        return {
          filter: !!f, filterShown: vis(f), filterLabel: f ? f.textContent : '',
          sort: !!s, sortShown: vis(s), sortLabel: s ? s.textContent : ''
        };
      },
      authorOptions: authorOptions,
      authorCap: function () { return AUTHOR_CAP; },
        filterMove: filterMove,
        filterCommit: filterCommit,
        filterCurValue: filterCurValue,
        emptyHint: function () {
          var e = document.querySelector('.fz-empty');
          return e ? (e.textContent || '').replace(/\s+/g, ' ').trim() : '';
        },
        sortState: sortState,
        setSort: setSort,
        clearSort: clearSort,
        cycleSort: cycleSort,
        sortMenu: openSortMenu,
        closeSort: closeSort,
        sortOpen: function () { return !!sortEl; },
        sortItems: function () {
          return [].slice.call(document.querySelectorAll('[data-fz-sval]')).map(function (el) {
            return el.dataset.fzSval + '/' + el.dataset.fzSdir;
          });
        },
        nodataState: function () {
          var e = document.querySelector('.fz-nodata');
          var a = e ? e.querySelector('[data-fz-nodata]') : null;
          return {
            shown: !!e, why: e ? (e.dataset.fzWhy || '') : '',
            text: e ? (e.textContent || '').replace(/\s+/g, ' ').trim() : '',
            act: a ? a.dataset.fzNodata : '',
            actText: a ? (a.textContent || '').trim() : '',
            first: !!(e && e.parentNode && e.parentNode.firstChild === e),
            tab: a ? a.getAttribute('tabindex') : null,
            ready: (document.querySelector('.fz-ready') || {}).textContent || ''
          };
        },
        emptyReason: emptyReason,
        retryFetch: retryFetch,
        // 自测用：按序号选行（真机点行号时走的是同一条 selectRows）
        selectRows: function (i) {
          var rows = allRows();
          selectRows(typeof i === 'number' ? rows[i] : i);
          return this.selState();
        },
        clearSel: clearSel,
        copySel: copySel,
        firstRunHint: firstRunHint,
        helpFlag: function () { return !!store.get('helpSeen', false); },
        clearHelp: function () { store.set('helpSeen', 0); return true; },
        selState: function () {
          var nb = document.querySelector('.fz-namebox');
          var rf = document.querySelector('.fz-ref');
          var inp = document.querySelector('.fz-input');
          return {
            n: SEL.length, ref: selRef(), ords: SEL.map(rowOrd),
            text: selTsv(), rows: selTsv() ? selTsv().split('\n').length : 0,
            cols: selTsv() ? selTsv().split('\n')[0].split('\t').length : 0,
            painted: document.querySelectorAll('.fz-selrow').length,
            namebox: nb ? (nb.textContent || '').replace(/\s+/g, '') : '',
            refbox: rf ? rf.textContent : '', input: inp ? inp.textContent : '',
            hidden: SEL.filter(function (r) { return r.classList.contains('fz-hide'); }).length
          };
        },
        // 空表提示的每一道闸门都摊开：真机上"没出提示"时不用猜是哪个条件挡的
        nodataGate: function (total) {
          var n = total === undefined
            ? document.querySelectorAll('.fz-row, .fz-nrow').length : total;
          return {
            total: n, tableMode: CFG.tableMode, sheet: !!document.querySelector('.fz-notesheet'),
            filter: filterOn(), yieldMode: yieldMode, pullBusy: pullBusy, moreBusy: moreBusy,
            collected: lastCollectAt, pageAge: Date.now() - pageAt, need: needNoData(n)
          };
        },
        viewerInfo: function () {
          var v = document.querySelector('.fz-viewer');
          if (!v) return { open: false };
          var im = v.querySelector('.fz-v-bd img');
          var pos = v.querySelector('.fz-v-pos');
          var b = v.querySelector('.fz-v-hd b');
          return {
            open: true,
            src: im ? (im.getAttribute('src') || '') : '',
            failed: !!v.querySelector('.fz-v-err'),
            pos: pos ? pos.textContent : '',
            count: pos ? parseInt((pos.textContent || '').split('/')[1], 10) || 0 : 1,
            label: b ? b.textContent : '',
            nav: !!v.querySelector('.fz-v-nav')
          };
        },
        viewerGo: viewerGo,
        imgList: imgList,
        isSiteAsset: isSiteAsset,
        rowHit: rowHit,
      cellText: cellText,
      cellsOf: cellsOf,
      hushVideos: hushVideos,
      unhushVideos: unhushVideos,
      hushedState: function () {
        var all = [].slice.call(document.querySelectorAll('video'));
        var vids = all.filter(function (v) { return !(v.closest && v.closest('.fz-vbox')); });
        return {
          total: all.length,
          outsidePlayer: vids.length,
          playing: vids.filter(function (v) { return !v.paused; }).length,
          loud: vids.filter(function (v) { return !v.paused && !v.muted; }).length,
          hushed: vids.filter(function (v) { return v.dataset.fzHushed === '1'; }).length,
          playerPlaying: all.filter(function (v) {
            return (v.closest && v.closest('.fz-vbox')) && !v.paused;
          }).length
        };
      },
      searchTerms: searchTerms,
      // 自测用：打字 = 设值 + 派一次 input（和用户敲键盘走同一条路）
      setSearch: function (q) {
        var inp = document.querySelector('.fz-search');
        if (!inp) return null;
        inp.value = q == null ? '' : String(q);
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        return { terms: searchTerms(), show: applyFilter().show };
      },
        typeOptions: typeOptions,
        // 自测用：真机上 sync 由 MutationObserver/rAF 自动踢，无头 + virtual-time 下 rAF 不一定跑
        diag: function () { return { stage: DIAG.stage, why: DIAG.why, rows: DIAG.rows, err: DIAG.err, at: DIAG.at }; },
        diagWhy: diagWhy,
        diagSet: diagSet,
        syncNow: function () { sync(); },
        titlePresets: TITLE_PRESETS
      };
    } catch (eP) {}
    diagSet('boot');
    try {
      hookApi();
      injectCSS();
      buildChrome();
      checkDupScripts();
      // 工具栏按钮的兜底：挂在 body 上（chrome 会被重建，body 不会），
      // 只有全局那条捕获处理器没办成事时才会触发，见 bindChromeClicks 的注释
      bindChromeClicks(document.body);
      // 工具栏按钮的兜底：挂在 body 上（chrome 会被重建，body 不会），
      // 只有全局那条捕获处理器没办成事时才会触发，见 bindChromeClicks 的注释
      bindChromeClicks(document.body);
      applyFavicon();
      applyTitle();
      hookHistory();
      watch();
      bindKeys();
      bindHeaderFallback();
      bindColDrag();
      sync();
      // 首屏封面预热（v1.23）：首页卡片的封面图是**懒加载**的，页面刚打开那一瞬 img.src
      // 往往还是空的；而 watch() 的 MutationObserver 只盯 childList、不盯 attributes，
      // 图片 src 后填好的那一刻**不触发 sync**（用户不滚动、DOM 不动就永远不重采）。
      // 结果：首次建行时封面为空 → 永久缓存成「—」，只有翻页/滚动才偶尔重采上。
      // 这里前 12 秒每隔 1.2s 主动补一轮（collectCards 里第 3 段补漏会重画空封面行），
      // 图片一加载出来就能补上；之后停掉，不再空转。
      (function coverWarmup() {
        var n = 0;
        var t = setInterval(function () {
          n++;
          try { collectCards(true); } catch (eCW) {}
          if (n >= 10) clearInterval(t);     // 10 轮 × 1.2s = 12s
        }, 1200);
      })();
    } catch (e) {
      diagSet('error', 'boot-throw', { err: (e && e.message) ? e.message : String(e) });
      console.error('[fishy] 初始化失败（' + diagLine() + '）：', e);
      return;
    }
    if (!document.querySelector('.fz-chrome')) {
      diagSet('error', 'no-chrome');
      console.error('[fishy] 外壳未创建（' + diagLine() + '），请把这条报错发给我');
    } else {
      var n0 = fzRowCount();
      diagSet(n0 > 0 ? 'built' : 'chrome-ok', n0 > 0 ? '' : 'no-rows-yet', { rows: n0 });
    }
    diagWatchdog();
    applyTitle();
    clearInterval(titleTimer);
    titleTimer = setInterval(applyTitle, 900);
    setTimeout(sync, 600);
    setTimeout(sync, 1800);
  }

  boot();
})();
