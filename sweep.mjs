// 真机巡检：列表滚动 + 批量笔记 + 搜索页，输出问题清单
// 用法: node sweep.mjs [笔记数量]
import { openInjected, closePage, sleep } from './cdp-lib.mjs';

const N = +(process.argv[2] || 6);
const RESULT = [];
const ok = (n, c, e) => { RESULT.push((c ? 'PASS ' : 'FAIL ') + n + (e ? '  [' + e + ']' : '')); return !!c; };
const info = (n, e) => RESULT.push('  · ' + n + (e ? '  ' + e : ''));

const HIDE_LOGIN = `(()=>{const all=[...document.querySelectorAll('div,section')]
  .filter(e=>/手机号登录/.test(e.textContent||''));
  let best=null;
  for(const e of all){const r=e.getBoundingClientRect();
    if(r.width>300&&r.height>200){if(!best||r.width<best.getBoundingClientRect().width)best=e;}}
  if(best){best.style.display='none';return 1;} return 0;})()`;

const LIST_PROBE = `(()=>{
  const rows=[...document.querySelectorAll('.fz-row')];
  const nums=rows.map(r=>{const n=r.querySelector('.fz-num');return n?+n.textContent:0;});
  const empty=rows.filter(r=>!(r.textContent||'').trim()).length;
  const badCells=rows.filter(r=>r.querySelectorAll('.fz-c').length!==7).length;
  const imgVisible=rows.filter(r=>[...r.querySelectorAll('img')].some(i=>{
    const b=i.getBoundingClientRect();return b.width>2&&b.height>2;})).length;
  const fd=window.__INITIAL_STATE__&&window.__INITIAL_STATE__.feed;
  const arr=fd&&(fd.feeds?((fd.feeds._rawValue||fd.feeds.value)||[]):[]);
  const bd=document.querySelector('.fz-board');
  const br=bd?bd.getBoundingClientRect():null;
  const above=[...document.querySelectorAll('body > *')].filter(e=>{
    if(e.classList.contains('fz-chrome')||e.classList.contains('fz-board'))return false;
    const q=e.getBoundingClientRect();
    return q.height>30 && q.top < (br?br.top:999) && q.top>=0;
  }).length;
  const letterN=document.querySelectorAll('.fz-letter').length;
  const cellsN=rows[0]?rows[0].querySelectorAll('.fz-c').length:0;
  return {rows:rows.length,empty,badCells,imgVisible,title:document.title,
    letterN:letterN, cellsN:cellsN,
    letterN:letterN, cellsN:cellsN,
    boardTop:br?Math.round(br.top):-1, boardW:br?Math.round(br.width):0, aboveN:above,
    boardTop:br?Math.round(br.top):-1, boardW:br?Math.round(br.width):0, aboveN:above,
    feedLen:Array.isArray(arr)?arr.length:0,
    seq:nums.every((v,i)=>v===i+1),nums:nums.slice(0,5).concat(['...',nums[nums.length-1]])};})()`;

const DETAIL_PROBE = `(()=>{
  const id=(location.pathname.match(/\\/explore\\/([0-9a-zA-Z]+)/)||[])[1];
  const st=window.__INITIAL_STATE__;const dm=st&&st.note&&st.note.noteDetailMap;
  const e=dm&&dm[id]; const n=e&&e.note;
  const il=n&&(n.imageList||n.image_list)||[];
  const cl=(e&&e.comments&&e.comments.list)||[];
  let subs=0; cl.forEach(c=>{subs+=((c.subComments||[]).length);});
  const ns=document.querySelector('.fz-notesheet');
  if(!ns) return {id,path:location.pathname,noSheet:1,why:document.documentElement.getAttribute('data-fz-why'),
                  ntype:n&&n.type,stateImgs:il.length};
  const rows=[...ns.querySelectorAll('.fz-nrow')];
  const main=rows[0];
  const cells=[...main.querySelectorAll('.fz-c')].map(c=>(c.textContent||'').replace(/\\s+/g,' ').trim());
  return {id,path:location.pathname,stateImgs:il.length,stateCmts:cl.length,stateSubs:subs,
    ntype:n&&n.type,stateType:n&&n.type,
    nrow:rows.length,links:main.querySelectorAll('.fz-link[data-i]').length,
    lv:ns.querySelectorAll('.fz-lv1,.fz-lv2').length,
    zeroBtn:[...ns.querySelectorAll('.fz-toggle')].filter(function(b){
      return /展开\s*0/.test(b.textContent||'');}).length,
    toggles:ns.querySelectorAll('.fz-toggle').length,
    zeroBtn:[...ns.querySelectorAll('.fz-toggle')].filter(function(b){
      return /展开\s*0/.test(b.textContent||'');}).length,
    toggles:ns.querySelectorAll('.fz-toggle').length,
    author:cells[1],type:cells[2],desc:cells[3],likes:cells[4],time:cells[5],
    stat:ns.querySelector('#fz-ns-stat').textContent.replace(/\\s+/g,' '),
    emptyRows:rows.filter(r=>!(r.textContent||'').trim()).length};})()`;

