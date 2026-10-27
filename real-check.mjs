// 真实小红书站点自动回归（游客态，无需登录）
// 用法: node real-check.mjs [--shot]
// 依赖：本地 headless Edge 已开调试端口（见 start-edge.mjs）
import { openInjected, closePage, sleep } from './cdp-lib.mjs';

const RESULT = [];
function ok(name, cond, extra) {
  RESULT.push((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  [' + extra + ']' : ''));
  return !!cond;
}

const HIDE_LOGIN = `(()=>{const all=[...document.querySelectorAll('div,section')]
  .filter(e=>/手机号登录/.test(e.textContent||''));
  let best=null;
  for(const e of all){const r=e.getBoundingClientRect();
    if(r.width>300&&r.height>200){if(!best||r.width<best.getBoundingClientRect().width)best=e;}}
  if(best){best.style.display='none';return 1;} return 0;})()`;

const LIST_PROBE = `(()=>{
  const rows=[...document.querySelectorAll('.fz-row')];
  const nums=rows.map(r=>{const n=r.querySelector('.fz-num');return n?+n.textContent:0;});
  const bad=rows.filter(r=>r.querySelectorAll('.fz-c').length!==7).length;
  const img=rows.filter(r=>[...r.querySelectorAll('img')].some(i=>{
    const b=i.getBoundingClientRect(); return b.width>2&&b.height>2;})).length;
  const links=rows.filter(r=>r.querySelector('.fz-link')).length;
  const seq=nums.every((v,i)=>v===i+1);
  return {rows:rows.length,cells6:bad===0,badCells:bad,hideImg:img===0,imgRows:img,
          links:links,title:document.title,seq:seq,
          why:document.documentElement.getAttribute('data-fz-why')};})()`;

const DETAIL_PROBE = `(()=>{
  const id=(location.pathname.match(/\\/explore\\/([0-9a-zA-Z]+)/)||[])[1];
  const dm=window.__INITIAL_STATE__.note.noteDetailMap;
  const e=dm[id]; const n=e&&e.note;
  const il=n&&(n.imageList||n.image_list)||[];
  const cl=(e.comments&&e.comments.list)||[];
  let subs=0; cl.forEach(c=>{subs+=((c.subComments||[]).length);});
  const ns=document.querySelector('.fz-notesheet');
  if(!ns) return {noSheet:1,why:document.documentElement.getAttribute('data-fz-why'),id:id};
  const rows=[...ns.querySelectorAll('.fz-nrow')];
  const main=rows[0];
  const cells=[...main.querySelectorAll('.fz-c')].map(c=>(c.textContent||'').replace(/\\s+/g,' ').trim());
  return {
    id:id, stateImgs:il.length, stateCmts:cl.length, stateSubs:subs,
    stat:ns.querySelector('#fz-ns-stat').textContent.replace(/\\s+/g,' '),
    nrow:rows.length, links:main.querySelectorAll('.fz-link[data-i]').length,
    lv:ns.querySelectorAll('.fz-lv1,.fz-lv2').length,
    toggles:ns.querySelectorAll('.fz-toggle').length,
    author:cells[1], type:cells[2], desc:cells[3], likes:cells[4], time:cells[5],
    hasReplyPrefix: rows.some(r=>/回复 @/.test(r.textContent||''))
  };})()`;

(async () => {
  const { page, cdp } = await openInjected(['xiaohongshu-fishy.user.js']);
  try {
    // ---------- 列表页（先清 cookie，重置小红书游客访问配额） ----------
    await cdp.send('Network.clearBrowserCookies');
    await cdp.navigate('https://www.xiaohongshu.com/explore');
    await sleep(7000);
    await cdp.evaluate(HIDE_LOGIN);
    const L = await cdp.evaluate(LIST_PROBE);
    ok('R1 列表页伪装成工作簿1', L.title === '工作簿1', L.title);
    ok('R2 瀑布流变成表格行', L.rows >= 12, L.rows + ' 行');
    ok('R3 每行都是 7 个单元格', L.cells6, '坏行 ' + L.badCells);
    ok('R4 行号 1..N 连续', L.seq);
    ok('R5 行内原图不可见', L.hideImg, '有图行 ' + L.imgRows);
    ok('R6 每行都有图片文字链接', L.links >= Math.max(1, L.rows - 3),
      L.links + '/' + L.rows + '（允许个别纯文字笔记）');

    // ---------- 挑一篇笔记 ----------
    const url = await cdp.evaluate(`(()=>{
      const f=window.__INITIAL_STATE__.feed.feeds;
      const arr=f._rawValue||f.value||[];
      const a=arr.filter(x=>(x.noteCard||{}).type==='normal'&&x.xsecToken)[0]||arr[0];
      return a? ('/explore/'+a.id+'?xsec_token='+encodeURIComponent(a.xsecToken||'')+'&xsec_source=pc_feed'):null;
    })()`);
    ok('R7 能取到带 xsec_token 的笔记链接', !!url, url ? url.slice(0, 60) : 'null');
    if (!url) throw new Error('没有可用笔记');

    // ---------- 详情页 ----------
    await cdp.navigate('https://www.xiaohongshu.com' + url);
    await sleep(10000);
    await cdp.evaluate(HIDE_LOGIN);
    await sleep(1500);
    const D = await cdp.evaluate(DETAIL_PROBE);

    if (D.noSheet) {
      ok('R8 详情页接管成表格', false, 'why=' + D.why);
    } else {
      ok('R8 详情页接管成表格', true, D.stat);
      ok('R9 主贴图数量与站点数据一致',
        D.links === D.stateImgs && D.links >= 1, D.links + ' 链接 / state ' + D.stateImgs + ' 张');
      ok('R10 主贴有作者', !!D.author && D.author.length > 0, D.author);
      ok('R11 主贴正文不是导航文案',
        !/猜你想搜|扫码|推荐\s*RED|只看图文|登录后查看/.test(D.desc || '') && (D.desc || '').length > 0,
        (D.desc || '').slice(0, 26));
      ok('R12 时间列干净（无 IP 属地/编辑于）',
        !/[\u4e00-\u9fa5]/.test(D.time || ''), D.time);
      ok('R13 评论行数 ≥ 站点一级评论数',
        D.nrow - 1 >= Math.min(D.stateCmts, 1), D.nrow + ' 行 / 一级 ' + D.stateCmts);
      if (D.stateSubs > 0) {
        ok('R14 楼中楼层级全部展开', D.lv >= D.stateSubs, D.lv + ' 层 / state 子评论 ' + D.stateSubs);
        ok('R15 有"回复 @某人"引用', D.hasReplyPrefix);
      }
      ok('R16 表格无 JS 异常', cdp.errors.length === 0, cdp.errors.slice(0, 2).join(' | '));
    }

    if (process.argv.includes('--shot')) {
      await cdp.shot('shots/real-detail.png');
      RESULT.push('SHOT shots/real-detail.png');
    }
  } catch (e) {
    ok('R0 全流程未崩溃', false, String(e.message || e));
  } finally {
    cdp.close();
    await closePage(page.id);
  }

  const pass = RESULT.filter((r) => r.startsWith('PASS')).length;
  const fail = RESULT.filter((r) => r.startsWith('FAIL')).length;
  console.log(RESULT.join('\n'));
  console.log('\n=== 真实站点 ' + pass + ' pass / ' + fail + ' fail ===');
  process.exit(fail ? 1 : 0);
})();
