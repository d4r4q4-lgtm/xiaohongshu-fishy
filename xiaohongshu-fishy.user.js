// ==UserScript==
// @name         小红书 · 表格模式（摸鱼）
// @namespace    https://github.com/d4r4q4-lgtm/xiaohongshu-fishy
// @version      0.13
// @author       haozi
// @description  把小红书伪装成 Excel 在线表格：一帖一行，图片变成「图01」文字链接，点开才看原图
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

  console.info('%c[fishy] v0.13 已注入 · ' + location.host + location.pathname, 'color:#217346;font-weight:600');

  // 版本回执：只发到本机 127.0.0.1，用来确认实际在跑哪一版（排查"改了没生效"）
  (function fzPing() {
    try {
      var u = 'http://127.0.0.1:8125/hit?v=0.13&p=' + encodeURIComponent(location.pathname);
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
  (function curtain() {
    try {
      var st = document.createElement('style');
      st.id = 'fz-curtain';
      st.textContent = 'html.fz-boot,html.fz-boot body{opacity:0 !important;background:#fff !important;}';
      (document.head || document.documentElement).appendChild(st);
      document.documentElement.classList.add('fz-boot');
      setTimeout(function () { document.documentElement.classList.remove('fz-boot'); }, 2000);
    } catch (e) {}
  })();

  try {
    if (sessionStorage.getItem('fz-off') === '1') {
      document.documentElement.classList.remove('fz-boot');
      console.warn('[fishy] 已被「Alt+Shift+T」关闭。控制台执行 sessionStorage.removeItem("fz-off") 后刷新即可恢复。');
      return;
    }
  } catch (e) {}

  // ---------- 可调参数 ----------
  var CFG = {
    tableMode: true,       // 首页信息流重排成表格
    detailSheet: true,     // 笔记详情页也渲染成同一张表
    docTitle: '工作簿1',    // 标题栏文件名
    sheetName: 'Sheet1',
    login: true,          // 标题栏的"已登录"伪装状态（纯装饰）
    minImgSize: 64,
    idleCollapseMs: 9000
  };

  // 外壳高度：标题栏30 + 工具栏26 + 公式栏30 + 列号18
  var HEAD_H = 104;
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

  // ---------- 工具 ----------
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
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
  // 头像/图标一律不算正文图片
  function isAvatarImg(im) {
    var t = ((im.getAttribute('src') || '') + ' ' + (im.getAttribute('data-src') || '')).toLowerCase();
    if (t.indexOf('avatar') > -1 || t.indexOf('sns-avatar') > -1) return true;
    if (im.closest && im.closest('[class*="avatar"],[class*="Avatar"],[class*="head-img"],[class*="headImg"],[class*="portrait"]')) return true;
    return false;
  }

  function isPhoto(img) {
    if (img.dataset.fz) return false;
    if (img.closest('.fz-row,.fz-chrome,.fz-viewer,.fz-notesheet')) return false;
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
    var label = '图' + pad(idx);

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
      openImage(link, real, '图 ' + pad(idx) + (dim ? ' · ' + dim : ''), cleanSrc(real));
    });
    return link;
  }

  function degradeAll() {
    var imgs = Array.prototype.slice.call(document.images);
    for (var i = 0; i < imgs.length; i++) {
      if (isPhoto(imgs[i])) degrade(imgs[i]);
    }
    degradeBg();
  }

  // 有些大图是 background-image，不是 <img>
  var bgIdx = 0;
  function degradeBg() {
    var els = document.querySelectorAll('div,section,li,a,span,figure');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.dataset.fzBg) continue;
      if (el.closest('.fz-row,.fz-chrome,.fz-viewer,.fz-notesheet')) continue;
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
      link.textContent = '图' + pad(++bgIdx);
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
  var viewer = null;

  function openImage(anchor, url, caption, alt) {
    closeViewer();
    var v = document.createElement('div');
    v.className = 'fz-viewer';
    v.innerHTML =
      '<div class="fz-v-hd"><b>' + esc(caption) + '</b><span class="fz-v-x">关闭</span></div>' +
      '<div class="fz-v-bd"><img alt=""></div>';
    var vim = v.querySelector('.fz-v-bd img');
    vim.onerror = function () {
      if (alt && vim.getAttribute('src') !== alt) { vim.src = alt; alt = ''; return; }
      var err = document.createElement('div');
      err.className = 'fz-v-err';
      err.textContent = '图片加载失败（可能已过期）';
      vim.replaceWith(err);
    };
    vim.src = url;
    v.querySelector('.fz-v-x').onclick = closeViewer;
    v.addEventListener('click', function (e) { e.stopPropagation(); });
    document.body.appendChild(v);

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
    var title = pick(card, ['[class*="title"]', 'a[title]', NOTE_A_SEL + ' span'], 50) || txt(link, 50);

    return {
      href: href,
      title: title,
      desc: pick(card, ['[class*="desc"]', '[class*="abstract"]'], 120),
      author: pick(card, ['a[href*="/user/"] span', '[class*="name"]', 'a[href*="/user/"]'], 16),
      uid: uid,
      likes: pick(card, ['[class*="like"] span', '[class*="like"]', '[class*="count"]'], 10),
      time: pick(card, ['[class*="time"]', '[class*="date"]'], 20),
      type: card.querySelector('video') ? '视频' : '图文',
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
        uid: ''
      };
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
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
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
  function stateComments(pid) {
    if (!pid) return null;
    var st = readInitialState();
    if (!st) return null;
    var dm = st.note && (st.note.noteDetailMap || st.note.note_detail_map);
    var entry = dm && (dm[pid] || dm[String(pid)]);
    var cs = entry && (entry.comments || entry.comment);
    var list = cs && (cs.list || cs.comments || []);
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
        urls: pics.map(function (o) { return o.src; }),
        dims: pics.map(function (o) { return (o.w && o.h) ? o.w + '×' + o.h : ''; }),
        uid: ui.userId || ui.user_id || '',
        cid: c.id || ''
      };
      return node;
    }

    for (var i = 0; i < list.length && out.length < 240; i++) {
      var c = list[i];
      if (!c || c.invalid) continue;
      var root = mk(c, 0, null, i);
      var subs0 = c.subComments || c.sub_comments || c.subCommentList || [];
      root.cIdx = root.cIdx === undefined ? i : root.cIdx;
      root.subTotal = c.subCommentCount || c.subComment_count || subs0.length || 0;
      root.subHasMore = !!(c.subCommentHasMore || c.sub_comment_has_more) ||
        (parseInt(root.subTotal, 10) || 0) > subs0.length;
      out.push(root);
      if (root.cid) byId[root.cid] = root;

      var subs = subs0;
      // 接口拦截到的完整回复优先补进来（state 里通常只带第一条）
      try {
        var pool = pooledSubs(c.id);
        if (pool.length) {
          var have = {};
          for (var q0 = 0; q0 < subs.length; q0++) if (subs[q0] && subs[q0].id) have[subs[q0].id] = 1;
          for (var q1 = 0; q1 < pool.length; q1++) {
            var pc = pool[q1];
            if (pc && pc.id && !have[pc.id]) { subs.push(pc); have[pc.id] = 1; }
          }
        }
      } catch (e0) {}
      if (subs.length > (parseInt(root.subTotal, 10) || 0)) root.subTotal = subs.length;
      var lastParent = root;
      for (var j = 0; j < subs.length && out.length < 240; j++) {
        var sc = subs[j];
        if (!sc || sc.invalid) continue;
        // 楼中楼：找到它回复的那条
        var parent = lastParent;
        var tc = sc.targetComment || sc.target_comment;
        if (tc && tc.id && byId[tc.id]) parent = byId[tc.id];
        else if (tc && tc.userInfo) {
          // 没有 id 时按被回复者名字找最近的同作者节点
          for (var q = out.length - 1; q >= 0 && q > out.length - 12; q--) {
            if (out[q].author === (tc.userInfo.nickname || '')) { parent = out[q]; break; }
          }
        }
        var kid = mk(sc, (parent.depth || 0) + 1, parent, i);
        kid.kidx = j;
        if (kid.cid) byId[kid.cid] = kid;
        parent.kids.push(kid);
        out.push(kid);
        lastParent = kid;
      }
    }
    return out;
  }

  // 统一入口：state 为主（有楼中楼），DOM 只用来补 state 里还没出现的
  function readComments(pid) {
    var id = pid || (location.pathname.match(NOTE_PATH) || [])[1] || '';
    var st = null;
    try { st = stateComments(id); } catch (e) { st = null; }
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

    var authorLink = (root && root.querySelector('a[href*="/user/"]')) || document.querySelector('a[href*="/user/"]');
    var uid = '';
    if (authorLink) {
      var um = (authorLink.getAttribute('href') || '').match(/\/user\/(?:profile\/)?([0-9a-zA-Z]+)/);
      if (um) uid = um[1];
    }

    // 主贴图只从媒体区取
    var imgs = [];
    try { imgs = mediaImgs(); } catch (em) { imgs = []; }
    if (!imgs.length) imgs = imgList(scope, 9);

    return {
      href: location.pathname + location.search,
      title: title,
      desc: desc,
      author: author,
      uid: uid,
      likes: likes,
      collects: collects,
      cmtCount: cmtCnt,
      time: time,
      type: (function () {
        // 只看媒体容器里的 video，页面上其他位置（推荐位/悬浮播放器）不算
        var mr = mediaRoots()[0] || root;
        return (mr && mr.querySelector('video')) ? '视频' : '图文';
      })(),
      urls: imgs.map(function (o) { return o.src; }),
      dims: imgs.map(function (o) { return (o.w && o.h) ? o.w + '×' + o.h : ''; }),
      comments: readComments()
    };
  }

  // ---------- 单元格渲染 ----------
  function imgLinks(data) {
    if (!data.urls || !data.urls.length) return '<span class="fz-mdim">—</span>';
    var out = "", shown = Math.min(data.urls.length, 30);
    for (var i = 0; i < shown; i++) {
      out += '<a class="fz-link" data-i="' + i + '">图' + pad(i + 1) + '</a>';
    }
    if (data.urls.length > shown) out += '<span class="fz-mdim">+' + (data.urls.length - shown) + '</span>';
    return out;
  }

  function cellsHtml(data, idx, kind, kidCount) {
    var isCmt = kind === 'comment';
    var sub = [];   // 类型列已经写了"回复"，作者列不再重复

    var replyTo = (data.depth && data.parentAuthor && !/^回复\s*@/.test(data.desc || ''))
      ? ('回复 @' + data.parentAuthor + '：') : '';
    var body = isCmt
      ? '<span class="fz-es">' + (data.depth ? '<i class="fz-reply">↳</i> ' : '') +
        (replyTo ? '<b class="fz-at">' + esc(replyTo) + '</b>' : '') + esc(data.desc || '') + '</span>' +
        ((data.urls && data.urls.length) ? '<span class="fz-el">' + imgLinks(data) + '</span>' : '') +
        (((parseInt(kidCount, 10) || 0) >= 2)
          ? '<span class="fz-el"><a class="fz-link fz-toggle" data-k="' + (data.rootKey || 0) +
            '" data-idx="' + (data.cIdx || 0) + '" data-more="' + (data.subHasMore ? '1' : '0') +
            '" data-total="' + kidCount +
            '" data-open="展开 ' + kidCount + ' 条回复" data-close="收起回复">展开 ' + kidCount + ' 条回复</a></span>'
          : '')
      : (data.title ? '<span class="fz-et">' + esc(data.title) + '</span>' : '') +
        (data.desc
          ? '<span class="fz-es">' + esc(data.desc.length > 300 ? data.desc.slice(0, 300) + '…' : data.desc) + '</span>' +
            (data.desc.length > 300
              ? '<span class="fz-el"><a class="fz-link fz-full" data-full="' + esc(data.desc) + '">展开全文（' +
                data.desc.length + ' 字）</a></span>'
              : '')
          : '') +
        '<span class="fz-el">' + imgLinks(data) + '</span>';

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

    return '' +
      '<div class="fz-c fz-num">' + idx + '</div>' +
      '<div class="fz-c fz-a">' +
        '<b>' + esc(data.author || '未知作者') + '</b>' +
        '<span>' + esc(sub[0] || '') + '</span>' +
        '<span>' + esc(sub[1] || '') + '</span>' +
      '</div>' +
      '<div class="fz-c fz-d">' + esc(isCmt ? (data.depth ? '回复' : '') : (data.type || '笔记')) + '</div>' +
      '<div class="fz-c fz-e">' + body + '</div>' +
      '<div class="fz-c fz-o">' + esc(/^\d/.test(String(data.likes || '')) ? data.likes : '') + '</div>' +
      '<div class="fz-c fz-p">' + esc(data.time || '') + '</div>' +
      '<div class="fz-c fz-x">' + acts + '</div>';
  }

  function bindLinks(scope, data) {
    scope.addEventListener('click', function (e) {
      var a = e.target.closest ? e.target.closest('.fz-link') : null;
      if (!a || a.dataset.i === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      var i = parseInt(a.dataset.i, 10) || 0;
      openImage(a, data.urls[i], '图 ' + pad(i + 1) + (data.dims[i] ? ' · ' + data.dims[i] : ''), cleanSrc(data.urls[i]));
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

  function absorbNote(o, depth) {
    if (!o || typeof o !== 'object' || depth > 9) return;
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

  function absorbComments(j, depth) {
    if (!j || typeof j !== 'object' || depth > 6) return;
    if (Object.prototype.toString.call(j) === '[object Array]') {
      for (var i = 0; i < j.length && i < 120; i++) absorbComments(j[i], depth + 1);
      return;
    }
    var u = j.user_info || j.userInfo;
    if (j.id && typeof j.content === 'string' && u && (u.nickname || u.nick_name || u.nickName)) {
      cmtPool[j.id] = j;
      var subs = j.sub_comments || j.subComments || j.sub_comment_list || [];
      for (var k = 0; k < subs.length && k < 60; k++) {
        if (subs[k] && subs[k].id) cmtPool[subs[k].id] = subs[k];
      }
    }
    for (var kk in j) {
      if (Object.prototype.hasOwnProperty.call(j, kk)) {
        var v = j[kk];
        if (v && typeof v === 'object') absorbComments(v, depth + 1);
      }
    }
  }

  // 池子里属于某条一级评论的子回复
  function pooledSubs(rootId) {
    var out = [], cid;
    for (cid in cmtPool) {
      var o = cmtPool[cid];
      if (!o || o.id === rootId) continue;
      var tc = o.target_comment || o.targetComment;
      var rid = (tc && (tc.id || tc.comment_id)) || o.root_comment_id || o.rootCommentId ||
        o.parent_comment_id || o.parentCommentId || '';
      if (rid && String(rid) === String(rootId)) out.push(o);
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
                res.clone().json().then(function (j) {
                  absorbNote(j, 0);
                  if (/comment|note/i.test(url)) absorbComments(j, 0);
                }).catch(function () {});
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
                if (t.length > 40 && t.charAt(0) === '{') {
                  var jx = JSON.parse(t);
                  absorbNote(jx, 0);
                  var xu = String(x.responseURL || '');
                  if (/comment|note/i.test(xu)) absorbComments(jx, 0);
                }
              } else if (x.responseType === 'json' && x.response) {
                absorbNote(x.response, 0);
                if (/comment|note/i.test(String(x.responseURL || ''))) absorbComments(x.response, 0);
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
    if (tokenMap) return tokenMap;
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
    location.href = noteHref(id, tk);
    return true;
  }

  function buildRow(card, data, idx) {
    card.classList.add('fz-row');
    card.dataset.fzRow = '1';

    var cells = document.createElement('div');
    cells.className = 'fz-cells';
    cells.innerHTML = cellsHtml(data, idx);
    card.appendChild(cells);

    bindLinks(cells, data);

    // 自己补上 xsec_token 再跳转；拿不到 token 就不跳（避免落到 404 风控页）
    card.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('.fz-link')) return;
      if (DEMO) {
        e.preventDefault();
        if (typeof window.__fishyDemoOpen === 'function') window.__fishyDemoOpen(data);
        return;
      }
      openNote(card, data, e);
    });
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

  // 把站点容器挪到屏幕外，但保留它的布局与滚动能力（无限加载还要用）
  function markSource() {
    var g = findCardGroups();
    if (!g) return null;
    var src = g.parent;
    src.classList.add('fz-rows', 'fz-src');
    // 挪到 body 下：它自己 fixed 不占空间，但祖先（main-container 等）可以整块隐藏，
    // 不会因为"隐藏祖先"把它一起干掉，也不会在顶部留残渣
    if (src.parentNode !== document.body) {
      try { document.body.appendChild(src); } catch (e) {}
    }
    document.documentElement.classList.add('fz-table');
    return src;
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

  function appendBoardRow(d, idx) {
    ensureBoard();
    var row = document.createElement('div');
    row.className = 'fz-row fz-brow';
    row.dataset.fzId = d.id;
    row.innerHTML = '<div class="fz-cells">' + cellsHtml(d, idx) + '</div>';
    bindLinks(row.firstChild, d);
    row.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('.fz-link')) return;
      openNoteById(d);
    });
    board.appendChild(row);
    return row;
  }

  function openNoteById(d) {
    if (DEMO && typeof window.__fishyDemoOpen === 'function') { window.__fishyDemoOpen(d); return; }
    if (!d.token) { toast('这篇笔记暂时打不开（链接缺 token）'); return; }
    try {
      sessionStorage.setItem('fz-note', JSON.stringify({
        id: d.id, title: d.title, author: d.author, likes: d.likes,
        uid: d.uid, urls: d.urls, dims: d.dims, type: d.type
      }));
    } catch (e) {}
    location.href = noteHref(d.id, d.token);
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

  function collectCards() {
    ensureBoard();
    var anchors = document.querySelectorAll(NOTE_A_SEL);
    var added = 0;
    for (var i = 0; i < anchors.length && added < 80; i++) {
      var a = anchors[i];
      var href = a.getAttribute('href') || '';
      var m = href.match(NOTE_PATH);
      if (!m) continue;
      var id = m[1];
      if (noteMap.has(id)) continue;
      var card = cardOf(a);
      var d;
      try { d = readCard(card); } catch (e) { d = null; }
      if (!d) continue;
      // 占位/广告卡片：没标题、没图、没作者，留着只是一行"—"
      if (!d.title && !(d.urls && d.urls.length) && (!d.author || d.author === '未知作者')) continue;
      d.id = id;
      d.href = href;
      try { d.token = tokenFor(card, id); } catch (e) { d.token = ''; }
      noteMap.set(id, d);
      appendBoardRow(d, noteMap.size);
      added++;
    }
    return added;
  }

  // 空白行铺在自有看板末尾
  function fillBoard() {
    var b = ensureBoard();
    var f = b.querySelector('.fz-nfill');
    if (!f) {
      f = document.createElement('div');
      f.className = 'fz-nfill';
      b.appendChild(f);
    }
    if (b.lastElementChild !== f) b.appendChild(f);
    var need = Math.max(34, Math.ceil((innerHeight - b.getBoundingClientRect().bottom) / 26) + 2);
    if (f.children.length >= need) return;
    var html = '';
    for (var i = f.children.length; i < need; i++) {
      html += '<div class="fz-frow"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>';
    }
    f.insertAdjacentHTML('beforeend', html);
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

  // 站点的无限加载挂在它自己的滚动容器上，这里主动向所有可滚动元素派发滚动
  var lastPull = 0;
  function pullMore() {
    if (Date.now() - lastPull < 2500) return;
    lastPull = Date.now();
    var src = document.querySelector('.fz-src');
    if (src) {
      try { src.scrollTop = src.scrollHeight; } catch (e) {}
      try { src.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (e) {}
    }
    var targets = [window, document, document.scrollingElement, document.documentElement, document.body];
    // 只挑"可能是滚动容器"的元素，别全页遍历（否则滚动会卡死）
    var cands = document.querySelectorAll('[class*="container"],[class*="scroll"],[class*="feed"],main');
    for (var i = 0; i < cands.length && i < 120; i++) {
      var e = cands[i];
      if (e.scrollHeight > e.clientHeight + 40) targets.push(e);
    }
    for (var k = 0; k < targets.length; k++) {
      var t = targets[k];
      if (!t) continue;
      try { t.scrollTop = t.scrollHeight; } catch (err) {}
      try { t.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (err) {}
    }
  }

  function ensureMoreRow() {
    var rows = ensureBoard();
    if (!rows) return;
    var el = document.getElementById('fz-more');
    if (!el) {
      el = document.createElement('div');
      el.id = 'fz-more';
      el.className = 'fz-morerow';
      el.innerHTML = '<a class="fz-link" id="fz-more-btn">加载更多</a><span class="fz-mdim" id="fz-more-state"></span>';
      el.querySelector('#fz-more-btn').addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var state = document.getElementById('fz-more-state');
        var before = document.querySelectorAll('.fz-row').length;
        if (state) state.textContent = '加载中…';
        pullMore();
        setTimeout(function () {
          collectCards();
          fillBoard();
          var after = document.querySelectorAll('.fz-row').length;
          if (state) state.textContent = after > before ? '' : '没有更多了';
        }, 1600);
      });
    }
    var lastFill = rows.querySelector('.fz-nfill');
    if (lastFill) rows.insertBefore(el, lastFill);
    else if (rows.lastElementChild !== el) rows.appendChild(el);
  }

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
    var need = Math.max(34, Math.ceil((innerHeight - rows.getBoundingClientRect().bottom) / 26) + 2);
    if (filler.children.length >= need) return;

    var html = '';
    for (var i = filler.children.length; i < need; i++) {
      html += '<div class="fz-frow"><i>' + (base + i + 1) + '</i><i></i><i></i><i></i><i></i><i></i></div>';
    }
    filler.insertAdjacentHTML('beforeend', html);
  }

  // ---------- 详情页：铺一层同样的表格 ----------
  var noteSheet = null;
  var cmtKeys = {};
  var cmtRoots = [];
  var closedPid = '';
  var noteSheetData = null;

  // 评论行 HTML：base 是主贴行号（主贴占 1，评论从 2 开始）
  function cmtRowsHtml(list, base) {
    var n = base || 1, out = '';
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      n++;
      var attrs = c.depth
        ? ' data-parent="' + (c.rootKey || 0) + '"'
        : ' data-root="' + (c.rootKey || 0) + '"';
      out += '<div class="fz-nrow' + (c.depth ? ' fz-lv' + Math.min(c.depth, 3) : '') + '"' + attrs +
        '><div class="fz-cells">' + cellsHtml(c, n, 'comment',
          c.depth ? 0 : (c.subTotal || (c.kids || []).length)) +
        '</div></div>';
    }
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

  function openNoteSheet(data) {
    removeSheet();
    var el = document.createElement('div');
    el.className = 'fz-notesheet';

    var html = '<div class="fz-ns-bar">' +
      '<span>笔记详情 · ' + esc(data.author || '') + '</span>' +
      '<span id="fz-ns-stat" class="fz-ns-dim"></span>' +
      '<span class="fz-ns-tags">' +
        (data.tags || []).slice(0, 6).map(function (t) { return '#' + esc(t); }).join(' ') +
      '</span>' +
      '<span class="fz-sp"></span>' +
      '</div>' +
      '<div class="fz-nrow fz-main"><div class="fz-cells">' + cellsHtml(data, 1, 'main') + '</div></div>';

    var roots = (data.comments || []).filter(function (c) { return !c.depth; });
    var flat = data.comments || [];
    cmtRoots = roots;
    html += '<div class="fz-cmts">' + cmtRowsHtml(flat, 1) + '</div><div class="fz-nfill"></div>';

    el.innerHTML = html;
    noteSheetData = data;
    document.body.appendChild(el);

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
          // 站点分页加载，一次只给几条 —— 再给一个"继续加载"的入口
          tgs[i].textContent = '再加载几条（已 ' + loaded + '/' + (tgs[i].dataset.total) + '）';
          tgs[i].dataset.mode = 'more';
        } else {
          tgs[i].textContent = tgs[i].dataset.close || '收起回复';
          tgs[i].dataset.mode = 'close';
        }
        tgs[i].dataset.expanded = expanded[key] ? '1' : '0';
      }
    }

    // 重画评论区（保留展开状态）
    function renderCmt(cs) {
      if (!cs || !cs.length) return;
      var cbox = el.querySelector('.fz-cmts');
      if (!cbox) return;
      cbox.innerHTML = cmtRowsHtml(cs, 1);
      var rowEls2 = cbox.querySelectorAll('.fz-nrow');
      for (var q = 0; q < cs.length && q < rowEls2.length; q++) rowEls2[q].__fz = cs[q];
      applyFold();
      updateNsStat(el, data);
      fillSheet(el);
    }
    el.__fzApplyFold = applyFold;
    el.__fzRenderCmt = renderCmt;
    applyFold();

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
      openImage(a, d.urls[i2],
        '图 ' + pad(i2 + 1) + (d.dims && d.dims[i2] ? ' · ' + d.dims[i2] : ''),
        cleanSrc(d.urls[i2]));
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
    if (slot) slot.innerHTML = imgLinks(data);
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

  function updateNsStat(el, data) {
    var span = el.querySelector('#fz-ns-stat');
    if (!span) return;
    var st = data.stats || {};
    var loaded = Math.max(0, el.querySelectorAll('.fz-nrow').length - 1);
    var parts = [];
    if (st.likes !== '' && st.likes !== undefined) parts.push('赞 ' + st.likes);
    if (st.collects !== '' && st.collects !== undefined) parts.push('藏 ' + st.collects);
    var total = (st.comments !== '' && st.comments !== undefined) ? st.comments : '';
    parts.push('评论 ' + (total !== '' ? (loaded + '/' + total) : loaded));
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
  }

  // 用户主动关闭：记住这篇别再自动弹出来
  function closeNoteSheet() {
    removeSheet();
    try {
      var m = location.pathname.match(NOTE_PATH);
      if (m) closedPid = m[1];
    } catch (e) {}
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
  function hideEl(el) {
    if (!el || el.dataset.fzHide === '1') return;
    el.dataset.fzHide = '1';
    el.style.setProperty('display', 'none', 'important');
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
      if (el.classList.contains('fz-chrome') || el.classList.contains('fz-notesheet') || el.classList.contains('fz-viewer')) continue;
      list.push(el);
      if (el.children.length < 30) {
        for (var j = 0; j < el.children.length; j++) list.push(el.children[j]);
      }
    }
    var vw = innerWidth;
    for (var k = 0; k < list.length; k++) {
      var e = list[k];
      if (!e || !e.getBoundingClientRect) continue;
      if (e.closest && e.closest('.fz-chrome')) continue;
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
    var inp = document.querySelector('input[placeholder]:not(.fz-search)');
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
    var as = document.querySelectorAll('a[href*="channel_id"],a[href*="channelId"]');
    for (var i = 0; i < as.length; i++) {
      var t = txt(as[i], 6);
      if (t && t.length <= 4 && links.length < 24) links.push({ t: t, h: as[i].getAttribute('href') });
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
    box.innerHTML = links.map(function (x) {
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
          cl.contains('fz-filler')) continue;
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
      if (el.closest && (el.closest('.fz-chrome') || el.closest('.fz-notesheet') || el.closest('.fz-viewer') || el.closest('.fz-board'))) continue;
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
      if (el.closest && (el.closest('.fz-chrome') || el.closest('.fz-notesheet') || el.closest('.fz-viewer') || el.closest('.fz-board'))) continue;
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
      if (el.classList.contains('fz-chrome') || el.classList.contains('fz-viewer') || el.classList.contains('fz-notesheet')) continue;
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

  function buildChrome() {
    if (document.querySelector('.fz-chrome')) return;

    var head = document.createElement('div');
    head.className = 'fz-chrome fz-head';

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
        '<span class="fz-t1item">消息</span>' +
        '<input class="fz-search" type="text" placeholder="搜索" spellcheck="false">' +
      '</div>' +
      '<div class="fz-t2">' +
        '<span class="fz-namebox">A1' + CARET + '</span>' +
        tabs +
        '<i class="fz-tsep"></i>' +
        '<span class="fz-cats"></span>' +
        '<i class="fz-tsep"></i>' +
        '<span class="fz-tb fz-pick">常规' + CARET + '</span>' +
        '<span class="fz-tb fz-pick">10' + CARET + '</span>' + '<i class="fz-tsep"></i>' +
        tb('B', 'fz-b') + tb('I', 'fz-i') + tb('U', 'fz-u') +
        '<span class="fz-tb">A<i class="fz-swatch"></i>' + CARET + '</span>' +
        '<span class="fz-tb">▨' + CARET + '</span>' + '<i class="fz-tsep"></i>' +
        '<span class="fz-tb">≡' + CARET + '</span>' +
        '<span class="fz-tb">⊞' + CARET + '</span>' +
        '<span class="fz-tb">⇅' + CARET + '</span>' +
        '<span class="fz-tb">⌗</span>' +
        '<i class="fz-tsep"></i>' +
        tb('格式刷', 'fz-weak') +
        '<span class="fz-sp"></span>' +
        tb('⋯', 'fz-weak') +
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
      return '<span class="fz-letter' + (i === 1 ? ' on' : '') + '">' + ch + '</span>';
    }).join('');

    var foot = document.createElement('div');
    foot.className = 'fz-chrome fz-foot';
    foot.innerHTML =
      '<span class="fz-sheet on">' + esc(CFG.sheetName) + '</span>' +
      '<span class="fz-addtab">+</span>' +
      '<span class="fz-sp"></span>' +
      '<span class="fz-zoom">−</span><span class="fz-pct">100%</span><span class="fz-zoom">+</span>';

    document.body.appendChild(head);
    var li = detectLogin();
    if (li !== null) CFG.login = li;
    renderAuth();
    bindSearch();
    document.body.appendChild(letters);
    document.body.appendChild(foot);
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

  function renderAuth() {
    var slot = document.querySelector('.fz-authslot');
    if (!slot) return;
    // 按站点真实登录态决定显示"登录"还是"登出"
    var logged = true;
    try { logged = isLoggedIn(); } catch (e) { logged = !!CFG.login; }
    var want = logged ? 'out' : 'in';
    var cur = slot.querySelector('[data-fz-auth]');
    if (cur && cur.dataset.fzAuth === want) return;    // 没变化就别重绘
    slot.innerHTML = logged
      ? '<span class="fz-user"></span><span class="fz-t1item fz-authbtn" data-fz-auth="out">登出</span>'
      : '<span class="fz-t1item fz-authbtn" data-fz-auth="in">登录</span>';
  }

  // ---------- 标题 / 图标 ----------
  var titleTimer = null;
  function applyTitle() {
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

  // ---------- 样式 ----------
  var COLW = '30px 150px 54px minmax(300px,1fr) 74px 118px 108px';

  var CSS = [
    'html.fz,html.fz body{background:#fff !important;}',
    'html.fz body{padding-top:' + HEAD_H + 'px !important;padding-bottom:' + FOOT_H + 'px !important;font-family:"Microsoft YaHei","PingFang SC",-apple-system,sans-serif !important;color:#222;font-size:12px;}',
    'html.fz ::selection{background:#d7e7ff;}',

    '.fz-chrome{position:fixed;left:0;right:0;z-index:2147483000;background:#fff;box-sizing:border-box;}',
    '.fz-head{top:0;height:86px;}',
    '.fz-letters{top:86px;height:18px;display:grid;grid-auto-rows:18px;grid-template-columns:' + COLW + ';background:#f5f5f5;border-top:1px solid #d0d0d0;border-bottom:1px solid #d0d0d0;overflow:hidden;}',
    '.fz-letter{text-align:center;line-height:17px;font-size:10px;color:#777;border-right:1px solid #e2e2e2;box-sizing:border-box;overflow:hidden;}',
    '.fz-letter.on{background:#e2efda;color:#375623;font-weight:700;box-shadow:inset 0 0 0 1px #70ad47;}',
    '.fz-foot{bottom:0;height:' + FOOT_H + 'px;border-top:1px solid #d0d0d0;display:flex;align-items:center;gap:6px;padding:0 8px;font-size:11px;color:#555;background:#f5f5f5;}',

    '.fz-t1{height:30px;display:flex;align-items:center;gap:8px;padding:0 10px;box-sizing:border-box;border-bottom:1px solid #e2e2e2;}',
    '.fz-app{width:15px;height:15px;border-radius:2px;background:#217346;flex:0 0 15px;position:relative;}',
    '.fz-app::after{content:"";position:absolute;left:3px;top:3px;right:3px;bottom:3px;border:1px solid rgba(255,255,255,.9);}',
    '.fz-file{font-size:12px;font-weight:600;color:#333;}',
    '.fz-star{color:#bbb;font-size:11px;}',
    '.fz-hint{font-size:11px;color:#999;}',
    '.fz-sp{flex:1;}',
    '.fz-user,.fz-t1item{font-size:11px;color:#666;}',
    '.fz-authslot{display:flex;align-items:center;gap:8px;}',
    '.fz-authbtn{cursor:pointer;padding:0 4px;border-radius:2px;}',
    '.fz-authbtn:hover{color:#217346;background:#eff6ef;}',
    '.fz-search{width:168px;height:20px;border:1px solid #dcdcdc;border-radius:2px;background:#fff;font-size:11px;color:#333;padding:0 6px;outline:none;box-sizing:border-box;font-family:inherit;}',
    '.fz-search::placeholder{color:#aaa;}',
    '.fz-search:focus{border-color:#217346;}',
    'html.fz.fz-table .fz-row.fz-hide{display:none !important;}',

    '.fz-t2{height:26px;display:flex;align-items:center;gap:1px;padding:0 8px;box-sizing:border-box;border-bottom:1px solid #e2e2e2;overflow:hidden;}',
    '.fz-namebox{min-width:64px;height:18px;line-height:16px;border:1px solid #d0d0d0;border-radius:2px;font-size:11px;color:#333;padding:0 4px;text-align:center;margin-right:6px;background:#fff;}',
    '.fz-cats{display:inline-flex;align-items:center;gap:0;}',
    '.fz-cat{font-size:11px;color:#555;padding:0 8px;height:20px;line-height:20px;border-radius:2px;text-decoration:none;white-space:nowrap;}',
    '.fz-cat:hover{background:#eaeaea;color:#217346;}',
    '.fz-tab{font-size:11px;color:#555;padding:0 8px;height:26px;line-height:26px;border-right:1px solid #eee;}',
    '.fz-tab.on{color:#217346;font-weight:600;box-shadow:inset 0 -2px 0 #217346;}',
    '.fz-tb{min-width:18px;height:18px;line-height:18px;text-align:center;font-size:11px;color:#444;padding:0 4px;border-radius:2px;white-space:nowrap;}',
    '.fz-tb:hover{background:#eaeaea;}',
    '.fz-b{font-weight:700;}',
    '.fz-i{font-style:italic;font-family:Georgia,serif;}',
    '.fz-u{text-decoration:underline;}',
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

    '.fz-cells{display:grid;position:relative;z-index:2;pointer-events:auto;grid-template-columns:' + COLW + ';align-items:stretch;font-size:12px;color:#222;cursor:cell;min-height:56px;}',
    'html.fz-demo .fz-cells{pointer-events:auto;}',
    '.fz-c{padding:6px 7px;border-right:1px solid #d0d0d0;box-sizing:border-box;overflow:hidden;line-height:1.55;word-break:break-all;}',
    '.fz-num{color:#888;text-align:center;background:#f7f7f7;padding:6px 2px;}',
    '.fz-a b{display:block;font-weight:600;color:#1a1a1a;font-size:12px;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.fz-a span{display:block;font-size:10.5px;color:#888;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.fz-b,.fz-c,.fz-d,.fz-hash{font-size:11px;color:#555;}',
    '.fz-e{display:flex;flex-direction:column;gap:3px;}',
    '.fz-reply{font-style:normal;color:#b8bcc4;margin-right:2px;}',
    '.fz-et{font-weight:600;color:#1a1a1a;}',
    '.fz-es{color:#555;font-size:11.5px;max-height:36px;overflow:hidden;white-space:pre-wrap;}',
    '.fz-at{font-weight:400;color:#0563c1;}',
    '.fz-el{display:flex;flex-wrap:wrap;gap:10px;font-size:11.5px;}',
    '.fz-o,.fz-p{font-size:11px;color:#666;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '@keyframes fzblink{50%{border-color:transparent;}}',
    '.fz-x{display:flex;gap:8px;align-items:center;font-size:11px;color:#888;white-space:nowrap;}',
    '.fz-x .fz-act{font-size:11px;}',
    '.fz-row:hover .fz-c{background:#f4f9ff;}',
    '.fz-row:hover .fz-num{background:#eef4ea;}',

    '.fz-board{display:block !important;width:100% !important;margin:0 !important;padding:0 !important;}',
    // 源列表必须留在视口内：小红书用 IntersectionObserver 观察底部哨兵来加载更多，
    // 放到视口外（left:-20000px）就永远不会触发，表现为"滚到 30 行就不动了"。
    // 特异性必须压过上面的 .fz-rows{position:static !important}
    'html.fz.fz-table .fz-rows.fz-src{position:fixed !important;left:0 !important;top:0 !important;right:auto !important;bottom:auto !important;width:100% !important;height:100% !important;max-height:none !important;overflow:auto !important;display:block !important;opacity:0 !important;pointer-events:none !important;z-index:-1 !important;}',
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
    '.fz-ns-tags{color:#0563c1;margin-left:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:38%;}',
    '.fz-nrow{border-bottom:1px solid #d0d0d0;}',
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

    '.fz-viewer{position:fixed;z-index:2147483002;background:#fff;border:1px solid #d0d0d0;border-radius:3px;padding:6px;box-sizing:border-box;overflow:auto;box-shadow:0 4px 18px rgba(0,0,0,.18);font-size:11px;}',
    '.fz-v-hd{display:flex;align-items:center;gap:10px;padding:0 2px 5px;color:#666;border-bottom:1px solid #eee;margin-bottom:6px;}',
    '.fz-v-hd b{font-weight:600;color:#222;}',
    '.fz-v-x{margin-left:auto;color:#0563c1;cursor:pointer;}',
    '.fz-morerow{display:block !important;padding:7px 10px;border-bottom:1px solid #d0d0d0;background:#fff;font-size:12px;color:#666;}',
    '.fz-morerow .fz-link{margin-right:12px;}',
    // 登录/登出时临时让位：藏起伪装层，露出原生界面
    'html.fz-yield .fz-chrome,html.fz-yield .fz-board,html.fz-yield .fz-notesheet,' +
    'html.fz-yield .fz-morerow,html.fz-yield .fz-filler,html.fz-yield .fz-src,html.fz-yield .fz-viewer{display:none !important;}',
    'html.fz-yield body{padding-top:0 !important;}',
    'html.fz-yield body .fz-toast{display:block !important;}',
    '.fz-toast{position:fixed;left:50%;transform:translateX(-50%);bottom:60px;z-index:2147483647;background:rgba(30,30,30,.9);color:#fff;font-size:12px;padding:8px 16px;border-radius:4px;}',
    '.fz-v-err{padding:24px 12px;color:#999;font-size:12px;text-align:center;}',
    '.fz-v-bd img{display:block;max-width:100%;max-height:56vh;width:auto;height:auto;border:1px solid #eee;}'
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
    var p = location.pathname + location.search;
    if (p !== lastPath) { lastPath = p; pageAt = Date.now(); lastAnchorCount = -1; fitDone = false; aboveDone = false; removeSheet(); closedPid = ''; }

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
    hideAboveTable();
    ensureMoreRow();
    maybeNoteSheet();
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
    renderAuth();
    bindSearch();
    applyFilter();
    dropCurtain();
  }

  var schedule = (function () {
    var pending = false, logged = false;
    return function () {
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () {
        pending = false;
        try {
          sync();
        } catch (e) {
          if (!logged || DEMO) { logged = true; console.error('[fishy] sync 出错：', e); }
        }
      });
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
      if (innerHeight + (window.scrollY || 0) >= document.documentElement.scrollHeight - 260) {
        if (Date.now() - lastPull > 2500) {
          lastPull = Date.now();
          pullMore();
          setTimeout(function () { collectCards(); fillBoard(); }, 1500);
        }
      }
    }, { passive: true });
    addEventListener('resize', thumb(schedule, 400), { passive: true });
  }

  function applyFilter() {
    var inp = document.querySelector('.fz-search');
    if (!inp) return;
    var q = (inp.value || '').trim().toLowerCase();
    var rows = document.querySelectorAll('.fz-row');
    for (var i = 0; i < rows.length; i++) {
      var hit = !q || (rows[i].textContent || '').toLowerCase().indexOf(q) > -1;
      rows[i].classList.toggle('fz-hide', !hit);
    }
  }

  function toast(msg) {
    var d = document.getElementById('fz-toast');
    if (d) d.remove();
    d = document.createElement('div');
    d.id = 'fz-toast';
    d.className = 'fz-toast';
    d.textContent = msg;
    document.body.appendChild(d);
    setTimeout(function () { if (d.parentNode) d.remove(); }, 2400);
  }

  // 小红书的登出接口需要签名，脚本无法直接调用；改为打开不带脚本的原生页面
  // ===== 登录 / 登出：直接借用小红书自己的界面 =====
  var yieldMode = false;

  function isLoggedIn() {
    // 有 .login-btn 就是没登录（登录后这个按钮会消失）
    return !document.querySelector('.login-btn');
  }

  // 让开我们的伪装层，露出小红书原生界面（否则原生弹窗会被压在下面看不见）
  function yieldToSite() {
    yieldMode = true;
    document.documentElement.classList.add('fz-yield');
    var hidden = document.querySelectorAll('[data-fz-hide="1"]');
    for (var i = 0; i < hidden.length; i++) {
      try { hidden[i].style.removeProperty('display'); } catch (e) {}
      hidden[i].dataset.fzHide = '0';
    }
    try { document.body.style.removeProperty('padding-top'); } catch (e) {}
  }

  function resumeFromSite() {
    yieldMode = false;
    document.documentElement.classList.remove('fz-yield');
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

  // 从外层往里逐层试（有的实现把手势绑在 svg 或它爸身上）
  function tryPress(el, onDone) {
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
      if (i >= targets.length) { onDone(false, before); return; }
      var t = targets[i++];
      press(t);
      setTimeout(function () {
        if (String(el.className || '') !== before) onDone(true, String(el.className || ''));
        else next();
      }, 260);
    })();
  }

  function siteAction(what, row, sheetEl) {
    if (what === 'reply') {
      yieldToSite();
      setTimeout(function () {
        var box = document.querySelector('#noteContainer textarea, .engage-bar textarea, .engage-bar input');
        if (box) { try { box.focus(); box.click(); } catch (e) {} }
      }, 350);
      toast('已切到原生界面，直接输回复');
      return true;
    }
    var host = findActHost(row);
    if (!host) { toast('没找到这一行的原生元素'); return false; }
    var el = host.querySelector(what === 'like' ? '.like-wrapper' : '.collect-wrapper');
    if (!el) { toast('原生按钮不存在'); return false; }
    var before = String(el.className);
    var beforeTxt = (el.textContent || '').replace(/\s+/g, '');
    tryPress(el, function (changed, after) {
      after = after || String(el.className);
      var label = what === 'like' ? '点赞' : '收藏';
      var nowTxt = (el.textContent || '').replace(/\s+/g, '');
      var numChanged = nowTxt !== beforeTxt;      // 数字变了也算成功（未登录时只会弹提示、类名不变）
      var on = what === 'like' ? /liked|like-active/.test(after) : /collect-active|collected/.test(after);
      if (changed) toast(on ? ('已' + label) : ('已取消' + label));
      else if (numChanged) toast('已' + label);
      else {
        // 脚本点不动（站点校验 event.isTrusted）→ 让位 + 红框圈住按钮，等真人点一下
        toast('红框就是' + label + '按钮，点一下即可（表格会自动回来）');
        yieldToSite();
        setTimeout(function () {
          highlightEl(el);
          pollUntil(function () { return String(el.className) !== before; }, function (ok3) {
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
      if (e.key === 'Escape') { inp.value = ''; applyFilter(); inp.blur(); }
    });
  }

  function dropCurtain() {
    var el = document.documentElement;
    if (!el.classList.contains('fz-boot')) return;
    var ready = document.querySelector('.fz-notesheet') ||
                document.querySelector('.fz-row') ||
                Date.now() - bootAt > 1400;
    if (ready) el.classList.remove('fz-boot');
  }

  // ---------- 安全阀 ----------
  var lastEsc = 0, idleTimer = null;
  function resetIdle() {
    clearTimeout(idleTimer);
    if (!viewer) return;
    idleTimer = setTimeout(closeViewer, CFG.idleCollapseMs);
  }

  function escapeAll() {
    closeViewer();
    if (noteSheet) closeNoteSheet();
    scrollTo({ top: 0 });
  }

  // 鼠标划过单元格时，名称框和公式栏跟着变（看起来像真的在选中单元格）
  function bindHover() {
    document.addEventListener('mouseover', function (e) {
      var cell = e.target.closest && e.target.closest('.fz-c');
      if (!cell) return;
      var wrap = cell.parentElement;
      if (!wrap || !wrap.classList || !wrap.classList.contains('fz-cells')) return;
      var row = wrap.closest('.fz-row, .fz-nrow');
      if (!row) return;
      var idx = Array.prototype.indexOf.call(wrap.children, cell);
      var numEl = wrap.querySelector('.fz-num');
      var rowNo = (numEl && parseInt(numEl.textContent, 10)) || '';
      var LET = ['', 'A', 'B', 'C', 'D', 'E'];
      var ref = document.querySelector('.fz-ref');
      var inp = document.querySelector('.fz-input');
      if (ref) ref.textContent = (LET[idx] || 'A') + rowNo;
      if (inp) inp.textContent = (cell.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    }, true);
  }

  // 主表格滚到底 → 顺手把隐藏的源列表滚到底，触发站点自己的加载更多
  var lastNudge = 0;
  function nudgeSource() {
    var now = Date.now();
    if (now - lastNudge < 1500) return;
    lastNudge = now;
    var src = document.querySelector('.fz-src');
    if (!src) return;
    try { src.scrollTop = src.scrollHeight; } catch (e) {}
    try { src.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (e) {}
  }

  function bindScrollLoad() {
    addEventListener('scroll', thumb(function () {
      var h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      if (innerHeight + scrollY < h - 900) return;   // 还没滚到底就别打扰
      nudgeSource();
    }, 400), { passive: true });
  }

  function bindKeys() {
    addEventListener('keydown', function (e) {
      if (e.ctrlKey && e.shiftKey && (e.key === 'X' || e.key === 'x')) {
        e.preventDefault();
        escapeAll();
        return;
      }
      if (e.key === 'Escape') {
        if (viewer) { closeViewer(); return; }
        if (noteSheet) { closeNoteSheet(); return; }
        var now = Date.now();
        if (now - lastEsc < 420) escapeAll();
        lastEsc = now;
        return;
      }
      if (e.altKey && e.shiftKey && (e.key === 'R' || e.key === 'r')) {
        e.preventDefault();
        CFG.tableMode = !CFG.tableMode;
        store.set('tableMode', CFG.tableMode);
        document.documentElement.classList.toggle('fz-table', CFG.tableMode);
        if (!CFG.tableMode) {
          document.querySelectorAll('.fz-rows').forEach(function (el) { el.classList.remove('fz-rows'); });
          var f = document.querySelector('.fz-filler');
          if (f) f.remove();
        } else { schedule(); }
        return;
      }
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
      }
    });

    addEventListener('click', function (e) {
      var t = e.target.closest && e.target.closest('[data-fz-auth]');
      if (!t) return;
      e.preventDefault();
      e.stopPropagation();
      if (t.dataset.fzAuth === 'out') doLogout();
      else doLogin();
    }, true);

    addEventListener('blur', closeViewer);
    addEventListener('mousemove', thumb(resetIdle, 400), { passive: true });
    addEventListener('wheel', function (e) {
      if (e.deltaY < -16 && viewer) closeViewer();
    }, { passive: true });
    addEventListener('click', function (e) {
      if (viewer && !e.target.closest('.fz-viewer') && !e.target.closest('.fz-link')) closeViewer();
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
        expandOnSite: expandOnSite,
        expandAllOnSite: expandAllOnSite,
        absorbComments: absorbComments,
        pooledSubs: pooledSubs,
        cmtRowsHtml: cmtRowsHtml
      };
    } catch (eP) {}
    try {
      hookApi();
      injectCSS();
      buildChrome();
      applyFavicon();
      applyTitle();
      hookHistory();
      watch();
      bindScrollLoad();
      bindKeys();
      sync();
    } catch (e) {
      console.error('[fishy] 初始化失败：', e);
      return;
    }
    if (!document.querySelector('.fz-chrome')) {
      console.error('[fishy] 外壳未创建，请把这条报错发给我');
    }
    applyTitle();
    clearInterval(titleTimer);
    titleTimer = setInterval(applyTitle, 900);
    setTimeout(sync, 600);
    setTimeout(sync, 1800);
  }

  boot();
})();