(async () => {
  const { page, cdp } = await openInjected(['xiaohongshu-fishy.user.js']);
  try {
    // ---------------- 1. 列表页 + 滚动加载 ----------------
    await cdp.navigate('https://www.xiaohongshu.com/explore');
    await sleep(7000);
    await cdp.evaluate(HIDE_LOGIN);
    const L1 = await cdp.evaluate(LIST_PROBE);
    ok('列表：接管成工作簿', L1.title === '工作簿1', L1.title);
    ok('列表：一帖一行且 7 列', L1.badCells === 0 && L1.rows >= 12, L1.rows + ' 行');
    ok('列表：行号连续', L1.seq, JSON.stringify(L1.nums));
    ok('列表：列号条格数与表格列数一致', L1.letterN === L1.cellsN,
      '列号 ' + L1.letterN + ' 个 / 表格 ' + L1.cellsN + ' 列');
    ok('列表：没有空行', L1.empty === 0, L1.empty + ' 空行');
    ok('列表：原图不可见', L1.imgVisible === 0, L1.imgVisible + ' 行有图');
    ok('列表：表格紧贴工具栏下方（顶部没有站点残留）',
      L1.boardTop >= 100 && L1.boardTop <= 120 && L1.aboveN === 0,
      'top=' + L1.boardTop + ' 上方残留 ' + L1.aboveN + ' 块');
    ok('列表：表格铺满整宽', Math.abs(L1.boardW - 1440) < 30, L1.boardW + 'px');
    ok('列表：表格紧贴工具栏下方（顶部没有站点残留）',
      L1.boardTop >= 100 && L1.boardTop <= 120 && L1.aboveN === 0,
      'top=' + L1.boardTop + ' 上方残留 ' + L1.aboveN + ' 块');
    ok('列表：表格铺满整宽', Math.abs(L1.boardW - 1440) < 30, L1.boardW + 'px');

    for (let i = 0; i < 3; i++) {
      await cdp.evaluate(`(()=>{window.scrollTo(0,document.body.scrollHeight);return 1;})()`);
      await sleep(2200);
    }
    const L2 = await cdp.evaluate(LIST_PROBE);
    // 站点给多少条数据，表格就必须有多少行（这才是脚本的责任）
    ok('列表：行数与站点数据条数一致', L2.rows >= L2.feedLen && L2.feedLen > 0,
      L2.rows + ' 行 / 站点 ' + L2.feedLen + ' 条');
    if (L2.feedLen > L1.feedLen) {
      ok('列表：加载更多后行数同步增长', L2.rows > L1.rows, L1.rows + ' → ' + L2.rows + ' 行');
    } else {
      RESULT.push('SKIP 列表增长（站点本次没返回更多数据：' + L1.feedLen + ' → ' + L2.feedLen +
        ' 条，游客态常见，登录后需另测）');
    }
    ok('列表：滚动后无空行、行号连续', L2.empty === 0 && L2.seq && L2.badCells === 0,
      '空行 ' + L2.empty);

    // ---------------- 2. 候选笔记（小红书游客有访问配额，每批前清一次 cookie） ----------------
    const PICK = `(()=>{
      const f=window.__INITIAL_STATE__.feed.feeds; const arr=f._rawValue||f.value||[];
      return arr.filter(x=>x.xsecToken&&x.noteCard).slice(0,2).map(x=>({
        id:x.id, tk:x.xsecToken, ty:(x.noteCard||{}).type,
        t:((x.noteCard||{}).displayTitle||'').slice(0,16)}));})()`;

    let done = 0, rounds = 0;
    while (done < N && rounds < 8) {
      rounds++;
      await cdp.send('Network.clearBrowserCookies');
      await cdp.navigate('https://www.xiaohongshu.com/explore');
      await sleep(5500);
      await cdp.evaluate(HIDE_LOGIN);
      let batch = [];
      try { batch = await cdp.evaluate(PICK); } catch { batch = []; }
      if (!batch.length) { info('第 ' + rounds + ' 轮没取到候选，重试'); continue; }

      for (const it of batch) {
        if (done >= N) break;
        const url = '/explore/' + it.id + '?xsec_token=' + encodeURIComponent(it.tk) + '&xsec_source=pc_feed';
        await cdp.navigate('https://www.xiaohongshu.com' + url);
        await sleep(9000);
        await cdp.evaluate(HIDE_LOGIN);
        await sleep(1000);
        const D = await cdp.evaluate(DETAIL_PROBE);
        done++;
        const tag = (it.ty || '?') + ' ' + (it.t || '');

        if (/^\/login/.test(D.path || '')) {
          RESULT.push('SKIP 详情（被引导到登录页，游客配额用尽）：' + tag);
          done--;
          continue;
        }
        if (D.noSheet) {
          ok('详情：接管 ' + tag, false, 'why=' + D.why);
          continue;
        }
        const problems = [];
        if (D.links !== D.stateImgs) problems.push('图 ' + D.links + '/' + D.stateImgs);
        if (!D.author) problems.push('作者空');
        if (!D.desc) problems.push('正文空');
        if (/猜你想搜|扫码|推荐\s*RED|只看图文|登录后查看|穿搭\s*美食/.test(D.desc)) problems.push('正文=导航');
        if (/[\u4e00-\u9fa5]/.test(D.time)) problems.push('时间含中文:' + D.time);
        if (D.stateSubs > 0 && D.lv < D.stateSubs) problems.push('层级 ' + D.lv + '/' + D.stateSubs);
        if (D.stateCmts > 0 && D.nrow < 2) problems.push('没抓到评论');
        if (D.emptyRows) problems.push('空行 ' + D.emptyRows);
        if (D.zeroBtn) problems.push('出现"展开0条回复" ' + D.zeroBtn + ' 个');
        if (D.zeroBtn) problems.push('出现"展开0条回复" ' + D.zeroBtn + ' 个');
        var wantType = D.stateType === 'video' ? '视频' : (D.stateType === 'normal' ? '图文' : '');
        if (wantType && D.type !== wantType) problems.push('类型=' + D.type + ' 应为 ' + wantType);
        ok('详情 ' + tag, problems.length === 0,
          problems.length ? problems.join(' | ') : (D.links + ' 图 / ' + D.nrow + ' 行 / ' + D.lv + ' 层 / ' + D.time));
      }
    }
    info('实际验证 ' + done + ' 篇 / 用了 ' + rounds + ' 批会话');

    // ---------------- 3. 搜索结果页 ----------------
    await cdp.navigate('https://www.xiaohongshu.com/search_result?keyword=%E9%80%9A%E5%8B%A4%E7%A9%BF%E6%90%AD&source=web_explore_feed');
    await sleep(8000);
    await cdp.evaluate(HIDE_LOGIN);
    const hasCards = await cdp.evaluate(`(()=>{
      const a=document.querySelectorAll('a[href*="/explore/"]').length;
      const n=document.querySelectorAll('[class*="note-item"]').length;
      const needLogin=/登录后查看搜索结果/.test(document.body.innerText||'');
      return a+n-(needLogin?1000:0);})()`);
    if (hasCards <= 0) {
      RESULT.push('SKIP 搜索页接管（游客态提示"登录后查看搜索结果"，无卡片可测；登录后才能验）');
    } else {
      const S = await cdp.evaluate(LIST_PROBE);
      ok('搜索：结果页也能接管成表格', S.rows >= 5 && S.badCells === 0, S.rows + ' 行 / title=' + S.title);
      ok('搜索：行号连续、无空行', S.seq && S.empty === 0, '空行 ' + S.empty);
    }

    ok('全程无 fishy 异常', cdp.errors.length === 0, cdp.errors.slice(0, 3).join(' | '));
  } catch (e) {
    ok('巡检未崩溃', false, String(e.message || e));
  } finally {
    cdp.close();
    await closePage(page.id);
  }

  const pass = RESULT.filter((r) => r.startsWith('PASS')).length;
  const fail = RESULT.filter((r) => r.startsWith('FAIL')).length;
  const skip = RESULT.filter((r) => r.startsWith('SKIP')).length;
  console.log(RESULT.join('\n'));
  console.log('\n=== 巡检 ' + pass + ' pass / ' + fail + ' fail' + (skip ? ' / ' + skip + ' skip' : '') + ' ===');
  process.exit(fail ? 1 : 0);
})();
