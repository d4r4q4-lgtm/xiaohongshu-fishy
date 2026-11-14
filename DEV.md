# 开发文档

> 面向要改这个脚本的人。作者 **haozi**，版本 `1.25`。  
> 只讲实现与坑，不赘述使用方式（那在 [README](README.md)）。

---

## 1. 设计目标与取舍

| 目标           | 做法                                                | 为什么                       |
| ------------ | ------------------------------------------------- | ------------------------- |
| 看起来像真的 Excel | 自建一套固定定位的「外壳」（标题栏/工具栏/公式栏/列号/状态栏），并把表格放进 `body` 流 | 只做 CSS 变换看不出工具栏、列号这些"硬特征" |
| 原始数据不丢       | 把站点列表容器留在 DOM 里，只是隐藏并移出视觉                         | 站点自己的"加载更多"、虚拟滚动都依赖它      |
| 不改站点代码       | 全程只读 DOM/状态 + 派发事件 + 少量 DOM 挪动                    | 侵入越小，改版后越容易修              |
| 数据尽量拿全       | 三级来源：**拦截接口 > 页面状态 `__INITIAL_STATE__` > 扫描 DOM** | 任意一级失效还有后备                |
| 加载由人发话       | "加载下一批"只认**点按钮**：滚动、进页面、失败重试都不许自己去拉（v0.77） | 表格是拿来**读**的；自己在长，用户就没有"停"的时刻 |

**核心取舍**：宁可牺牲"一次全加载"，也要保证**界面稳定不露馅**。所以列表页面的"加载更多"取决于站点自身行为，脚本只负责把它触发出来。

---

## 2. 整体架构

```
┌─────────────────────────────────────────────────┐
│ boot()                                          │
│  hookApi()      拦截 fetch/XHR                  │
│  injectCSS()    注入 .fz-* 样式                 │
│  buildChrome()  顶部/底部外壳 + 列号条          │
│  hookHistory()  pushState 监听                  │
│  watch()        MutationObserver + rAF 节流     │
│  bindKeys                 快捷键                 │
└──────────────────────┬──────────────────────────┘
                       │ 每次 DOM 变化 / 每秒
                       ▼
┌─────────────────────────────────────────────────┐
│ sync()  同步一次全部状态                        │
│  1 路径变化 → removeSheet / 重置标记            │
│  2 hideSiteHeader / hideBeforeBoard / hideBars   │
│  3 ensureBoard / collectCards / fillBoard       │
│  4 maybeNoteSheet()  ← 详情页接管主入口         │
│  5 renderAuth / bindSearch / applyTitle         │
└─────────────────────────────────────────────────┘
```

**为什么用轮询 + MutationObserver 而不是纯事件**：小红书是 SPA，路由变化、异步渲染、虚拟滚动都很频繁，纯监听会漏；纯定时又太贵。现在是「MutationObserver 触发 + 40ms rAF 节流 + 兜底 setInterval」。

---

## 3. 文件清单

**随仓库发布的（使用者需要的）：**

| 文件 | 作用 |
|---|---|
| `xiaohongshu-fishy.user.js` | 全部功能，单文件 |
| `README.md` | 使用说明 |
| `DEV.md` | 本文件 |
| `docs/images/` | 截图 |

**作者本地的开发工具（未随仓库发布）：**

| 文件 | 作用 |
|---|---|
| `serve.mjs` | 本地只读更新源（`127.0.0.1:8125`），提供脚本、`/version`、`/hit` |
| `check.mjs` | 一键跑本地四套 + 真机两套 |
| `sweep.mjs` | 真机巡检：列表 + 批量笔记 + 搜索页（含游客态空表提示） |
| `real-check.mjs` | 真实站点单篇断言 |
| `cdp.mjs` / `cdp-lib.mjs` | 用 CDP 驱动 headless Edge（注入脚本、求值、截图、真实鼠标） |
| `test.html` / `test-scroll.html` / `test-off.html` | 本地单元用例（用假数据模拟真实结构） |
| `test-empty.html` | 本地单元用例：**一行都没有**时（游客态搜索页）给不给提示 |
| `fishy-update-server.vbs` | Windows 开机自启更新源 |
| `push.cmd` | 本机一键推送到 GitHub |

> 这些工具不进仓库：对使用者没意义，也让仓库干净。需要时由作者本地保留。

---

## 4. 数据获取的三级策略

详情页要的东西（标题/正文/作者/赞藏评/图片/评论）有四个可能的来源，优先级从高到低：

### ① 接口拦截（`hookApi` / `absorbNote` / `absorbComments`）

在 `document-start` 包裹 `window.fetch` 和 `XMLHttpRequest`，把响应克隆一份解析：

- `/api/sns/web/v1/feed` → `absorbNote()` 提取 `note_card` / `note` 里的完整数据  
  |  |  |  
  | --- | --- |
- 任何 URL 含 `comment|note` 的响应 → `absorbComments()` 递归收集所有"像评论"的对象（有 `id` + `content` + `user_info`）进 `cmtPool`

> ⚠️ **不能自己发请求**。所有 `/api/` 都校验 `x-s` 签名，缺了直接被网关拒：  
> `POST /api/sns/web/v1/logout` → `500 create invoker failed, service: jarvis-gateway-default`。  
> 所以只**拦截**，不**发起**。

### ② 页面状态 `__INITIAL_STATE__`（`readInitialState` / `readStateNote`）

**关键坑**：它是 JS 字面量（含 `undefined`、单引号、无引号键），**`JSON.parse` 一定失败**。

```js
// ❌ 一定抛错
JSON.parse(script.textContent)
// ✅ 优先直读对象（Tampermonkey 下用 unsafeWindow）
unsafeWindow.__INITIAL_STATE__
// ✅ 其次：洗掉 undefined 再 parse
text.replace(/\bundefined\b/g, 'null')
// ✅ 最后兜底：当作表达式求值
new Function('return (' + text + ')')()
```

结构（实测）：

```
__INITIAL_STATE__.note.noteDetailMap[noteId]
  .note        { imageList, tagList, interactInfo{likedCount,...}, type, time, user }
  .comments    { list: [ { id, content, likeCount, createTime, userInfo,
                           subCommentCount, subCommentHasMore, subComments: [...] } ] }
```

**字段命名两套并存**：接口返回 `image_list` / `user_info` / `like_count`（下划线），  
页面状态是 `imageList` / `userInfo` / `likeCount`（驼峰）。所有读取处都要两种都认，  
否则会出现"从接口补进来的回复作者全叫匿名用户"这种问题。

### ③ DOM 扫描（`readNotePage` / `readCommentsDom` / `mediaImgs`）

真实结构（2026-10 实测）：

```
#noteContainer
  .author / .author-wrapper .info a.name .username     ← 作者
  .media-container  (video)                            ← 媒体区
  .interaction-container
    .note-scroller > #detail-desc.desc                 ← 正文
                   > .date  ("编辑于 09-27 广东")      ← 时间（要剥掉 IP 属地）
    .interactions.engage-bar
      .like-wrapper 3250  .collect-wrapper 260  .chat-wrapper 572
```

- `#detail-title` **大多数笔记不存在**（没标题就没这个节点），不能拿全页 `[class*=title]` 去猜，  
  否则会抓到登录框标题或导航词（这个坑踩过）
- 评论项：`[class*="comment-item"]`，楼中楼是 `.comment-item.comment-item-sub`
- **楼中楼默认不展开**：DOM 里只有平级评论，子评论只在 `comments.list[i].subComments`

### 三级合并（`maybeNoteSheet`）

```js
var data = cached || dom;          // 先用缓存/页面
if (stn) {                         // 再拿状态覆盖关键字段
  if (stn.images.length) { data.urls = ...; data.imgLocked = 1; }  // 图以状态为准
  if (stn.type) data.type = stn.type;
  ...
}
```

**图片必须"锁定"**：`imgLocked = 1` 之后，`retryMainImages` 不再用页面图覆盖 ——  
页面里的大图会混进推荐位、骨架屏，导致 1 张图的视频笔记列成 5 张。

---

## 5. 伪装层

`buildChrome()` 造三个固定层 + 一个列号条：

| 类名            | 位置         | 内容                                |
| ------------- | ---------- | --------------------------------- |
| `.fz-head`    | `top:0`    | 标题栏（`工作簿1`/登录/搜索）+ 工具栏 + 公式栏      |
| `.fz-letters` | `top:86`   | 列号条，`grid-template-columns: COLW` |
| `.fz-foot`    | `bottom:0` | 工作表标签、缩放                          |
| `.fz-board`   | 正常流        | 表格本体（`body` 直接子元素）                |

**列宽常量 `COLW` 是唯一真源**：

```js
var COLW = '30px 150px 54px minmax(300px,1fr) 74px 118px 108px';
//          行号  作者   类型      内容            赞      时间     操作
```

`body` 用 `padding-top: HEAD_H(104px)`、`padding-bottom: FOOT_H` 给固定层留位。

> **每次改列，必须同步三处**：`COLW`、`fz-letters` 的字母数组长度、  
> 空白行 `<i>` 的个数。漏一处就会出现"列号只显示到 D""右下角缺一格"。  
> 这三处已经用断言锁住（见 §9）。

---

## 6. 列表接管

### 6.1 找到卡片

`findCardGroups()` → 找到所有 `a[href*="/explore/"]` 的公共祖先容器；  
`cardOf(a)` → 从链接往上走，直到这个祖先里出现"别的笔记"为止，就是一张卡片。

### 6.2 建行

`collectCards()`：按 id 去重，`readCard()` 读出标题/作者/封面/赞数，`appendBoardRow()` 造一行。

**占位卡片要过滤**：既没标题、又没图、又没作者的行，会渲染成一行 `未知作者 / —`。

### 6.3 隐藏原始列表（关键坑，2026-10-28 定稿）

源容器（`.fz-src`）平时**收成一个隐形的 240px 窗口**，不占位；只在拉取下一页的那几秒
临时加 `.fz-src-flow` 放进文档流。

```css
/* 平时：不占位、不留空白区，但卡片仍然完整渲染（作者/赞数要从 DOM 读） */
html.fz.fz-table .fz-rows.fz-src{position:fixed;left:0;top:0;width:100%;height:240px;
  overflow:auto;opacity:0;pointer-events:none;z-index:-1;}
/* 拉取时：回到文档流，window 滚动才能驱动站点翻页 */
html.fz.fz-table .fz-rows.fz-src.fz-src-flow{position:static;height:auto;overflow:visible;z-index:0;}
```

三条实测结论：

1. **翻页靠 window scroll 驱动，而且必须"慢慢滚"**
   一步 `scrollTop = scrollHeight` 跳到底站点不认；`320px / 400ms` 一段段推才会发下一次
   `homefeed` 请求。
2. **源列表必须真的在文档流里，站点的滚动计算才成立**
   但它一旦长期留在流里，表格下方就会出现 2000px+ 的空白区（`opacity:0` 的卡片占着高度），
   滚动体验直接崩。所以是"按需入流"：拉取时进、结束就收回。
3. **哨兵要跟着容器一起搬**
   站点用 `IntersectionObserver(root=viewport)` 盯 `.feeds-loading`，而它是 `.feeds-container`
   的**兄弟节点**（都在 `.feeds-page` 里）。只搬卡片网格、把哨兵留在 `display:none` 的祖先里，
   观察器永远不触发。所以 `sourceOf()` 要往上找一层，把"带哨兵/可滚"的那层容器整块搬走。

连带坑：

- **特异性**：`.fz-rows{position:static !important}`（0,3,1）会压掉 `.fz-src`（0,1,0），
  必须写成 `html.fz.fz-table .fz-rows.fz-src`（0,4,1）。
- **子元素不能强制塌陷**：`html.fz.fz-table .fz-rows > *{position:static;width:100%}` 会让
  源列表的卡片高度塌陷成 0，容器 `scrollHeight == clientHeight`，滚不动。
  必须写成 `:not(.fz-src) > *`。
- **源容器要挪到 `body` 下**（`markSource`），否则它的祖先（`.main-container`）没法整块隐藏。
- **图片和样式扫描必须跳过 `.fz-src`**：整棵 feed 几千个节点，每次 DOM 变动扫一遍 +
  `getComputedStyle`，主线程直接打满（实测 50% CPU、单次卡顿 400ms+，会拖崩标签页）。

### 6.4 加载更多（v0.17 起，v0.21 稳定）

```
ensureMoreRow()   表格末尾一行：「加载更多」+ 状态（共 N 条 / 正在加载…）
  ├ 点「加载更多」→ loadMore()（v0.77 起不再有滚到底自动加载）
  │    └ pullMore()  盖一层「正在计算…」遮罩 → 窗口 320px/400ms 分段滚到底 → 还原滚动位置
  │         └ collectCards()  数据变多就收工
  └ 5.4s 还没动静 → assistMore()  让位到原生列表再自动滚一遍（兜底）
```

要点：

- 拉取期间**不能改任何布局**，所以用一层 `.fz-pullmask` 遮罩挡住滚动过程（几何中性）。
- 还原滚动位置、`collectCards()` 都在 `finish()` 里；`pullBusy` 单飞 + 14s 看门狗兜底。
- 站点回包有快有慢，`loadMore()` 里的轮询会看 6 次（每次 0.6s）再判失败。

### 6.5 首页数据从哪来（别只看 DOM）

首页是**虚拟滚动**：DOM 里永远只挂一屏（约 30 张）卡片，往下滚是"换掉"而不是"追加"。
所以行数据不能只从 DOM 取：

| 来源 | 用途 |
|---|---|
| `__INITIAL_STATE__.feed.feeds` | **全量已加载列表**（id / displayTitle / type / cover / interactInfo / xsecToken），行数据主体 |
| DOM 卡片 | 补作者、赞数、封面尺寸（更真实） |
| note id（ObjectId 前 8 位） | **发布时间**——首页 feed 里根本没有时间字段，见 §14-30 |
| 接口拦截 | 详情页图片/评论（首页 `homefeed` 响应**必须跳过**，见 §13-21） |

`collectCards()` 两遍：先扫 DOM 卡片，再把 `feed.feeds` 里还没进 DOM 的补上，最后按
`feed.feeds` 的真实顺序 `orderRows()` 排一遍。

**封面图取数（2026-11-13 定稿，v1.22）**：CDP 抓真机 `__INITIAL_STATE__` 实测，首页 `noteCard` 的键是
`[type, displayTitle, user, interactInfo, cover]`，**没有 `imageList`**（v1.21 误以为图文笔记有 imageList，
那条回退只在极少数接口形态下有用）。`cover` 是对象：
`{ urlPre, urlDefault, url:"", infoList:[{imageScene,url}], width, height }` —— **`url` 常是空串，
真正有值的是 `urlDefault` / `urlPre` / `infoList[0].url`**。
`coverOf(nc)` 统一兜住几种形态：cover 对象 / cover 直接是字符串 URL / 封面挂在 `video` 子对象 /
图集第一张。站点换一版字段名时不用再改这条链路。
**踩坑**：本地 `test.html` 的 `feed.feeds` mock 以前只有 id+token、从没造过 cover 数据，
所以"首页封面变横杠"这类 bug 本地永远测不出来（本地全绿、真机全空）。v1.22 起 mock 复刻真机
`noteCard.cover` 结构，并加 T7c 断言直接验 `stateFeedItems()` 每条都能拿出封面 URL。

**v1.23 时序竞态修复（"大多数时候是横杠、偶尔才有"）**：真正让封面长期为空的不是字段名，是**时序**。
链路：页面一打开脚本就采集 → 此时卡片封面图还没懒加载完（img.src 为空）→ `readCard()` 拿到 `urls: []`
→ 行被 `noteMap.set(id, d)` **永久缓存**成"没封面"。而 `collectCards()` 两处都有
`if (noteMap.has(id)) continue`，行只建一次、之后永不重读；`watch()` 的 MutationObserver 只盯
`childList`、不盯 `attributes`，**图片 src 后填的那一刻不触发 sync**（用户不滚动就永远不重采）。
两个原因叠加 → 封面几乎永远补不回来，只有图片恰好在采集前就绪（快网/缓存）时"偶尔有"。
修法两处：
1. `collectCards()` 第 3 段「封面补漏」：对已存在但 `urls` 为空的行，先看 state、再看 DOM 重读，
   补上就 `patchRowCover()` 重画那一行（不再受 `noteMap.has` 的"一次性"限制）。
2. `boot()` 里起「首屏封面预热」：前 12 秒每 1.2s 主动 `collectCards(true)` 一轮，图片一加载出来
   就补上；之后停掉不空转。

### 6.4 顶部清理（`hideBeforeBoard`）

`.fz-board` 是 `body` 直接子元素 → **排在它前面的 body 子元素一律隐藏**。  
不依赖类名/结构，登录态、游客态、不同窗口宽度都能清干净。

**必须排除**：

- 我们的层（`.fz-chrome/.fz-board/.fz-src/.fz-toast/...`）
- 笔记详情容器（`#noteContainer` / `.note-detail-mask` / `#detail`…）—— 里面还有要读的数据
- `classList` 不是 `DOMTokenList` 的元素（**SVG 的 `classList` 是 `SVGAnimatedString`，  
  没有 `contains`，直接调会每轮 sync 抛错**）

---

## 7. 详情接管

入口 `maybeNoteSheet()`，判定顺序：

```js
if (!CFG.detailSheet) return;
if (noteSheet) return;                       // 已打开
if (Date.now() - pageAt < 700) return;       // 刚换页，等稳定
var pid = pathname.match(/\/explore\/([0-9a-zA-Z]+)/);  // 没有 id = 不是详情页
if (closedPid === pid) return;               // 用户手动关过
var dom = readNotePage(); if (!dom) return;
```

**判定"是不是详情页"**&#x7528; `noteRoot()`（`#noteContainer` 可见且宽度 > 200），  
不要用"有没有标题元素"——很多笔记没有标题。

渲染：`openNoteSheet(data)` → 造 `.fz-notesheet`，第一行主贴、接着 `<div class="fz-cmts">` 评论区。

### 数据后到怎么办

- `retryMainImages()`：1.2/2.6/4.2/6.5s 重试取图（拿到了 `imgLocked` 就不再覆盖）
- `refreshMainMeta()`：补赞数/时间/类型/正文，变了就重画主贴行
- 评论：`[0.9s, 1.8s, ... 13s]` 多轮重读，签名比对（条数+层级+作者+正文前 12 字），变了才重画

---

### 7.1 详情页也能继续加载（v0.23）

**v0.22 之前的硬伤**：评论区的「加载更多评论」按钮 `[data-cmore]` 只在事件委托里被引用，
**从来没被渲染出来** —— 详情页根本没有入口，只能看到首屏那 10 来条。

v0.23 的做法（和瀑布流同一套规律）：

```
[data-cmore] 点击（v0.77 起滚到底不再触发）
  └ pullMoreComments()：只找**这篇详情自己的**评论区滚动容器（v0.74 起，见 §47）
       ├ 从 .comments-el 往上找最内层能滚的祖先（实测是 .note-scroller）
       ├ html/body 一律不算（那是瀑布页的滚动者）
       ├ 第 1 下先跳到"离底部 1.5 屏"
       ├ 之后每 320ms 往下推 0.7 屏 + 派发 scroll/wheel（一步跳到底站点不认）
       ├ 每轮顺手点掉"加载更多/查看更多评论/展开更多回复"这类文字按钮
       └ 每轮重读 __INITIAL_STATE__ 的 comments.list，条数涨了就算成功
  └ 重读 → renderCmt() 重画 → 按钮显示"已加载 N 条，共 M 条"
```

要点：

- **原生详情一直渲染在表格下面**（`hideBeforeBoard` 特意排除了 `#noteContainer`），
  滚动它对画面没有任何影响，所以详情页不需要遮罩。
- 失败退避：连续拉不到就 4s→8s→…（上限 30s），避免在同一个位置反复空转。
- 瀑布流侧同步去掉了 400 条上限（用户要求"理论上不封顶"），只保留失败退避。

## 8. 评论树

### 8.1 为什么必须从 state 建树

小红书的楼中楼**默认折叠**，DOM 里只有一级评论和第一条子评论。  
`comments.list[i].subComments` 通常也只有 **1 条**，但 `subCommentCount` 是总数（"9"/"10+"），  
`subCommentHasMore: true`。

所以 `stateComments(pid)`：

```
for 每条一级评论 c:
  root = mk(c, depth=0, rootKey=i)
  root.subTotal   = c.subCommentCount
  root.subHasMore = c.subCommentHasMore || subTotal > subs.length
  subs = c.subComments ∪ pooledSubs(c.id)     // 合并接口拦截到的
  for 每条子评论 sc:
    parent = byId[sc.targetComment.id] || 上一个节点    // 楼中楼定位
    kid = mk(sc, parent.depth + 1, parent, i)
    parent.kids.push(kid); out.push(kid)               // DFS 顺序：父 → 子 → 兄弟
```

|                                                            |             |
| ---------------------------------------------------------- | ----------- |
| `readComments()` 以 state 为主，DOM 只用来补 state 里还没出现的一级评论（按"作者 | 正文前24字"去重）。 |

### 8.2 折叠与分批

- 渲染时给回复行加 `data-parent="rootKey"`，`applyFold()` 统一控制显隐：  
  **未展开 → 只显示该组第一行**；已展开 → 全显示
- 按钮三态（`data-mode`）：
  | mode    | 文案                | 点击       |
  | ------- | ----------------- | -------- |
  | `open`  | `展开 195 条回复`      | 展开 + 拉一批 |
  | `more`  | `再加载几条（已 10/195）` | 再拉一批     |
  | `close` | `收起回复`            | 收起       |
- 拉批的手段 `expandAllOnSite()`：扫描 `#noteContainer` 里所有文案匹配  
  |  |  |  
  | --- | --- |  
  `展开.{0,4}回复|查看更多回复` 的**最内层**元素，逐个派发  
  `pointerover→mouseover→mouseenter→mousemove→pointerdown→mousedown→pointerup→mouseup→click`。
  > 先派发 hover 是必须的：小红书的按钮常常是 hover 才挂上事件。  
  > 取"文案最短、同长度取更靠后"的那个，否则会点到外层容器（**点父元素不会触发子元素的监听**）。
- 每次拉完 1.2s / 3s / 4.8s 重读 state 并重画（保留已展开集合）。

---

## 9. 登录 / 登出 / 赞 / 收藏 / 回复

### 9.1 `yieldToSite()` —— 让位的通用手法

原生弹窗的 `z-index` 远低于 `.fz-chrome`，直接点会被压住看不见。所以：

```js
yieldMode = true;                                   // sync() 第一行直接 return
documentElement.classList.add('fz-yield');          // CSS 隐藏所有 .fz-* 层
// 撤销之前 hideEl 加过的 display:none
[data-fz-hide="1"] → style.removeProperty('display'); dataset.fzHide = '0'
body.style.removeProperty('padding-top');
```

恢复 `resumeFromSite()`：去掉 class + `yieldMode=false` + `sync()`。  
**不 reload**（比刷新快，也不丢滚动位置）。

### 9.2 登录态怎么判断

```js
// 有 .login-btn 就是没登录（登录后这个按钮消失）
const isLoggedIn = () => !document.querySelector('.login-btn');
```

比读 `__INITIAL_STATE__.user` 可靠（游客态那个字段取不到）。  
`renderAuth()` 每次 sync 都跑，按钮的「登录/登出」跟着真实状态变。

### 9.3 登录

`yieldToSite()` → 200ms 后 `click` 掉 `.login-btn` → 原生登录浮窗出现  
→ `pollUntil(isLoggedIn)` → 成功或超时都自动恢复。

### 9.4 登出

1. `apiLogout()`：`POST /api/sns/web/v1/logout`（`credentials:'include'`）—— 能成就真退出
2. 失败 → `yieldToSite()` + 提示"点右上角头像 → 退出登录" → `pollUntil(!isLoggedIn)` → 自动恢复

### 9.5 赞 / 收藏 / 回复 —— 一个重要事实

**脚本合成的点击会被丢弃**（站点校验 `event.isTrusted`）。试过全都不行：

- `el.click()`
- 完整鼠标事件序列
- **带真实坐标**的 `PointerEvent`（`clientX/clientY/pointerId/pointerType/isPrimary` 齐全）
- 逐层试：元素 → 内部 svg 的父级 → svg → 直接子元素 → 父元素

所以最终方案：脚本先试一遍，800ms 内 class 或数字没变 →  
`yieldToSite()` + **红框高亮目标按钮**（`highlightEl`：`box-shadow:0 0 0 9999px rgba(0,0,0,.45)` 压暗全页

- `@keyframes fzblink` 闪烁 + `scrollIntoView` 居中）→ 真人点一下 → 检测到变化自动恢复。

**判定成功的标准**：`class` 变了 **或** 数字变了。  
（只看 class 会漏：未登录时点收藏只弹提示、不改 class。）

---

## 10. 安全阀

| 机制   | 实现                                                        |
| ---- | --------------------------------------------------------- |
| 防闪   | `html.fz-boot{opacity:0}`，`dropCurtain()` 在表格就绪或 1.4s 后揭开 |
| 紧急收起 | `Ctrl+Shift+X` → `escapeAll()`：关查看器 + 关详情表 + 滚回顶部         |
| Esc  | 逐层关闭（查看器 → 详情表）                                           |
| 空闲收起 | 查看器 9s 无操作自动关                                             |

---

## 11. 测试体系


### 三套用例 + 一键

```
node check.mjs                       # 本地四套（约 7s，315 条断言）
node check.mjs --real --sweep=6      # 加上真机巡检 + 真实站点断言（约 2min）
```

| 套件                 | 条数 | 覆盖                                             |
| ------------------ | -- | ---------------------------------------------- |
| `test.html`        | 278 | 外壳结构、行/列一致性、图片链接、查看器、详情接管、评论层级、state 解析、折叠三态、接口入树、CSV 导出、表头筛选（F1–F16 + T22b 详情页）、键盘与空结果提示（F15b–F16d）、键盘可达（K1–K7）、点列头排序（S1–S21，含详情排评论 / 排序与筛选叠加 / CSV 同序 / 顺序被打乱后 sync 校回 / 两个箭头样式都在）、选中与复制（C1–C15）、首次提示（L1–L2）、长正文导出全文（T54b–T54c）、藏起来的视频不出声（H0–H4）+ 列宽拖动与双击自适应（WD1–WD9）+ `Ctrl+F` 送焦点（SA8） |
| `test-scroll.html` | 23 | 滚动、站点重渲染自愈、搜索（S9b–S9e 分词/提示回显/清掉连搜索一起清、S5c 换页自动清空）、登录/登出 |
| `test-off.html`    | 4  | 「Alt+Shift+T 临时关闭」：原地退出、留恢复入口、一键清标记、reload 后自己接管 |
| `test-empty.html`  | 10 | 一行都没有时（游客态搜索页）：0 行不弹首次提示（E0b）、提示内容按登录态/路径分岔、状态栏「没有内容」、按钮键盘可达、表格模式关掉时跟着藏、抓到内容后自动消失回「就绪」 |
| `sweep.mjs`        | 18 | 真机：列表布局、列号一致性、批量笔记（图文/视频/多图/少评）、搜索页（+2 条游客态 SKIP；游客态 0 行时必须给"要登录"的提示） |
| `real-check.mjs`   | 70 | 真机：单篇端到端 + 列表/详情 CSV 导出 + 设置菜单开关 + 表头筛选（R22–R25）+ 键盘/空结果（R26–R28、R32）+ 图集编号与素材过滤（R29–R31）+ 点列头排序 / `⇅` 面板（R33）+ 空表提示不误报（R34）+ 选中整行 / `Ctrl+C` 复制（R35）+ `↑↓` 走选区（R36）+ 首次提示文案与只弹一次（R37）+ 搜索分词 / 提示回显 / 清掉连搜索一起清（R38）+ 长正文导出全文且不带按钮文案（R17b）+ `Ctrl+F` 送焦点（R6u）+ 拖列宽 / 双击自适应（R6v–R6x） |

> 数字从结果区（`<pre>`）里数出来，**不是**从整页 dump 里正则捞的：整页 dump 里
> `<script>` 源码本身含 `'PASS '/'FAIL '` 字面量，全页正则会把这些源码算成断言（虚高）。
> `flush()` 还会把 `data-tests="92 pass / 0 fail"` 写到 `<html>` 上，作为兜底读数（见踩坑 36）。
> 调试时 `FZ_DUMP=1 node check.mjs` 会把整页 dump 落到 `dump-<页面>.txt`，
> 用来确认"某条断言到底跑没跑"。

### 关键断言（都是踩过坑才加的）

```js
boardTop === .fz-thead 底边          // 表格必须紧贴表头，不能被站点内容顶下去
表格上方可见的 body 子元素数 === 0     // .fz-src（隐形的站点数据源）不算
列号格数 === 表头格数 === 每行格数     // 加列忘改列号条会立刻报（别在断言里写死 6/7）
主贴图片数 === 站点数据图数            // 防止 DOM 混进推荐位大图
出现「展开 0 条回复」= 直接 FAIL
视频笔记 → 内容列必须有「视频」入口     // 详情表没有"类型"列，别按列文本判类型
筛选后 CSV 的条数 === DOM 里可见的行数  // 筛选和导出的口径必须一致（都是"看得见的"）
新加进来的行也要受当前筛选管住         // 否则"筛完又冒出别的"（F15/F16）
点列头排序：第三次点回原序             // 清掉排序必须按行号还原，光"不再排"会留在上一次的顺序里（S4/S11）
排序只在当前这张表里发生               // 详情里排评论不能把背后首页表格的顺序带走（S19）
排序后 CSV 的第一行 === 屏幕第一行      // 所见即所得，导出必须跟着看得见的顺序（S10）
空表提示只在"真的没有行"时出现          // 有内容时冒一句，以后真出问题就没人信了（R34 / E1）
防闪期结束必须有人补一次 sync           // 静态空页面上一个变化都没有，没人会再喊 sync（踩坑 48）
点行号只选中、不会顺手把笔记打开         // 不然选区根本用不了（C2 / R35 用 sessionStorage 里的 fz-note 验）
复制的列数 === CSV 的列数                // 两条独立的路（TSV / CSV）口径必须一样，"操作"列都不进（C4 / R35）
键盘到得了每一个能点的地方             // 原生多为 <span>，tabindex 得脚本补，且必须在 innerHTML 之后（K1–K7 / R32）
Shift+↓ 要能连着长                      // 锚点不动、活口在走；只记锚点会"按了没反应"（C12/C15、踩坑 51）
0 行时不许弹首次提示                    // 空表格上提"脚本已接管"只会更让人困惑（E0b）
换页要清掉搜索框                        // 搜索是"在这张表里找"；跟着进单篇只会让评论全被藏（S5c、踩坑 53）
导出/复制要的是全文，不是屏上截的那 300 字  // 按钮文案（展开全文/展开 N 条回复）不许进 CSV（T54b/T54c、R17b）
滚到底不许发 homefeed / 不许拉评论        // 加载只认按钮；滚到底 = 读到底（v0.77，见 §49）
点按钮之后才允许出现 .fz-busy              // 没点就没加载；卡片 25s 保险丝必须能自己撤（§48）
让位时 .fz-thead 仍是 grid、遮罩铺满       // 一刀 display:block 会把表头列宽打塌（§48）
藏起来的东西不许出声（视频/实况图）        // CSS 藏了不等于不播：非播放器的 <video> 一律暂停+静音（H0–H4、巡检）
筛选条件要有作用域（类型只筛列表）        // 列表专有的列不去卡详情表，否则那个值在详情表里一个都对不上 = 整张表被藏（T22c / R8b、踩坑 57）
顺着表往下读的队列要和屏幕同序                 // 点行那一刻写（window.open 之前）；只有"从表里点进来"的笔记才给上一篇/下一篇（Q1–Q5 / R7b / R8c）
时间筛选：不知道时间的行不许藏                // "今天"=本地 0 点、其余=现在往前推 N×24h；id 推不出时间就从屏上那串时间反推（W1–W8 / R6e / R6e2 / R8d）
拼 HTML 一个属性一段                        // 把新属性插进上一个属性的引号里，浏览器会默默吃掉后面的属性（T22f / 踩坑 60）
作者面板的搜索框要"先筛再截断"                // 反过来写，「还有 N 位」就是死路；条数上限 30（A8/A9 造 40 位作者验）/ R6f
假绿的断言：本机证伪不了的别写成断言          // 无头浏览器里非表单元素 focus() 不生效 → 焦点类断言拆掉护栏也不红（踩坑 62 / A10）
作者筛选是精确匹配                        // 「小鹿」不许带出「小鹿不迷路」；选项跟着数据长出来、多的在前（A1–A4 / T22d / R6d）
```

### 真机自测怎么做的（`cdp.mjs`）

用 CDP 驱动 headless Edge，**不是**模拟环境：

```bash
msedge --headless=new --remote-debugging-port=9333 --user-data-dir=.cdp/profile about:blank
```

- `Page.addScriptToEvaluateOnNewDocument({source})` 注入脚本 → 等价 `@run-at document-start`
- 每次 `PUT /json/new` 开新标签页，跑完 `json/close`，避免重复注入
- `Runtime.evaluate` 求值、`Page.captureScreenshot` 截图、  
  `Input.dispatchMouseEvent` 发**真实**鼠标事件（验证 isTrusted 问题时用得上）
- `page` 里的 `__INITIAL_STATE__` 只读不写，**游客态也能验证绝大部分结构**

> 游客态限制：连续打开十几篇后被重定向到 `/login?redirectPath=`。  
> **清 cookie 不等于"重置配额"**：清掉之后第一次访问 `/explore` 一定会被赶到 `/login`
> （游客的 `a1` cookie 就在这一步发下来），**再访问一次**才拿得到信息流。
> 这套动作封装在 `cdp-lib.mjs` 的 `freshGuestSession()` 里，`sweep` / `real-check` 都用它；
> 两次之后仍是空信息流 = 配额真的用尽，此时记 **SKIP**，不要记 FAIL
> （否则回归天天一片红，真问题会被淹掉）。

> headless Edge **不落地** blob 下载（用最朴素的 `a.download` 试过，同样不落地），
> 所以 CSV 导出只能断言到「toast 文案 + `__fzProbe.csv()` 的文本/行数/文件名」，
> 真正的文件落地要在真实浏览器里点一下 —— 这是环境限制，不是脚本的坑。

---

## 12. 调试手段

| 手段                             | 用途                                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| `<html data-fz-why>`           | 接管状态：`ok/warmup/busy/closed/no-data/list/throw:...`                                          |
| `<html data-tests>`            | 测试页 `flush()` 写下的最终结果（`92 pass / 0 fail`），`check.mjs` 的兜底读数                                       |
| `<html data-flushes>`          | 每次 flush 的 `tag:条数`（`flush(tag)` 记的），查"汇总行为什么和结果区不一致"用                                          |
| `<html data-fz-ns>`            | 详情表内部状态（`cls/kids/in/q`）                                                                     |
| `window.__fzProbe`             | 只读函数集合：`readNotePage/readComments/readStateNote/noteParts/pickTime/badText/expandOnSite/filterState/likeNum/...` |
| `http://127.0.0.1:8125/hit?v=` | 脚本每次加载向本机上报版本，用来确认"改完到底生效没有"                                                                 |
| `data-fz-hide`                 | 标记哪个元素被我们隐藏过（让位时要还原）                                                                         |

---

## 13. 踩坑清单（按踩的先后）

1. **`__INITIAL_STATE__` 不能 `JSON.parse`** —— 它是 JS 字面量。
2. **`#detail-title` 大多数笔记不存在** —— 别拿全页 `[class*=title]` 猜，会抓到登录框标题。
3. **正文抓到导航文字** —— 必须优先 `#detail-desc`，并过黑名单（"推荐 RED 穿搭…"）。
4. **赞数列显示成日期、时间列显示成 IP 属地** —— `.date` 的文本是"编辑于 09-27 广东"，要剥属地。
5. **楼中楼永远抓不到** —— 站点默认不展开，数据只在 `subComments`（而且只给 1 条）。
6. **视频笔记被判成图文** —— `document.querySelector('video')` 会命中推荐位里的视频，只看媒体容器。
7. **1 张图的笔记列出 5 张** —— DOM 里混进了推荐位大图；state 有图后要 `imgLocked`。
8. **滚动不加载** —— 源容器被扔到视口外，IntersectionObserver 永远不触发。
9. **`.fz-src` 的 fixed 不生效** —— 被更高特异性的 `.fz-rows{position:static!important}` 压掉。
10. **源容器滚不动** —— 子元素被强制 `position:static` 后高度塌陷，`scrollHeight==clientHeight`。
11. **首页表格被顶到页面底部** —— 隐藏逻辑有个"含 explore 链接就不隐藏"的保护，  
    而 `.fz-src` 正好在 `.main-container` 里，把整块判成了卡片容器。
12. **列号只显示到 D** —— 列号数组 8 个、表格 7 列，多的那个掉到第二行被裁掉。
13. **`展开 0 条回复`** —— `subCommentCount` 是字符串 `"0"`，在 JS 里为真值。
14. **SVG 元素让 sync 每轮抛错** —— `SVGElement.classList` 是 `SVGAnimatedString`，没有 `contains`。
15. **`window.open` 被拦时不抛错** —— 只返回 `null`，写在 `catch` 里的兜底永远不执行。
16. **测试页被真跳走** —— 登出逻辑让测试用例真的执行了 `location.href`，后续断言全没跑。
17. **DOM 变了 ≠ 操作成功** —— 未登录点收藏只弹提示不改 class，据此判"成功/失败"都会错；  
    最终要看**业务数据**（账号里有没有记录）。
18. **改 innerHTML 字符串后必须抽查真实 DOM** —— 多写一个引号会生成  
    `data-total="9"" data-open="..."` 这种坏属性，`node --check` 查不出来。

19. **首页是虚拟滚动** —— DOM 只挂一屏卡片，滚过去就被换掉；只从 DOM 收行，永远只有 30 条。
20. **`.feeds-loading` 是卡片的兄弟节点** —— 只搬卡片网格，哨兵留在隐藏祖先里，`IntersectionObserver` 永不触发。
21. **拦截 fetch 别解析 homefeed** —— 一次几十条笔记的响应全量递归走一遍，主线程被按住，站点翻页直接卡死。
22. **拉取时改布局就白干** —— `position:fixed` / `transform` / 占位块都会让站点算不准"到没到底"。
23. **游客配额会耗尽** —— 连着刷十几页后连原生页面都翻不动，别误判成脚本坏了（换浏览器配置/等一会儿再试）。

---

## 14. 自动更新（可选，默认关闭）

开源版**不带头部的 `@updateURL` / `@downloadURL`** —— 不想让脚本偷偷连任何服务器，  
安装方式也改成纯手动导入（下载 `.user.js` → 拖进浏览器 / 油猴导入）。

想开自动更新，两条路：

**A. 自己托管**  
在文件头部加：

```js
// @updateURL    https://你的地址/xiaohongshu-fishy.user.js
// @downloadURL  https://你的地址/xiaohongshu-fishy.user.js
```

**B. 用仓库里的本地更新源**

```
@updateURL → http://127.0.0.1:8125/xiaohongshu-fishy.user.js
serve.mjs 每次请求实时读文件里的 @version（改完即生效，不用重启）
Tampermonkey 定期比对版本 → 自动拉新版
```

Windows 开机自启：`fishy-update-server.vbs` 放启动文件夹（纯 ASCII，WSH 按 ANSI 读），  
内部三级探测 node 路径（`.workbuddy` 自带 node 最新版目录 → Program Files → Program Files(x86)），  
并且每 2 分钟 ping 一次 `/version`，挂了自动重启。

> **降版本不会触发自动更新**（Tampermonkey 只升不降）。从高版本回退必须手动重装一次。

---

1. **断言是资产**。每修一个坑就该加一条断言，否则下次改别的地方又会踩回来。
2. **"看起来成功"不算成功**。判断功能是否实现，看最终业务结果。
3. **改紧耦合的地方要全链路抽查**：`COLW` ↔ 列号 ↔ 空白行 ↔ 断言里的列数。
4. **真实结构优先**。任何 `querySelector` 的假设，都先在真机上验证一遍再写。
24. **源列表长期留在文档流里 = 表格下面一大片空白** —— 必须"拉取时入流、结束收回"。
25. **每帧跑全套 sync** —— 站点滚动时 DOM 每秒变上百次，必须限频（现在 150ms）并给
    `collectCards` / 降级扫描各自限频，否则主线程打满、标签页会崩。
26. **别在断言里写死列数** —— 列表列数从 8 列精简到 6 列（`2026-10-28`），
    `sweep` / `real-check` 里写死的 `!== 7` 让真机回归连续多天"全红"，
    真问题反而被淹掉。现在统一改成 `行格数 === 表头格数 === 列号格数`，
    外加 `boardTop === .fz-thead 底边`、`.fz-src` 不计入"顶部残留"。
27. **首页数据里没有发布时间 / 评论数 / 收藏数** —— `noteCard.interactInfo` 只有
    `liked` 和 `likedCount`，`noteCard` 也没有 `time`。**但时间还有第二个来源**：
    笔记 id 是 24 位 hex 的 ObjectId，**前 8 位就是创建时间戳**（见 30 条）。
    评论数 / 收藏数没有替代来源，列表就不放这两列。
28. **详情表没有"类型"列** —— 视频笔记靠内容列里的「视频」入口（`.fz-vplay`）体现，
    按列文本判类型只会读到隔壁的作者名（真机上就这么误报过）。
29. **`updateLetters()` 要放在 `maybeNoteSheet()` 之后**（或补一次）—— 详情表是在
    `maybeNoteSheet` 里才建出来的，列号条/表头晚一拍才换，那一拍就是"详情行顶着列表表头"，
    实测被本地用例 T54 抓出来（它按表头拼 CSV，读到的还是列表表头）。
30. **时间不必向站点要 —— 笔记 id 里就带着**（v0.40）。id 是 24 位 hex 的 ObjectId，
    前 8 位是创建时间戳（秒）：`6abdb2dc…` → `2026-10-01 09:09`。
    2026-10-30 实测 3 篇：2 篇与站点显示**分秒一致**，差的那篇是**被编辑过**
    （站点详情显示"最后编辑时间"，id 永远是创建时间）。
    取舍：**站点给了就用站点的**（`timeTextOf()` 先看 `data.time`，且必须长得像时间），
    没给才用 id 兜底 —— 这条同时把评论行的时间也补齐了（评论 id 同样是 ObjectId，
    实测都是笔记发布之后的合理日期）。
    边界：`!24 位 hex`、时间戳落在 2020-09 之前或 2100 之后，一律返回空，**不瞎编**。
31. **探针字符串里的反斜杠要写两遍** —— `sweep.mjs` / `real-check.mjs` 的探针是
    JS 模板字符串包出来的，`\d`、`\/` 会被 Node 先"吃掉"一层反斜杠，
    注入到页面里就变成 `/^d{1,2}/d{1,2}/` 这种残缺正则（报 `missing ) after argument list`，
    而且报在 `R0 全流程未崩溃` 上，看不出真凶）。写 `\\d`、`\\/`、`\\s`。
32. **图文笔记里的"实况图"在页面上也是 `<video>`** —— 只按"媒体容器里有 video"判类型，
    会把图文笔记标成视频（真机巡检抓到"见识到了大闸蟹真的很寒"这一篇）。
    类型以**站点数据**为准（`readStateNote().type`），DOM 只在站点没给时当兜底；
    本地 T56 就是拿"轮播里塞一个 video + state 写成 normal"复刻出来的。
33. **`boot()` 在 `<head>` 里执行时 `document.body` 还不存在** —— 它靠 `setTimeout(boot, 60)` 重试，
    所以页面里紧跟脚本的同步断言（解析期、甚至 `load` 都可能先到）会看到"什么都没有"，
    看着像脚本没接管。`test-off.html` 第 2 趟就等了 900ms 再断言。
    （同理：本地用例页必须让 `<script>` 先设 `window.__FISHY_DEMO__ = true`，
    否则第 31 行的 `!DEMO && !HOST_OK` 直接 return，页面"干净"得让人误判成功能正常。）
34. **"临时关闭"的标记不能在 reload 之后又被设一遍** —— `test-off.html` 第 1 趟设
    `sessionStorage['fz-off']`，靠另一个 `fz-off-done` 挡住第 2 趟再设，否则每次刷新都把自己
    关回去，"恢复"那一步永远看不到（表现是 O3 一直红，而 O1/O2/O4 全绿）。
35. **自己画的浮层会被自己"藏站点元素"的启发式吃掉** —— 设置菜单是固定在右上角的
    261×164 面板，正好满足 `hideSideBars()` 里「右侧悬浮按钮组」的条件
    （`position:fixed` + `left > vw-280` + 高 < 500 + 宽 40~340 + 高 ≥ 60），
    打开约 600ms（下一次 sync）后被当站点控件 `display:none`。
    现在的规矩是**一个收口**：`hideEl()` 进来先 `isOurs(el)`，
    `isOurs` = `el.closest('.fz-chrome,.fz-notesheet,.fz-viewer,.fz-board,.fz-menu,.fz-toast')`，
    所有 hide* / fitModals 的判断也都换成它。
    发现过程也值得记：R19 只断言"面板存在、有 4 项"，全绿；是**两张截图字节数一模一样**
    （菜单开着 == 菜单关着）才暴露的 —— 所以 R19b 特意在 1.8s（十几轮 sync）之后再验一次
    "还在屏上、还点得到"，本地 T68~T70 钉住"自己的不许藏 / 站点的照样藏"。
36. **汇总行写在异步链中间 = 报了假数字**（v0.42，测试自己的坑）。`test.html` 里
    `flush()` 本来压在 `snakeCaseTest()` 同步段的末尾；v0.42 在它前面插了一条 `waitFor` 异步链
    （新进来的行要不要受筛选管，见 §17），于是顺序变成
    `… 76 条断言 → flush('tail') 写下「76 pass」→ 异步回调再补 16 条断言`。
    结果区（`ok()` 每次都整块重写）最后是 92 行、汇总行却写 76 —— **两个数字单独看都对，合起来骗人**。
    两处修：`flush()` 移到异步链最末尾；`check.mjs` 的数字改成**只从结果区 `<pre>` 里数**
    （整页 dump 的 `<script>` 源码里有 `'PASS '/'FAIL '` 字面量，全页正则会把源码算成断言，
    之前报的"96 条"里有 4 条就是这么来的）。`flush()` 另外把 `data-tests="92 pass / 0 fail"`
    写到 `<html>` 上兜底，`flush(tag)` 把每次 flush 的 tag+条数记进 `data-flushes`，
    "哪次 flush 报了多少"一眼可见 —— 这次就是靠它定位的。
37. **加行的地方有两处，别只改一处** —— 列表行有两个建行入口：
    DOM 卡片路径（`buildRow`）和数据看板路径（`appendBoardRow`，`innerHTML` 里是
    `.fz-cells` + `cellsHtml()`）。v0.42 把筛选要用的 `data-fz-type` / `data-fz-like`
    只加在了前者上，本地用例里所有行都落进"类型 = 笔记"一个桶（F4 直接红），
    真机上则会出现"有的行能筛、有的行筛不动"。现在两处都走 `stampRow(el, d)`。
    顺带记一下：看板行的类名是 `fz-row fz-brow`，**它同时匹配 `.fz-row`** ——
    按 `.fz-row` 数行会把两条路径混在一起，别以为只有一条路。
38. **点表头是 toggle，不是"打开"**（v0.43，真机 R26 红了一次）—— 筛选面板的入口
    写的是"同一个键再点一下 = 关掉"。R25 点「全部」清条件时**面板是故意不关的**
    （和 Excel 一致，清完还能接着选），于是 R26 再点一次表头正好把它关了，
    探针读到 `选项 0 个`、`起手高亮=null`。规矩：**凡是点开关的断言，动手前先
    `closeFilter()` 把状态收到确定值**，别依赖上一条断言留下的状态。
39. **探针里"点一下"和"量一下"的顺序**（v0.43，真机 R27 红了一次）—— 同一个
    `Runtime.evaluate` 里我写了 `if (x) x.click();` 然后在 `return {}` 里数可见行，
    读到的当然是**点完以后**的数字（32 行），断言 `vis === 0` 就假红。
    规矩：**要断言的点前值，必须在点击之前存进变量**；`return` 里的表达式是最后才求值的。
    （这类错在探针里特别隐蔽：日志看起来"页面明明是对的"。）
40. **本地 fixture 的形状不等于真机的形状**（v0.44）—— 图集翻页本来想写在首页用例里，
    结果本地 demo 每行只有 1 张图（探针吐 `最多只有 1 个图链接`），一条断言都立不住；
    真机首页每行**也只有 1 张真封面**。之前看到"一行 2 张"，其中一张其实是站点素材图
    （见第 42 条）。教训：**写断言前先用探针把真机的形状读出来**（每行几张图、标签长什么样），
    再决定用例挂哪儿 —— 这组的归宿是详情页主贴行（6 张图）。
41. **探针里链式取值要判空**（v0.44）—— `v.src.slice(0,60)`：查看器没打开时 `viewerInfo()`
    只返回 `{open:false}`，于是探针抛 `TypeError`，cdp 记的是 `"__error"` 而不是断言红 ——
    看起来像"这一步挂了"，其实是"这一步的前提没成立"。规矩：探针里一律 `(v.src||'')`，
    并且**显式返回形状**（`{noLink:1}` / `{few:2}` / `{multi:0}`），让失败一眼能读。
42. **站点自己的静态资源域不是"笔记图片"**（v0.44）—— 卡片的 `<img>` 里混着
    `picasso-static.xiaohongshu.com/fe-platform/…`（角标/占位/播放图标），尺寸还过了
    `minImgSize` 那道线，于是被当成"第 2 张封面"，点开是张素材图。
    内容图的域名是 `sns-webpic*` / `sns-img*` / `*.xhscdn.com` / `ci.xiaohongshu`；
    `isPhoto()`（页面降级路径）早就只认这些，但 `imgList()`（卡片取图）当时只挡了头像和尺寸 ——
    **同一件事的两处判定口径必须一致**。现在统一走 `isSiteAsset()`。
43. **PowerShell 5.1 的 `Get-Content` / `Set-Content` 会把 UTF-8 文件写成乱码**（v0.45，代价最大的一次）——
    只想给两个文件改几行字符串，于是写了 `(Get-Content -Raw) … .Replace(…) … Set-Content -Encoding UTF8`：
    PS 5.1 读文件按 ANSI（CP936）解码、写文件又加 BOM，一个来回之后 `test.html` 里
    **225 行中文全变乱码**（`测试` → `娴嬭瘯`），更狠的是**有些换行被吃掉** ——
    换行一没，`// 注释` 就和下一行代码并成一行，**那行代码等于被注释掉了**
    （`if (i === 7) …` 一行 `video` 卡片没了，本地用例只剩 5 条断言在跑）。
    规矩：**动仓库里的 UTF-8 文本只用编辑工具或 Node/Python 显式 UTF-8**
    （`.NET` 的 `[System.IO.File]::ReadAllText(p, [Text.Encoding]::UTF8)` 也可以），
    `Get-Content` / `Set-Content` 一概不碰。
44. **乱码能捞回来：会话记录本身就是一份完整流水**（v0.45）—— 修上面那次事故试了三条路：
    编辑工具/Node 逐条改（文件已坏，改不动）、`.git`（这台机器没有 git 可执行文件）、
    阴影副本（OneDrive 的云端占位符在只读卷上读不出来）。
    真正救回来的是**会话记录** `%USERPROFILE%\.dsh\sessions\…\session.v4.jsonl.zstd`：
    多帧 zstd（按魔数 `28 B5 2F FD` 拆帧），每条 `read` / `write` / `edit` 的参数都是原样文本。
    用它按"行号 + 骨架"回填：`test.html` 225 行坏行修回 191 行，剩下 34 行按上下文重写
    （重写完比对 ASCII 骨架，确认只多回了被吃掉的 `<` `'` `)` 这类字符，代码一个字没动），
    跑出来 114 条断言全绿。`real-check.mjs` 更省事：记录里有一次 `write` + 31 次 `edit`，
    按序重放即得原文；再用坏文件的"反解版"做逐字符比对，差异只剩坏文件自己丢的那几个字。
45. **无头窗口里 `:focus` 永远不匹配**（v0.45）—— 键盘可达性要断言"焦点描边真的画出来了"，
    可 headless Edge 里 `document.hasFocus() === false`：`:focus` 规则压根不生效，
    量到的永远是 `outline: none`（看着像样式没写，其实是环境）。规矩：**能从样式表读到的规则就断言规则**
    （遍历 `document.styleSheets` 找 `[data-fz-filter]:focus` 那条，读 `outlineStyle/Width/Color`），
    只有 `document.hasFocus()` 为真时才补一次实测 —— 环境限制不该记成功能红。
46. **"已经在位"就别动 DOM**（v0.46）—— 排序挂在 `applyFilter()` 里（这样新加载的行也自动就位），
    而 `applyFilter()` 每次 `sync()` 都会跑；如果每次都 `insertBefore` 一遍，即使顺序没变也会产生
    mutation，`MutationObserver` 又踢一次 `sync()` —— 自己把自己转起来（和「空结果提示」那次同款）。
    规矩：**先算出想要的顺序，和现状逐项比对，一样就一个 DOM 都不碰**。
47. **一个点击只能干一件事**（v0.46）—— 「赞」这一格既是"点赞数筛选"的入口（点一下出面板，R22–R26 钉着），
    又想做成"按赞排序"的入口：两个都很常用，抢同一个点击就一定有一个永远没人发现。
    最后是**拆开走两条路**：列头点击归筛选（`click` 里先判 `[data-fz-filter]`），排序走工具栏的 `⇅` 面板；
    列头仍然挂着 `data-fz-sort="like"`，只用来画 `▲▼`。样式上两个箭头得能同时看见
    （`content:"▼▾"`，见 §20）。
48. **没人再喊 sync 的地方，得自己定闹钟 —— 而且别用 rAF**（v0.47，`test-empty.html` 第一次跑就红）——
    空表提示有 2 秒防闪（刚进页面不该弹），可"没有任何行"的页面**恰恰没有任何 DOM 变化**：
    第一轮 sync 在 60ms 时跑完（防闪期内不出提示），之后就再没人喊 sync 了 —— 提示永远不出现。
    补了个"防闪期结束时补一次"的闹钟，但第一版闹钟调的是 `schedule(true)`，
    而 `schedule` 末尾是 `requestAnimationFrame`：**无头 + `--virtual-time-budget` 下 rAF 不一定跑**
    （"加载更多"那套也踩过），真机静态页更没有下一帧来救场。改成闹钟里直接 `sync()`（`boot()` 也这么干）。
    本地 fixture 里量到的现象很干脆：`nodataGate()` 里 `need=false`（因为 total 被 E9 自己塞的卡片顶成了 1），
    加上 `pageAge=5125` —— 把"每一道闸门摊开给探针看"之后，一眼就定位了。
49. **想加新的点击行为，先找没人占的落点**（v0.48）—— 整行已经被"点开笔记"占着（本地 C2 / 真机 R35 钉着），
    "赞"那格被筛选占着（踩坑 47）。"选中整行"最后落在**行号格**上：它是 Excel 里唯一的行头，
    而且没有别的东西在用它。实现上在**捕获阶段**判 `.fz-num` 并 `stopPropagation()` ——
    行自己的 `click` 在冒泡阶段，拦得住；要是在冒泡里判，行早就把笔记打开了。
    加完之后立刻要问一句："这个新落点会不会顶掉老行为？"（本地 C2 + 真机 R35 都用
    `sessionStorage.fz-note` 反过来验"点击没有开笔记"。）
50. **断言里比 id / 序号，先统一类型**（v0.48，C7 第一次跑就红）—— `rowOrd()` 返回数字、
    `numOf()`/DOM 文本返回字符串，`3 === "3"` 永远是 false，报错信息里看着还都对
    （"选中 1 行（行号 3）"）。同一批断言里 C3 侥幸过了，因为它用 `join(',')` 比 —— 那是字符串。
    要么统一 `String(...)`，要么两边都取 DOM 文本。
51. **"锚点"和"活口"是两个位置，别用一个变量**（v0.49，C15 当场红）—— 范围选择有两头：
    固定不动的锚点、在走的那一头。只记锚点的话，第二次 `Shift+↓` 算出来还是"锚点 +1"，
    于是按了两下还是 2 行 —— 用户会觉得"按了没反应"。改成 `SELROW`（锚点）+ `SELFOCUS`（活口），
    `selectRows(row, to)` 末尾顺手 `SELFOCUS = to || row`，Shift+点击 和 Shift+方向键 就都对了。
52. **筛选的口径是"含端点"**（v0.49）—— 赞筛选是 `赞数 >= 阈值`。写用例想"把某一行筛掉"时，
    阈值得取 `那一行的赞数 + 1`；取等值筛不掉（C13 第一次跑就是这么红的：
    "第 1 行（赞 8642）筛掉=false"）。从用户视角看，写 1000 就是"1000 的也要"，这正是他们要的，
    所以要迁就这个口径的是**用例**，不是反过来改功能。
53. **一个 `show` 数两张表，详情页的空态提示就永远出不来**（v0.50）—— `applyFilter()` 数的是
    `.fz-row, .fz-nrow` 全部可见行，`.fz-empty` 的条件是 `filterOn() && show === 0`。
    于是"列表搜索词跟着进了单篇、评论一条都不命中"时：评论全被藏起来（看着像没加载出来），
    可列表那几行还可见 → `show ≠ 0` → **提示一个字都不冒**。两条一起修：
    ① 换页时清掉搜索框（`clearSearch()`，跟 §22 的 `clearSel()` 同一个位置）；
    ② `.fz-empty` 的文案里回显搜索词（「没有符合条件的行（搜索「×」）」）。
    教训：**"空"是相对哪张表说的** —— 共用一个计数时，先想清楚"谁的空"。同理，
    改 `emptyEl.innerHTML` 之后必须再 `markKeyboard(emptyEl)`（踩坑 6 的老坑，这次差点又栽）。
54. **`querySelector('.fz-link')` 拿到的是"第一个链接"，加个链接就换人了**（v0.51，T20/T21 一起红）——
    给长正文行加了「展开全文（N 字）」之后，详情表里第一个 `.fz-link` 从「图01」变成了
    「展开全文」，于是"点图01 看原图"点到了别的东西，图集翻页那 4 条跟着全红。
    产品代码本来就有这道防线（`bindLinks` 里 `a.dataset.i === undefined` 直接 return），
    是**用例**少了同一道：挑元素要挑特征（`.fz-link[data-i]`），不能靠"第一个"。
55. **CSS 藏起来 ≠ 不出声**（v0.52）—— `display:none` 的元素里的 `<video>` 照样在播、照样出声。
    摸鱼时**突然冒出视频声音**，比屏幕上多一张表格危险得多（表格好歹还像工作）。
    做法：在"藏元素"的同一个函数里顺手暂停 + 静音（`hideEl` 里一行），每轮 `sync` 再兜一遍 ——
    因为站点还有**别的藏法**：自己用 CSS 规则直接 `display:none` 的容器不经 `hideEl`；
    瀑布流卡片的 `<video>` 还是"悬停才创建"的（见 `guessType` 那段注释）。
    唯一不碰的是**用户自己点开的播放器**（`.fz-vbox` 里那个）—— 那是他自己要看。
56. **"整段包含"这种断言，会在真机上挑着数据挂**（v0.52，R17b 连挂两次）——
    用 `csvText.indexOf(正文全文)` 判断"导出里有全文"：第一次挂在**引号转义**上
    （正文里有 `,` / `"` 时 CSV 字段要加引号、内部引号翻倍），
    第二次挂在**空白归一化**上（`cellText` 把空白压成单空格，`data-full` 是原始正文，带换行）。
    教训：比字符串之前先**统一口径**（比解析后的字段，或两边用同一套归一化），
    否则这条断言只在你恰好抽到"干净"那条数据时才是绿的 —— **偶发绿比偶发红更坏**。
57. **筛选条件跨表误伤：一张表专有的列，别拿去卡另一张表**（v0.53，T22c / R8b 一起红）——
    `rowHit` 里的 `FILT.type` 是不带条件的：只要类型筛选有值，就把**所有**行按 `fzType` 卡一遍。
    可 `fzType` 只有列表行有（`stampRow` 只在列表那两条建行路径上跑），详情表（主贴 + 评论）
    压根没有"类型"这一列 —— 于是"在列表上筛了类型、再进笔记"，**整张详情表 24 行全被藏**，
    看着就像评论没加载出来（和踩坑 53、§24 是同一类错觉）。
    修法：类型筛选只筛 `.fz-row`（列表专有的列），赞 / 搜索两边都生效。
    教训：**给筛选条件加"作用域"** —— 先问这张表里到底有没有这一列，
    再问"这个值在另一张表里一个都对不上时会怎样"（答案就是全藏）。
    > 真机那条还多一层教训：R8b 第一版是在**列表页**设好类型筛选再 `navigate` 去笔记页 ——
    > 全页导航会重建脚本状态，内存里的筛选条件已经没了，这条断言就永远绿（**假绿** ✗）。
    > 得在**详情页上**把筛选置上（真实路径是"让位给原生界面时同页点开笔记"）才真的在测东西；
    > 红检时它的报错是「详情 24 行 · 被藏 24 行」。

58. **空结果别缓存**（v0.55，Q1 一开始就红）—— `buildTokenMap()` 原本是 `if (tokenMap) return tokenMap;`，
    抓到空表也会一直缓存着。真机上 state 是后到的（SPA 切页 / 接口慢），第一遍什么都没抓到之后，
    **这一趟会话就再也不去 state 里找 token 了** —— 之前没炸，是因为卡片自己的 `xsec_token` 链接
    （第二级兜底）把跳转救回来了；而 v0.55 的"顺着表往下读"必须**每行都拿到 token** 才进队列，
    于是立刻暴露：队列永远 0 条。
    修法：`if (tokenMap && Object.keys(tokenMap).length) return tokenMap;` —— 空表不算结果。
    教训：**缓存要区分"答案是没有"和"还没拿到"**（同一个理由也适用于任何"首次调用就去抓数据"的地方）。

59. **一个动作两个入口：只挂了一条建行路径**（v0.55，Q5 / R7b 红）—— 列表行有两条建行路径：
    `buildRow()`（站点卡片那条）和 `appendBoardRow()`（数据面板那条，走 `openNoteById()`）。
    我把"点行时记队列"只加进了前者的 click 处理，Q5 一跑就是「队列 0 条」：测试页的行是
    **数据面板**那条建的。
    修法：两条都挂（`buildRow` 的 click 里 + `openNoteById()` 开头），一行调用不重不漏。
    教训：**给"某个动作"加副作用之后，grep 一遍这个动作的所有入口**
    （`__fishyDemoOpen` / `openNote` / `openNoteById` 这类名字就是入口清单）。
    > 附带收获：红检时只关掉 `openNoteById()` 那一处，真机 R7b 照样红 —— 说明**真机上现在走的是
    > 数据面板那条路**（卡片那条是兜底）。这类"哪条路在跑"的问题，红检比读代码快。

60. **拼 HTML 时把新属性插进了上一个属性的引号里**（v0.56，真机 R8d 红、本地全绿）——
    给主贴行加"时间戳属性"时我写成了
    `'... data-fz-like="' + esc(likes) + (function(){ return ' data-fz-ms="' + ms + '"'; })() + '" data-fz-author="' + ...`
    —— 那个 `data-fz-ms` 落在了 `data-fz-like` 的引号**里面**。浏览器不报错，它安静地把
    `data-fz-like` 解析成「1.2万 data-fz-ms=」，后面的 `data-fz-author` 也跟着被吃掉。
    真实症状：**主贴行的作者和时间戳都没了**（详情页"只看这个人的评论"就永远漏掉主贴行）。
    本地测试为什么没红：作者筛选那几条断言算的是"可见行都对得上 + 比总数少"，
    主贴行被漏掉恰好也满足（**假绿**）。
    抓它的是那条"把症状量出来"的断言：真机 `R8d`「主贴行带时间戳」直接报 `主贴有时间戳=false`。
    修法：一个属性一段拼（`' data-fz-x="' + v + '"' + ' data-fz-y="' + w + '"'`）。
    教训两条：
    ① **动态拼 HTML 时，属性和值都要成对写出来**，别在值后面直接接下一个片段的 `+`；
    ② 断言要**检查值本身干不干净**，不能只检查"逻辑上对不对" —— 因此补了 `T22f`：
    主贴行的 `data-fz-like / data-fz-author / data-fz-ms` 必须分别是"不含空格的数字串、
    作者名、13 位毫秒"，红检时报错正是 `like=「1.2万 data-fz-ms=」· author=「小鹿不迷路><div class=」`。

61. **模板字符串里的正则反斜杠只写了一份**（v0.56，`R33` 一跑就 `SyntaxError`）——
    `real-check.mjs` 里 `cdp.evaluate(\`...\`)` 用的是**模板字符串**，我往里塞了一条
    `match(/^(\d{1,2})\/(\d{1,2}).../)`。模板字符串会**先**处理转义：`\d` 变成 `d`
    （不报错，正则悄悄失效 —— 最坏的那种），`\/` 变成 `/` —— 正则字面量**提前结束**，
    整段脚本 `SyntaxError: missing ) after argument list`。症状很有迷惑性：
    真机汇总从 49 掉到 44 且只报 `R0 全流程未崩溃`，因为异常把后面几条断言全带走了。
    规矩：**写进模板字符串（或任何字符串）的正则，反斜杠一律双份**（`\\d` `\\/` `\\s`），
    改完先 `node --check` 再 `node --check` 也检查不出内容级错误 —— 所以要靠真机跑一次。

62. **写了一条本机根本证伪不了的断言（假绿）**（v0.57，`A10` 拆了护栏也不红）——
    给"搜索框里 ↑↓ 挑选项"写断言时，我顺手断言了"焦点留在搜索框里、没被抢到条目上"
    （那正是我加的护栏要防的）。红检把两处护栏全拆掉 —— `A10` **照样绿**。
    原因：无头浏览器里 `document.activeElement` 对**非表单元素**的 `focus()` 不生效
    （`<input>` 生效、`<div tabindex=0>` 不生效），所以 `stillInput` 恒为 true，这条断言
    永远不可能失败。改法：断言只留**本机能证伪**的部分（高亮确实移了一格、回车确实生效、
    搜索词确实留在框里、重画面后还能接着打字筛），焦点那两项降级成**打印出来的实测值**，
    并在实现文档里写明"这条在本机证伪不了"。教训：**加断言之后先想办法让它红一次** ——
    红不了的不是资产，是装饰。

63. **自己画的 UI 被当成了站点的元素**（v0.57，潜伏已久、这轮才碰响）—— `hideTopSearch()` 用
    `input[placeholder]:not(.fz-search)` 找站点顶部搜索框。作者面板新加的搜索框**也带
    placeholder**，于是命中它、然后拿它的祖先去做 `display:none`。当时 `isOurs()` 挡住了真正的
    隐藏，但 `searchDone` 被提前置真 —— 后果是**站点的搜索框以后再也不隐藏了**（摸鱼时露出来），
    而且换个祖先尺寸就会误伤面板本身。
    规矩：**凡是按"站点长什么样"写的选择器，都要显式排除我们自己**（`:not(.fz-*)` +
    `closest('[data-fz-menu-panel]')` 兜一层）。`document.querySelector` 是全文搜索，它不认识
    "这是谁的界面"。

64. **断言里读的是活节点，"当时的值"会被后面的代码改掉**（v0.57，`A13` 因此假红）——
    我在同步后拿到 `var box = querySelector('.fz-minput')`，然后在 `ok(...)` 的**消息里**再读
    `box.value`。中间那几行把搜索框清空了，于是断言拿到的是"清空之后"的值，看起来像产品坏了。
    规矩：**要断言某个瞬间的状态，就当场把它抄成字符串/数字**（`var v = box.value`），
    别把 DOM 引用留到断言甚至消息里 —— 消息里更不该读活节点。    同一类坑还有个变种：**跨时刻比较**。真机上 feed 一直在流进来，我拿"渲染那一刻的列表条数"
    和"几毫秒后读到的作者总数"去比对，本机连续撞了两次（30 位 vs 34 位）。期望值要么取自
    **同一次渲染**，要么就别在真机上断言 —— 上限/「还有 N 位」这类跟数据规模有关的文案，
    交给本地用造出来的数据钉死（`A8`/`A9`：40 位作者，同一时刻同一份数据）。

### 6.6 取数方式（v0.35 定稿）：回到原生页 + 前台遮挡

```
点「加载更多」
  ├ makeCover('.fz-board')   把当前看到的表格 clone 一份钉在顶层（+「正在加载…」悬浮提示）
  ├ yieldToSite()            收起我们的层，原生页回到正常布局（源列表 unmark 回原位）
  ├ 原生页分段滚（先退回上方三屏，再 0.55 屏/320ms 往下推）
  ├ resumeFromSite() + dropCover()
  └ collectCards(true) → 重画；有增量就报"新加载 N 条"，没有就报"站点没给新内容"
```

为什么这么做：

- 之前那套"把源列表塞进文档流"会改站点几何，翻页全看它心情；**原生页本来就是原生布局**，是它最认的状态。
- 用户全程只看到 clone 出来的旧画面 + 一行提示，不会看到原生小红书。
- 详情页同理；并且**详情改成新标签页打开**（`window.open`），因为 SPA 切换会让原生详情被我们自己的隐藏规则连带 `display:none`（尺寸 0 → 滚不动），新标签页是干净整页，详情渲染在 body 层。

风险与对策：

- clone 大表耗时 → 克隆前不做深度处理，且 cover `pointer-events:none` 防误点。
- 失败即停：9s 看门狗，失败退避 6s→12s→…（上限 60s），不重试、不再"让位"给用户看。
- `window.open` 需要点击手势，且 URL 必须带 `xsec_token`（否则 404）。

---

## 15. 导出 CSV（v0.39 起）

伪装成 Excel 的表格，最实在的出口就是**真的给一份 Excel 能打开的文件**。全程本地，不碰任何接口。

```
Ctrl+Shift+E / 点工具栏的 ⇩
  └ buildCsv()   从当前视图读表（详情表优先，其次 .fz-board）
       ├ 表头取 .fz-thead（列表 6 列 / 详情 7 列），首格空 → 写成「行号」
       ├ 逐行读 .fz-c 文本，空白折叠成单空格
       ├ 跳过滤镜隐藏的行（.fz-hide）——所见即所得
       ├ 跳过「操作」列（赞/收藏/回复是给人点的，导出去没意义）
       └ csvOf(rows, head) 拼文本：字段含 ," 换行 → 加引号、引号翻倍
  └ Blob + a[download] 落地：工作簿1-YYYYMMDD[-笔记].csv（UTF-8 BOM）
  └ toast「已导出 N 行 → 文件名」
```

设计取舍：

| 点 | 做法 | 为什么 |
|---|---|---|
| 编码 | 文本开头写 `\ufeff` | 不写 BOM，Excel 打开中文就是乱码（WPS 也认 BOM） |
| 换行 | `\r\n` | CSV 规范（RFC 4180），Excel 最稳 |
| 读 DOM 而不是读数据源 | 直接读 `.fz-c` 文本 | 列表行来自 DOM+state 合流，直接读渲染结果才是"你看到的" |
| 纯函数与落地分离 | `csvOf()` 纯函数、`buildCsv()` 读 DOM、`exportCsv()` 只负责下载+提示 | 前两个能直接断言，测试里不用真的触发下载 |
| 命名 | `工作簿1-20261030.csv` | 和伪装的文件名一致；详情页加 `-笔记` 防覆盖 |

排障：`window.__fzProbe.csv()` 返回 `{name, text, count, detail}`，**只看不下载**。

---

## 16. 设置菜单（v0.41 起）

`CFG` 一直都在，但改它只能去改代码或记住没写在界面上的快捷键 —— 这是"最后一步不好用"。
工具栏最右的 `⋯` 就是 `CFG` 的入口（`data-fz-menu` → `.fz-menu` 面板）：

| 菜单项 | 落到哪 | 立刻发生什么 |
|---|---|---|
| 首页表格模式 | `CFG.tableMode` | 开：`markSource()` + `lastAnchorCount=-1` + `schedule(true)`；关：见下 |
| 详情页接管 | `CFG.detailSheet` | 关：关掉已经开着的详情表；开：`schedule(true)` 重新接管 |
| 换个文件名 | `CFG.docTitle` | 在 5 个预设里轮换，`.fz-file` 和 `document.title` 一起变 |
| 导出 CSV | — | 等于 `Ctrl+Shift+E` |

改完写 `store.set()`（有 `GM_setValue` 就用它，没有退化成 `localStorage['fz:*']`），刷新还在。
`__fzProbe.cfg()` / `setCfg(k, v)` 走的是同一条路，测试和菜单调的是同一份代码。

### 关掉表格模式 = 真的"退回原生页面"

这是这一版最容易做错的地方，**只把 `fz-table` 摘掉是不够的**：

```
applyTableMode(false)
  ├ html.fz-off          伪装层整块收掉（CSS：.fz-chrome/.fz-board/.fz-notesheet/.fz-filler…）
  │                      + body 的 padding-top/bottom 还回去
  ├ unmarkSource()       源列表搬回原位（不还回去，原生页面里列表是空的）
  ├ unhideSite()         之前被 hideEl() 藏起来的站点元素全部还原（data-fz-hide）
  ├ 清 .fz-rows / .fz-filler / .fz-pullmask
  └ dropFavicon() + applyTitle()   图标和标签页标题也还给站点
```

而且 `sync()` 在最前面就分流：`!CFG.tableMode` 时**只**处理"详情页接管"这一项，
`hideSiteHeader()/hideSideBars()/…` 一个都不许跑 —— 跑了原生页面就缺头少 sidebar。
两个开关是独立的：可以"不要表格、但详情页还是要接管"。

排障：`window.__fzProbe.cfg()` 看状态，`setCfg('tableMode', true/false)` 手动切回来。

自己画的浮层必须躲开"藏站点元素"那套启发式：`hideEl()` 收口在 `isOurs()` 上（见踩坑 35）。
菜单打开后至少等一轮 `sync`（150ms）再断言可见性，否则测试会假绿。

### 顺手修的：`Alt+Shift+T` 以前关得掉、开不回来

"临时关掉"那一档（`sessionStorage['fz-off'] = '1'`）是脚本**第一个**检查的东西，命中就 `return`——
连 `bindKeys()` 都没跑到，于是只能开 devtools 删 key 才回得来。现在这一档自己会绑一个最小监听：
再按一次 `Alt+Shift+T` → 清 key → `location.reload()`，另外挂 `window.__fzOff.resume()` 给控制台用。
`test-off.html` 专测这条回路，靠 sessionStorage 把第 1 趟的结论带到 reload 之后的第 2 趟：

```
第 1 趟  fz-off=1     → O1 页面 100% 原生（没有 .fz-head、html 上没有 fz 类）
                        O2 有 __fzOff.resume 这个恢复入口
                        O4 按 Alt+Shift+T → 标记当场被清掉（reload 是下一个任务才发生）
                        ↓ 脚本自己 reload
第 2 趟  fz-off=null  → O3 脚本重新接管，伪装层回来了
```

写这个页面踩到两个坑，都是"测试自己的坑"，记在 §7 里（boot() 的 60ms 重试、以及别把标记在
reload 之后又设一遍）。

---

## 17. 表头筛选（v0.42 起）：Excel 的"自动筛选"

伪装成 Excel，就不能只有"看起来像"：一列数据能不能像 Excel 那样点表头就筛，
是这类工具最容易露馅的地方。v0.42 把 `赞`、`类型` 两列做成了自动筛选。

```
点表头「类型 ▾」→ .fz-filtmenu（和设置菜单共用 placePanel / [data-fz-menu-panel] 语义）
  ├ 选项从当前数据长出来：typeOptions() 现数一遍行上的 data-fz-type
  │   「全部类型 31 / 图文 23 / 视频 8」—— 不写死"图文/视频"，站点多出类型也照列
  ├ 「赞 ▾」是档位：全部 / ≥100 / ≥1000 / ≥1万（likeNum() 解析 "1.2万"→12000、"9871"→9871）
  └ 选中 → setFilter() → applyFilter() → 行上挂 .fz-hide + 状态栏写「筛选 N/M 行」
```

设计取舍（都是有理由的，别随手改）：

| 决定 | 为什么 |
|---|---|
| 条件只存内存（`FILT = {type, minLike}`），**不**进 `store` | 刷新后剩一个"筛过的表格"看起来像**数据丢了**，比"筛选没记住"糟得多 |
| 行号保留原编号（筛完可能是 1、3、7…） | Excel 就是这样的；重排行号会让人以为表格里只剩这些数据 |
| 类型/赞写在行上（`data-fz-type` / `data-fz-like`），不在筛选时回头猜 DOM | 详情页的 `.fz-d` 是 IP、不是类型，按类名认列一定错（踩坑 28 的同类问题） |
| 表头的 ▾ 用 CSS `::after` 画，**不进 textContent** | CSV 表头是直接读 `.fz-thead` 文本的，插个 `<span>` 或 `▾` 字符就会把 `▾` 导进 CSV |
| 认不出的赞数（`"赞"`、空）→ `likeNum()` 返回 `null`，设了阈值就**排除** | 宁可少一行，也不要拿"猜的数字"参与比较 |
| `applyFilter()` 挂在 `sync()` 末尾 | 滚动加载 / 接口补进来的新行会自动跟着筛，不用到处插调用（F15/F16 钉这条） |
| 「全部」清掉后**面板不自动关** | 和 Excel 一致：清完还能接着选另一个条件；点别处 / `Esc` 才收 |

排障：`window.__fzProbe.filterState()` 看条件、`setFilter('like','10000')` 手动设、
`clearFilter()` 清干净。真机断言是 R22~R25（▾ 真的画出来了、选完没有混进来的行、
CSV 条数 == 可见行数、清掉后状态栏回到「就绪」）。

2026-10-30 真机实测（游客态 31 行）：类型选项 `全部类型 31 / 视频 12 / 图文 19`，
选「视频」→ 可见 12 行、混进来的 0 行、`筛选 12/31 行`、`csv().count === 12`；
4 张截图（收起 / 面板开着 / 筛完 / 清掉）用 Pillow 对比：
面板只改到表头下方 `(0,121)-(209,281)` 那块（1.21% 像素），筛完整表变化 8.97%，
**清掉之后与收起时逐像素完全一致（0.00%）** —— "筛完能原样退回来"是量出来的，不是眼看的。

详情页走的是同一个 `applyFilter()`：`.fz-nrow` 也在它的选择器里，
详情表头的 `赞` 列同样挂 `data-fz-filter="like"`（详情没有类型列，第 2 格是作者，别照抄索引 ——
`FILTERABLE` 在详情是 `{1:'like'}`、在列表是 `{1:'like',2:'type'}`）。
本地 T22b 拿 demo 的评论赞（32/3/15 vs 主贴 1.2万）验过：门槛 1000 时 1/5 行可见、清掉回到 5 行。
状态栏统计的是**所有被筛的行**，所以详情页开着时那个数字是"列表 + 详情"的总数（实测 11/15）。

### 17.1 让"筛"这件事不至于把人卡住（v0.43）

三处补的都是"用了才知道缺"的东西：

| 补什么 | 为什么 |
|---|---|
| 菜单底部写全快捷键（含 `Ctrl+Shift+X`） | 以前只有 README 里有，界面上看不见 —— **最常用的那条没人知道 = 等于没做** |
| 筛选面板 `↑`/`↓` 移动、`Enter` 生效 | 打开面板时自动高亮当前生效项；鼠标用户无感，键盘用户少一次瞄准。焦点在输入框里时不抢键（否则搜索框里按方向键会跳选项） |
| 筛到 0 行 → 表格顶上一行「没有符合条件的行 · 清掉筛选」 | 全被筛掉时只剩补白空行，看着像脚本坏了；`paintEmpty()` 只在真的空时挂，且**已在树上就只挪位置、不删了重插**（否则每轮 sync 都产生 mutation → 死循环） |

`paintEmpty()` 挂在 `paintFilter()` 里（每轮 sync 都跑），所以它必须"idempotent 到不产生 DOM 变更"。
截图量化（真机 33 行）：菜单打开只改右上角 `(1128,46)-(1440,268)`（2.69% 像素，比 v0.42 高了
一截就是因为多了快捷键那几行），键盘筛完整表 5.9%，筛到空 14.14%，
**清掉之后与列表初始状态逐像素一致（0.00%）**。

断言：本地 `F15b`~`F15e`（一打开就有高亮 / ↑↓ 移动 / 回车生效 / 输入框里不抢键）、
`F16b`~`F16d`（空结果有提示且能一键回去、有结果时不出现）、`T59b`（快捷键确实写在菜单上）；
真机 `R26`~`R28`。探针新增 `filterMove` / `filterCommit` / `filterCurValue` / `emptyHint()`。

---

## 18. 看图：同一篇的图能翻（v0.44）

看大图时最烦的是"看完第 1 张想看第 2 张，得关掉再去点一下"。v0.44 让同一篇的图成为
**一组**：查看器标题右边写 `3/6`，`←` `→` 或点 `‹` `›` 翻，翻到底是循环，`Esc` / 点别处关掉。

```
openImage(anchor, url, caption, alt, gallery, index)
  ├ gallery 由调用方给：list 走 bindLinks(data) 的 data.urls，详情走 row.__fz.urls
  │  （galleryOf(urls, dims) 生成 {url,label,alt}，label 就是「图 03 · 1080×1440」）
  ├ 没给 gallery 就退化成"只有一张"：不显示翻页按钮，←/→ 也不动手
  └ 每次换图**重建 <img>**：老逻辑"加载失败就把 img 换成提示"带着状态走会变脏
```

一眼能看出来的三个决定：

- **不给 gallery 也能用**：`fz-imgcell`（卡片降级路径）没有 url 列表，就当作单图 —— 少一份图不报错。
- **`viewerGo(d)` 从 DOM 里的 `3/6` 反推下标**，不额外存状态：键盘、按钮、外部调用走同一条路。
- **循环而不是到头停住**：一篇就 2 张图时，"到头停住"会让人以为坏了。

顺带修掉一个真机上才看得见的问题：**首页那"第 2 张封面"其实是站点的素材图**
（`picasso-static.xiaohongshu.com/fe-platform/…`，尺寸过了 64px 那道线）。
`imgList()` 现在和 `isPhoto()` 一样先过 `isSiteAsset()`，所以首页每行只有真封面；
链接也一律编号（`图01` / `图02`），不再出现两个一模一样的「图」。（v0.85 起笔记的图改叫「封面图」，评论配图仍是编号，见 §51。）

真机实测（游客态，2026-10-31）：某行两格时点第 2 格 → 标题 `2/2`、`→` 绕回 `1/2`、
`Esc` 关掉；抽样 8 行点开图片链接，域名全是 `sns-webpic-qc.xhscdn.com`，站点素材 0 张。

断言：本地 `T7b`（首页链接带编号）、`T21b`~`T21e`（详情主贴 6 张：`1/6` 起手、`→` 到 `2/6`、
两次 `←` 绕到 `6/6`、点 `›` 回 `1/6`）、`T55g`（`imgList` 只留真图，滤掉 `fe-platform`）；
真机 `R29`/`R30`（翻页 + 编号）和 `R31`（8 行样本里没有素材域名、没有残留的查看器）。
探针新增 `viewerInfo()` / `viewerGo(d)` / `imgList(root)` / `isSiteAsset(src)`。

---

## 19. 键盘可达：原生 `<span>` 按钮也得能用键盘点（v0.45）

"能点"的东西在站点上多半不是 `<button>`：表头的筛选入口、`⋯` 菜单的四个可点项、
工具栏按钮、查看器的 `‹` `›`，都是 `<span>` / `<i>` / 没写 `href` 的 `<a>` ——
Tab 键停不上去，回车也没反应。鼠标用户完全无感，纯键盘用户在表格模式里寸步难行
（摸鱼场景里"一只手不在鼠标上"的比例不低，而这类人恰恰最容易发现"点不动"）。

```
KBD_SEL = '.fz-link,[data-fz-filter],[data-fz-sort],[data-fz-sortmenu],[data-fz-sval],
           [data-fz-nodata],[data-fz-menu],[data-fz-export],[data-fz-fval],
           .fz-mi,[data-fz-clearfilter],[data-fz-set],.fz-v-x,.fz-v-nav i,.fz-pick,
           .fz-tab,.fz-tb,.fz-addtab,.fz-zoom,.fz-authbtn,.fz-ns-x'
markKeyboard(root)  →  给命中的元素补 tabindex="0"（<a> 不补 role，其余补 role="button"）
  ├ buildRow / appendBoardRow        建行之后（必须等 innerHTML 写完）
  ├ buildChrome / updateLetters      工具栏、表头、列号条
  └ openMenu / openFilter / openSortMenu / openImage / openNoteSheet / 评论重画 / 空表提示
                                     每个浮层各自标记一次
bindKeys            Enter / Space → 给当前焦点命中的 KBD_SEL 派发一次真 click
                    （输入框/文本域/contentEditable 里一律不抢键）
```

**唯一的例外**：行号格 `.fz-num`（v0.48 起可点 = 选中整行）**不进 KBD_SEL** ——
它的键盘等价物是 `Shift+Space`（Excel 原样，见 §22）。往 Tab 序列里塞 30 多个行号
是把"可达"变成"每次多按几十下"，所以例外本身要写进文档、也要有等价路径。

三个别踩的：

- **标记必须在 `innerHTML` 之后**：一开始写在 `stampRow()` 里（它先跑），
  `.fz-link[data-i]` 当时还不存在，量到的 `tabindex` 全是 `null`（本地 K6 当场红）。
- **`role="button"` 别加到 `<a>` 上**：`<a href>` 本来就能聚焦，加 role 反而让读屏软件念成按钮。
- **筛选面板清空后故意不关**（和 Excel 一致），所以"回车 = 打开面板"这类断言前先 `closeFilter()` 归零，
  否则上一条用例留下的"已打开"状态会让 `aria-expanded` 断言假红。

焦点样式用 Excel 的绿（`outline:2px solid #217346` + `background:#eef6f0`），
样式表里只留**一条** `:focus` 规则 —— 之前还写了一条只改背景的 `[data-fz-filter]:focus`，
遍历样式表时会先撞上它，`outlineStyle` 读到空（见踩坑 45 的另一半）。

断言：本地 `K1`~`K7`（筛选入口可聚焦 + `aria-expanded` 跟随、焦点描边规则、
回车开面板、`↑↓` 移动时 DOM 高亮同步、普通单元格回车无副作用、
`封面图` 回车开查看器、点别处关查看器）；真机 `R32`（同一套 + 描边规则来自样式表，
窗口真有焦点时才实测）。探针新增 `filterKey` / `filterMove` / `filterCommit` /
`filterCurValue` / `emptyHint`。

---

## 20. 点列头排序（v0.46）：Excel 的"排序"那一栏

模仿的是 Excel 里最顺手的那个动作：**点列头就排**，再点一下反向，第三次回原顺序。
最常用的两个方向是"看最火的"（赞 ↓）和"看最新的"（时间 ↓），所以这两个的默认方向是降序，
文本列（标题 / 作者 / 内容）默认升序。

```
SORTS = { list:{key,dir}, detail:{key,dir} }      // 两张表各记各的
key: '' | like | time | author | text             // 取值列：.fz-o / .fz-p / .fz-a / .fz-e
点击路径   [data-fz-sort] 列头 → cycleSort(key)    换列=默认方向 → 同列再点=反向 → 第三次=回原序
          工具栏 ⇅（[data-fz-sortmenu]）→ 排序面板（六项，含"赞 ↓ 从多到少"）→ setSort(key,dir)
执行点     sortRows() 挂在 applyFilter() 里 —— 每次 sync 都会校一遍，新加载进来的行自动就位
```

几个刻意的决定：

- **赞的排序入口在 `⇅` 面板，不在列头**：列头那一下归筛选（见踩坑 47）。列头仍然挂
  `data-fz-sort="like"`，只为画 `▲▼`；两个箭头用一条更高优先级的规则同时显示（`content:"▼▾"`）。
- **按行号还原**：清掉排序不是"不再管了"，而是把行按 `行号` 排回去 ——
  否则表格会停在上一次的排序结果里（本地 S4/S11 就是钉这个）。
- **按父容器分组排**：首页行在 `.fz-board`、评论行在评论区、主贴行单独一格，
  分组排就不会把主贴行排到评论后面；行后面紧跟的「加载更多」用 `anchor = 最后一行.nextSibling`
  留在原处。详情页排序**只动详情表**（`sortScope()` 收口），在笔记里排评论不会把首页顺序带走（S19）。
- **稳定排序**：同值时按行号兜底。赞数一样、时间都是空的行不会每轮换位置
  （换来换去会让 MutationObserver 反复触发，见踩坑 46）。
- **行号不变**：和筛选同一套口径 —— 排序只改显示顺序，行号仍是原始序号；导出 CSV 也就跟着屏幕走。
- **画箭头用 `::after`，不写进文字**：表头 `textContent` 必须是干净的列名，导出 CSV 直接读它。

断言：本地 `S1`~`S21`（列头挂载与初始状态、点时间列头三态循环、赞列头点击仍归筛选、
赞升降序、赞列头亮 ▼、与筛选叠加、CSV 同序、清掉后回原序、`⇅` 面板六项与选完自动收、
Esc、键盘回车排序、顺序被打乱后 sync 校回、详情排评论 + 首页顺序不动 + 清掉后楼层恢复、
`赞` 列头两个箭头的样式都在）；
真机 `R33`（同一套在真实列表上跑，并核对 CSV 首行 = 屏幕首行）。探针新增
`sortState` / `setSort` / `clearSort` / `cycleSort` / `sortMenu` / `closeSort` / `sortOpen` / `sortItems`。

> **v0.56 起 `R33` 走的是新入口**：点时间列头出的是**筛选面板**，排序在面板顶上的
> 「↓ 新的在前 / ↑ 早的在前 / ✕ 取消排序」三条里，所以 `R33` 按"列头 → 面板 → 那一条"来点，
> 并且**用屏上那串时间当尺子**核对整列顺序（`fzMs` 版本的顺序只作为对照打印，不当断言 ——
> 被编辑过的笔记，id 时间是发布时间、屏上是最后编辑时间，两者本来就可以不一样）。
> 它以前一直 `SKIP`（"带时间的行太少"），其实是 `th.click()` 那条老路在 v0.56 已经不排序了，
> 于是"量不出顺序"永远成立 —— **跳过会把陈旧断言藏起来**，这次一并修掉：真机 32 行全部量到，
> `时间 ↓` / `↑ 反向` / `✕ 回原序` 三个方向都验过（红检：把 `applyPanelSort` 的升降反过来，
> `R33` 立刻报 `时间 ↓ false · 列头 fz-sasc · 状态「排序：时间 ↑」`）。

---

## 21. 空表提示（v0.47）：一行都没有时，说清为什么

最像"脚本坏了"的画面不是报错，而是**一张空表格 + 状态栏写着「就绪」**。
真机实测（2026-10-31，游客态）：`/search_result` 下一页 0 行、`.fz-ready` = 「就绪」、
底部条「已载入 0 条」、屏幕上只有补白的 49 个空行号 —— 用户唯一的线索在最下面那行小字里。

```
emptyReason()   分清两种原因，给的话和下一步完全不同：
  ├ 没登录 + /search*  → 「搜索结果要登录才给」+「去登录」（本站不给游客搜索结果数据）
  ├ 没登录（其它页）    → 「游客态没内容了」+「去登录」（连刷十几页后额度用完）
  └ 已登录还抓不到      → 「没抓到内容」+「再试一次」+ 让按 F12 搜 [fishy] 拿报错（多半是站点改版）
needNoData(total) 闸门：表格模式在、列表页、没有筛选条件（筛到空有它自己的 `.fz-empty`）、
                  total === 0、不在 loading/让位中、跑过至少一轮收集、进页面满 2 秒（防闪）
布局            `.fz-nodata` 插在 `.fz-board` 第一个子元素（和 `.fz-empty` 同一个位置/身份约定）
状态栏          total === 0 且该提示时写「没有内容」，不再是「就绪」
```

三个刻意的决定：

- **原因要分清，不要一句"没数据"**：游客态该去登录，改版该去看报错 —— 给错下一步比不给更糟。
- **防闪 2 秒 + 闹钟**：进页面头 2 秒不出提示（首屏慢时不该闪）；但"没有任何行"的页面也没有任何 DOM
  变化，不会有人再喊 sync，所以防闪期结束自己补一次 `sync()`（**直接调，不走 `schedule`** ——
  它的末尾是 rAF，无头 + virtual-time 下不一定跑，见踩坑 48）。
- **只在真的 0 行时出现**：有内容时一个字都不许冒（`R34` 钉这条）—— 这提示的价值全在"它一出现就是真的"。

断言：本地 `test-empty.html` `E1`~`E9`（游客搜索页文案/状态栏/只有一条/按钮键盘可达、
换成已登录后改口径、不重复插、点「再试一次」有反馈且不抛错、表格模式关掉时跟着藏起来、
抓到卡片后自动消失回「就绪」）；真机 `R34`（有内容时绝不冒提示）。
真机游客搜索页那一条落在 `sweep.mjs` 的搜索段：0 行时**必须**给「要登录」的提示
（有卡片就 SKIP，登录态由环境决定）。探针新增 `nodataState` / `nodataGate`（每道闸门摊开）/
`emptyReason` / `retryFetch`。

---

## 22. 选中与复制（v0.48）：Excel 最常用的那条路

装样子装了十几版的"名称框 / 公式栏"（`bindHover()` 里鼠标划过就写 `D3` 和格子内容），
一直是**只能看不能用的**：划过就变、移开就没，更不能复制。这一版把这条路修成真的。

```
点行号 .fz-num      → 选中整行（Excel 的行头就这么用）；再点别的行号 = 换一行
Shift+点行号        → 从"上次点的那行"连到这里（一段，只能在一个容器里：首页 / 评论区）
Shift+Space         → 键盘做法（Excel 原样）：选中焦点所在的那一行
Ctrl+C              → 复制选区：行之间 \n、列之间 \t（TSV，Excel/WPS/微信直接吃）
Esc                 → 取消选区（名称框回到 A1）
显示                → 行号格填深绿 + 整行贴框；名称框写 3:5；公式栏写这一行的内容
复制口径            → 只复制看得见的行（筛掉的不进）、跳过 .fz-x（"操作"是按钮）、
                      顺序就是 DOM 顺序（= 当前排序 + 筛选后的顺序），行号仍是原始序号
```

几个刻意的决定：

- **落点选行号，不选整行**：整行被"点开笔记"占着，见踩坑 49。行号是 Excel 里唯一的行头，
  而且捕获阶段 `stopPropagation()` 就能挡住行的冒泡 handler。
- **行号不进 Tab 序列**（对 §19 那条"每个能点的地方键盘都到得了"的唯一例外）：
  键盘走 `Shift+Space`（Excel 原样）就够了。要是把行号塞进 Tab，一屏 30 多行就多 30 多个站，
  键盘用户每次都要多按几十下 —— 那是把可达性做成了负担。**例外要有等价路径，且写进文档**，
  不能偷偷不算数。
- **复制不和用户抢**：只在"有选区、且用户没自己划字"时接管 `Ctrl+C`；
  否则一个字都不拦（本地 C5 用 `defaultPrevented` 反过来钉）。
- **两种写剪贴板**：`navigator.clipboard.writeText` 优先，失败退回临时 `textarea` +
  `execCommand('copy')`；两条都可能失败（无头里就常失败）—— 所以成功/失败都要给 toast，
  **探针断言的是文本本身（`copySel().text`），不是系统剪贴板**。
- **选区跟着行本身**：存的是行元素，不是行号文本；`applyFilter()` 里补一次样式，
  所以排序/筛选/sync 重建过之后选区还在（本地 C8）。
- **换页/换路径就清掉**：`sync()` 的路径变化分支里 `clearSel()`，免得选着首页的行、
  跳进笔记后还留着框。
- **`↑↓` 是 v0.49 补的另一半**（Excel 里选完就用方向键走）：`moveSel(±1, shift)` ——
  不按 Shift = 整行上下挪一格；按着 Shift = 锚点不动、活口在走（`SELROW` / `SELFOCUS`，
  见踩坑 51）。两个细节：
  - **跳过被筛掉的行**：选到一个看不见的行，用户只会以为"选中丢了"。
  - **到头了不拦按键**：已经在第一/最后一行时 `return false`，`↑↓` 继续管页面滚动 ——
    不然滚不动会很难受（本地 C14 用 `defaultPrevented === false` 钉这条）。
  - 浮层开着时让给浮层（筛选面板的 `↑↓` 是选条件）。

断言：本地 `test.html` `C1`~`C15`（点行号选中整行 + 名称框/公式栏 + 行号真的填了深绿、
点行号不开笔记、Shift+点连成一段、TSV 行数列数与 CSV 同口径、`操作`列不进（临时塞一个 `.fz-x`
证明被跳过）、`Ctrl+C` 有选中才接管 / 没选中不拦、Esc 收回 A1、键盘 `Shift+Space`、
sync 重建后样式还在、筛掉的行不复制且全被筛掉时明说、`↑↓` 走一行、`Shift+↓` 连着长、
跳过被筛掉的行、到头交还滚动、`Shift+空格 → Shift+↓×2 → Ctrl+C` 一条龙）；
真机 `R35`/`R36`（同一套在真实列表上跑，并用 `sessionStorage.fz-note` 验"点行号没顺手开笔记"）。
探针新增 `selState` / `selectRows` / `clearSel` / `copySel`。

---

## 23. 首次提示（v0.49）：装完第一次进来，得知道三件事

用户脚本最典型的死法不是 bug，是**装上之后不知道怎么用**：伪装层一出来他以为是站点改版，
然后就没然后了。所以第一次真的抓到内容时，弹一句、只说一次：

```
脚本已接管这张表 · 设置看工具栏最右的 ⋯ · Ctrl+Shift+X 一键收起
```

- **只在真抓到内容时弹**（`paintFilter()` 里 `total > 0 && !筛选中 && !yieldMode`）：
  一行都没有的时候弹"脚本已接管"只会更让人困惑 —— 那种场景交给 §21 的空表提示。
  本地 `test-empty.html` 的 `E0b` 专门钉这条（0 行时既不能弹、也不能把"已经说过"的标记写掉）。
- **只弹一次**：`store('helpSeen')`（GM_setValue / localStorage 同一套，和 CFG 一个口味）。
  探针 `firstRunHint()` / `helpFlag()` / `clearHelp()` 用来在用例里反复制造"刚装上"。
- **`toast()` 加了第二个参数**（毫秒）：默认还是 2.4 秒，这条提示给 6 秒 ——
  三件事一句话，2.4 秒读不完。
- 本地两个 fixture 都在开头 `localStorage.removeItem('fz:helpSeen')`：
  `.edge-run/<页面>` 的 profile 是复用的，不清的话"第一次"只存在于第一次跑。

断言：本地 `test.html` `L1`（页面上真弹过并记住了、再调不弹）+ `L2`（清掉标记后三件事齐全、
并写回标记）、`test-empty.html` `E0b`（0 行时不弹不写）；真机 `R37`（同一套文案在真实页面上渲染）。
探针新增 `firstRunHint` / `helpFlag` / `clearHelp`。

---

## 24. 搜索框（v0.50）：空格分词 + 说清"你搜的是什么"

搜索框本身早就有（`input` 变化 → `applyFilter()`，命中判据是 `rowText()` —— **不含行号**，
不然搜"1"会把第 1 行也捞出来）。v0.50 补三件事：

1. **空格分词，每个词都得命中**：`searchTerms()` 把输入切成 `['小鹿','通勤']`，
   `rowHit()` 挨个 `indexOf` —— 一个词都不许漏。单个词的用法和以前**一模一样**
   （子串匹配），所以老习惯不受影响，两个词以上才体现差别。
   为什么不学 Excel 的"整串子串"？搜索框的用户直觉就是多词 AND；
   而 `rowText()` 是把单元格用空格拼起来的，整串比反而会让"小鹿 通勤"永远搜不到。
2. **搜不到时回显搜索词**：`.fz-empty` 写「没有符合条件的行（搜索「小鹿 通勤」）」，
   两个词以上时提示改成「（多个词要都命中：去掉一个再试）」——
   用户知道自己该松哪个条件，而不是干看"没有符合条件的行"。
   实现上 `paintEmpty()` 用 `emptyEl.dataset.fzQ` 存上次的词，变了才重写 `innerHTML`
   （重写之后顺手 `markKeyboard(emptyEl)`，见踩坑 6）。
3. **换页清空搜索框**：`clearSearch()` 挂在路径变化那行（和 §22 的 `clearSel()` 同处）。
   `▾` 筛选（赞/类型）**按设计跟着走**（详情页也吃同一套，T22b 钉着），搜索不跟 —— 见踩坑 53。
   另外 `clearFilter()` 本来就顺手清了搜索框（点「清掉筛选」不会只清一半，本地 S9d 钉着）。

输入框上还挂了 `title`：「按作者 / 标题 / 类型搜：空格分隔多个词，每个词都要命中；
回车去站内搜；Esc 清空」—— 这三件事在页面上原本一个字都没写。

断言：本地 `test-scroll.html` `S9b`（两个词只会更少不会更多、`searchTerms()` 切词）、
`S9c`（搜不到时提示里写着搜的词）、`S9d`（「清掉筛选」连搜索框一起清）、
`S9e`（单个词仍是子串匹配）、`S5c`（换页后搜索框自动清空）；真机 `R38`
（在真实列表上用标题/作者各取两个字做两词查询）。探针新增 `searchTerms` / `setSearch`。

---

## 25. 长正文与导出（v0.51）：格子里是截的，导出去的是全文

格子里 >300 字的正文只画前 300 字 + 一个「展开全文（N 字）」链接 —— 这是故意的（Excel 一行
不该有几屏高；`data-full` 里存着全文，点一下就地展开）。

**坑在出口**：导出 CSV 和 `Ctrl+C` 走的是"这一格的文本"，也就是 `cell.textContent` ——
于是导出去的长正文是**半截**，后面还跟着一句 `……展开全文（427 字）`（真机上原来就是这样，
按钮文案被当成了正文；评论行的「展开 N 条回复」同理）。

修法：给"一格的内容文本"定一个唯一口径 `cellText(c)`（导出和复制共用，两条路必须一样）：

1. 有 `.fz-full`（说明正文被截了）→ 用 `data-full` 把屏幕上那段换成**全文**；
2. `.fz-full` / `.fz-toggle` 这类**按钮**的文案从文本里剔掉；
3. 其余一律还是原来的 `textContent`（口径尽量不变，免得动到别的断言）。

**和「所见即所得」的边界**（这条要说清，不然下次有人照着反着改）：

```
所见即所得 = 哪些行、哪些列、什么顺序   （筛掉的行不导、操作列不导、顺序同屏）
长正文长度 = 内容，不是视图             → 给全文
```

本地 fixture 的正文特意写成 **427 字**（真机上长笔记很常见，而 `>300` 那个分支必须被真的走到，
否则这条规则永远只是"看着对"）；短文（没走截断分支）时同样不许冒出按钮文案。

断言：本地 `test.html` `T54b`（屏上 301 字 / 导出全文 / CSV 里含全文）、`T54c`
（格子里有按钮，但 CSV 和剪贴板里都没有）；真机 `R17b`（两种长度都断言：CSV 里永远没有
「展开全文」文案，超 300 字时导出的格文本必须比屏上的长且含全文）。探针新增 `cellText`。

> 顺手删了 `real-check.mjs` 里写重复的一条 `R9b`：同一条断言写两遍会**虚增计数**，
> 和"计数要诚实"冲突。

---

## 26. 藏起来的东西不许出声（v0.52）

表格接管页面之后，站点原来的 DOM 只是被 `display:none` 藏起来 —— 里面的 `<video>` **照样在播、
照样出声**。摸鱼时**突然冒出视频声音**，比屏幕上多一张表格危险得多：表格好歹还像工作，
声音是当场暴露。

所以多了一条硬规则：**凡是被我们盖住/藏起来的，一律暂停 + 静音。**

```
hideEl(el)            藏元素的那一刻就顺手 hushVideos(el)
sync() 每轮            hushPage() 再兜一遍（站点自己用 CSS 规则藏的、不经 hideEl 的）
yieldToSite()         让位给原生界面 → unhushVideos()（用户这会儿是真的在看原生页面）
关表格模式（sync 分支） 同样 unhushVideos()
```

两个必须记住的细节：

- **不碰用户自己点开的播放器**：`.fz-vbox` 里那个视频是他主动要看，静音了就像坏了
  （`hushVideos` 里 `v.closest('.fz-vbox')` 直接跳）。
- **要还回去**：静音前把 `muted` 原值记在 `data-fz-was-muted`，让位/关模式时按原值恢复 ——
  别在用户的原生页面上留副作用。
- 为什么每轮 `sync` 兜一遍而不是只在 `hideEl` 里做：站点还有别的藏法 —— 自己用 CSS 规则
  `display:none` 的容器压根不走 `hideEl`；瀑布流卡片的 `<video>` 还是**悬停才创建**的。

断言：本地 `test.html` `H0`（先造出"正在播 + 没静音"的视频）/ `H1`（藏起来后立刻暂停 + 静音）/
`H2`（不经 `hideEl` 的也被 `sync` 兜住）/ `H3`（播放器里的不碰）/ `H4`（让位时静音还回去）；
真机巡检每篇详情都断言"非播放器视频在播数 = 0 / 出声数 = 0"。

**巡检要凑到视频笔记**：`sweep.mjs` 原来只取信息流前两条，图文笔记里连 `<video>` 都没有，
这条断言就成了"碰运气"（真机抽到视频笔记才有效）。现在候选**优先挑一篇 `type==='video'`
的笔记**，再配一篇图文 —— 实测两个视频笔记的页面里都是「页面视频 1 个（在播 0）」，
这条断言才算真的在测东西。

> 本地测试怎么造"正在播"：无头里真去加载媒体不现实，但状态可以如实造 ——
> 用实例属性盖住 `paused`（读 `false`）+ 换成计数版的 `pause()`，
> 就能验证我们**真的调了暂停**，而不是只看一个静音开关。探针新增
> `hushVideos` / `unhushVideos` / `hushedState` / `cellsOf`。

---

## 27. 筛选的边界：哪张表有哪一列（v0.53）

筛选条件不是"全局布尔"，得看**这张表有没有那一列**：

| 条件 | 首页列表 | 详情表（主贴 + 评论） |
|---|---|---|
| 「类型」▾ | ✅ 筛 `.fz-row` 的 `fzType` | ❌ 详情表没有类型这一列 → **不动它** |
| 「赞 ≥ N」▾ | ✅ | ✅ 主贴和评论都有赞数（T22b 就是这么设计的） |
| 「作者」▾ | ✅ 笔记作者 | ✅ 主贴作者 + 评论作者 → 筛出来就是「只看这个人的评论」 |
| 「时间」▾ | ✅ 笔记 id 推出来的发布时间 | ✅ 主贴同上、评论用 createTime 或屏上时间 → 「只看这段时间的评论」 |
| 搜索框 | ✅ | ✅（换页会清掉，见 §24） |

**踩坑 57 就是这么来的**：`rowHit` 里 `FILT.type` 不带作用域，详情行的 `fzType` 是 `undefined`
→ 和任何类型都不相等 → 整张详情表被藏。真实笔记上红检的报错是「详情 24 行 · 被藏 24 行」：
用户筛了"视频"再点开一篇，看到的是**空表**，第一反应是"评论没加载出来"。

修法就是那一行作用域（`el.classList.contains('fz-row')`）。以后加条件的检查法：
**把"这个值在另一张表里一个都对不上"的情形想一遍** —— 结果不该是"全藏"。

### 作者 ▾（v0.54）：Excel 里最常见的那个动作

「只看这个人」是筛选里最常用的一个，所以作者列头也挂 ▾（`FILTERABLE` 里列表第 4 格、详情第 2 格）。
三件事值得记：

1. **选项跟着数据长出来**：`authorOptions()` 按当前视图取行（列表 `.fz-row` / 详情 `.fz-nrow`），
   数出每位作者的条数，**多的排前面**（同位按名字），超过 30 位就截断并在标题里写
   「还有 N 位，用搜索框找」—— 不然评论几百个作者的面板能拖到屏幕外。
   行上没有 `fzAuthor` 的不进候选（筛它没意义）。
2. **精确匹配，不是子串**：`FILT.author` 直接 `!==` 比较。真机上「小鹿」绝不能带出「小鹿不迷路」
   （本地专门造了这一对：两行「小鹿」+ fixture 里现成的「小鹿不迷路」）。
3. **作者两表都有，所以不加作用域** —— 这正是 §27 说的那条：先看这张表有没有这一列，
   有就让它生效，且要想清楚生效成什么样（详情表里筛作者 = 只看这个人的评论，是想要的）。

断言：本地 `test.html` `A1`（列头既筛又排，箭头都在、`textContent` 仍是干净列名）/
`A2`（面板条目 = 数据里真实作者数 + 1，计数与合计对得上）/ `A3`（只剩他的行 + 精确匹配）/
`A4`（清掉全回来且列头不标绿）、`T22d`（详情表里 = 只看这个人的评论）、`T22e`（详情表的作者 ▾ 候选来自评论作者，不是列表那 10 行）；
真机 `R6d`（真实列表 33 行/31 位作者：选一位 → 可见 1/33 且都对得上，清掉回 33/33）。

断言：本地 `test.html` `T22c`（类型筛选下详情 0 行被藏、列表只留视频那 1 行、清掉即回）；
真机 `R8b`（在真实笔记页上把类型设成一个**不存在的值**，主贴和评论仍一行不藏）。

---

## 28. 顺着表往下读（v0.55）：点行进队列，笔记页给上一篇 / 下一篇

摸鱼最常走的那条路是"看完这篇看下一篇"。可点行是**开新标签页**，看完得切回列表再找下一行 ——
三下操作，还容易点重。v0.55 把这条路上的摩擦去掉：点行那一刻把**这一眼看到的那张表**存成队列，
笔记页顶部就出现 `‹ 上一篇 · 下一篇 ›` 和 `第 k/N 篇（按表格顺序）`，键盘 `Alt+↑` / `Alt+↓` 也行。

### 三个设计决定

1. **队列 = 可见顺序，不是全部行**。`saveQueue()` 读的是 `.fz-board .fz-row:not(.fz-hide)` ——
   和导出 CSV 同一个口径（"所见即所得"）。筛了类型、按时间排过，队列就是筛完排完的顺序，
   所以"下一篇"永远是**你刚才看到的下一行**。上限 80 行（够读一晚上，也不会把 storage 塞满）。
2. **存在 sessionStorage，不落盘**。`window.open(url, '_blank')` 没带 `noopener`，
   新标签页会**继承一份副本** —— 队列就跟着过去了；而它关掉标签就没了，和"筛选条件不写盘"一致。
   注意顺序：必须在 `window.open` **之前**写，副本是开标签那一刻拍的（Q5 的名字就写着这件事）。
3. **不在队列里就不显示按钮**。笔记页先问"当前这篇在队列里吗"（`queueNav()`）；
   翻浏览器历史进来、或从站内搜索点进来的笔记，队列里没有它 → 这排按钮根本不出现，
   不会给你两个点了没反应的链接。顺带也挡住了"队列是上一次的、token 已经过期"的情况。

### 怎么测的：把 `window.open` 换成测试桩

点行会开新标签页 —— 这正是本地/真机测试都不好碰的地方。真机 `R7b` 的做法是**在页面里把
`window.open` 临时换成桩**（记录参数、返回一个假 window），然后真的 `dispatchEvent` 一个 click：

```js
var opened = [], ow = window.open;
window.open = function (u) { opened.push(String(u)); return { focus: function(){}, opener: null }; };
try { row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }
finally { window.open = ow; }
```

于是"点了行 → 队列写好 → 跳转链接是这一篇且带 token"三件事一次测完，页面原地不动。
真机实测：可见 35 行 → 队列 35 条，队首就是点的那一行，`window.open` 正好 1 次。

### 覆盖情况（说清楚，别假装）

- 本地 `test.html`：`Q1`（队列条数/内容）、`Q2`（顺序 = 屏幕顺序）、`Q3`（筛过之后只装可见行）、
  `Q4`（`queueHref('next')` 指向下一行且带 token）、`Q5`（**点行**这条路真的写队列）。
- 真机 `real-check.mjs`：`R7b`（真点一行 + `window.open` 桩）、`R8c`（笔记页出现导航条，
  第 1/35 篇、上一篇到头、下一篇带 token）。
- **没覆盖到的**：`buildRow()`（站点卡片）那条建行路径的 click —— 测试页的行全是数据面板建的
  （`data-fz-id`），本地造不出卡片行；真机红检说明真机走的是数据面板那条。两处是同一行调用，
  风险只剩打错字这个量级，但**如实记着**（见踩坑 59）。

---

## 29. 时间筛选 + Excel 式下拉（v0.56）

到 v0.56，「自动筛选」才凑齐四列：赞、类型、作者、**时间**。顺手把下拉框做成 Excel 的样子
（排序和筛选在同一张菜单里）。

### 时间从哪来（这是这个功能的地基）

| 行 | 时间来源 | 有没有 |
|---|---|---|
| 首页列表 | 24 位笔记 id 的**前 8 位 hex**（秒级时间戳）`noteIdMs()` | 一定有（id 一定在） |
| 详情主贴 | 同一个 id（`data.id / noteId / 路径`） | 有 |
| 详情评论 | feed/state 里的 `createTime` → 没有就从**屏上那串时间**反推 `timeTextMs()` | 大多数有；爬的还是 DOM 评论就没原始值 |

`timeTextMs()` 认 `MM/DD HH:MM`（补当前年份；补出来落在未来一天以上就减一年 —— 跨年那几天
看到的 `12/30` 属于上一年）和 `YYYY-MM-DD HH:MM`。真机上评论行 **21/23** 有值（2 行没有时间文本），
列表行 **34/34** 的时间戳和屏上那串时间**逐字一致**（R6e2 量的；对不上的只会是"被编辑过"的笔记，
站点显示的是最后编辑时间）。

### 语义：今天 = 本地 0 点；其余 = 现在往前推 N×24 小时

`whenFloor()` 就这两个分支。为什么不一刀切按 24 小时算「今天」：用户说"今天"想的是**日历上的今天**。
面板里的条数天然单调（今天 ≤ 3 天 ≤ 7 天 ≤ 30 天 ≤ 全部），Panel 的 4 个台阶只可能越来越大 ——
这条不变量不依赖日历，`W2` 就按它断言（比断言"今天 = 3 条"结实得多）。

### 不知道时间的行**永远不藏**

这是 §27 那条"作用域"原则的延伸：**不知道 ≠ 不符合**。`rowHit` 里只在
`ms && ms < floor` 时才藏 —— 时间推不出来的行（数据缺字段、站点没给）一律留着。
不这么做的话，一旦上游数据少了时间字段，用户一筛「今天」看到的就是**空表**，
比"多留几行"坏得多。本地 `W3/W4/W6` 各按三条构造行（刚发的 / 40 天前的 / 没时间的）钉死这件事。

### 下拉框里带排序（Excel 就是这样）

带 ▾ 的列同时也是可排序列，一个点击只能干一件事 —— 那就照 Excel：**点列头出下拉，
下拉前三条是「↑ 升序 / ↓ 降序 / ✕ 取消排序」**（当前生效的打 ✓）。`PANEL_SORT` 把
面板的 key 映射到排序 key（`when → time`），`applyPanelSort()` 和 ⇅ 面板、点列头排序
共用同一个 `setSort()`，所以"第三次点回原顺序"在面板里就是「✕ 取消排序」。

副作用要记住：**点时间列头不再直接排序，而是出面板**（和「赞」一样）。本地那几条排序断言
（`S2/S3/S4/S16`）因此改成"走面板里的那三条"，其中 `S16` 顺带覆盖了纯键盘路线：
列头回车出面板 → 从高亮的「全部时间」往上三格就是「↑ 早的在前」→ 回车。

### 断言清单

本地 `test.html`：`W1`（列头既筛又排）/ `W2`（台阶条数单调）/ `W3`（7 天：旧行藏、无时间行留）/
`W4`（今天：0 点起算）/ `W5`（清掉全回来、列头不标绿）/ `W6`（详情表里也生效）/
`W7`（门槛：今天是本地 0 点、7 天是 7×24h）/ `W8`（屏上时间 → 毫秒，含跨年减一年）/
`T22f`（主贴行三个 data 属性干净，见踩坑 60）；
真机 `real-check.mjs`：`R6e`（双向：留下的够新、藏的确实旧；漏藏/错藏都必须是 0）、
`R6e2`（台阶单调 + 时间戳与屏上时间逐字一致 34/34）、`R8d`（主贴行有时间戳 + 评论行覆盖率）。

---

## 30. 作者面板的搜索框（v0.57）：把「还有 N 位」从一句空话变成一条路

起因很小：作者候选封顶 30 位，面板说明写着「（还有 N 位，用搜索框找）」，可**面板里根本没有
搜索框** —— 那句话指的是页面顶部的搜索框，它搜的是笔记，不是作者。于是第 31 位之后的作者
在界面上**根本选不到**，用户只能看见"还有 12 位"这种话干瞪眼。

### 做法：先按关键词筛，再截断

顺序是关键。`authorOptions(q)` 里：

1. 先把当前表里的作者按条数排好（同数按名字）；
2. **再用关键词过滤**（子串匹配、不区分大小写）；
3. 最后才 `slice(0, AUTHOR_CAP)`。

反过来写（先截断再过滤）就是原来那个死路：第 40 位作者永远进不了列表，搜索也就永远搜不到它。
`A9` 专门钉这一条 —— 造 40 位作者，搜「作者40」，必须**恰好命中 1 位且能被选到**；
红检把顺序倒回来，它立刻报 `搜「作者40」→ 全部作者 · matched=51`。

说明文字也跟着分成三种：没搜（共 N 位 / 还有 M 位没显示）、搜到了（搜「x」：M 位作者）、
一个字都没中（「没有匹配「x」的作者（清掉搜索框就都回来了）」）。「全部作者」永远在第一行 ——
不管搜什么都留着，随时能清。

### 键盘：面板自己的搜索框里，↑↓/回车 仍然归面板

原来那条规则是"正在输入框里打字就一律不抢 ↑↓/回车"（保护页面顶部搜索框）。
面板里有了自己的输入框之后，这条会把面板的键盘操作也一起废掉，所以加了一个判断：
`inPanelInput = typing && filtEl.contains(activeElement)` —— **是面板自己的框**就照旧处理
↑↓/回车（Excel 里就是边打字边用方向键挑），页面别处的框照旧一律不抢。

配套两处"别抢焦点"的护栏（`markFilterCur` / `filterMove`：有搜索框时不要把焦点从框里挪到条目上）。

### 老实说：焦点那两条断言，本机证伪不了

护栏写完我顺手断言了"焦点还在搜索框里"，红检把两处护栏全拆掉 —— **断言照样绿**。
无头浏览器里 `document.activeElement` 对非表单元素的 `focus()` 不生效（`<input>` 生效、
`<div tabindex=0>` 不生效），所以那两条在本机**不可能失败**（见踩坑 62）。
现在的处理：断言只留能证伪的（高亮移了一格、回车生效、搜索词留在框里、重画面后还能接着打字筛），
焦点降级成打印出来的实测值；真机 `R6f` 走完整用户路径（打字 → 列表收窄 → 点它 → 表真的筛了）。

### 面板要做成"活的"，但不能抢焦点

面板一开，真机上的 feed 还在往里流（sync 每 150ms 自己踢一次）。原来的实现只在开门那一刻
渲一遍，于是：条数停在开门那一刻，新作者进不来，`35 位作者` 的面板可能显示着「列表 31 项、没有
还有 N 位」这种自相矛盾的画面（真机 `R6f` 第一版就是这么红的）。

现在 `sync()` 末尾会 `renderFilterItems(false)`：面板开着就跟着新数据重画。关键是 `false` ——
重画**绝不抢焦点**：如果焦点本来在搜索框里就还回框里（连光标位置一起），本来在某个条目上就还回
那个条目（按 `data-fz-fval` 找回来），其余情况不碰焦点。另外 `markFilterCur(doFocus)` 多了一个
参数：开门和用户自己操作时给 true（顺手把焦点放到高亮项上），后台同步时给 false。

顺带修了一个潜伏的老问题：`hideTopSearch()` 用 `input[placeholder]:not(.fz-search)` 找站点的搜索框，
面板里那格搜索框也有 `placeholder` —— 它会被当成"站点顶部搜索框"，然后**拿它的祖先去 `display:none`**
（`isOurs` 挡了一下，但 `searchDone` 会被提前置真，站点的搜索框以后就不再隐藏了）。
现在选择器排除 `.fz-minput`，并且落在 `[data-fz-menu-panel]` 里的一律不碰（见踩坑 63）。

### 断言清单

本地 `test.html`：`A5`（只有作者面板有搜索框）/ `A6`（打一个字列表立刻收窄、全部项还在）/
`A8`（超过上限封顶 30 + 说清还有几位）/ `A9`（**打字能把没显示的那几位捞出来**）/
`A10`（打字后 ↑↓/回车照常、搜索词留在框里）/ `A11`（重画面后还能接着打字筛）/
`A12`（清掉搜索词回原样，且不动筛选状态）/ `A13`（**只同步、不做用户操作**，新行到达时候选自己更新）/
`A14`（行没了候选也跟着消失，**两侧都断言**）/ `A15`（同步重画时框里的字和收窄状态都保住）；
真机 `real-check.mjs`：`R6f`（打字 → **扛住一次 sync** → 点它 → 可见行全是这个人；上限提示按数据条件断言）。

---

## 31. 快捷键卡片：让"卡片上写的"和"按出来的"是同一件事（v0.58）

### 问题：卡片是手写的，功能是活的

设置菜单（工具栏最右的 `⋯`）底部有一张快捷键卡片 —— 对用户来说这是**唯一**能看到快捷键的地方
（README 在网页外面）。它是手写的一串 HTML，于是：

- v0.56 加了「时间 ▾」筛选、面板顶上的升序/降序 —— 卡片没写；
- v0.57 给作者面板加了搜索框 —— 卡片没写。

结果是用户打开"帮助"，看到的是上个版本的功能表。**文档漂移在 UI 里比在 README 里严重得多**，
因为用户会照着它做。

### 做法：一份清单渲染，逐条按一遍

`SHORTCUTS`（`[按键, 说明]` 的数组）是**唯一来源**，`shortsHtml()` 把它渲染进卡片，
探针再把它导出给自测。`SG1`–`SG11` 干两件事：

- **卡片本身**：清单没有空行（`SG1`）、卡片逐条来自清单（`SG2`）、卡片里能看到新功能的名字
  （`SG3`：「时间」「升序」「搜索框」「顶部搜索框」「Shift+空格」）；
- **卡片上写的按键真的能按**（`SG4`–`SG10`）：`Ctrl+Shift+X` 关掉设置菜单**和**筛选面板、
  `Esc` 关菜单、`Alt+Shift+R` 按两次必须回到原样（中间必须变过 —— 用签名对比，不去猜"现在是开还是关"）、
  卡片说的四个表头 `▾` 真的都挂着、它们真的进了 Tab 序列、搜索框/行号真的在。

### 它抓到的真 bug：最常用的那个键漏了三个浮层

`escapeAll()`（`Ctrl+Shift+X`）原来只 `clearSel() / closeViewer() / closeNoteSheet()`，
**筛选面板、排序面板、设置菜单一个都没关**。而卡片上写着"收起浮层 · 回顶部（最常用）"，
README 写着"一键收起所有浮层"。现在补上了三个 `if (x) closeX()`（真机 `R6g` 复核）。

### 两条如实跳过（不假装测过）

- `Ctrl+Shift+E`（导出）：按下去会走**真的下载**（Blob + `a.click()`）。在无头 + dump-dom 这条链上
  会把整个自测挂住（我挂了两次、每次都要手动杀进程）。导出的正确性由 T 系列的 CSV 断言管，
  `SG7` 如实记一笔 SKIP。
- `Alt+Shift+T`（本页临时关掉）：这**一条按下去就是 `location.reload()`**。第一次真按了 —— 页面
  当场重载，自测卡死，而且 `Location.prototype.reload` 在 Chromium 里是 `[LegacyUnforgeable]`，
  改不掉也拦不住。`SG11` 只核对"卡片里有这一条"，并如实记 SKIP。

为这两条给 `test.html` 加了 `skip(name, why)`：`SKIP` 行既不算过也不算不过（和 sweep 的 SKIP 一个口径），
计数仍然诚实。

### 顺带

- 菜单加了 `max-height:calc(100vh - 24px); overflow:auto`：卡片变长以后，小窗口下菜单比屏幕高，
  底下几项根本点不到。
- 断言里的 `⋯` 按钮引用不能留旧节点（菜单/工具栏会被重画），每回都得重新找 —— 见踩坑 66。


65. **"按一下快捷键"这种测试，先想清楚按下去会不会把测试自己弄死**（v0.58，自测挂了两次）——
    我照着卡片逐条按键，结果 `Alt+Shift+T` 是 `location.reload()`：页面当场重载，自测再也
    等不到 `flush`，跑批只能手动杀进程；`Ctrl+Shift+E` 走真实下载，在无头 + dump-dom 里同样把
    页面挂住。教训：按之前先读一遍那个键的处理函数 —— **会刷新/会下载/会弹窗的键，不许在自测里按**，
    改成如实 `SKIP` 并写清为什么（`test.html` 原本没有 `skip()`，是这轮加的）。
    另外：**自测挂住（不是变红）的第一嫌疑是套件里抛了异常** —— 抛在 `flush` 之前，页面永远不会
    告诉跑批"我结束了"。我给 `SG11` 写了 `skip(...)` 却没先实现 `skip`，就是这么一个 ReferenceError
    把整轮跑批挂死的（红检反而查不出来，因为它连红都来不及变）。

66. **断言里留了会被重画的 DOM 引用**（v0.58，`SG5`/`R6g` 各栽一次）—— `SG5` 拿着早先找到的 `⋯` 按钮
    再点一次：工具栏/菜单会被重画，旧节点已经不在文档里，点它等于没点（"菜单没开"是假红）。
    `R6g` 更隐蔽：我在**快捷键已经把菜单关掉之后**才去读卡片文字，于是永远读到 0 个字
    （"卡片是空的"是假红）。规矩：**读任何随渲染变化的东西，都当场 `querySelector` 一次**；
    顺序上也要先读"只在那一刻存在"的东西（比如打开状态下的卡片），再做会改变它的动作。

---

## 32. 状态栏：说清「为什么只剩这几行」，并且一键退回来（v0.59）

### 问题：只报数字，用户会以为数据没了

状态栏原来只有 `筛选 3/34 行 · 排序：时间 ↓`。可门槛（赞 ≥ 1000）、时间窗（最近 7 天）、作者都是
用户自己设的 —— 摸鱼时切走半小时再回来，只看到三行，第一反应是"数据丢了"。表头变绿只说明**哪一列**
有筛选，看不出**是什么条件**。

而且"退回来"只有两条路：开面板选「全部」（一次只能退一个条件），或者等筛到一行都不剩时那个空表
提示（筛剩几行时它不出现）。

### 做法

- `filterSummary()` 把生效的条件写成一句人话（`搜「小鹿」 · 赞 ≥ 1000 · 作者「X」 · 最近 7 天`），
  挂在状态栏的 `title` 上 —— 鼠标停一下就能看见，不占地方；
- 状态栏右边两个入口：`✕ 清掉筛选`（复用已有的 `[data-fz-clearfilter]`，它连搜索框一起清）和
  `✕ 取消排序`（新加 `[data-fz-clearsort]`，只 `clearSort()`）。**分开两个**是因为用户经常只想退其中一个，
  堆在一起清会把另一个也弄没；
- 没事可清时两个链接 `display:none`（不占地方、也不会误点）；
- 两个都进了 `KBD_SEL`（`tabindex=0` + `role=button`），Tab 停得上、回车等于点一下。

同一句人话在评论表里会换个说法：`只看「X」的评论` 而不是 `作者「X」`。判断写成
`document.querySelector(".fz-notesheet")` —— 和原来的内部变量 `noteSheet` 等价，但自测能从外面
把这个条件摆出来（`CL7` 塞一个空的 `.fz-notesheet`，和 `R7b` 里 stub `window.open` 一个路子）。

### 断言

`CL1`（没筛选没排序时两个链接都不出现 + 状态栏就是「就绪」+ 没有 title）/
`CL2`（title 和链接的 title 都写着作者和搜索词 = 说清为什么）/
`CL3`（点一下：作者、搜索词、赞数、时间一起清干净，行全回来，链接消失）/
`CL4`（**只**退排序：筛选原封不动、行序回到原样；两个入口互不牵连）/
`CL5`（只排序时不该冒出"清掉筛选"）/ `CL6`（两个入口 Tab 可达）/
`CL7`（评论表里换说法、回首页换回来）；真机 `R6h`（状态栏 title 里有作者、点一下全回来）。

红检（四处一起弄坏）→ `CL1`/`CL2`/`CL3`/`CL4`/`CL5`/`CL7` 全红，报的话就是原因本身：
「筛选入口显示=true」「提示「」」「筛选还在=」（空）「评论「作者「小鹿不迷路」」」。


67. **补丁脚本自己也会被引号弄挂**（v0.59，同一类坑这轮撞了两次）—— 写一次性 Node 补丁脚本时，
    在**双引号字符串**里又放了裸 `"`（`"清掉筛选"`），脚本直接 `SyntaxError: missing ) after argument list`；
    换成 PowerShell here-string 也一样，here-string 里嵌 `"` 会让 PS 报「字符串缺少终止符」。
    两次都好在是"整段没写进去"而不是"写错半句"，但白等了两轮。规矩：**补丁脚本里的中文引号一律用
    「」**（正好和文档风格一致），非要双引号就转义；**动产品文件之前先让脚本自己 `node --check` 一遍**。

---

## 33. 缩放：把工具栏最右边那三个死字接上线（v0.60）

### 问题：摆了控件，没接线

工具栏最右边一直有 `− 100% +`。查了一遍：这三个 `span` 只出现在**三处** —— 工具栏的 HTML、
CSS、以及 `KBD_SEL`（键盘可达清单）。**没有任何点击处理，也没有缩放状态**。更糟的是因为进了
`KBD_SEL`，它会被 `markKeyboard` 补上 `tabindex`，键盘用户 Tab 得上去、按回车什么都不发生。

这是同一类问题的第三次（v0.57 面板里那句「用搜索框找」当时根本没有搜索框；v0.58 卡片写着
"收起浮层"而 `escapeAll` 漏了三个浮层）。所以这轮顺手记了条检查法（踩坑 68）：
**看得见的控件，grep 一遍它的 class —— 只有 HTML/CSS/键盘清单里出现、没有 handler，就是装饰。**

### 做法

- 尺寸全部乘一个 CSS 变量：`.fz-cells{font-size:calc(14px * var(--fz-z,1))}`、行高、单元格内边距、
  作者名/时间/类型那几行字号都跟着 `--fz-z`。`--fz-z=1` 时和以前**逐像素一致**（所以既有的
  布局/滚动断言一条都不用改）。
- `zoomApply(pct)`：夹到 60%–160%、每档 10%（和 Excel 一样），写变量 + 更新那个数字 + `store.set`；
  开机时 `zoomApply(ZOOM, true)` 应用上次的比例（Excel 也是每个表记住缩放）。
- 三个控件带上 `data-fz-zoom="-1|0|1"`，走既有的委托点击（`0` = 回 100%）。
- **Ctrl+滚轮**：Excel 就是这个手势。关键是 `e.preventDefault()` —— 不拦的话浏览器会缩放**整个页面**，
  伪装出来的表格和站点元素一起变大变小，看着就不像表格了。只在 `html.fz-table` 且鼠标落在表格/
  评论表/工具栏上时才接管，不按 Ctrl 的普通滚动一概不管。
- `.fz-pct` 补进 `KBD_SEL`：中间的"回 100%"也是个按钮，之前漏在 Tab 序列外（`ZM8` 抓到的）。

### 断言

`ZM1`（默认 100%：数字、CSS 变量、实际字号三样对得上 —— 就是防"只换数字不换尺寸"）/
`ZM2`（点 + 真的变大）/ `ZM3`（点 − 回 100%）/ `ZM4`（下限夹住，字号 > 0 且明显变小）/
`ZM5`（点数字回 100%；上限夹住）/ `ZM6`（比例进 store）/
`ZM7`（Ctrl+滚轮会缩**且** `defaultPrevented`，普通滚动不拦）/ `ZM8`（三个控件可 Tab、回车等于点一下）；
真机 `R6i`（点 + 数字和字号一起变，点数字回 100% 且落库）。

红检（把 `--fz-z` 从字号里拿掉 + 去掉 preventDefault）→ `ZM2`/`ZM4`/`ZM5`/`ZM7` 红，
报的话就是原因：「字号 14 → 14（110%）」「被拦下=false」。


68. **摆了控件，没接线**（v0.60，第三次撞见同一类）—— 工具栏的 `− 100% +` 只有 HTML、CSS 和
    `KBD_SEL` 三处引用，没有 handler、没有状态。`KBD_SEL` 还帮它补了 `tabindex`，于是"看起来能用、
    键盘也能停上去、按下去没反应"。三次同类：v0.57 面板里写着「用搜索框找」却没有搜索框、
    v0.58 卡片说"收起浮层"而 `escapeAll` 漏了三个浮层、v0.60 缩放是死字。
    检查法：**挑任何一个看得见的新控件，`grep` 它的 class/属性，只出现在 HTML/CSS/键盘清单里 = 装饰**。
    写断言时也要盯住"真的动了吗"：`ZM2` 断言的不只是数字从 100 变 110，还有 `.fz-cells` 的
    `getComputedStyle().fontSize` 真的变大了 —— 只断言数字的话，改回死字它照样绿。

---

## 34. Tab 序列审计：装饰按钮不许抢 Tab（v0.61）

### 问题：Tab 下来的前十几站全是死路

假工具条上有 16 个只为了像 Excel 的按钮（常规 / 10 / B / I / U / A / ▨ / ≡ / ⊞ / ⌗ / ▦ / % / , / ⌕ / ❄ /
格式刷），加上 ribbon 页签「开始 / 插入」和页脚的「＋」，一共 19 个。它们**没有任何点击处理**，
却因为 `KBD_SEL` 里一个笼统的 `.fz-tb`（以及 `.fz-tab` / `.fz-addtab` / `.fz-pick`）全部被 `markKeyboard`
补上 `tabindex` —— 键盘用户从页首 Tab 下来，前十几站按回车什么都不会发生。这也正好违反 `KBD_SEL`
自己那句注释的意图（"这里统一补 tabindex"是给**能用**的东西补的）。

### 做法

- `KBD_SEL` 里删掉 `.fz-tb` / `.fz-tab` / `.fz-addtab` / `.fz-pick`。能用的三站（`⇅` `⇩` `⋯`）本来就有
  自己的 data 属性（`[data-fz-sortmenu]` / `[data-fz-export]` / `[data-fz-menu]`），照样在清单里；
- 再加一道保险丝 `markDecor(root)`：建完外壳扫一遍装饰件，摘掉 `tabindex` + 标 `aria-hidden="true"`，
  防止以后有人又把 `.fz-tb` 塞回清单。两道闸是**独立**的 —— 这决定了红检要怎么写（见踩坑 69）；
- 探针新增 `tabStops()`：报出**每一个 Tab 站点命中哪个选择器**（`⇅(data-fz-sortmenu)` 这种），
  以及装饰件有没有偷偷留 `tabindex`。

### 断言

`AU1`（≥10 个装饰件，全都没 `tabindex`、全都标了 `aria-hidden`）/
`AU2`（`⇅` `⇩` `⋯` 三站在 Tab 序列里）/ `AU3`（工作簿外壳里**每一个** Tab 站点都落在"点得动"
名单里，≥5 站；名单是写死的，加新控件就得来登记）/
`AU4`（保险丝没误伤：能用的三个按钮仍留着 `tabindex` 且没被标装饰）；真机 `R6j`（同一套在真实页面上再数一遍）。

健康状态下真实站点报的是：**Tab 站点 13 个** —— `⇅(data-fz-sortmenu)` `⇩(data-fz-export)` `⋯(data-fz-menu)`
`赞/类型/标题/作者/时间(表头)` `✕ 清掉筛选` `✕ 取消排序` `−(zoom)` `100%(zoom)` `+(zoom)`，一个死站都没有。

红检：把 `.fz-tb` 塞回 `KBD_SEL` 之后 `AU1`/`AU3` **仍然全绿** —— 保险丝单独就把结果守住了；
所以必须**两道闸一起拆**才会红（见踩坑 69）。拆掉后 `AU1` 报「还带 tabindex 的：fz-tb fz-pick,…（17 个）」、
`AU3` 报「Tab 站点 29 个 · 名单外的=常规(?) …」—— 一眼看出多出来的 16 站是装饰件。


69. **审计断言要先想清楚它测的是哪一道闸；红检要把闸全拆了才算验过**（v0.61）—— 我把 `.fz-tb` 塞回
    `KBD_SEL` 之后 `AU1`/`AU3` 仍然全绿，一度以为断言是假的。其实不是：断言测的是**结果**
    （Tab 序列里没有死站），而结果由**两道独立机制**守着（`KBD_SEL` + 保险丝 `markDecor`），只拆一道
    结果当然不坏。教训是：红检前先列出"有哪几道闸会挡住这个坏结果"，**全拆**再跑；只拆一道换来一片绿，
    分不清是"断言没用"还是"另一道闸在干活"。

    同一轮的另一个小坑：`markDecor(_foot)` 用 `document.querySelector(".fz-foot")` 拿页脚，那时候它还没
    `appendChild`，拿到 `null` —— 页脚的「＋」漏标了，`AU1` 报「没标 aria 的：fz-addtab@foot」才看出来。
    **手上已经有局部变量（`foot`）就别再去查 DOM**。

---

## 35. 列宽截住了，悬停得看得全（v0.62）

### 问题：摸鱼时最想看的那一列，恰恰最常被截断

表格列宽是固定的常量（`COLW`），标题这一列永远不够长；而站点自己的卡片被我们压成
`opacity:0 + pointer-events:none`，悬停不会冒出原生 tooltip。结果就是：**想看清完整标题，
只能点进笔记** —— 而这正是摸鱼时最不想做的事（点进去就是一次跳转、一次回退）。

### 做法

`cellTips(scope)`：给行里的单元格补 `title`（Excel 列宽不够时就是这个行为）。三条规则：

1. **只给「内容」挂**（`b` / `span`）—— 链接和图标（图01 / 展开全文 / 赞 / 收藏 / 前一篇）是按钮，
   给它们挂一个"等于自身文字"的 title 只是把按钮标签重复一遍，还会挤掉它们自己的说明；
2. **只在叶子上挂** —— 容器的 `textContent` 会把里面的东西全拼起来，比如操作列会拼成
   「打开原图复制链接」，看着像内容其实是按钮标签；
3. **不覆盖已有的 title**（`if (el.title) continue`），行号列和操作列整列跳过。

调用点四处：列表两条建行路径（`buildRow` / `appendBoardRow`）、详情表初建、详情表"加载更多评论"
重画评论区。幂等（已有 title 就跳过），所以重画也不会重复劳动。

### 断言：本地验规则，真机验"真的截住了"

本地 fixture 的标题都不够长，`scrollWidth > clientWidth` 一个都量不到 —— 硬在本地断言"截断被覆盖"
只能是空转。所以拆成两半（这也是这轮最值得记的一条）：

- `TT1`（本地）验**规则**：凡是挂了我们 title 的内容元素，title 必须**逐字等于**它的完整文字，
  且至少有 10 个（同时报出标题格的实测宽度，用来区分"没截住"和"根本没量到"）；
- `R6k`（真机）验**存在**：真实标题确实被列宽截住（`cut >= 1`），且每一个被截住的格子 title 都是
  完整原文；顺带验证链接/图标一个都没被挂。真机上万一内容都没超宽，就 `skip` 并报出实测宽度，
  不硬凑一个绿。

`TT2`（行号列/操作列不设 title）/ `TT3`（**每一行**都补上了，不是只有第一行碰巧有 —— 两条建行路径）/
`TT4`（单元格里的链接/图标一个都没被挂 title）。

红检：把 title 改成截断版（`s.slice(0,4) + …`）+ 把 `a,i` 重新算进去 + 去掉行号列跳过 + 只处理第一行
→ `TT1`/`TT2`/`TT3` 红（`TT4` 在同一批里没红，单独拆掉"只算 b/span"这条才红 —— 一条断言只对它自己
那条规则负责，混在一起拆容易看错）。


70. **本地 fixture 造不出来的条件，别硬在本地断言**（v0.62）—— `TT1` 最初写的是"本地被列宽截住的
    格子都要有完整 title"，跑出来 `被截住的 0 个`：fixture 的标题根本不够长，`scrollWidth > clientWidth`
    一个都量不到。这时候有两种坏做法：把断言删掉（真机问题没人管），或者把 fixture 标题改长硬凑
    （可能碰坏别的用例）。正确做法是**把断言拆成两半**：本地验"规则"（凡是我们挂的 title 都必须逐字
    等于原文），真机验"存在"（确实有被截住的格子，且都被覆盖了）。凡是"要某个外部条件成立才谈得上
    验证"的断言，都该这么拆 —— 本地那一半永远可跑、可证伪，真机那一半负责真实世界。

---

## 36. Excel 的跳转键：Ctrl+Home / Ctrl+End / PageDown / PageUp（v0.63）

### 问题：三四十行只能一步步走

真机首页 30~35 行，评论表 30 行上下。之前只有 ↑↓（一次一行）和鼠标。Excel 里 `Ctrl+Home` 回 A1、
`Ctrl+End` 跳到最后有内容的地方、`PageDown/PageUp` 一屏一屏走 —— 都是肌肉记忆，插件里一个都没接。

### 做法

- 把"当前视图里看得见的行"抽成 `navRows(root)`，`moveSel`（↑↓ 那套）也改成用它 —— **同一个口径**，
  免得两处判断不一致（被筛掉的行必须跳过，否则"选中丢了"）；
- `navRoot()`：有选中就跟着选区的父节点；没选中就挑当前视图的容器（`.fz-notesheet` → `.fz-board`）。
  `Ctrl+Home/End` 不要求先选中（Excel 里总有个活动单元格）；
- `navTo(all, i, block)`：夹住下标、选中、`scrollIntoView`。**PageDown 走到底就停在最后一行**
  （Excel 语义），和 ↑↓ 到底时"交回浏览器"是两回事 —— 因为 PageDown 本身就是翻页键；
- `screenStep(all)`：一屏几行从**行高实量**（`getBoundingClientRect().height`）算，缩放之后照样对；
- 三个键都走同一道守卫：没开浮层、光标不在输入框里。

### 断言 + 一个被抓出来的真 bug

`NG1`（Ctrl+End：没选中也能用、选中最后一行、`block=end`、拦住按键）/ `NG2`（Ctrl+Home 回第一行，
`block=start`）/ `NG3`（PageDown 一次 ≥5 行，PageUp 原路回到出发点）/ `NG4`（到底就停住，不交回浏览器）/
`NG5`（**没选中时 PageDown 一个键都不拦**，让浏览器自己滚）/ `NG6`（光标在搜索框里时 Ctrl+Home 不抢）/
`NG7`（评论表里跳的是评论行，不动首页那批隐藏行）；真机 `R6l`（三个键在真实页面上都管用）。

`NG6` 一上手就红了 —— 而且是**真 bug**：`typing` 这个变量原来只在"筛选面板开着"那个 `if (filtEl)`
分支里用 `var` 定义，函数作用域里别处读到的全是 `undefined`，所以新加的"正在打字就不抢"守卫形同虚设
（在搜索框里按 Ctrl+Home 照样跳行）。修法是把 `typing` 提到 handler 最上面算一次，全 handler 共用。
要不是专门写了一条"**不该发生**什么"的断言，这个洞会一直留着。

红检：把 `block` 写成 `nearest` → `NG1`/`NG2` 红；`screenStep` 换成 1 → `NG3` 红；越界就 `return`
→ `NG4` 红；去掉 `SEL.length` 门槛再硬取第 0 行 → `NG5` 红；去掉打字守卫 → `NG6` 红。


71. **守卫读了 `undefined`，等于没守卫**（v0.63，`NG6` 抓到的真 bug）—— `var typing` 写在
    `if (filtEl) { ... }` 里，`var` 是函数作用域，所以别处引用不会报错，只是拿到 `undefined`；
    `!typing` 于是永远成立，新增的"正在输入框里打字就别抢键"守卫一次都没生效。这类洞的共同点是
    **不报错、只是静默失效**，所以只有"专门断言某件事**不该**发生"的用例才抓得到（`NG6` 就是
    「光标在搜索框里按 Ctrl+Home 不该跳行」）。教训：共享的判断（谁在打字、有没有浮层、是不是这个视图）
    一律在 handler 最上面算一次，别在某个分支里顺手 `var` 一个同名变量。

---

## 37. 筛空了别骗人：说清作用域，也别承诺没验证过的补救（v0.64）

### 问题：一句"没有符合条件的行"，读起来像"小红书没有"

插件只拿到站点这一轮给的那几十行（真机首页 34 行前后）。搜索/筛选只在这些行里做，
可提示只写「没有符合条件的行（搜索「x」）」——用户会以为全站都没有。

### 先做实验，再写文案

本来想加一句"往下滚会加载更多"，但在真机上先量了一遍：**滚到底 6 次，行数一直是 34**
（`scrollY` 从 0 到 1752、文档高 2652，滚动是真的发生了，只是站点不再给数据）。
所以这句"安慰"是假的，不能写。最终只写事实：

> 没有符合条件的行（搜索「x」）· 只在已加载的 34 行里找过（站点这一轮只给这么多）

顺带一个容易漏的细节：空表提示原来只在**搜索词变了**的时候重写 HTML（`dataset.fzQ !== q`），
但"已加载 N 行"里的 N 会因为后加载的行而变化 —— 判据改成 `q + "|" + loaded`，否则数字会一直停在
第一次那版（`EM3` 就是为这个写的）。

### 断言

`EM1`（提示里必须有「已加载的 N 行」且 N === 实际行数）/
`EM2`（**不许出现**没验证过的承诺：`/往下滚|加载更多|继续滚|滚一滚/` 一律不许有）/
`EM3`（插一行再 sync，数字必须跟着变、判据 key 也要变）/
`EM4`（清掉筛选后提示连这句话一起消失，不留过期的说明）；真机 `R6m`（同一套在真实画面上再验一遍）。

红检：去掉作用域那句 + 塞一句「往下滚会加载更多」+ 判据退回只比搜索词 + 让提示永不移除
→ `EM1`/`EM2`/`EM3`/`EM4` 全红（"永不移除"还连带把两条老断言也弄红了，正好说明它们没白写）。


72. **别在文案里许下没验证过的补救**（v0.64）—— 筛空时最自然的安慰是"往下滚会加载更多"，
    听起来无害，但真机实测滚到底 6 次行数一动不动；写上去就是骗人，用户滚半天只会更火。
    规矩：**提示里出现的每一个"你可以……"都得先实验过**（这次的实验脚本才二十行：滚 6 次、
    每次记一个行数）。顺带记住这个数据：**真机首页一轮 34 行、往下滚不会再加载** —— 以后凡是
    "要不要做个加载更多/翻页"的判断，都从这个事实出发。

---

## 38. 右键菜单：Excel 里最顺手的那个入口（v0.65）

### 问题

Excel 里右键是最高频的入口（复制 / 只复制这一格 / 按这列筛）。插件之前右键只会弹**浏览器**的菜单，
一眼就露馅；而且"复制"只有整行一条路 —— 想只拿标题那一格，只能整行粘出去再删。

### 做法

- 只在 `.fz-board / .fz-notesheet` 上接管 `contextmenu`，伪装层外面还给浏览器；
- Excel 的礼节：右键先把这一行变成当前行（`selectRows`），再出菜单；
- 菜单项**只做这一格/这一行能做的事**：复制选中 N 行、只复制这一格（带内容预览）、按这一列筛选、
  导出 CSV、在新标签页打开这篇笔记、清掉筛选。不做"插入/删除行"——伪装表格改不动站点数据，
  摆一个按不动的按钮就是骗人；
- 每一项都自带存在条件：行号列没有筛选就不摆「按这一列筛选」；评论行没有 token 就不摆「打开笔记」；
  没有条件在生效就不摆「清掉筛选」；
- 复用 `.fz-mi / .fz-mk / .fz-mt / .fz-mv` 那套菜单样式和 `markKeyboard`（键盘也能走到），
  位置贴鼠标右下角并夹在视口内；
- 三种关法缺一不可：Esc、点别处、`Ctrl+Shift+X`（**上一轮踩过的坑：新加浮层必须挂进 escapeAll**）。

### 断言（CT1–CT8 + 真机 R6n）

CT1 拦住浏览器菜单＋顺便选中这一行／CT2 行号列没有筛选就不摆筛选项（**摆假按钮**是这类菜单最容易犯的错）/
CT3「只复制这一格」拿到的就是那一格、不是整行 TSV／CT4 打开的是**这一列**的筛选面板／
CT5 右下角右键也不越出视口／CT6 三种关法／CT7 有 token 才摆「打开笔记」（正反两面）/
CT8「清掉筛选」跟着条件走（正反两面）。

「导出成 CSV」这一项**故意不点**：无头下真去下载会挂住整个跑批（老坑），它的导出路径在别处有断言，
这里只查"项在不在" —— 这一点写在用例注释里，免得以后有人以为漏测了。

红检两轮：第一轮拆 `selectRows`／`preventDefault`／筛选项目条件／`copyText`→`copySel`／面板 key／位置夹紧／
token 条件 → CT1–CT5、CT7 红；**CT6 和 CT8 没红**，于是发现两个用例自身的问题（见踩坑 73 / 74），
修好用例后再拆"点别处 / 收起浮层"和"永远摆清掉筛选" → CT6、CT8 才红。

真机 R6n：34 行 · 菜单项=[copy,cell,filter,csv] · 拦住浏览器菜单=true · 选中这一行=true ·
位置 {left:222, top:322, right:416, bottom:427, vw:1440, vh:900} · 隔开 600ms 后单独一下 Esc 收掉=true。
（游客 feed 偶尔只给两三行，那时 R6n 会**诚实跳过**并在末尾记一条 SKIP —— 所以整轮有时是
"58 pass / 1 skip"，断言总数仍是 59。跳过不等于通过。）


73. **同步测试分不出"单次 Esc"**（v0.65）—— `Esc` 有个"420ms 内连按两下 = 收起浮层"的设计，
    而本地用例是一路同步按下来的，每一下都落在 420ms 里，于是"单独一下 Esc 关掉菜单"那条分支
    **永远不会被本地用例走到**：拆了它，CT6 照样绿（红检就是这么发现的）。办法不是删断言，
    而是分层：本地查"连按两下/点别处/收起浮层"，真机 `R6n` 先 `await sleep(600)` 拉开间隔，
    再按一下 Esc —— 那条分支才有意义。凡是"带时间窗/节流/防抖"的行为都属这一类。

74. **只断言"该有的有"，不断言"不该有的没有"，就是假绿**（v0.65）—— CT8 第一版只查了
    "有条件时菜单里有「清掉筛选」"，而条件消失后它只查了"菜单关着"（当然关着）。红检时把
    `if (filterOn())` 改成 `if (true)`（永远摆），CT8 **照样绿** —— 因为它从来没查过反面。
    改成"清掉之后再右键一次，这项必须没了"才咬得住。写"跟着状态走"的 UI，一定要正反两面都断言。

---

## 39. 选区键：Ctrl+A 全选、Ctrl+Shift+Home/End 选到两端（v0.66）

### 问题

到第 26 轮为止，跳转键（Ctrl+Home/End、PageDown/PageUp）已经接上了，但 Excel 里跟它们成对出现的
**选区键**一个都没有：Ctrl+A 只会选中网页文字（还要防我们自己的伪装层），Ctrl+Shift+End 更是没有，
想"把这一整页复制进 Excel"只能从第一行拖到最后一行。

### 做法

- 选区写入抽成唯一入口 `setSel(list, anchor, focus)`：点/拖、Shift 连选、Ctrl+A 三条路都走它，
  "锚点是谁、活口是谁、提示怎么报"只写一份（踩坑 71 的教训）；
- `selectAllVisible()` 用 `navRows()`（**看得见的行**）而不是 `allRows()`：Excel 筛选之后 Ctrl+A
  也只选看得见的那些，而且 ↑↓ / Ctrl+End / PageDown 早就是这个口径，全选不能例外；
- `Ctrl+Shift+End/Home`：锚点那头不动，活口跳到两端（复用 `selectRows(anchor, target)` 的区段语义），
  并把目标滚进视野；
- 两道让位：光标在输入框里（`typing`）让给浏览器，用户自己划了字也让给浏览器（和 Ctrl+C 同规矩）。

### 顺手修掉一个真 bug

加 Ctrl+A 时对照 Ctrl+C 才发现：**Ctrl+C 没有 `typing` 守卫**。在搜索框里选好字按 Ctrl+C，会被我们
抢去复制"选中的行"，用户复制不到自己选的文字（`clip` 被写了、`preventDefault` 也是 true）。
修好后 SA7 专门盯着它。同一个方向的键要**成组检查守卫** —— 第 26 轮 `typing` 提到 handler 顶部时，
只补了新键，没回头看已经存在的键。

### 断言（SA1–SA9 + 真机 R6o）

SA1 全选并拦住浏览器默认行为／SA2 被筛掉的行不进选区（本地给一行挂 `.fz-hide` 造前提，真机 R6o 走
真的筛选）／SA3 搜索框里不抢／SA4 用户划了字不抢／SA5 Ctrl+Shift+End 从当前格选到最后／
SA6 Ctrl+Shift+Home 反着选、锚点还是那一格／SA7 搜索框里 Ctrl+C 不抢（那个 bug）。

红检两轮：第一轮拆"筛掉的行不选"/`typing`/划字守卫/Shift 分支/Ctrl+C 守卫 → SA2–SA7 红；
第二轮拆整条 Ctrl+A 分支 → SA1（连 SA2）红，并把 Shift 连选的锚点接反 → SA5/SA6 红，
证据是「锚点=10（点的是第 3 行）」—— 见踩坑 76。


75. **同一个方向的键要成组检查守卫**（v0.66）—— 第 26 轮把 `typing` 提到 handler 顶部时，只给新加的
    Ctrl+Home/End/PageDown 补了守卫，**没回头看已经存在的 Ctrl+C**：于是"在搜索框里选好字按 Ctrl+C"
    被抢去复制选中的行。加键的时候顺手把邻近的键都念一遍（↑↓、Tab、Enter、Ctrl+C、Ctrl+A…），
    问一句"它在输入框里该不该让位"，比事后靠用户报bug便宜得多。

76. **探针字段恒为默认值，断言就是白绿**（v0.66）—— SA5/SA6 想断言"Shift 连选时锚点不动"，读的是
    探针的 `anchor`，而它取的是 `SELROW.dataset.fzRow` —— 那个属性在行上是**空串**，于是两边都是 `"?"`，
    `anchor === anchorId` 永远成立。红检时把锚点那头接反了，SA5/SA6 一开始**照样绿**，这才发现。
    改法：探针取用户真正看得见的行号（`.fz-num` 的文字），断言里再加一条 `anchorId && anchorId !== "?"`。
    凡是"断言两个值相等"的地方，都要先问一句：**这个字段有没有可能是恒定的默认值？**

---

## 40. 遮罩（幕布）：一个静默失效的"不闪原生页面"（v0.67）

### 起因：想量"白屏多久"，量出个别的东西

插件开页面时先盖一层白的（`html.fz-boot{opacity:0}`），等表格好了再掀 —— 为的是不让原生小红书
在伪装层建好之前闪一下。我写了个每 100ms 采样一次的注入脚本，想看看"白屏多久"，结果采样里
**从头到尾没有 BOOT**：幕布压根没装上。

原因：`@run-at document-start` 下 `document.documentElement` 不保证已经存在（无头注入实测就是 null），
而整段安装包在 `try {} catch (e) {}` 里 —— 装不上的表现和装上了一模一样，没有任何提示。
（我第一遍还把这份数据读成了"幕布挂了 3.8 秒"，见踩坑 77。）

### 改法

- `installCurtain()` 返回真假，装不上就**接着补**：0ms 轮询 + `readystatechange` 双保险；
  装成功后不再重复（判断依据是 `<style id=fz-curtain>` 在不在，所以掀掉之后不会被又盖回来）；
- 掀幕布的条件从"到点盲掀"改成**必须能证明站点藏住了**：`siteHidden()` 认 `#app / #main-container /
  .main-container`，**全都不在画面上**才算数；
- 「不在画面上」用 `getClientRects().length === 0` 判断，而不是看 `display` —— 父节点被 `display:none`
  时孩子自己的 computed display 还是 `block`（见踩坑 79）；
- 兜底仍是 3800ms，但走 `dropCurtain(true)`：站点没藏住就不掀（宁可多盖一会儿，也别露原生页面）。

### 真机实测（无头 Edge，注入方式与真实油猴一致）

| 项目 | 改前 | 改后 |
| --- | --- | --- |
| 幕布装上 | 从来没有（`documentElement` 为 null） | 第 1 次就成，启动后 1ms |
| 掀幕布 | —（没有幕布，原生内容从第一帧起就露着） | 外壳起来 + 站点藏住 → **68ms**（原因 shell） |
| 第一帧绘制 | 160ms，画的是原生页面 | 160ms，**盖在幕布后面**；首次有内容绘制 220ms ≈ 掀幕布那一刻 |

行数据 692ms 才到 —— 也就是说改完之后用户看到的是"遮罩 68ms → 空表格骨架 → 行慢慢出来"，
而不是"原生页面"。

### 断言（CU1–CU4 + 真机 R6p）

CU1 装上了／CU2 被清掉还能补装（真机就是靠这条救回来的）／CU3 装过之后不会再盖回来／
CU4 「站点藏住了」的两面（看得见时不算、父节点藏住时算）；真机 R6p 把"装上 + 掀的时机 + 第一帧被盖住"
串成一条，并作为静默失效的回归线（没装上时页面照常能看，只有它会红）。


77. **数据要看全，别急着下结论**（v0.67）—— 我拿着"每 100ms 采样一次"的时间线，看到里面没有 BOOT，
    就想当然地以为"幕布挂到 3800ms 才掀"，还照着这个结论写了代码注释。真相是**幕布压根没装上**。
    采样里缺一样东西，可能是"它来晚了"，也可能是"它从来没来"—— 这两种解释要分别去证（这里只要多做
    一步：读一下 `curtainInstall()` 就知道是后者）。写进代码的注释也一样要有证据，错了要改回来。

78. **被 try/catch 包住的初始化，会静默失效**（v0.67）—— `document-start` 时 `document.documentElement`
    可能是 null，`classList.add` 于是抛错、被 `catch (e) {}` 吞掉：伪装层该有的遮罩一次都没生效，
    而页面看着一切正常。凡是"没成功就等于没做"的初始化，都要**返回真假 + 装不上就重试 + 把结果记下来**
    给自测读（`curtainInfo`）。这也是这条 bug 能活这么久的原因：它不报错。

79. **父节点藏住 ≠ 子节点"自己"藏住**（v0.67）—— 判断"这个元素在不在画面上"，看它自己的
    `getComputedStyle().display` 是不够的：父节点 `display:none` 时，孩子的 computed display 仍是
    `block`。第一版 `siteHidden()` 就是这么写的，于是在真机上永远等不到"站点藏好了"，
    只能退化成"等表格出来"（432ms 而不是 68ms）。正解是 `el.getClientRects().length === 0`。

---

## 41. 状态栏统计：像 Excel 一样报 平均值/计数/求和（v0.68）

### 为什么是这个

伪装的可信度靠的是"每一处都像 Excel"，而不只是外框像。Excel 选中一片有数字的格子时，右下角会报
平均值/计数/求和 —— 这是绝大多数人天天见、却不会特意去看的地方，正好是伪装里最划算的一格。
顺便它也有用：一眼知道"我选的这几行平均多少赞"。

### 口径（这条比实现重要）

- **只算看得见的选中行**：被筛选藏起来的行不进统计 —— 和 `Ctrl+A`、`Ctrl+C`、`Ctrl+End` 一个口径
  （§39 定的规矩：Excel 筛选之后，全选/复制也只作用于看得见的行）；
- **认不出数字的格子不进平均值**（赞列显示 "–" 或空时），但会**如实报有几格**：
  「平均值: 7,500  计数: 2（另有 1 格没写赞数）  求和: 1.5万」——不假装那格是 0；
- 数字按站点那套写法显示（上万用"万"、四位数带千分位），一长串 0 看着像乱码；
- 没选中、或选中的格子里一个数字都没有时整块不显示（`:empty` 不占位），不会留一句"平均值: 0"。

实现上只多了一个 `selStats()` + `paintSelStats()`，画在 `paintFilter()` 之后（`paintSel` 是所有选中
写入的公共出口，那里顺带重画一次就够）。

### 断言（SS1–SS4 + 真机 R6q）

SS1 没选中时不写统计／SS2 三行（1.2万 / 3000 / "–"）→ 平均值 7,500 · 计数 2（另有 1 格）· 求和 1.5万／
SS3 真筛一次（赞 ≥ 1万）→ 计数掉到 1，去掉筛选又回来（双向）／SS4 9999 → 9,999、加 10万 → 11万；
真机 R6q：`Ctrl+A` 全选后状态栏报的数字，和在检查里**独立重数一遍**的结果逐项一致
（实测：看得见 31 行 · 我数 31 格 / 求和 301760 · 状态栏「平均值: 9,734  计数: 31  求和: 30万」）。

### 真机数据是活的

R6f（作者面板搜索）这类"拿 feed 第一行的作者去搜"的断言会偶发红：同一版本连跑两次，一次红一次绿
（本轮就撞上了，第一次红、第二次绿）。看到它红，**先重跑一次**再当回归看。真机跳过的条目也一样是
诚实的：R6k（列宽截断的 title）在"这一轮内容都没超过列宽"时会 SKIP 并写出实测宽度。


80. **桩数据要长得跟真的一样，不然验的是空气**（v0.68）—— 测"筛选后统计只算看得见的行"，我一开始
    手工给行加 `.fz-hide`：下一次 `applyFilter()` 立刻把它改回来，等于什么都没验（第一次失败就是
    这个原因）。改走真筛选之后又发现：桩行没有 `dataset.fzLike`（真行都有），筛选引擎把三行全筛掉了。
    结论：**要验"筛选口径"就用真筛选；造假数据时把真行的字段补齐**（`fzLike` 还要给数值形式 ——
    `"1.2万"` 写进 dataset 会被解析成 1）。

81. **模板字符串里的正则反斜杠会静默消失**（v0.68）—— `cdp.evaluate` 的执行体是模板字符串，`\d` 在
    里面会变成 `d`：正则 `/^(\d+)/` 到页面里成了 `/^(d+)/`，**什么都匹配不到**。于是一条本该红的断言
    变成了 SKIP（"这一轮抓到的行里没有赞数字"），而真机数据其实好得很（插件自己数出来 33 行 / 求和
    430905）。文件里要写双份（`\\d`），patch 脚本里要写四份（`\\\\d`）。救回我的是那条 skip 当时把
    "我看到了什么"写进了消息里 —— **skip 也要写清依据**，否则它就是在替 bug 打掩护。

82. **UI 上报的数字必须有口径，而且要和邻居一致**（v0.68）—— "选中 3 行，求和 1.5万"里的 3 到底是
    "选中的行"还是"看得见的选中行"？同一份数据两种答案。既然 §39 已经定了"筛选之后全选/复制只看
    看得见的"，统计就必须是同一个口径：**同一个概念在相邻功能里给出不同数字，比不显示这个数字更坏**。

---

## 42. 详情表的"当前视图"：一行属于哪张表按容器算（v0.69）

### 症状

在笔记页（评论表）里 `Ctrl+A`：只选中了**主贴那一行**，评论一行都没选上；`↑↓` 也走不动，
`Ctrl+End` 到不了最后一条评论。想复制几条评论只能一行行点。

### 根因

`navRoot()` / `navRows()` 判断"这一行在不在当前表里"用的是 `r.parentNode === root`。
列表页的行是**平铺**在 `.fz-board` 下的，所以一直是对的；详情表的 DOM 是
`.fz-notesheet > [主贴行 + .fz-cmts > 评论行…]` —— 评论行的父节点是 `.fz-cmts`，
于是"当前视图的行"只剩主贴那一行。**同一张表两套口径**：CSV 导出（`exportScope`）用的是
后代查询 `querySelectorAll`，导出一直是全的；只有选区/导航这条线漏了评论。

### 改法

新增 `rowScope(row)`（最近的 `.fz-notesheet` / `.fz-board` / 父节点）和 `scopeRows(scope)`
（容器**后代**里的 `.fz-row,.fz-nrow`，排除 `.fz-hide`，DOM 顺序＝视觉顺序）。
`navRoot()` / `navRows()` / `selectRows()` 全部改走它们 —— 于是：

- `Ctrl+A` 在详情表里选上「主贴 + 全部评论」（真机实测 24 行）；
- `↑↓` / `Ctrl+End` 能一路走过主贴和评论；
- `Shift` 从主贴行划到评论行能连成一段（以前"跨容器"直接放弃）。

### 顺带修掉的另一个洞：评论区重画会吃掉选区

站点评论一直在流进来，评论区是 `cbox.innerHTML = cmtRowsHtml(...)` **整块重画**的，
行元素全变新 —— 用户选了几行还没 `Ctrl+C`，选区就没了。现在重画前先记下"第几行是选中的"
（`selIdxIn`），重建之后按原位选回来（`selIdxBack`）。

### 断言

- 本地 SS9：详情表里 `Ctrl+A` 要选上「主贴行 + 评论行」（3 行、求和 83000）—— 红检把
  `navRows` 改回 `parentNode` 版本后，它复现的正是真机症状（选中 1 行 / 求和 73000）；
- 本地 SS8：重画之后选区回来，并且**先证明不恢复就真的没了**；
- 真机 R6r：详情表 `Ctrl+A` 后，状态栏统计与独立重数一致（实测 24 行 / 求和 2985）；
- 真机 R6s：调真的重画钩子（`P.rerenderCmts()`，走的是 `renderCmt` 本身）——
  先证明行确实被换掉（`didWipe=true`），再验选区 3→3、数字一模一样。
  红检：把"恢复"那一步拿掉 → 选区 3→0、统计变 null。

### 教训（写进踩坑 83）

这个 bug 本地一直是绿的：我的桩把评论行**直接**塞进 `.fz-notesheet`，恰好符合那个错误假设。
桩的 DOM 形状必须照抄真机（`.fz-cmts` 那一层不能省），否则测的是自己想象出来的页面。


83. **桩的 DOM 形状要和真机一致，不然测的是自己想象的页面**（v0.69）—— 我把评论行直接塞进
    `.fz-notesheet`，而真机是 `.fz-notesheet > .fz-cmts > 评论行`。于是"当前视图的行按 parentNode
    算"这个 bug 在本地一直绿：`Ctrl+A` 的断言只覆盖了列表页。照抄真形状之后，同一条断言当场
    复现真机症状（只选中 1 行）。**桩要照抄真 DOM 的层级**，尤其"谁是谁的子节点"这种刚好被
    实现假设掉的地方。

84. **同一个概念不能有两套判断**（v0.69）—— "这一行属于哪张表"：导出用后代查询（一直是对的），
    选区/导航用 `parentNode`（漏了评论）。同一张表，一个功能给你全部评论、另一个只给主贴行。
    凡是要判断"当前视图/当前表"，就抽成一个函数（现在叫 `rowScope`/`scopeRows`）大家共用。

85. **保住选区这类修复，断言要证明"情况真的发生了"**（v0.69）—— 验"重画之后选区还在"，必须同时
    证明行**真的被换掉了**（`didWipe=true`：旧元素已 disconnected），否则重画没发生的话断言白过。
    真机上这一点靠"挂钩子走真函数"（`P.rerenderCmts()` 调的就是 `renderCmt`），不是另写一份假的。

---

## 43. 详情表的 ↑↓ 也要横跨主贴行和评论行（v0.70）

### 症状

上一节把 `Ctrl+A` / 统计 / `Shift` 划选统一到 `navRows()` 之后，还剩一个漏网的：`moveSel()`
（`↑↓` / `Shift+↑↓`）自己传了个父节点 —— `navRows(SEL[0].parentNode)`。表现很怪：
在主贴行上按 `↓` **能**走进评论，但站在第一条评论上按 `↑` 就**回不到主贴行**（单向的）。
原因还是父节点：主贴行的父节点是 `.fz-notesheet`，评论行的父节点是 `.fz-cmts`。

### 改法

一行：`navRows()`（不带参数）—— 当前视图由 `navRoot()` → `rowScope()` 统一算。
现在 `Ctrl+A` / `Ctrl+C` / `Ctrl+Shift+Home,End` / `↑↓` / 统计 / `Shift` 划选用的是同一个判断。

### 排查过程（值得记）

本地新写的 SS10 一开始红得很奇怪：点主贴行号根本没选中（`点后=0`），连评论行也点不动了。
把现场打出来才看清：`mrow.parentNode === null` —— 我手里的主贴行元素**已经被换掉了**
（`sync` / 排序会重建行），派给一个 detached 元素的事件当然到不了处理函数。
**是断言攥着旧元素，不是产品有问题。** 改成"每次现场取行 + 比较用行号（`selIdx`）"之后，
SS10 一次就红得干干净净：`↓ 后 行号=1 · ↑ 后 行号=1`（卡在第一条评论，正是真机症状）。

### 断言

- 本地 SS10：`↓` 从主贴行到第一条评论、`↑` 回主贴行（红检：把 `navRows()` 换回
  `navRows(SEL[0].parentNode)` → `↑` 卡在第 1 行）；
- 真机 R6t：实测「表内 23 行（评论 22 条）· 主贴行在第 0 位 · ↓ 到第 1 位（落进评论块=true）·
  ↑ 回到第 0 位」。


86. **断言里别攥着行元素不放**（v0.70）—— `sync` / 排序会把行换成新元素（`cbox.innerHTML = …`、
    `insertBefore` 重排），攥着的那份就成了 detached：事件派给它等于没派（判据是
    `el.parentNode === null`），于是断言红得莫名其妙、还以为是产品坏了。
    **要现场取（`ns.querySelector(...)`），比较用行号/内容，不要用元素同一性。**

---

## 44. 列宽能拖了 —— 以及断言要量屏幕上那一格（v0.71）

### 这轮做了两件小事

1. **`Ctrl+F` 接管**：以前按 `Ctrl+F` 会拉起浏览器自己的查找条 —— 一条横条盖在"表格"上，是这个伪装里
   最显眼的破绽（Excel 里 `Ctrl+F` 本来就是查找）。现在焦点直接跳进顶部搜索框，并把原来的词选好方便覆盖；
   光标已经在搜索框里打字时让给浏览器（`SA8` 连这个反向一起断言）。
2. **列宽可以拖**：拖表头（或字母行）的右边缘改这一列的宽度，Excel 原样。宽度挂在 CSS 变量上
   （`--fz-wl1…wl6` / `--fz-wd1…wd7`），所以拖动只改一个变量，不用把整张样式表重注入一遍；
   列表的"标题"列和详情的"内容"列是弹性列（`minmax(…,1fr)`），自己会吃掉多余空间，不参与拖动。
   宽度只在内存里记，刷新回默认 —— 和第 30 条一个规矩：这类状态不落盘。

### 真机 R6v 抓到的真 bug：视图是按祖先猜的

第一版 `bindColDrag` 里写的是 `th.closest('.fz-notesheet') ? 'detail' : 'list'`。**表头是共享的固定
chrome，永远在 `.fz-notesheet` 外面** —— 于是在详情页拖列宽时，代码认定自己在"列表"，把宽度写进了
`W_LIST` 和 `--fz-wl*`，而屏幕上的表头用的是 `COLW`（`--fz-wd*`）：**拖动完全没反应**，
更坏的是列表那一套宽度被**悄悄改掉**了（等你切回列表，列宽已经不对了）。

改法：表头在 `buildHead` 里按**同一个 `detail` 标记**给自己盖一个 `data-fz-view`，拖动只认这个章；
字母行读它自己早就有的 `data-fz-key`（`6|0` / `7|1`）。表头自己说自己是哪张表的表头 ——
和踩坑 84 一个道理：同一个概念只能有一套判断，而且判断要问"最知道的那一方"。

### 断言教训（这条比 bug 值钱）

- R6v 第一版量的是**内部数组**，于是它"失败"得莫名其妙：证据写着 `第2列 52 → 132`（数组确实改了，
  但改的是另一个视图那一套），而屏幕上 `150 → 150` 纹丝不动。改成量**屏幕上那一格的宽度**
  （`getBoundingClientRect`）之后，bug 立刻现形 —— **断言要量用户看得见的东西**。
- 本地红检第一次是**假动作**：把 `headView` 换回按祖先判，本地照样全绿 —— 因为本地表头压根不在
  `.fz-notesheet` 里面（真机那个 bug 恰恰靠"不在里面"才发生）。于是补了 `WD6`：**把表头手动塞进一个
  `.fz-notesheet` 里**，要求它照样按自己的声明改列宽 → 这一版红检才红（`起始=140 → 拖+30 后=140`）。
  真机照不出的摆放，就用"这条规矩本身"来测（踩坑 70 的老办法）。

### 数字

本地 308 条（`test.html` 271）/ 真机 67 条 / 巡检 18 条。


87. **跟视图绑定的操作，视图要问元素自己，别猜祖先**（v0.71）—— 表头/工具栏这类共享 chrome
    永远在 `.fz-notesheet` / `.fz-board` **外面**，按 `closest()` 猜一定猜错（真机 R6v：详情页拖列宽
    被写进列表那一套，屏幕上没反应，还把另一张表的列宽改坏了）。让**建它的人**盖个章
    （`data-fz-view`），用的人只读章。
88. **断言要量用户看得见的东西**（v0.71）—— 量内部数组/状态，会出现"数组变了、屏幕没动"这种
    通过或失败都说不清的结果（R6v 第一版就是这么被骗过去的）。能量 `getBoundingClientRect`、
    能量 `textContent`，就别去读内部变量。

---

## 45. 列宽不许拖出屏幕 —— 以及两张表里的 `null`（v0.72）

### 上一节的功能留下一个新状态

列宽能拖之后，"整张表比窗口还宽"第一次变得**可达**了（以前列宽是常量，加起来 658px，永远装得下）。
真机一量：页面的 `body` 是 `overflow-x: hidden`，`window.scrollTo(400, 0)` 之后 `scrollX` 还是 `0` ——
也就是说**超出去的那截格子既滚不到也看不见**。实测：窗口 1440，把最后一列从 92 拖到 892 之后，
这一列的右边缘到了 **1458**；而修好之前更狠，一次拖到 900 时右边缘是 **1636**（196px 永远够不着）。

### 改法

- 拖动时按 `colRoom()` 卡上限：`窗口宽 - 其余各列的"最少占宽"`（并且不低于这一列自己的下限）；
- 窗口变小（或列宽被别的东西改宽）时 `clampCols()` 把固定列**从右往左**收回窗口内，收到各自下限为止；
  弹性列（标题 / 内容）自己会吃掉多余空间，所以它是"缓冲"，收到它的下限就不收了。

### 修这个功能时又踩了一个坑（这条才是这轮的重点）

下限表里弹性列那一格我顺手写成了 `null`（**宽度**表里它就是 `null`，表示"不参与拖动"）。
但 `totalOf()` 要用下限表算"这张表最少要占多少"，`null` 参与算术会被当成 **0** ——
于是上限整整松了 280/300px，表格照样被推出屏幕，只是没那么夸张（R6w 报的就是 `1636`）。

**更要命的是：本地断言里那张 `MINS` 表我是照着产品抄的，于是把同一个 `null` 也抄进去了** ——
本地 WD7 全绿，两边一起错。R6w 之所以能抓到，是因为它量的是**屏幕上这一列的右边缘**，
而不是任何一张表。改完两张表之后：`118 → 704（变宽 586）· 文档宽=1440 · 右边缘=1440`，正好停在窗口边上。

### 断言

- 本地 WD7（拖到很远也不超过窗口）、WD8（收回超宽列宽，`resize` 走的就是它）；
  红检：拿掉拖动上限 → WD7 红（`窗口=739 · 拖+5000 后这一列=900 · 此刻最少占=1138`）；
  把 `clampCols` 改成空操作 → WD8 红（`5238 → 5238`）；
- 真机 R6w：`窗口=1440 · 最后一列 118 → 704（变宽 586）· 文档宽=1440 · 右边缘=1440 · 拖回=118`。

### 数字

本地 310 条（`test.html` 273）/ 真机 68 条 / 巡检 18 条。


89. **同名的两张表要分清哪格是 `null`**（v0.72）—— 祈祷别再有第三张：宽度表里弹性列是 `null`
    （不参与拖动），下限表里它是**真实下限**（280/300）。`null` 一进算术就变 0，
    上限于是松了一格，表格又被推出屏幕（R6w 抓到 `1636`）。
    顺带更贵的一条：**本地断言别照抄产品那张常量表** —— 我把同一个 `null` 抄进测试，
    结果本地全绿、两边一起错。断言要量屏幕上那一格（右边缘 1440），别量自己抄来的数。
---

## 46. Ctrl+S 与双击按内容调宽 —— 以及红检抓出来的三个假绿（v0.73）

### Ctrl+S 是比查找条更响的一次穿帮

上一轮拦的是 `Ctrl + F`（浏览器查找条会横在"表格"上）。`Ctrl + S` 更狠：
它会弹出**「保存网页」对话框**，里面带着网址和文件名。拦下来给一句「已保存」的回执就完事；
光标在输入框里时让给浏览器（用户那时是在选字，不是在"保存表格"）——SA9 / SA9b 两条都断言了。

### 双击表头右边缘 = 按内容调宽（Excel 原样）

量"这一列的内容需要多宽"用的是**和 tooltip 同一条规则**（`cellTips`，见 1194 行）：
只看叶子的 `b` / `span`。第一版直接读 `scrollWidth`，本地 WD9 立刻就红：

```
双击后=141 · 再双击=142
```

每双击一次宽 1px。原因是 `scrollWidth` 至少等于 `clientWidth`：格子够宽之后它报的是
**盒子现在多宽**，于是"按内容调宽"吃自己的结果、无限慢慢变宽。改用 `Range` 量**文字**，
并在量不到文字时算 0（不要退回 `scrollWidth`）。

但真机 R6x 又红了，而且是详情页独有：

```
宽 150 → 151 · 再双击=152
```

详情页作者那一列有个**没有文字的叶子**（图标/头像），`Range` 量出 0，代码就退回了
`scrollWidth` —— 又踩回同一个坑（这回是"空叶子"）。改成"量不到就是 0"，
另外加一道"量出来的目标宽度和现在差不多（±2px）就别动"，真机才落到：

```
detail 第2列（7 列 / 25 行）· 宽 150 → 124 · 再双击=124 · 过程中弹过面板=false（每步 falsefalsefalsefalsefalsefalsefalse）
```

### 三个假绿（这轮最值钱的部分）

1. **合成事件打错了元素**：我在测试里把 `click` 派发给了 `document`，于是
   "双击不该把筛选面板打开"这句**永远绿**——真实浏览器里按下和松开都在表头那一格，`click` 归它。
   红检把 `colEdgeDown` 破坏掉，WD9 居然还是绿的，这才发现。改成三个事件都打在表头格上。
2. **只断言末态**："面板开完又关"从末态看不出来。改成**每一步都记**，破坏后拿到
   `falsefalsetruetruetruefalsefalse`——第一下 click 确实把面板打开了，双击之后才关掉。
3. **量宽度退回盒子宽度**（上面那条 `scrollWidth` 的坑）：同一个坑在本地和真机各踩一次。

顺带把 `colEdgeDown` 和 `colDragMoved` 放同一条命上：靠 click 消费、靠 250ms 兜底
（松手落在窗口外时没有 click），和上一轮那次教训一致。

### 断言与数字

- 本地 SA9（`Ctrl+S` 被拦下且有回执）/ SA9b（光标在框里时让给浏览器）、
  WD9（先拖到最窄造出"真被截住"，再双击：宽度落到内容需要附近、截住的格子清零、
  再双击一次不变、全程不弹面板）；红检：拿掉整条 Ctrl+S 分支 → SA9 红，
  不认列边缘 mousedown → WD9 红（每步 `…truetruetrue…`）；
- 真机 R6x（如上）。
- 本地 313 条（`test.html` 276）/ 真机 69 条 / 巡检 18 条。

90. **合成事件要打在真浏览器会打的那一格上**（v0.73）—— 把 `click` 派发给 `document`，
    `e.target.closest(...)` 就什么都匹配不到："别弹面板"这类断言于是**永远绿**。
    按下和松开都在同一格时 `click` 归那一格，测试要照这个来。
91. **别只断言末态**（v0.73）—— "开完又关"在末态里看不出来（面板开→关，最后是 `false`）。
    把每一步的状态都记下来放进证据里，破坏后才拿得到 `falsefalsetruetruetruefalsefalse`。
92. **量"内容多宽"不能退回 `scrollWidth`**（v0.73）—— 它至少等于 `clientWidth`，
    格子够宽之后报的是"盒子现在多宽"：按内容自适应会吃自己的结果，每双击一次宽 1px。
    要量文字（`Range`），量不到就算 0（图标/头像这类空叶子），并且"和现在差不多就别动"。

## 47. 「加载更多评论」的结果是瀑布页 —— 滚动对象出圈了（v0.74）

### 症状

详情页点「加载更多评论」：评论一条没多，**背后的首页倒是在翻页**。

真机实测（游客态、CDP 驱动真站，2026-10-31）：

|                    | 点之前   | 点之后        |
| ------------------ | ----- | ---------- |
| `comments.list` 条数 | 10    | 10（评论 17→17） |
| `feed.feeds` 条数    | 45    | **193**    |
| 网络                  | —     | `homefeed` ×4，`comment/page` ×0 |

诊断串也已经把话说出来了：`容器2·哨兵有·hasMore1·17→17·fz reds-lock-scrol(1506)` ——
"容器 2"里一个是 `.note-scroller`，另一个是 `fz reds-lock-scroll`，也就是 `<html>`。

### 根因

`cmtFallbackScrollers()`（旧）从 `.comments-el` 往上走 12 层，只要 `scrollHeight - clientHeight > 60`
就收下，于是 **`<html>` 也进了列表**。而详情页底下压着的就是瀑布页（`.feeds-page` 一直在 DOM 里），
`html.scrollTop = …` 等于告诉站点"首页到底了"，它就去发 `homefeed`。表格盖着屏幕，用户什么都看不见。

真机结构（实测，2026-10-31）：

```
.comments-el           高 2482 · overflow:visible      ← 不是滚动者
  .note-scroller       sh 2587 / ch 674 / auto         ← 真正滚的是它
    .interaction-container
      #noteContainer
        .note-detail-mask   position:fixed · sh == ch   ← 自己不滚
          html / body       overflow:hidden             ← 但 scrollTop 照样改得动，且是瀑布页的
```

### 改法

- `cmtScrollers()` 重写：只在**详情这棵子树**里找（`.note-detail-mask`，没有就退到最近一层
  `[class*="note-detail"]`），从 `.comments-el` 往上取**最内层**可滚祖先；
  `cmtPageLevel()` 把 `html / body / scrollingElement` 一律按死，`cmtInScope()` 出圈就 break。
  实测现在只剩 1 个：`.note-scroller(3055)`。
- 每轮 tick 再验一次 `cmtInScope(e)`；收工时把各容器的 `scrollTop` 和页面 `scrollY` 都摆回原处。
- `wheel` 改 `bubbles:false`：冒泡到 window 会被瀑布页的滚轮监听接住，又带着它翻页。
- `cmtMoreButtons()` 只在详情子树里找"加载更多"（以前 `cmtRoot()` 拿不到就退成 `document`，全页扫）。
- 未登录时站点把评论锁了（"登录查看全部评论内容"）：说一句实话就收工，不再空滚 10 秒。
- 顺带：`absorbComments` 记下"这条评论属于哪篇"（`noteId` / 请求 URL 里的 `note_id` / 当前详情页），
  只有「加载更多」那条路用它补评论（`readComments(pid, true)`），首屏不用 —— 见踩坑 94。

### 断言

- 复现脚本（真站）：点「加载更多评论」后 `homefeed` 0 次、`feed 45→45`、容器只剩 `.note-scroller`；
  修之前同一脚本是 `homefeed ×4`、`feed 45→194`。
- 本地 315 条 / 真机 70 条全绿（`node check.mjs --real`）。

93. **"可滚的祖先"必须出圈检查**（v0.74）—— 从评论往上爬，`<html>` 也在里面；详情页底下压着瀑布页，
    滚 html 就是让站点"首页到底、再拉一页"。于是"加载更多评论"变成"加载更多笔记"，而屏幕上毫无动静
    （表格盖着）。找"谁在滚"要给一个圈，并且把 `html/body/scrollingElement` 按死。
94. **首屏渲染不能吃"会变长的数据源"**（v0.74）—— 第一版把接口拦到的翻页评论直接拼进 `stateComments`，
    首屏也跟着用：同一个列表读两次顺序可能不同，`renderCmt` 整块重画之后选区跳到别的行上
    （真机 R6s 当场红：求和 30 → 27）。要补可以，只能挂在「加载更多」那条路上。
95. **居中的元素，hover 位移要叠在 `translate(-50%,-50%)` 上**（v0.84）—— 只写 `translateY(-2px)` 会把
    居中的 `-50%` 一起顶掉，鼠标一放上去按钮横跳半个身位。同理，居中按钮的 `z-index` 得比后插入的
    压暗层 `#fz-dim` 高一档，否则同层"后来者赢"，按钮被半透明黑盖暗（还能点，但看着像禁用）。
96. **量"屏幕正中"不能用 `innerWidth`**（v0.84）—— `position:fixed` 的百分比相对**去掉滚动条**的
    初始包含块算，`innerWidth` 把滚动条也量了进去（15px 的条 → 差 7px）。断言 BK2 第一版就因为这个
    报了 `dx=-7 dy=-7`，但截图明明是居中的。改 `documentElement.clientWidth/clientHeight` 才对齐。
97. **拼进 `evaluate` 的正则，反斜杠要写两遍**（v0.86）—— `cdp.evaluate(\`...\`)` 是普通模板字符串，
    `\d` 会先被煮成 `d`（只有 tagged template 的 `raw` 才保留），页面里跑的就成了 `/^封面图d*$/`：
    `mainOk=false`，可打出来的标签明明是 `封面图1`。`real-check.mjs` 里所有写进模板字符串的正则都要 `\\d`。
98. **拿 `className` 变没变当"点成功了"**（v0.88）—— `press()` 先派发 `pointerover`/`mouseover`，
    站点一 hover 就换 class，于是第一拍就判成成功：点赞既不让位也不出红框（用户原话"收藏是好的、
    点赞没有红框"）。判断成败要看**语义状态**（`liked` / `collect-active` 这类），不看类名整体变化；
    红框之后 `pollUntil` 等真人点的条件同理，否则鼠标扫过就被当成点上了。
99. **原生 `checkbox` 在站点页会被 reset 抹掉**（v0.89）—— 设置面板第一版用 `<input type="checkbox">`，
    本地测试页正常，真机上整排只剩文字、看不见勾。改成"input 只留语义 + `<i>` 自绘"，
    `:checked + i` 画蓝底白勾；`accent-color` 救不回来这种 reset。
100. **"已经建好的行"不会自己重建**（v0.90）—— `reflowFeed()` 开头就 `if (card.dataset.fzRow === '1') return`，
    所以改"单元格内容"的设置（折叠 / 图片 / 悬停）只 `schedule(true)` 是没用的，必须自己把 `.fz-cells` 换掉；
    而且重画时**不能再走 buildRow**（会把 `openNote` 再绑一次，点一下开两个标签页）。
101. **同一页面被注入两次 = 两套界面**（v0.90）—— CDP 的 `addScriptToEvaluateOnNewDocument` 会累积，
    每次注入都各建一套 chrome / 表格 / 详情表：屏幕上叠着，`removeSheet()` 只收掉自己那套，
    设置改完"只对其中一套生效"。脚本开头加 `if (window.__fzLoaded) return;` 就干净了；
    查的时候数一下 `document.querySelectorAll('.fz-notesheet').length` 就知道有没有中招。
102. **全局只挂一个捕获 click，是单点故障**（v0.91）—— 它自己被 `stopPropagation` 顶掉、或者被更早的
    捕获处理器拦掉（同页两份脚本时必然发生），面板里所有条目就一起哑。修法是"面板/工具栏各自再挂一层"，
    再加一条 **pointerdown + 120ms 后核对状态**的补刀；补刀不能直接在 pointerdown 里做业务
    （`setFilter` 会重画面板，把正要 click 的节点换掉，实测 `sameItem=false`）。





### 第二轮（v0.75）：真正让它在登录态一直抓瀑布页的，是 `yieldToSite()`

v0.74 把 `html` 从滚动列表里摘掉之后，登录态下点「加载更多」**还是**在拉瀑布页、评论一条不进来。
用 `IntersectionObserver` 打桩看站点在盯谁，答案就在眼前：

```
OBSERVED: feeds-loading(viewport) · note-item(viewport) · comment-item(viewport) · ...
```

`feeds-loading` 是**首页**的"到底了，再拉一页"哨兵。而 `yieldToSite()` 会把 `.fz-src`（首页源列表）
原样还回文档流 —— 于是那个哨兵一进视口，站点立刻发 `homefeed`：我们只是点了"加载更多评论"，
站点却在拉首页。这也是为什么用户看到的是"原版瀑布页"：让位那一刻，屏幕上盖着的克隆也被
`html.fz-yield` 一起藏了，露出来的就是被还原的原生页面。

改法：**详情页拉评论不再让位**。

- 原生详情本来就渲染在表格下面（`hideBeforeBoard` 特意放过了 `#noteContainer`），
  实测表格打开时 `#noteContainer` 是 `1027×678`、`.note-scroller` 的 `clientHeight=516` ——
  尺寸是真实存在的，滚它对画面没有任何影响；
- 所以 `pullMoreComments()` 只做 `cmtShowNative()`（万一详情被我们藏了就临时恢复出来），
  滚完 `cmtHideNative()`，全程不 `yieldToSite()`、不盖 cover、不 `resumeFromSite()`；
- 每轮 tick 把页面 `scrollY` 按回原位（`feeds-loading` 只要看到自己进视口就会拉首页）；
- `scrollIntoView` 换成 `scrollSentinelIn()`：只改**这个容器**的 `scrollTop`，
  而且哨兵在视野上方时不动它（评论区顶部那个 `loading-container` 也吃 `[class*=loading]`，
  不管方向地滚它会每轮把位移拽回上面）；
- "贴底回弹"从"只许一次"改成可以反复（`wiggleN`）：真机上站点常常要看到好几次才肯发下一页；
- 诊断里加"评论请求+N"（`cmtReqN`）+ 按钮文案分流：
  `+0` = 站点压根没理我们（可能已经到底），`>0` 但条数没涨 = 回了包但没入表。

实测（游客态、不打让位、逐 150ms 采样）：

```
t=0.2s  scrollTop 1270   pageY 0   feed 44
t=2.1s  scrollTop 2818（到底）  pageY 0   feed 44
t=3.3s  scrollTop 2147（回弹）→ 2818（再到底）… 反复三次
t=7.5s  收工，scrollTop 归 0，全程 pageY=0、homefeed 0 次
```

另外两道闸（v0.75 收尾）：

- `cmtFreezeFeed()` / `cmtThawFeed()`：拉评论这几秒把 `.feeds-page / .feeds-container / .fz-src`
  直接 `display:none`。不管详情容器需不需要"恢复祖先才能量尺寸"，首页都不可能在视口里露头，
  `feeds-loading` 那条线就断得干净。
- `doLoadCmts()` 每次点击都先把"此刻读到的"并进 `cmtStore`（`mergeCmts` 只增不减），
  并且**没有新增就不重画**。以前空拉一次也会拿旧快照整块重画，把站点自己后来加载的评论缩回去
  —— 真机 R6s 就是被这一条放大的（选区按行号恢复，行数一变就指到别的评论上）。

> R6s 本身是条"看运气"的真机断言：它假定表格最后三行是普通可见评论，但尾行经常是折叠起来的
> 楼中楼、或正好被站点的实时数据改动；同一条用例在不同笔记上时红时绿（本轮三次跑：红、绿、绿，
> 改动前那次直接 skip）。要稳住它得把选区恢复从"行号"改成"评论 id"，那是另一件事。

## 48. 让位时顶上/底下漏出原网页 —— 以及"到底在不在加载"（v0.76）

### 漏的是哪一条

遮罩 `.fz-cover` 只铺 `top:HEAD_H` 到 `bottom:FOOT_H` 这一段（表头 86+18+24 和表尾 30 留给伪装层），
而让位时 `html.fz-yield` 会把 `.fz-chrome`（表头/列号条/表头行/表尾）整层藏掉 ——
于是顶上那 128px 和底下那 30px 露出原生网页。

更糟的是：`.fz-cover` 里那份"表格克隆"本身也带 `.fz-board` 类，被同一条规则一起藏了，
所以让位那几秒屏幕是**纯白**的（用户看到的就是"闪一下白屏 + 底下的红书"）。

### 三处改动

```css
/* 让位时保留伪装层，遮罩就还是铺中间那一条 —— 屏幕一点都不变 */
html.fz-yield.fz-keepchrome .fz-head{display:block!important;}
html.fz-yield.fz-keepchrome .fz-letters{display:grid!important;}
html.fz-yield.fz-keepchrome .fz-thead{display:grid!important;}
html.fz-yield.fz-keepchrome .fz-foot{display:flex!important;}
html.fz-yield.fz-keepchrome .fz-cover{top:HEAD_H!important;bottom:FOOT_H!important;}
html.fz-yield .fz-cover{top:0!important;bottom:0!important;}      /* 万一真没留住，也不能漏 */
html.fz-yield .fz-cover .fz-board{display:block!important;}       /* 克隆是给人看的，别跟着藏 */
```

`yieldToSite(keepChrome)` 新增一个参数，列表翻页走 `yieldToSite(true)`；`resumeFromSite()` 顺手清掉这个类。

> 坑：第一版直接写 `html.fz-yield.fz-keepchrome .fz-chrome{display:block!important}` ——
> 一刀切成 block，把 `.fz-thead` 的 grid 打散了：列宽模板还在（`minmax(280px,1fr)`），
> 但子元素退化成块级流，"赞 类型 标题 作者 时间"挤成一小撮贴在最左边。
> **每个层的 display 都不一样（block/grid/grid/flex），必须逐个还回去。**

### 「到底在不在加载」

以前只有一句 12px 的小药丸（`.fz-cover-tip`），在让位那几秒还几乎看不见 —— 用户只会以为卡死。
现在统一走 `.fz-busy`：整屏很淡的白幕 + 屏幕正中一张卡片（绿色转圈 + 加粗主文案 + 灰副文案 +
一条来回跑的绿色进度条），`role="status"` / `aria-live="polite"`，`pointer-events:none`（照样能滚）。

| 场景 | 主文案 | 副文案（会随进度变） |
| --- | --- | --- |
| 列表翻页 | 正在加载下一批笔记… | 从原站翻页取数据，画面会保持不动 → 第一种方式没拿到，换成让位重滚一次 → 已收到 N 条，正在整理 |
| 详情评论 | 正在加载评论… | 从原站取下一批评论，表格稍后自动刷新 → 已取到 N 条新评论，正在整理 |

`.fz-cover-tip` 直接 `display:none`（被卡片取代，留着只会在顶上飘一句没头没尾的话）。

### 顺带：选区按"评论 id"恢复

真机 R6s 时红时绿：整块重画只按**行号**找回选区，站点评论一增一减就指到别人身上
（实测求和 21000→1020）。现在 `selKeysIn()` 一起记 `__fz.cid`，`selIdxBack(box, idx, keys)`
先按 id 认人、认不出才退回行号；DOM 读来的评论没有接口 id，就补一个
`dom:作者|正文前24字` 的稳定指纹。

> 提醒：R6s 仍会在"表格最后三行里有折叠的楼中楼/没有赞数的那条"时 **skip**（它自己的前置条件），
> 那是用例保守，不是功能坏了。

## 49. 加载下一批，只认那一个按钮（v0.77）

用户的要求很直白：**"加载更多"只能由点按钮发起**。之前的自动路径有三条，全部拆掉：

| 位置 | 原来 | 现在 |
| --- | --- | --- |
| 列表页 | `bindScrollLoad()` 滚到接近底部就 `nudgeSource()`，站点的 `feeds-loading` 一进视口就自己发 `homefeed`，行数悄悄变多 | 函数留空（只留注释）。`nudgeSource` 只给「再试一次」那种明确点击用 |
| 列表页 | `autoMore()`：滚到底静默试一次，连着两次失败写提示 | 删除（本来也没人调用，留着只会被后人接上） |
| 详情页 | `.fz-notesheet` 滚动监听：滚到离底 240px 就 `doLoadCmts()` | 删除。滚到底只说明"读到这里了" |
| 详情页 | `toasyCmtKick()`：进页面 0.9s 后偷偷唤醒一次评论区 | 删除。评论区空着就在表尾写"点左边拉第一批" |

为什么值得改：表格是拿来**读**的。滚到底再自动拉，等于"我还在看，你就替我要下一批"——
表一直在长，滚动位置还在跳，用户根本没有"停"的时刻；失败了还会自己弹提示、自己退避重试。
现在只有一条指令路径：点「加载更多」/「加载更多评论」，其余时候页面一动不动。

配套文案（空评论区）：按钮写「加载评论」而不是「加载更多评论」，右边灰字补一句
"（评论区还没初始化，点左边的链接拉第一批）"——不然 0 条的时候没人知道该点哪儿。

> 顺带把 `cmtNextAt` 的退避降级成"只是提示语"：手动点击不受退避限制，想再试就能再试。

---

## 50. 让位是"单向"的：点赞/收藏/回复之后没有回头路（v0.78）

### 症状

详情页点「赞 / 收藏 / 回复」，脚本会 `yieldToSite()` 把伪装层收起来，露出原生界面让用户操作。
问题是这一步**只有去路、没有回路**：

| 动作 | 谁负责把表格还回来 | 实际情况 |
| --- | --- | --- |
| 赞 / 收藏（脚本点得动） | `press()` 检测到 class / 数字变了 | 根本不进让位，没事 |
| 赞 / 收藏（点不动） | `yieldToSite()` + 红框 + `pollUntil(25s)` → `resumeFromSite()` | 25 秒内没点就干等；中途想放弃也没有按钮 |
| 回复 | `yieldToSite()` + 聚焦输入框 | **压根没人负责回来** —— 打完字，屏幕上只剩原生小红书 |
| 登录 | `pollUntil(isLoggedIn)` → resume | 同上，想放弃只能关标签页 |

### 改法

让位期间浮一个固定的回头按钮（`.fz-back`；v0.78 时挂右下角 `20 / 120`，v0.84 起改到**屏幕正中**，见 §55）：

- **一直可见**：`yieldToSite()` 里 `showBackBtn()`、`resumeFromSite()` 里 `hideBackBtn()`；
  只有"用户型让位"才显示 —— 拉取用的 `yieldToSite(true)` 屏幕还是我们的表格，不显示。
- **点它就是回来**：`backToTable()` → `resumeFromSite()` → 700ms 后重读一次评论 + 刷主贴数据
  （刚发的回复、刚点的赞立刻反映到表里），不是简单把界面盖回去。
- **键盘也给两条路**：`Esc`（`typingInBox()` 为真时让给用户 —— 别把人从回复框里拽出来）、
  以及最常用的 `Ctrl+Shift+X`（`escapeAll()` 里先 `backToTable(true)`）。
- 文案跟着改：回复的 toast 写清"要回表格点屏幕正中「返回表格模式」或按 Esc"（6 秒，够看清）。
- **v0.80 又调了一轮**：按钮文案从「← 返回表格」改成「返回表格模式」，尺寸放大到 `14px / padding 12×20 / radius 24`
  （实测 165×44，之前 130×37）—— 它是让位期间唯一能点的东西，得像按钮，不能像小标签。

实测（真机、CDP 注入）：

```
点「回复」                → fz-back=true 箱子 [1294,799,130,37] · fz-yield=true · sheet 隐藏
点「返回表格」            → fz-back=false · fz-yield=false · sheet 又显示
yieldToSite(true)（拉取） → fz-back=false          ← 不该出现的地方不出现
```

---

---

## 51. 首页那一格叫「封面图」—— 编号是给多图用的（v0.79）

### 为什么改

首页（瀑布那一行）本来只放一张封面，却写着 `图01`：数字是给"多图"用的编号，一行只有一张时
反而让人猜"这 01 是什么、点开是不是还有 02"。详情页不一样 —— 主贴是轮播多图，编号确实需要。

所以文案拆成两套，由一个函数统一给：

```js
imgLinkLabel(i, n, listMode)
  listMode=false → '图' + pad(i+1)        // 详情：图01 / 图02 …
  listMode=true  → n > 1 ? '封面图'+(i+1) : '封面图'
```

- 首页（`cellsHtml(data, idx)` 不带 `kind`）→ 传 `listMode = !kind`，走「封面图」；
- 详情主贴 / 评论 → `kind` 是 `'main'` / `'comment'`，仍走编号；
- 判"这一格属于哪张表"在点击时用 `a.closest('.fz-board')`（列表）/ `.fz-notesheet`（详情），
  看图弹窗的标题也跟着叫法走：列表是「封面图 · 800×600」，详情是「图 01 · 800×600」。

真机实测（34 行）：每行只有 1 个图片链接，标签一律 `封面图`；`一行超过 1 张` 的情况在本轮样本里没有，
但逻辑留着 `封面图1 / 封面图2` 兜底（真出现时至少还能分清点的是哪张）。

### 顺带

- 断言同步：本地 `T7b`（原来钉 `/^图\d\d$/`）改成「每个链接都是 `封面图` / `封面图N`」；
  真机 `R30`（原「图片链接是编号的」）改成「写『封面图』，多图才编号」。`T20/T21`（详情页 `图01`）不动。
- `docs/images/list.png` 重拍了一张：现在整列都写着「封面图」。

### v0.85：详情主贴跟上（同一条口径，不再分两张表）

用户接着提「详情页的图01 改成封面图」。上一轮只在首页改了，详情主贴继续写 `图01 / 图02`——
同一个东西、同一个脚本，在两张表里两个名字，看着像两份数据；而且看图浮层的标题也是按
"在哪张表"硬写的（列表 `封面图`、详情 `图 01`），点开又变一次。

改法：把这个判断从"在哪张表"换成"是不是笔记的图"，并且在**生成链接的时候**就定下来：

```js
imgLinkLabel(i, n, cover)   // cover=true 才是封面
  cover=false → '图' + pad(i+1)                  // 评论里的配图：图01 / 图02 …
  cover=true  → n > 1 ? '封面图'+(i+1) : '封面图'  // 笔记的图（首页 / 详情主贴）
```

- `imgLinks(data, cover)` 给封面链接挂 `data-cov="1"`；
- 点击时读的也是这个标记（`a.getAttribute('data-cov')`），不再用 `a.closest('.fz-board')`
  去反推表：详情页里**主贴是封面、评论配图不是**，一页里两种都有，按表推必然推错一半；
- `galleryOf(urls, dims, cover)` 一并接上：看图浮层的标题、`1/6` 旁边那句、←/→ 翻页后的标题
  跟格子里写的是同一个词（以前表格写 `图01`、浮层写 `图 01`，间距都不一样）；
- `paintMain()` 里那次重画（数据后到时补图）原来漏传第二个参数 —— 首屏是 `图01`、
  等接口补到图再重画一次就变 `封面图`，同一行前后两个名字，这次一起修掉。

评论里的配图保持 `图01`：那是评论附件，不是封面，叫「封面图」反而是错的。

断言：本地 `T20` 改成"主贴全 `封面图N`（且带 `data-cov`）+ 评论格仍 `图\d+`（且不带）"，
`T21b/c/d` 的浮层标题跟着改；真机新增 `R30b`（同一条，在详情表上验一次）。

### v0.87：只有第一张叫「封面图」，其余 图2 / 图3 / 图4

v0.85 那一版多图会写成「封面图1 / 封面图2 / 封面图3」，用户当场纠正：**封面就一张**，第 2 张开始
是同一篇的配图，继续叫「封面图2」是错的；而且编号不该补零（`图02` 看着像"第 02 页"）。

```js
imgLinkLabel(i, n, cover)
  cover && i === 0 → '封面图'
  其余（含评论配图） → '图' + (i + 1)      // 图2 / 图3 / 图4 …，不补零
```

- 真机实测（11 图那篇）：`封面图 图2 图3 图4 图5 图6 图7 图8 图9 图10 图11`；
- 评论配图本来就不是封面 → 从 `图1` 起（以前是 `图01`，跟着一起去掉补零）；
- 看图浮层的标题、`←/→` 翻页后的标题都走同一个 `imgLinkLabel`，不会出现"格子写封面图、点开写图 01"；
- 降级路径（伪装失效时把原生页的图变成链接，`degrade()` / 背景图那条）也顺手去掉了 `pad()`；
- 断言同步：`T7b` 改成**按行分组**验（跨行连着数会全是「封面图」，第一版就栽在这），
  `T20/T21b/c/d` 改成 `封面图 / 图2 / 图N`，真机 `R30`、`R30b` 同一条规则。

---

---

## 52. 表头筛选"点不动"：被浮层挡了一层，以及幽灵引用（v0.81）

### 症状

用户反馈：瀑布页的「赞 / 类型 / 作者 / 时间」、详情页的「赞 / 作者 / 时间」都有 ▾，
但点了没反应（"大概率无法点击"）。

### 先量，别猜

无头真机里每个表头格都点得开（`elementFromPoint` 返回的就是表头自己，面板 7/24/8 项都正常）。
所以问题不在"有没有绑事件"，而在**点击有没有打到它**。于是做了一组对照实验：

| 场景 | 修之前 |
| --- | --- |
| A 正常点击 | ✅ 开面板 |
| B 头顶叠一层透明遮罩（不吞事件） | ❌ 事件目标是遮罩，`closest('[data-fz-filter]')` 落空 |
| C 遮罩连 `pointerdown/click` 都 `stopPropagation` | ❌ 我们的 click 监听根本收不到 |

B/C 都是浏览器扩展 / 输入法 / AI 侧栏常见的做法 —— 它们往页面上压一层透明层。

顺带还挖出一个更阴的：**幽灵引用**。`filtEl` 指向的面板如果被谁从 DOM 摘掉（不是走 `closeFilter()`），
之后每次点表头都会命中 `if (filtEl && filtKey === fk) closeFilter()` 这条"关闭"分支 ——
面板早就不在页面上了，于是**永远打不开**，症状和 B/C 一模一样。

### 改法

1. `headerHitAt(x, y)`：用 `document.elementsFromPoint()` 按坐标反查"这一点底下是不是表头"；
   表头只有 24px 高，先用 y 做短路，点别处不做命中测试（每次点击都会走到这里）。
2. `bindHeaderFallback()`：在**捕获阶段**监听 `pointerdown`，目标不是表头但坐标在表头上时，
   直接开面板 / 换排序 —— C 场景（连 click 都被吞）也能救。
3. 捕获阶段处理完，给这一次点击打个 500ms 的宽限（`hdrGraceUntil`）：
   主 click 处理器看到宽限直接整条跳过。否则"点别处关面板"会当场把刚开的面板关掉
   （实测：面板开→300ms 内被自己人关，`closeFilter` 的调用栈指到 `if (!closest('[data-fz-menu-panel]'))`）。
4. 两处 toggle 都改成 `filtEl && filtEl.isConnected && filtKey === fk`；`toggleMenu` 同理。
   幽灵引用不再挡住第一次点击。

### 断言

```
A 正常点击「赞」→ 面板 true
B 透明层盖住（不吞事件）→ 面板 true      ← 之前 false
C 透明层吞事件 → 面板 true               ← 之前 false
开关：点一次 open(7) → 再点 closed → 再点 open(7) → 换列 open(3) → 点页脚 closed
详情页：赞 7 项 / 作者 19 项 / 时间 8 项，面板 z=2147483600、未被遮挡
```

> 本地 315 / 真机 68 pass（2 条数据型 SKIP，不是功能问题）。

---

---

## 53. 回复的让位、回来的落点、表头的最后 6px、评论数口径（v0.82）

### 53.1 回复也要"黑底红框"

点赞 / 收藏点不动时会 `yieldToSite()` + `highlightEl()`（红框 + `box-shadow: 0 0 0 9999px rgba(0,0,0,.45)` 压暗全屏）。
回复那条路径只有"让位 + 聚焦输入框"，屏幕上什么提示都没有 —— 用户看到的就是"跳到一个原生小红书页，不知道该点哪"。
现在回复也 `highlightEl(box)`：黑底压暗 + 红框圈住输入框，和另外两个动作一个观感。

### 53.2 回来时落到瀑布页

`backToTable()` 原来是 `resumeFromSite()` + 700ms 后读一次评论；如果这期间详情表没了，它就直接 `return` ——
而 `sync()` 已经把首页表格建出来了，于是用户"回复完跳回瀑布页"。

为什么详情表会没：站点在提交回复后会重渲染详情节点，我们挂在它下面的 `.fz-notesheet` 被连根拔走
（`noteSheet` 变成脱离文档的幽灵，`maybeNoteSheet()` 第一行 `if (noteSheet) return` 就挡住了重建）。

改法：
- `yieldToSite()` 记下 `yieldHadSheet / yieldPid`（让位那一刻是不是停在详情表上）；
- `backToTable()` 里 `ensureSheet()`：详情表不在就先把幽灵引用清成 `null`、把 `closedPid` 让开，
  再调 `maybeNoteSheet()` 重建，最多试 4 次（140ms 起，每次 +320ms）；
- 重建成功后再读评论 + 刷主贴。

实测：让位后手动把 `.fz-notesheet` 从 DOM 摘掉 → 点「返回表格模式」→ 详情表被重建并显示（不是瀑布页）。

### 53.3 表头最后 6px 点不动

`bindColDrag()` 的 mousedown 把表头右边缘 6px 当"拖列宽"的热区，随后的 click 会被 `colEdgeDown` 吃掉 ——
所以在那 6px 里点筛选 ▾ **"没反应"**。按位置扫了一遍：

```
【赞】【类型】【作者】【时间】  中间=开 · right-16=开 · right-8(箭头)=开 · 最后6px=✗没开 · 左侧+10=开
```

热区收到 3px（双击自适应用的坐标就是 `right-3`，仍然成立）。现在只剩最后 3px 是调宽用的。

### 53.4 评论数：两处口径不一样

标题栏原来用 `行数 - 1`（含回复），表尾「已载入」只数一级评论 —— 同一屏两个数：

```
标题：评论 21/178        表尾：共 178 条评论 · 已载入 14 条
```

统一成"一级评论 + 所有回复"的合计（`cmtCounts()` / `cmtLoadedText()`）：

```
标题：评论 21/178        表尾：共 178 条评论 · 已载入 21 条（评论 14 + 回复 7）
```

标题那格还挂了 `title`：`已展示评论 21 行（一级评论 14 条 + 楼中楼回复 7 条），站点共 178 条` ——
鼠标停一下就知道这个 21 是怎么来的。

> v0.86 又改了一次口径：这个 21 只算"已经拉下来的"，各楼「展开 N 条回复」写着的那 N 条没算进去。
> 用户数出来的应该是 80。见 §56。

---

---

## 54. 回复的压暗、以及表头点不动时的第二条路（v0.83）

### 54.1 回复：先把屏幕压暗，再找框

v0.82 给回复加了 `highlightEl(box)`，用户反馈"还是没有那层黑"。两个原因叠在一起：

1. `highlightEl()` 是"目标元素 + 9999px 外阴影"的做法，回复框常常只有 170×50、还贴在页面底部，
   外阴影铺不满、看起来就像没压暗；
2. 回复框是**点开才渲染**的：`siteAction('reply')` 里 350ms 后一次性 querySelector，
   没命中的时候（类名又换了一版）就什么都不发生。

改法：拆成两层，并且不等目标就先把黑铺上。

```js
dimSite()   // #fz-dim：整屏 rgba(0,0,0,.45)，z=2147483646，pointer-events:none
frameEl(el) // #fz-hl ：只画红框（不再靠外阴影压暗）
```

- `siteAction('reply')`：`yieldToSite()` → **立刻 dimSite()** → 260ms 后开始找输入框，找不到每 250ms 再试，最多 8 次；
- `replyBox()` 不再死认一个选择器：`textarea / .engage-bar input / [class*="comment"] textarea /
  [contenteditable]` 全收，**按"能打字 + 画得出来"**挑第一个（宽 > 60、高 > 16），实在量不到才退一步；
- `clearHighlight()` 顺手把 `#fz-dim` 一起收，点「返回表格模式」/ Esc 都不会留一层黑。

实测（游客态点主贴「回复」）：`dim=true`、`dimBg=rgba(0,0,0,.45)`、`frame=true`、红框 173×56 圈在输入框上。

### 54.2 表头点不动：给一条完全不依赖表头的路

前两轮修的是"表头被浮层挡住"和"最后 6px 被拖动热区吃掉"，用户那边依旧是"点不动"。
与其继续猜，加一个**不看表头也能筛**的入口：工具栏上 `⇅` 旁边多了「筛选 ▾」。

- 点它 → 弹一个小菜单，列出**当前这张表能筛的列**（直接读表头挂的 `data-fz-filter`，列表是 赞/类型/作者/时间，详情是 赞/作者/时间）；
- 选一列 → 关掉菜单、在该列表头下面开条件面板（`openFilter(key, cell)`，位置照旧贴表头）；
- 有筛选生效时按钮变绿（`.fz-filtermk.on`）；
- 它自己的 Tab 站、`aria` 都按"真能点"登记（`KBD_SEL` / `markDecor` / `tabStops` 三处），
  不然会被"装饰件"那道保险丝按掉。

实测：工具栏「筛选 ▾」→ 列名菜单 4 项 → 选「类型」→ 条件面板 3 项 → 选「视频」→ 状态栏「筛选 13/35 行」；
表头本身那条路同时复测仍然正常（点「赞」→ 面板 true）。

### 54.3 v0.88：聚光灯（框内留白）＋ 点赞为什么没有红框

用户两句话：「收藏的功能是完整的，点赞的时候没有红框」「回复的时候（回复框）内不应该有遮罩」。
两个毛病一个根子：**红框和压暗是两套东西，一个负责"圈住"，一个负责"变暗"**，配合错了就两头不讨好。

#### ① 回复框被黑盖住

v0.83 是 `dimSite()`（整屏 `rgba(0,0,0,.45)`，z=2147483646）+ `frameEl()`（只画红框）。
红框是透明的，所以整屏那层黑**照样盖在输入框上** —— 看着像"这框不能打字"。

改法：`frameEl()` 不再只画框，改成和点赞/收藏同款的"聚光灯"：

```js
box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;' +
  'left/top/width/height: 目标框外扩 8px;' +
  'border:3px solid #ff2442;border-radius:8px;' +
  'box-shadow:0 0 0 9999px rgba(0,0,0,.45);animation:fzblink .65s ease-in-out 6;';
```

`box-shadow` 只画在 border box **之外**，元素自己没背景 → 框心天然透明，正好是"挖个洞"。
同时把 `#fz-dim` 撤掉（留着它，洞也被盖住）。找不到框时（回复框还没渲染出来）
`#fz-dim` 继续兜底，所以"压暗 + 提示"这件事不会丢。

实测（真机游客态点「回复」）：`dim=false`、`hl=823,774,158×56`、输入框 `831,782,142×40`
正好落在洞中央，`boxShadow = rgba(0,0,0,0.45) 0 0 0 9999px`。

#### ② 点赞没有红框：hover 那一拍被当成了"点成功"

红框只在"脚本点不动"时才出现。判定原来写的是 `className !== before`：

```js
press(t);                        // 先派发 pointerover / mouseover / mousedown / mouseup / click
setTimeout(function () {
  if (String(el.className) !== before) onDone(true);   // ← 站点 hover 就换了 class
  else next();
}, 260);
```

`press()` 的第一件事就是 `pointerover`/`mouseover`。小红书的赞按钮**一 hover 就改 className**
（换图标/加 hover 类），于是第一拍就被判成"点成功了"：弹一句「已点赞」、不让位、不出红框 ——
而实际上赞根本没点上。收藏按钮 hover 不改类，所以它碰巧是对的（用户看到的就是"收藏完整、点赞没框"）。

改法：判断"成没成"只看**语义状态**，不看类名变没变：

```js
function actOn(el, what) {
  var s = String((el && el.className) || '');
  return what === 'like' ? /liked|like-active/.test(s) : /collect-active|collected/.test(s);
}
// tryPress(el, isDone, onDone)：isDone() 真了才算成
tryPress(el, function () { return actOn(el, what) !== wasOn; }, cb);
```

红框之后等真人点的那段 `pollUntil` 也换成同一条判断 —— 否则鼠标扫过按钮（hover 换类）
就会被当成"点上了"，直接收框回表格。

实测（真机游客态，点表格里的赞/收藏）：两个都是 `yield=true · back=true · hl=true`、
`boxShadow=rgba(0,0,0,0.45) 0 0 0 9999px`、`dim=false`，红框分别圈在 65×32（赞）和 94×40（收藏）上。

---

## 55. 「返回表格模式」搬到屏幕正中（v0.84）

### 55.1 为什么不能挂右下角

从 §50 起这个按钮就固定在 `right:20px / bottom:120px`（当时是为了避开站点自己那一簇浮标：客服、发布、回到顶部）。
真用起来问题在"视线"上：

- 让位的时候用户已经在原生页面上**把注意力放在中间**（点开的笔记、弹出的回复框、登录框都在中间）；
  回头路挂在右下角，等于把唯一的出口放在余光里；
- 右下角那一带本身就是站点浮标的聚集区，`bottom:120px` 只是"这次没撞上"，站点一改版就会叠；
- 回复框在底部，按钮再往下压就会挡住输入。

结论：让位期间的回头路应该出现在**用户正在看的地方**，也就是屏幕正中。

### 55.2 改法

```js
'.fz-back{position:fixed;left:50%;top:50%;z-index:2147483647; ...' +
  'transform:translate(-50%,-50%);transition:background .12s,transform .12s;}',
'.fz-back:hover{background:#1b5e3a;transform:translate(-50%,calc(-50% - 2px));}',
'.fz-back:active{transform:translate(-50%,-50%);}'
```

两处不能省：

1. **hover / active 的位移必须叠在 `translate(-50%,-50%)` 上**。直接写 `translateY(-2px)` 会把居中的
   `-50%` 一起覆盖掉，鼠标一放上去按钮就横跳半个身位（165px 宽 → 跳到偏右 82px）。
2. **`z-index` 从 `2147483646` 提到 `2147483647`**。回复流程会先铺一层 `#fz-dim`（`rgba(0,0,0,.45)`，
   同样是 `2147483646`），两个同层时"后插入的赢" —— dim 是点开回复之后才建的，正好盖在按钮上面，
   按钮会被压暗一档，看着像灰掉了（点还是点得动，因为 dim 是 `pointer-events:none`，但视觉不对）。

### 55.3 踩坑：量"居中"不能用 `innerWidth`

回归断言第一版直接拿 `innerWidth / 2` 当中心，实测 `dx=-7 dy=-7` 判失败，但截图看着就是居中的。
原因是 `position:fixed` 的百分比是相对**初始包含块（去掉滚动条）**算的，而 `innerWidth` 把滚动条也量了进去：
15px 的滚动条 → 正好差 7.5px。改用 `document.documentElement.clientWidth / clientHeight` 就对齐了。

> 记一句话：**"元素在屏幕正中"和"视口宽度的一半"不是一回事**，量之前先想清楚用的是哪把尺子。

### 55.4 实测（真机 1440×900，CDP 点主贴「回复」让位）

```
.box          637,428 165×44      center 720,450   dx=0 dy=0
z             2147483647          #fz-dim z=2147483646（按钮在它上面）
hover         dx=0 dy=-2          transform=matrix(1,0,0,1,-82.59,-24)  ← 只上移 2px，横向不动
中心 elementFromPoint → SPAN（按钮自己的文字）
鼠标真点中心  → back=false · fz-yield=false     ← 真的回到表格
```

### 55.5 回归断言（`test.html` 新增 BK1–BK4）

| 用例 | 钉住的规矩 |
| --- | --- |
| BK1 | 拉取型让位（`yieldToSite(true)`）不摆按钮，`resumeFromSite()` 之后也不残留 |
| BK2 | 按钮中心 = `clientWidth/2, clientHeight/2`（±1px），顺带打印 `transform` |
| BK3 | `z-index` 比 `#fz-dim` 高一档，且视口正中那一点 `elementFromPoint` 落在按钮上 |
| BK4 | `resumeFromSite()` 之后按钮自己消失（不会一直挂在原生界面上） |

本地 **319 pass / 0 fail**（原 315 + 新增 4）；真机 **70 pass / 0 fail**。

---

## 56. 「已展示评论」把「展开 N 条回复」也算进来（v0.86）

### 56.1 用户数了一遍

v0.82 把标题栏和表尾统一成"一级评论 + 已载入回复"，屏幕上是：

```
标题：评论 17/265      表尾：共 265 条评论 · 已载入 17 条（评论 10 + 回复 7）
```

用户拿手指头点着屏幕数：**17 行 + 3+22+6+17+11+4 = 80**，应该是「评论 80/265」。
那 6 个加数是每个楼底下「展开 N 条回复」里的 N —— 他眼里这些也是"屏幕上已经告诉我的评论"。

他这个数法是有道理的：这个指标的作用是"我手上这批行，一共代表了站点多少条评论"，
而「展开 22 条回复」是**表格自己写出来的**，属于已告知的信息，不该只算行数。

### 56.2 新口径

```
已展示 = 表里现在的评论行（一级评论 + 已载入的回复）
       + 各楼「展开 N 条回复」里的 N
```

实现分两处，必须是同一个口径：

| 场景 | 函数 | 怎么数 |
| --- | --- | --- |
| 表已经画出来了（标题栏、表尾） | `cmtCounts(el)` | DOM：数 `.fz-nrow`，再读每个根行里 `.fz-toggle[data-total]` |
| 表还没画（拼 HTML 那一刻） | `cmtCountsOf(list)` | 数据：`subTotal`（站点给的回复总数），`N ≥ 2` 才算 |

两个细节：

- **只认 `mode === 'open'` 的楼**。`applyFold()` 会把已展开的楼标成 `close`（或加载中的 `more`），
  这时那 N 条已经落进 `rows` 里了 —— 再算一遍就是双计，展开前后数字会突然翻倍。
- **`subTotal` 可能是字符串 `'10+'`**：`parseInt('10+', 10) === 10`，认成 10 就行（站点自己也只写"10+"）。

表尾那行小字（`.fz-cnote`）不再由拼 HTML 的地方定稿，改由 `updateNsStat()` 统一刷 ——
标题栏和表尾永远是同一个数，不会出现"标题 80、表尾 17"。

```
标题：评论 95/614
title：已展示评论 95 条（表里 27 行：一级评论 17 条 + 已载入回复 10 条；另有 68 条挂在各楼「展开 N 条回复」里），站点共 614 条
表尾：共 614 条评论 · 已展示 95 条（评论 17 + 回复 10 + 未展开 68）
```

### 56.3 顺手修的真机断言 bug：模板字符串里的 `\d` 被"煮"掉了

`R30b`（`real-check.mjs`）一开始红着，报 `mainOk=false`，可打出来的标签明明是 `封面图1[1]`。
原因是它跑在 `cdp.evaluate(\`...\`)` 里 —— **模板字符串会先把 `\d` 煮成 `d`**（跟普通字符串一样，
只有 tagged template 的 `raw` 才保留反斜杠），于是页面里执行的是 `/^封面图d*$/`。改成 `\\d` 才对。

> 记一句话：**拼进 `evaluate` 的正则，反斜杠要写两遍**。

### 56.4 顺手修掉的老毛病：加载诊断把"已展示"那行顶掉了

表尾那行灰字一直是这么写的：`live.parentNode.querySelector('.fz-mdim')` —— 取**第一个** `.fz-mdim`。
以前第一个就是"共 N 条评论 · 已载入 …"，所以点完「加载更多评论」，那句统计就被
`评论区被锁（未登录）·未驱动滚动` 之类的诊断**替换掉、而且不会恢复**（v0.82 起就这样，只是没人注意）。

这次"已展示"成了唯一口径，被顶掉就等于数字消失。现在给诊断单独一格 `<span class="fz-cdiag">`，
`tip` 只写它，统计那行（`.fz-cnote`）谁都不许动。

实测（真机，点「加载评论」）：

```
进来时  标题 评论 68/210 · 表尾 已展示 68 条（评论 12 + 回复 10 + 未展开 46）
点加载  标题 68/210 · 表尾 原样（诊断写进自己的格子）
核对    行 22 + 折叠 46 = 68；从 DOM 独立数一遍 toggle 也是 46；标题、表尾都是 68
```

### 56.5 断言

| 用例 | 钉住的规矩 |
| --- | --- |
| 本地 `T71` | 造一条「展开 22 条回复」的楼：`all` 正好 +22；把它标成 close 就 -22（只算一次）；移除后回到原值；标题栏和表尾都是这个数 |
| 本地 `T71b` | 数据版 `cmtCountsOf` 与 DOM 版同口径（N ≥ 2 才算，`10+` 认成 10） |
| 真机 `R30b` | 详情主贴写「封面图」、评论配图写「图01」（v0.85 那条，顺手把转义修好） |

本地 **321 pass / 0 fail**（原 319 + 2），真机 **71 pass / 0 fail**。

---

## 57. 设置面板：把功能做成开关（v0.89）

### 57.1 为什么

到 v0.88，脚本里能改的东西全在代码里：想关掉"长正文折叠"、不想让视频静音、嫌加载卡片挡视线 ——
只能去改 `CFG` 默认值。菜单只有 4 项，且是"点一下立刻变"，没有"改一堆再一起存"的地方。

用户拿了一张 NGA 优化脚本的设置图：暖白卡片、左右两栏、一行一个勾、底下一排按钮、右下角「保存设置」。
照这个做，并且**所有开关默认勾上**（默认体验不变，想关的自己去关）。

### 57.2 结构

```
小红书 · 表格模式  v0.89                                    ✕
──────────────────────────────────────────────────────────
显示优化                          功能增强
 ☑ 折叠过长正文（超过 300 字）      ☑ 详情页接管（点笔记在表格里看）
 ☑ 图片变成文字链接（点开看原图）    ☑ 加载时的进度卡片
 ☑ 单元格悬停显示全文               ☑ 视频默认静音
 ☑ 键盘 Tab 时的绿色描边            ☑ 选中时状态栏报求和/平均
──────────────────────────────────────────────────────────
 + 高级设置        ← 展开：首页表格模式（总开关）/ 标题栏显示已登录伪装 / 文件名
──────────────────────────────────────────────────────────
[恢复默认] [导出设置] [导出 CSV]              [保存设置]
```

入口：工具栏 `⋯` →「设置…」（菜单从 4 项变 5 项）。Esc / 点遮罩 / 右上角 ✕ 都能关。

### 57.3 每个开关落在哪一行代码

| 开关 | 关掉之后 |
| --- | --- |
| `foldText` | `cellsHtml()` 里不再截 300 字，正文整段铺开（导出/复制本来就是全文） |
| `imgLink` | `imgLinks()` 直接返回「N 张图」，不再铺一排链接 |
| `tips` | `cellTips()` 直接 return，单元格不再挂 `title` |
| `kbRing` | `<html>` 挂 `fz-nokbd`，CSS 把我们的 `:focus` 描边全关 |
| `detailSheet` | 走原来的 `applyDetailSheet()`：关掉时把详情表收掉 |
| `busy` | `busyShow()` / `busySet()` 直接返回，按钮上的文字照样变 |
| `hush` | `hushVideos()` 返回 0，视频保持站点原声 |
| `statSel` | `selStats()` 返回 null，状态栏不再报求和/平均 |
| `tableMode` | 走 `applyTableMode()`：伪装层全收、站点元素全还 |
| `docTitle` | 走 `setDocTitle()`：标题栏文件名 |
| `login` | 只影响标题栏那个"已登录"装饰 |

**保存才生效**：面板上的勾只是表单，点「保存设置」才写 `CFG` + `store.set()`；「恢复默认」只把表单
勾回默认（全部开），也要再点保存 —— 免得手滑一下全部变了。

改了"影响单元格内容"的三个（`foldText` / `imgLink` / `tips`）会顺手重画一次：列表用
`lastAnchorCount = -1; schedule(true)`，详情表用 `removeSheet()` + `maybeNoteSheet()`
（这两个是在拼 HTML 时决定的，不重画就得刷新页面）。

### 57.4 踩坑 99：原生 checkbox 在站点页会被 reset 抹掉

第一版直接用 `<input type="checkbox">`，本地测试页好好的，真机上**整排看不见勾**（只有文字）——
小红书的 reset 把 `input` 的外观清掉了，`accent-color` 也救不回来。

改法：input 只留语义（`position:absolute;opacity:0`），样子交给紧跟其后的 `<i class="fz-set-cb">`：

```css
.fz-set-row input:checked + .fz-set-cb{background:#1b6fe3;border-color:#1b6fe3;}
.fz-set-row input:checked + .fz-set-cb::after{content:"";width:5px;height:9px;
  border:solid #fff;border-width:0 2px 2px 0;transform:rotate(42deg);}
```

选中状态、`label` 点击、键盘可达全靠那个隐藏的 input —— 测试里读的也是 `input.checked`，不受影响。

另外面板本身要加进 `isOurs()`（`.fz-setwrap`），否则 `hideSideBars()` 那套"藏站点浮层"的启发式
会把它当站点控件藏掉（§13 踩坑 35 的老毛病）。

### 57.5 实测

```
真机开面板  10 个复选框 · 全部勾选 · 面板 760×347 · 标题「小红书 · 表格模式 v0.89」
高级设置    默认 display:none，点开后露出 总开关 / 登录伪装 / 文件名 输入框
关两个开关  详情页那篇正文 301 字（截断） → 956 字（整段），图片格 封面图 → 「1 张图」
改回来      301 字 + 封面图（重画生效，不用刷新）
```

断言：本地 `T74`（菜单能开面板 / 两栏 / 10 个勾默认全开）、`T75`（高级设置默认收着、点开露出）、
`T76`（关 → 保存 → CFG 与存储都变 → 重开仍是关 → 改回能存回去）；菜单项数 4 → 5 的旧断言同步更新
（`T58`、真机 `R19` / `R28`）。

本地 **329 pass / 0 fail**；真机 **68 pass / 0 fail**（另有数据型 SKIP）。

### 57.6 v0.90：真机逐个开关复验，抓出 6 个问题

本地用例全绿不等于开关真的能用 —— 接上可见浏览器（§58）之后一个一个点，翻出来这些：

| 现象 | 根因 | 修法 |
| --- | --- | --- |
| 关掉「图片变链接」，列表照旧是链接 | `reflowFeed()` 会跳过**已经有 `.fz-cells` 的卡片**，`schedule(true)` 根本不重建行 | 新增 `rebuildCells()`：只换每行那个 `.fz-cells` 子节点（不动卡片上的 click，否则每次重画都会多绑一个 `openNote`，点一下开两个标签页） |
| 重画之后图片没了，只剩「—」 | 重画时用 `readCard(card)` 现场读，可这时候站点卡片早被我们藏了，`imgList()` 量到 0 张 | `buildRow()` / `appendBoardRow()` 建行时把数据存 `card.__fzData`，重画直接用这份 |
| 关掉「详情页接管」再打开，详情表不回来 | 关闭时走 `closeNoteSheet()`，它顺手记了 `closedPid`（"这篇用户关过"），再打开也不弹 | 关闭改成只 `removeSheet()`；重新打开时 `closedPid = ''` 并补一次 `maybeNoteSheet()` |
| 关掉「键盘描边」没反应 | CSS 依赖容器（`.fz-rows` / `.fz-chrome`），可行有两种宿主（站点卡片 / 数据看板的 `.fz-brow`） | 改成按**控件本身**点名单（`.fz-link:focus`、`[data-fz-filter]:focus` …） |
| 设置改完"只对一半生效"，详情表叠了两三张 | **同一个页面被注入多次**：每次 `addScriptToEvaluateOnNewDocument` 都会多跑一遍，各建一整套界面 | 脚本开头 `if (window.__fzLoaded) return;` 认领一次 |
| 首屏会露一下原生页面 | 幕布撤得比第一帧还早（`why=shell` 那条只看"外壳在+站点藏住"） | 撤幕布再加一条：**`why=shell` 时必须等 `performance.getEntriesByType('paint')` 有条目**（表格/详情表已经在了就不等 —— 第一帧画的就是我们的表） |

复验结果（真机、可见窗口，点真的开关、看真的 DOM）：

```
imgLink  35 链接 → 关掉 0 链接（格子写「1 张图」）→ 打开 35 链接
tips     169 个 title → 0 → 169
kbRing   outline 实心+绿底 → none+透明 → 实心+绿底
statSel  「平均值/计数/求和」有 → 无 → 有
detailSheet 详情表在 → 关掉没了 → 打开又回来
foldText 301 字（截断，有「展开全文」）→ 711 字（整段，无按钮）→ 301 字
hush     视频 muted=true → false
busy     点加载有卡片 → 关掉没卡片
```

### 57.9 v0.91：面板/工具栏「点了没反应」—— 给单点委托处理器加兜底

用户报：**瀑布页和详情页的筛选面板里，条件点了没反应；工具栏按钮也点不动**（截图里红框圈的是
排序项 + 筛选条件）。

我这边（单实例、脚本刚注入）复现不出来：`el.click()` 和真鼠标都能筛。能解释这个现象的是
**页面上跑着两份脚本**（油猴里装了两个、旧版没删、或别的管理器也装了）：两份各注册一个
window 捕获 click，先注册的那份先把 click 办掉并 `stopPropagation()` —— 用户点的条目被旧版处理，
旧版改的是它自己那套状态，屏幕上自然"什么都没发生"；工具栏按钮同理。

代码这边做了三件事，任何一条都足以让点击重新生效：

1. **面板自己接一层 click**（`bindPanelClicks`）：正常情况全局那条先 `stopPropagation()`，这层不会被触发，
   所以不会点一次执行两次；全局那条哑火时才由它接手。覆盖条件项、面板顶部的排序项、列名面板、空表按钮。
2. **按下 120ms 还没生效就补一刀**（pointerdown + 延时核对状态）：
   - 条件项：比对 `FILT` 当前值，不一样才 `setFilter`（幂等）；
   - 排序项：比对 `sortState()` 的 key/dir（`setSort` 是"设成确定状态"，也幂等）；
   - **为什么不直接在 pointerdown 里办**：`setFilter()` 会把面板重画一遍（每项要更新"当前 N 条"），
     按下就重画＝把正要 click 的那个节点换掉，容易点到别的项上。实测过，`sameItem=false`。
3. **工具栏四个按钮**（筛选 ▾ / ⇅ / ⇩ / ⋯）同样加 pointerdown 兜底：按下 150ms 后看"该开的面板开了没"，
   没开就自己开（只开不关，重复也不会刚开就关掉）。

另外加了一个**自检**：`checkDupScripts()` —— 页面上出现两个 `.fz-chrome.fz-head` 时，
`<html>` 挂 `fz-dup` 并弹一句「检测到两份脚本同时在跑，只保留一份并更新到最新版」，把根因直接说给用户。

实测（可见窗口）：

```
正常点击「≥1000」→ 筛选 23/33 行（只生效一次，400ms 后没被二次改动）
只发 pointerdown（模拟 click 被吃掉）→ 120ms 后自己补上，筛出生效
排序项只发 pointerdown → 就绪 · 排序：时间 ↓，面板自动收起；再点「恢复原顺序」回「就绪」
两份脚本检测：heads=1 时不误报
```

### 57.8 全量回归（v0.90 收尾）：跑了什么、结论

| 轮次 | 结果 |
| --- | --- |
| 本地 `test*.html` ×5 | 333 pass / 0 fail（固定） |
| 真机 `--real` ×6 | 402 或 401（69 pass / 68 pass + 1 条数据型 SKIP），0 fail |
| 巡检 `--sweep=6` | 419 pass / 0 fail（18 pass + 2 条数据型 SKIP） |
| 设置面板 8 个开关 ×2 轮 | 全部按预期（见 §57.6） |
| 设置面板周边（恢复默认 / Esc / 点遮罩 / 导出设置 / 导出 CSV） | 全部正常：恢复默认只改表单、Esc 与遮罩都不写配置 |
| 非设置抽查（筛选 / 搜索 / 看图 / 选中统计 / 列头排序） | 全部正常 |

两个**看起来像 bug、其实不是**的点，记下来免得下次再查一遍：

- **点「赞 / 类型 / 作者 / 时间」列头只出筛选面板，不排序** —— 这几列同时是筛选列，
  点它按 Excel 的规矩是开下拉；排序在面板顶部（「升序 / 降序 / 取消排序」）。
  真正"点列头三态排序"的是**没有 ▾ 的列**，比如「标题」：↑ → ↓ → 回原序（实测文案
  `就绪 · 排序：标题 ↑` → `↓` → `就绪`）。
- **`el.click()` 之后 `e.clientX/clientY` 是 0**：表头的"坐标反查兜底"（`headerHitAt`）
  在这种合成点击里量不到东西，别拿它当"表头点不动"的证据；用真坐标的
  `Input.dispatchMouseEvent` 或者直接看面板开没开。

### 57.7 复验时踩的三个"测试环境"坑（不是脚本的锅）

1. **开发扩展的 `content.js` 是快照**：`--load-extension` 挂的开发扩展里那份脚本停在我打包那一刻，
   浏览器一加载就在后面把 `window.__fzProbe` 覆盖回去 —— 于是"改了没反应"，害我以为是开关失效。
   现在 `live-edge.mjs` 不再挂扩展，统一 CDP 注入。
2. **窗口在后台时 `:focus` 不生效**：量键盘描边一直是 `none`。要用
   `Emulation.setFocusEmulationEnabled(true)` 让页面以为自己有焦点。
3. **`page.reload` 不会清掉旧注入**：同一标签页反复注入会累积，界面上是"多套表格叠着"。
   复验脚本现在每次都从干净页面开始，脚本自己也加了单例守卫。

---

## 58. 把脚本接到"看得见的浏览器"上（本地开发，v0.89 起）

平时验证都用无头 Edge（`check.mjs` 自己拉一个），好处是快、可回归；坏处是**看不见**，
而且永远是游客态。要看"登录之后到底什么样"，就得接一个真窗口。

### 58.1 三件事

```
node live-edge.mjs      # 起一个看得见的 Edge（调试端口 9334 + 专用配置 .cdp/live）
node live-attach.mjs    # 把 gm-stub + 用户脚本注入当前标签页，并刷新
node live-keep.mjs      # 常驻：注入 + 每 4 秒盯一次，导航/刷新后自动补回来
```

> **端口必须是 9334**：`check.mjs` 跑真机用例时，如果 9333 上已经有一个浏览器活着，它会**直接用那个**
> （`portAlive()` 的逻辑），于是"回归"其实是在你的可见窗口里点来点去 —— 数据是游客的、状态是脏的，
> 还会看到各种莫名其妙的 SKIP。吃过一次亏之后把可见窗口挪到 9334，9333 只归测试。

`live-edge.mjs` 里的关键参数：

```
--remote-debugging-port=9333          CDP 端口
--user-data-dir=.cdp/live             独立配置，不碰用户自己的浏览器
--window-size=1440,900                跟截图/断言里的视口一致
```

### 58.2 为什么不用 `--load-extension`

第一版把脚本打包成一个 MV3 扩展（`content_scripts` + `"world":"MAIN"`，因为脚本要读页面的
`__INITIAL_STATE__` 和拦 fetch，隔离世界读不到），结果 **Edge 156 静默不加载**：
`--load-extension` 从 Chromium 137 起只在特定条件下生效，加
`--disable-features=DisableLoadExtensionCommandLineSwitch` 也没救回来。

于是改走 CDP：`Page.addScriptToEvaluateOnNewDocument` **只要那条会话还活着，每次导航都会重新执行**。
所以 `live-keep.mjs` 就是一个"把会话一直挂着"的守护进程 —— 用户在窗口里随便点、随便跳，
脚本都还在；万一发现页面上没有 `.fz-chrome`，它就再注一次 + 刷新。

> 副作用：这个窗口的登录态是**独立配置**里的，用户得自己扫码登一次；关掉守护进程后，
> 新开的标签页就没有脚本了（和 Tampermonkey 的"装一次永久在"不是一回事）。

### 58.3 用它在实机上做过的验证

- 设置面板：点 `⋯` → 「设置…」→ 10 个开关全勾、标题带版本号（截图见 `shots/live-settings.png`）；
- 导航到笔记：列表页 → 详情页，脚本自动回来（`rows≈98`、`.fz-notesheet` 在），不用手动刷新。

---

## 59. 伪装区和工具区分开（v0.92）

用户的原话：「把左侧伪装用的按钮和本脚本真正的功能分开，把设置和真正的功能放在一起，
真正的功能和别的采用不同的样式显示，以方便用户区分」。

### 59.1 问题

工具条（`.fz-t2`）原来是**混着排的**：真能用的 4 个（筛选 / ⇅ 排序 / ⇩ 导出 / ⋯ 设置）夹在
十几个 Excel 样子货中间（常规、10、B/I/U、边框、%、⌕、❄、格式刷…），长得一模一样。
用户根本分不清"哪些点了会有反应"。设置还缩在最右边一个小 `⋯` 里，最像装饰的恰恰是最有用的。

### 59.2 改法

结构上切成两段：

```html
<div class="fz-t2">
  <span class="fz-deco">   … A1 / 开始 插入 / 推荐 RED … / 常规 10 / B I U / ▨ / ⌕ / ❄ / 格式刷 …  </span>
  <span class="fz-tools" role="group" aria-label="表格模式工具">
    <span class="fz-tool-tag">工具</span>
    <span class="fz-tb fz-filtermk" data-fz-fmenu="1">筛选▾</span>
    <span class="fz-tb" data-fz-sortmenu="1">⇅▾</span>
    <span class="fz-tb fz-export" data-fz-export="1">⇩</span>
    <span class="fz-tb fz-menu-btn" data-fz-menu="1">⚙ 设置</span>
  </span>
</div>
```

样式上明确区分：

- `.fz-deco{pointer-events:none;min-width:0;overflow:hidden;flex:0 1 auto;}` —— 伪装区**不吃鼠标**
  （点了不会有任何反应，也不会出现"手型光标"暗示可点），窗口窄时**先裁它**；
- `.fz-tools{margin-left:auto;flex:0 0 auto;border:1px solid #b9d3bf;background:#f1f8f3;border-radius:3px}`
  —— 靠右、浅绿底 + 细描边，前面一个 `工具` 小标签，里面文字用 Excel 的绿（`#1b5e3a`）加粗

`data-fz-*` 属性一个没动，所以点击/键盘/兜底三条路全都不受影响。

### 59.3 顺带修的一处测试脆弱点

`test.html` 里 `moreBtn()` 原来是**按文案找按钮**（`textContent === '⋯'`）。按钮一改名（`⋯` → `⚙ 设置`）
四条用例当场红（SG2/SG3/SG4a/SG5）。真机 `real-check.mjs` 也是同样写法。
现在统一改成按属性找：

```js
document.querySelector('.fz-tools [data-fz-menu], .fz-chrome [data-fz-menu]')
```

> 记一条：**测试按"文案"找控件，改文案就红；按 `data-*` 找，文案随便改。** 以后新增可点控件先给它一个
> `data-fz-xxx`，再写用例。

### 59.4 实测

```
工具组 box = [1252, 32, 180×21]（1440 宽的窗口，贴在右侧）
伪装区 pt-events = none，宽度 1136，窗口变窄时整段被裁
组内按钮：筛选 ▾ / ⇅ ▾ / ⇩ / ⚙ 设置
```

---

## 60. 详情页的楼层骨架（v0.93）

用户：「为详情页，有回复的楼层给出更明显的标记，以区分各个楼层」。以前全靠缩进 + `↳`，
几十楼滚下来分不清哪一行是新楼、哪一行是楼中楼。

### 60.1 做法

三件事一起上，**都不占新列**（详情表还是 7 列，导出/筛选/排序全不受影响）：

| 加在哪 | 怎么加 | 效果 |
| --- | --- | --- |
| 一级评论行（`data-floor="N"`） | 作者列前面插 `<i class="fz-fl">N楼</i>` | 每条楼一进门就看见第几楼 |
| 有回复的楼（`.fz-haskid`） | 行上 `box-shadow: inset 4px 0 0 #217346` + 背景 `#eef8f2`，徽标加 `.has` 变绿 | 一眼扫到"这楼有下文" |
| 楼中楼（`.fz-lv1/2/3`） | 不动，照旧缩进 + `↳ 回复 @某某` | 层级还在 |

楼与楼之间再加一条 `inset 0 2px 0` 的浅灰分隔线。

**为什么用 `inset box-shadow` 而不是 `border-left`**：border 会把整行往右推 3px，
和表头、和别的行全部对不齐；inset 阴影画在盒子内侧，布局一点不动。

### 60.2 两个坑

1. **徽标和作者名会被拆成两行**：`.fz-a b{display:block}` 把名字变成块级，`<i>徽标</i><b>名字</b>`
   就成了上下两行。修法是把两者包进 `.fz-aname` 做 flex 横排；但 **选择器要写 `.fz-a .fz-aname`** ——
   `.fz-a span{display:block}` 比单个 `.fz-aname` 具体，只写类名会被它按回 block（实测 `disp:block`，
   徽标还在上一行）。
2. **导出不能带上"3楼"**：`cellText()` 会把单元格的纯文本拿去写 CSV / 进剪贴板。把 `.fz-fl` 加进它的
   剔除名单（和 `.fz-full` / `.fz-toggle` 一起），导出拿到的还是干净作者名。

### 60.3 第三个坑：按内容调宽少算了一个徽标的宽度

"双击列边缘按内容自适应"（`autoFitCol`）是靠 `textWidth()` 量的，而它是**逐个文本节点取最长**，
取的不是"同一行几段的宽度之和"。徽标和作者名并排以后，算出来的宽度 = 名字宽，
正好差一个「3楼」的宽度 → 调完名字还是被截住（真机 `R6x` 红：`被截住 1 → 2`）。

修法：`textWidth()` 末尾补一段 —— 遇到 `.fz-aname` 就把"名字的 canvas 宽 + 徽标的实际宽 + 5px 间距"
加起来，和原来的结果取最大值。

```
名字被裁的问题 → 先看是不是"一行里有几段并排"，textWidth 只取最长那段
```

### 60.4 断言

- 本地 `T78`：每条楼都有「N楼」且序号连续；有回复的楼才有 `.fz-haskid`，且徽标带 `.has`；回复行不挂徽标
- 本地 `T78b`：格子原文含"楼"，`cellText()` 之后不含"楼"（导出干净）
- 实测（真机一篇 16 楼的笔记）：`1楼✅ 2楼✅ … 10楼✅ 11楼 12楼`，✅ = 带绿边/绿标

---

## 61. 设置面板换成表格同款皮肤（v0.94）

用户：「把设置页面的样式风格和整体做统一」。

### 61.1 问题

设置面板是按用户给的那张参考图做的：**米色底 `#fbf4e7` + 大圆角 16px + 蓝色方勾 `#1b6fe3` + 21px 居中标题**。
而表格本体是**白底、灰色细线、方角、Excel 绿 `#217346`** —— 一个暖色一个冷色，一个圆一个方，
打开设置像进了另一个产品。

### 61.2 改法（只动 CSS，DOM 一个字符没改）

| 元素 | 之前 | 现在 |
| --- | --- | --- |
| 面板底 | `#fbf4e7`、圆角 16、无边框 | `#fff`、圆角 3、1px `#b9bec7`、`0 10px 34px` 阴影 |
| 标题条 | 21px 居中、无底 | 34px 高浅灰条 `#f4f6f5` + **3px 绿左框**、14px 左对齐、版本号小灰 |
| 关闭 ✕ | 28px 圆角、暖灰 | 22px 方角、hover `#e4e8ea` |
| 栏目标题 | 15px 纯文字 | 12.5px + **3px 绿竖条**（和表头强调色同一个绿） |
| 复选框 | 16px / 蓝 `#1b6fe3` | 15px / 绿 `#217346`，hover 描边变浅绿 |
| 输入框 | 圆角 6、暖色描边 | 方角 2、`#c9ced6`，聚焦变绿 + 2px 绿光 |
| 底部按钮 | 圆角 7、米色 | 方角 2、`#fdfdfd` + `#c9ced6`（和工具栏按钮一致），hover `#eef1f3` |
| 主按钮「保存设置」 | 白底加粗 | **绿底白字** `#217346` |

字号也统一到 12.5px（等于表格正文），不再用 13.5/15/21 三档混着来。

### 61.3 实测

```
面板 720×277，背景 rgb(255,255,255)，圆角 3px
勾选态背景 rgb(33,115,70) = #217346（和表头、工具组同一个绿）
标题「小红书 · 表格模式 v0.94」，左侧 3px 绿边
底部：恢复默认 / 导出设置 / 导出 CSV …… 保存设置（绿底白字）
```

> 教训：**皮肤要从"本体"里取，不要从参考图里取。** 参考图给的是布局骨架（两栏 + 折叠 + 底部按钮），
> 配色/圆角/字号必须跟着自家界面走，否则拼起来就是两个产品。

---

## 62. 「展开 N 条回复 / 再加载几条」搬去本楼最底部（v0.95）

用户：「展开和，再加载应该在本楼的最底部」。

### 62.1 问题

以前这两个入口是**楼主那一格内容里的一个链接**（`cellsHtml` 里生成 `.fz-toggle`）。于是折叠状态
（默认只显示第一条回复）下，屏幕上读到的顺序是：

```
3楼 xinx   这是咋了
           [展开 3 条回复]        ← 按钮压在第一条回复上面
           ↳ 回复 @xinx：不小心放冻柜了
4楼 …
```

一行字写在"回复"之上，看着像"还没点，回复就已经出来了"，也说不清这 3 条到底挂在谁名下。

### 62.2 做法：独立一行，钉在本楼最后一条回复之后

新的渲染顺序是 `楼 → 它的回复… → 按钮行 → 下一楼`：

```
3楼 xinx   这是咋了
           ↳ 回复 @xinx：不小心放冻柜了
           [展开 3 条回复]          ← 本楼最底部
4楼 …
```

- `cellsHtml()` 里删掉那段链接，改由 `cmtRowsHtml()` 在"换楼"的那一刻补：
  维护一个 `pend`（当前这一楼还没收尾），遇到下一个一级评论就先 `closeFloor()`，最后再收一次尾。
- 新函数 `floorToggleHtml(c, total)` 生成 `<div class="fz-trow">`，里面还是原来那个 `.fz-toggle`
  （`data-k/idx/more/total/mode` 一个没少），所以 `applyFold()` 的文案切换、`expandOnSite()` 的
  "去点站点那一下"、`cmtFolded()` 的计数全都不用改语义。
- 折叠时后面几条回复是 `display:none`，按钮行不参与折叠 —— 于是"收起来"时它自然贴在那唯一一条
  回复下面，"展开"后又贴到最后一条下面。**同一个位置，两种状态都对**。

**关键一步：这一行不能叫 `.fz-nrow`。** 全项目认"数据行"的地方（`scopeRows()`、CSV 导出、
行号映射、键盘选区、`autoFitCol` 的 `fitRows()`）都是按 `.fz-nrow` 找的。少写一个 class，
比在十几处加 `:not(.fz-trow)` 稳得多 —— 真机上 `R17`（CSV 行数 = 表格行数）当场就证明了这一点。

样式（`grid-column: 4 / -1` 把按钮钉在内容列的起点，用户拖列宽时它跟着走，不用算像素）：

```
.fz-trow{border-bottom:1px solid #d0d0d0;background:#f7fbf9;box-shadow:inset 4px 0 0 #cfe6d8;}
.fz-trow .fz-cells{min-height:0;align-items:center;}
.fz-trow .fz-tg{grid-column:4 / -1;display:flex;align-items:center;gap:8px;padding:2px 8px 3px 20px;…}
```

左边那条浅绿竖线是**故意接在 `.fz-haskid` 的绿边下面**的：一眼看得出这行属于上面那一楼。

### 62.3 坑：排序一跑，所有按钮行在表格顶上堆成一坨

真机 `R39` 连红两次，报的顺序是：

```
[展开行] [展开行] [展开行] [展开行] 回复 ×8 楼7 楼11 楼1 楼9 楼15 楼4 …
```

楼号是乱的（7/11/1/9/15/4）——**乱的楼号才是线索**：数据行被某个东西重排过，而按钮行没跟着走。

`sortRows()` 的写法是"取出所有 `.fz-row/.fz-nrow` → 排序 → 逐个 `insertBefore` 搬回去"。
`.fz-trow` 不在这个名单里，于是**数据行全被搬走，按钮行原地不动**，最后一起留在表格最前面。
平时不排序看不出来；而排序是"视图的一部分"，列表页按过「时间↓」，进详情页照样生效
（`real-check` 的 `R33` 正好在这条断言之前按过一次）。

修法：搬行时把"行 + 紧跟它的按钮行"当成一个整体搬（`unitOf()`），锚点也取最后一个整体的末尾：

```js
function unitOf(row) {
  var u = [row], n = row.nextElementSibling;
  while (n && n.classList && n.classList.contains('fz-trow')) { u.push(n); n = n.nextElementSibling; }
  return u;
}
```

> 教训：**往一张"会被排序 / 会被筛选 / 会被重画"的表里加新行，先问一句"它跟着谁走"。**
> 只要它不是数据行，就一定会有一条搬运路径把它落下。这类 bug 只在"先排序、再换视图"的组合下出现，
> 单看详情页怎么点都是对的 —— 所以断言必须放在"真的按过排序"之后。

### 62.4 断言

- 本地 `T79`：造一楼 6 条回复 + 一楼 1 条回复 → 按钮行紧跟在"这一楼最后一条回复"之后、
  下一楼之前；楼主那一格里不许再有 `.fz-toggle`；这条行不是数据行；只有 1 条回复的楼不挂它
- 本地 `T79b`：插一条按钮行 → `setSort('time',-1)` → 它还跟着原来那一行，且没被挤到第一行
  （退回"只搬数据行"会红：`还跟着=false · 没被挤到第一行=false`）
- 本地 `T71` 改成用**独立一行**的假按钮测"已展示"口径：`rows` 不变、只有 `folded +22`
- 真机 `R39`：每条按钮行的前一个兄弟只能是"回复"或"楼主"、后一个兄弟只能是数据行/按钮行/表尾；
  `.fz-nrow` 里的 `.fz-toggle` 必须是 0 个

---

## 63. 只有标题能进详情页，Esc 全部撤掉（v0.96）

用户两句话：「原先点击整行或整张卡片任意区域即可跳转详情页，现改为仅点击标题文字才进入详情页；
没有标题的条目统一显示为「无标题」」，「去掉页面中所有通过 ESC 键返回或关闭的功能」。

### 63.1 标题变成唯一入口

`cellsHtml()` 里列表行的标题从 `<span class="fz-et">` 换成：

```
<a class="fz-link fz-et fz-title" data-fz-open="1" title="…">标题文字</a>
```

- 没标题就写「无标题」，并挂 `data-fz-untitled="1"`（样式走虚线，表示这是占位但能点）。
- 有点击的只有这一段。`buildRow()` 里原来的整卡 click 监听删掉，换成
  `bindRowOpen()` 只绑 `.fz-title`。
- **第二条建行路径也要管**：`appendBoardRow()`（追加行）以前也绑了整行点击，走的还是
  `openNoteById`。现在两个入口共用 `bindRowOpen()`；它里面先试 `openNote()`（卡片行有 href，
  token 从站点链路上找），失败再退 `openNoteById()`（追加行手里只有 token）。
- `rebuildCells()`（改设置后重画单元格）会整块换掉 `.fz-cells`，所以它也要补一次 `bindRowOpen()`，
  否则改完"图片变链接"开关，标题就点不动了。
- 样式：`.fz-c .fz-title` 用链接蓝 + 下划线，`padding:1px 4px; margin:-1px -4px` 让点击区比文字
  宽一点但不撑高行；悬停给浅蓝底。

### 63.2 Esc 全部撤掉

删掉的地方：

| 位置 | 原来 |
| --- | --- |
| `keydown` 主处理器 | 关设置 → 让位回表格 → 关右键菜单 → 关筛选 → 关排序 → 关菜单 → 关看图 → 关详情表 → 取消选中 → 连按两下「收起全部」 |
| 看图浮层 | 关浮层 |
| 顶部搜索框 | 清空 + blur |
| 快捷键卡片 / 菜单提示 / 筛选面板页脚 / 返回表格的绿药丸 | 都写着 Esc |

现在这些事分别归：浮层点外面或右上角 ✕、回表格点屏幕正中的绿按钮、取消选中点状态栏新加的
「✕ 取消选择」（`data-fz-clearsel`，和「清掉筛选 / 取消排序」同一套 chip）。

**详情表必须补一个出口**：`.fz-ns-x` 的样式和点击处理一直都在，但按钮早就按用户要求删了，
那会儿 Esc 是唯一退路。这轮把「✕ 关闭」放回表头右端，不然详情页进去就出不来。

顺带修了一个真问题：`paintSel()` 只改行的 class，不刷状态栏那串「平均值/计数/求和」，
取消选中之后数字会留在那儿。现在 `paintSel()` 末尾一起刷 `paintSelChip()` 和 `paintSelStats()`。

### 63.3 文案和注释

- 注释里 66 处 `**加粗**` 去掉，103 处 `——` 换成「，」（连带收拾了替换出来的多余空格）。
  中文里用不上那么长的破折，读起来像在演讲。
- 界面文案按"人话"重写了几句：首次接管提示、双脚本告警、诊断日志、视频浮层提示。

### 63.4 断言

- 本地 `T80`：点作者格、点整行都不开；点标题开一次（DEMO 与 `window.open` 两边都接着）
- 本地 `T80b`：空标题渲染成「无标题」，带 `data-fz-untitled` 和 `data-fz-open`
- 本地 `T80c`：标题的 computed style 是链接蓝 + pointer + 有下划线
- 本地 `Q5` 改成点标题验队列；`C6` 改成点状态栏「✕ 取消选择」
- 本地 `F12 / S15 / T66 / SG5 / CT6` 反过来了：按 Esc 之后面板**还开着**，点别处才关
- 本地 `T22` 改成点「✕ 关闭」关详情表
- 真机 `R7b`：点作者格/整行 0 次 `window.open`，点标题 1 次且链接带 token
- 真机 `R6n`：右键菜单按 Esc 不关、点别处关

---

## 64. 右侧滚动条 + 列表「换一批」（v0.97）

用户：「在页面右侧添加可见滚动条，确保内容溢出时能正常滚动」，「把列表底部的「加载更多」换成
「换一批」，实现方式是刷新页面，保证稳定可靠；详情页的加载更多不变」。

### 64.1 为什么一直没有滚动条

不是我们藏的，是站点关的：`getComputedStyle(document.documentElement).overflowY === 'hidden'`，
body 也是 hidden。后果不明显但很要命：

- `window.scrollTo()` / `scrollIntoView()` 照样生效（overflow:hidden 的盒子仍是滚动容器），
  所以脚本自己的"滚到第 N 行"一直是对的，测试也一直是绿的；
- 用户滚轮滚不动、右侧也没有条，一屏之后的内容等于看不见。真机量到的页面高度 2652，视口 900。

改法（都挂在 `html.fz` 上，让位给原生界面时也一致）：

```
html.fz{overflow-y:scroll !important;overflow-x:hidden !important;}   /* scroll 而不是 auto：条一直在 */
html.fz body{overflow:visible !important;}
html.fz{scrollbar-width:thin;scrollbar-color:#c8ccce #f3f4f4;}        /* Firefox */
html.fz::-webkit-scrollbar{width:14px;height:14px;background:#f3f4f4;}
html.fz::-webkit-scrollbar-thumb{background:#c8ccce;border:3px solid #f3f4f4;border-radius:7px;}
```

详情表本来就是自己的滚动容器（`.fz-notesheet{position:fixed;overflow:auto}`），补同一套
`::-webkit-scrollbar` 让两条条长得一样。

**布局没被挤坏**，因为工具条/表头/表尾都是 `position:fixed;left:0;right:0`：经典滚动条会把
布局视口压窄，它们的右边缘自动停在条左边。真机实测表头 / 表身 / 状态栏右边都是 1430
（= 1440 - 10），三者仍然对齐；列宽里那两条弹性列（`minmax(...,1fr)`）自己吸收了这 10px。

### 64.2 「换一批」= 刷新

```
el.innerHTML = '<a class="fz-link" id="fz-more-btn">换一批</a><span …id="fz-more-state"></span>';
click → reloadBatch() → setMoreState('正在换一批…') → 220ms 后 location.reload()
```

那 220ms 是给提示留一帧：不然点下去页面直接白掉，用户不知道是自己点错了还是脚本坏了。

以前那套 `loadMore/pullMore`（分段滚动逼站点翻页）**没有删**：它同时被巡检的"滚动能不能带出新行"
那条断言踩着，删掉得连那条一起改，收益不大。但现在没有入口调用它，注释里写明了。

详情页的「加载更多评论」走的是另一条线（`doLoadCmts` / `pullMoreComments`），这次一个字没动。

### 64.3 顺带看清的一件事：表尾后面还有一片补白行

`.fz-nfill` 里那批空行是用来把页面撑过一屏的（站点要靠"页面比视口高"来触发它自己的加载）。
以前页面滚不动，谁也看不到；现在能滚到底了，就会看到"最后一条笔记 → 一片空行"。

留着它们是对的（Excel 表末本来就长这样），但它们**行号是铺的那一刻算死的**：先按当时的数据行数
从 N+1 编到头，数据一多就对不上，滚到表尾会看到行号从 1 重新开始。所以 `fillBoard()` 末尾补了一段
"每次按当前数据行数重排"，真机上现在接得上了（数据 32 行 → 补白从 33 开始）。

### 64.4 断言

- 本地 `T81`：`html` 的 overflow-y 是 scroll、滚动条宽度 ≥8px、body 不再是 hidden
- 本地 `T81b`：详情表 overflow 是 auto，内容超出时条宽 ≥8px
- 本地 `T82`：表尾按钮文字是「换一批」，点一下触发一次"重新加载"（`setReloadHook` 计数）
- 本地 `test-scroll` 的 `S13` 改写：不再是"加载更多"，同时钉住"点一下就 reload 一次"
- 真机 `R40`：滚动条存在 + 能滚到 1703px + 表头/表身/状态栏右边缘三者相等
- 真机 `R41`：按钮文案、只触发一次 reload、页面上不再出现「加载更多」

---

## 65. 用户名可点 + 两个新开关（v0.98）

用户：「设置里加隐藏用户头像、隐藏表情的开关并实现」，「瀑布页和详情页的用户名可点击，
新标签页打开该用户主页」。

### 65.1 用户名变成入口

结构没换壳，只在里面多套了一层：

```
<b title="作者名"><a class="fz-uname" data-fz-user="<uid>">作者名</a></b>
```

外面那层 `<b>` 不能动，三处都靠它：`.fz-a b` 的粗体和省略号、`textWidth()` 里
`.fz-aname b` 的"徽标 + 名字"量宽、还有 TT1 那条"title 等于格子里的字"（所以 title 写名字本身，
不加"点开主页"这种后缀）。里面套 `<a>` 之后 `b` 不再是叶子节点，WD9 里那个"被截住没有"的探测
（只认没有子元素的 b/span）当场瞎了，得让它认"只包着一个 a"的 b。

uid 三个来源：列表卡片 `readCard()`、详情/评论的 `stateComments()`，以及 **DOM 兜底那条路**——
以前写死 `uid: ''`，现在从评论里的头像链（`a[href*="/user/"]`）里抠。抠不到的就不挂链接，
点上去什么都不发生（比开出一个 404 的用户页强）。

点击走全局捕获处理器里的一个分支（和行号选中、表头筛选同级），最终落到：

```
openUser(uid) → openInNewTab('https://www.xiaohongshu.com/user/profile/' + uid)
```

样式上刻意不跟标题抢：深色字 + 虚线底，悬停才变蓝。

### 65.2 隐藏用户头像

表格里本来就不画头像（T19 一直是 0 张 `img`），所以这个开关真正管的是**让位回原生界面**那几秒——
那时候满屏都是头像。实现是"默认藏、开例外"：

```
html.fz:not(.fz-showavatar) .fz-cells img,
html.fz:not(.fz-showavatar) img[src*="avatar"], …{display/visibility:hidden}
```

`CFG.hideAvatar` 默认 true；关掉开关时给 `<html>` 加 `fz-showavatar`，规则整条失效。
启动时（读存储那一段）和保存设置时各同步一次。

### 65.3 隐藏表情符号

`stripEmoji()` + `escT()`（先按设置去表情再转义），作用在标题、正文、作者、楼中楼引用、
评论区，以及「展开全文」的 `data-full`。`EMOJI_RE` 覆盖单码位 emoji、符号区、变体选择符 ️、
零宽连接符（👨‍👩‍👧 靠它拼）、肤色修饰。

**默认关**，和面板里其它开关不一样：它会改内容（导出、复制都跟着少字），用户要干净的表再自己勾。
读存储那一段原来写死 `store.get(k, true)`，默认关的开关会被"没存过"顶成开，所以改成取 CFG 里的值。

### 65.4 三个坑

1. **`__fzProbe.cfg()` 返回的是副本**（一份新对象），在测试里改它等于没改——T84 第一版就是这么
   假绿的。补了个 `setCfgVal(k, v)`：写 CFG、写存储，需要重画的当场重画。
2. **菜单里「8 个开关」是写死的**，面板早就 10 个了也没人发现。改成从 `SET_DEFS` 数出来。
3. **WD9 的截断探测**上一节说过了：`b` 里多了 `a` 之后，`!children.length` 这个条件把它整条跳过。

### 65.5 断言

- 本地 `T83`：点用户名只开一次，地址正好是 `/user/profile/<uid>`；`T83b`：没 uid 的没有链接
- 本地 `T84`：「隐藏表情」开后标题/作者里的 emoji 消失、别的字不变；`T84b`：开关真的写进设置
- 本地 `T85`：头像默认被 CSS 藏住，去掉 `fz-showavatar` 才显示
- 本地 `T74`：面板从 10 个开关变 12 个，并单独钉住"隐藏表情默认关"
- 真机 `R42`：点真机上的用户名，开的是 `/user/profile/<uid>`，`cursor: pointer`

---

## 66. 左上角伪装工具条：统一尺寸 + 1366 适配（v0.99）

用户：「参考（不要照抄）腾讯表格的左上角工具栏，把左上伪装按钮改一下，按钮、文字大小调成一样大，
并且考虑 1366 分辨率屏幕的兼容性」。

### 66.1 原来「大小不一样」是个真 bug，不只是审美

一排控件里同时存在三种高度：名称框 18px、页签 26px（还带右边框，像真的页签）、分类 20px、
按钮 18px；字号也是 11px 混着 10px/12.5px。真正的原因藏在类名上：

```
.fz-b{font-weight:700}          ← 我们给"加粗"按钮起的类名
.fz-b, .fz-c, .fz-d, .fz-hash { font-size: calc(12.5px * var(--fz-z,1)) }   ← 表格"B 列"那格
```

同一个 `.fz-b` 撞了车：加粗按钮的字号跟着**表格缩放**走。缩到 80% 时它是 10px，旁边的 I/U 还是
11px —— 用户看到的"大小不一样"，一半是这个。

### 66.2 做法

- 三个变量定死控件尺寸，挂在 `.fz-t2` 上，全场继承：

  ```
  --fz-ctl-h:20px     /* 高度：名称框、页签、分类、按钮全一样 */
  --fz-ctl-fs:12px    /* 字号：一个都不许例外 */
  --fz-ctl-pad:7px
  ```

- 所有控件改成 `inline-flex; align-items:center; height:var(--fz-ctl-h)`：不用 `line-height`
  对齐（中文字体上下留白不一样，`line-height` 对齐过几次都歪）。
- 按钮统一 `min-width:var(--fz-ctl-h)`（正方形下限）+ `padding:0 6px` + `border-radius:2px`，
  宽度随文字长短——工具栏本来就该这样。
- 分组用 `.fz-deco-g`（常驻）和 `.fz-deco-x`（窄屏先丢）包起来，中间还是那条 1px 竖线。
- 类名 `fz-b/fz-i/fz-u` → `fz-tbb/fz-tbi/fz-tbu`，避开单元格列名。

### 66.3 1366 兼容

先量清楚再定断点。改之前在 1366 下：伪装区 1136 + 工具组 180 + 内边距 16 = 1332，**已经顶到边**，
而且分类是站点动态给的（实测能到 494px / 24 个），再多一个就被裁。

- 分类在 JS 里**最多画 8 个**（`links.slice(0, 8)`），CSS 再按宽度往下砍；
- 断点（只丢东西，不缩字号）：

  | 宽度 | 动作 |
  | --- | --- |
  | ≤1440 | 分类最多 6 个 |
  | ≤1366 | 分类最多 5 个 |
  | ≤1240 | 整组 `.fz-deco-x` 收掉（≡ ⊞ ⌗ ▦ % , ⌕ ❄） |
  | ≤1080 | 分类整块收掉 |

改完实测（工具组一直在右边、不被挤）：

| 视口 | 伪装区宽 | 需要 | 裁掉 | 可见控件 | 高度 | 字号 |
| --- | --- | --- | --- | --- | --- | --- |
| 1920 | 1031 | 1031 | 0 | 26 | 20 | 12px |
| 1440 | 951 | 951 | 0 | 24 | 20 | 12px |
| 1366 | 911 | 911 | 0 | 23 | 20 | 12px |
| 1280 | 911 | 911 | 0 | 23 | 20 | 12px |
| 1024 | 476 | 476 | 0 | 10 | 20 | 12px |

1366 下还空着约 230px，不会再顶着边。

### 66.4 断言

- 本地 `T86`：伪装区可见控件的**高度只有一种、字号只有一种**，且 `scrollWidth ≤ clientWidth`
- 本地 `T86b`：工具组完整可见、右缘不出视口、排在伪装区右边
- 真机 `R43`：临时把视口切到 1366×768 量一遍（≥15 个控件、高度/字号各一种、没裁、工具组完整），
  量完切回 1440

---

## 67. 重写 README、重拍截图，顺手修掉「看图是白框」（v0.99 收尾）

### 67.1 「看图」其实一直是白框

重拍截图时才看见：浮层弹出来了、标题和 ✕ 都在、图片那块是白的。

查下来是站点干的。**它给页面上任何 `<img>` 都盖一记内联的 `visibility:hidden`**
（自己的懒加载保护，等图加载完再放开）。我们在浮层里新建的 `<img>` 也不例外：

```
IMG | vis=hidden   ← inline style="visibility: hidden;"
fz-v-bd | vis=visible
fz-viewer | vis=visible
```

用一张"裸 img"验证过：不经过我们任何代码，插到 body 里 2 秒后也被打上了同样的内联样式。

修法是一行 CSS：

```
.fz-v-bd img{… visibility:visible !important;}
```

内联样式不带 `!important`，所以这条能赢。修完 `getComputedStyle(img).visibility === 'visible'`。

断言：本地 `T12b`（自己造一张带 inline hidden 的图放进浮层，实测可见）、
真机 `R44`（真点开看图，visibility=visible + naturalWidth>0 + 浮层尺寸正常）。

### 67.2 README 重写

原来 315 行、45 条功能清单、几乎每句都有加粗和破折号，读起来像产品发布会。重写后的取向：

- 按「装 → 首页 → 详情 → 筛选 → 选中 → 看图 → 设置 → 加载 → 快捷键 → 限制 → 排错」排，
  一个问题一段，不再按功能堆 bullet；
- 加粗只留 3 处，破折号清零，标题不带 emoji；
- 该说的细节（行号不变、展开按钮钉在本楼底部、Ctrl+F 不进浏览器查找条）留着，
  但不再每条都写成三百字；
- 做不到的事单独一节，直说。

现在 219 行。

### 67.3 截图全部重拍

统一 **1366×768**（办公本最常见的一档），八张：

| 文件 | 内容 |
| --- | --- |
| `list.png` | 首页，工具栏 + 19 行 |
| `detail.png` | 详情页，楼层绿边 + 「展开 N 条回复」 |
| `filter.png` | 筛成「视频」之后打开面板，右侧只剩视频、状态栏「筛选 9/33 行」 |
| `select.png` | 选中三行，名称框 `1:3`、状态栏统计 |
| `viewer.png` | 看图浮层（修好之后才拍得出内容） |
| `settings.png` | 设置面板 12 个开关 |
| `menu.png` | 工具菜单 + 快捷键卡片 |
| `loading.png` | 拉评论时的加载卡片 |

旧图（`login.png` / `like-guide.png` / `filter-empty.png` / `bottom-0.22.png` /
`menu-shortcuts.png`）都删了，README 里也不再引用。

拍摄脚本的两点讲究，下次重拍还用得上：

1. **自己开一个标签页**（`PUT /json/new`），跑完关掉。窗口里可能开着好几个标签页，
   挑"第一个小红书标签页"很容易挑到没注入脚本的那个，拍出来是原生页面或者空白。
2. **每个状态单独摆好再拍**：筛选那张先 `setFilter` 再开面板，看图那张等
   `img.complete && naturalWidth>0`，加载卡片轮询 `.fz-busy` 出现再按快门。

### 67.4 列表标题改回细体

标题原来是 `font-weight:600`，当初是为了和同一格里蓝色的「封面图 / 图2」分开。用户不要加粗，
改回 400：靠"排在最前面"和悬停底色区分就够了，整张表看起来也更像真表格。
`T80c` 顺手把字重也钉住了（`font-weight` 必须是 400），和「封面图」那一档一致。
含列表行的五张截图（list / filter / select / viewer / menu）跟着重拍。

---

## 68. v1.10：四组共 20 条改动

用户一次提了 20 条，按"详情页 / 瀑布页 / 设置 / 通用"四组做完。

### 68.1 详情页

| 需求 | 做法 |
| --- | --- |
| 缺「返回列表」 | `.fz-ns-bar` 最左加「← 返回列表」。有队列或 referrer 是列表就 `history.back()`（筛选/排序都还在），否则回 `/explore` |
| IP 失灵 | **根因**：`cellsHtml` 一直渲染 `data.ip`，但只有 `mk()`（state/接口那条）填了它，**DOM 兜底那条压根没这个字段**。现在从评论节点的 `.location` 读，长度 >8 就不认（防止把正文当属地） |
| 两个滚动条 | 详情表打开时给 `<html>` 挂 `fz-hassheet`（`overflow:hidden`），页面本身不滚，只留 `.fz-notesheet` 那条 |
| 加载不动要提示未登录 | 三层：① `pullMoreComments` 回调里，没登录直接写「没登录：站点不给更多评论了」；② 9 秒兜底定时器，不管卡在哪都把按钮救回来；③ 诊断行照旧写「容器/哨兵/hasMore/请求+N」 |

**9 秒兜底是这轮的关键**：未登录时站点对翻页请求**根本不回应**，回调永远不来，
按钮就永远停在「加载中…」，用户只会以为脚本死了。实测 10 秒时会变成
「没登录：站点不给更多评论了（点右上角「登录」）」。

### 68.2 瀑布页

- **banner 文字偶尔冒出来**：以前是逐个 `hideEl`，站点一重渲染新节点就来不及藏。
  改成一条兜底 CSS：`html.fz.fz-table:not(.fz-yield) body > *:not([class*="fz-"]){visibility:hidden}`。
  判据是"类名里带 fz-"，我们自己的壳和弹层全带，站点的不带。
  **别写成一个个 `:not(.fz-xxx)` 白名单**——漏一个弹层就变成"看不见也点不动"
  （隐藏元素没法 focus，筛选面板当场键盘失灵，K4/K5 就是这么红的）。
- **封面图消失**：视频笔记的封面是 `<video poster>`，不是 `<img>`，`imgList()` 自然抓不到。
  现在按 poster 兜底，再不行取卡片里任意一张非头像图。详情主贴同样处理。
- **标题 / 封面图不标蓝**：新开关 `linkPlain`，只加一个 `html.fz-plainlink` 类，
  CSS 把颜色和底线退回普通文字（照样能点）。
- **"往下滚还是会刷新"**：真机没复现出来（监听 `beforeunload` 0 次、行节点 3 秒内 0 次重建）。
  banner 那条兜底顺带把"站点重渲染导致闪一下"也压住了，等用户再试。

### 68.3 设置

- **头像真的画出来**：`readCard` / `readNotePage` / `mk` / `readCommentsDom` 四处都补了 `avatar`，
  关掉开关就在作者列前面画 `<img class="fz-av">`（14px 圆角小图）。
  **又一个 `visibility` 坑**：站点给页面上每张 img 都盖 inline `visibility:hidden`，
  头像有尺寸但看不见——和 §67 的看图白框同一个原因，同样用 `!important` 顶回来。
- **删掉两个开关**：键盘描边（连那条绿色 `:focus` 规则一起删，焦点交回浏览器默认）、
  选中时的求和/平均（`selStats()` 直接 return null，函数留着方便以后恢复）。
- **两个新快捷键**：`Alt+Shift+E` 表情、`Alt+Shift+A` 头像，都写进 `SHORTCUTS` 卡片。
- **楼主**：`cmtRowsHtml` 比对 `noteSheetData.author / uid`（昵称改过也能认），
  行上加 `fz-oprow`（淡黄底），作者名后挂「楼主」棕标；主贴行恒为楼主。
- **楼层底色开关**：`html.fz-notint` 时 `.fz-haskid` 背景透明，左边那条绿线留着（那是标记不是底色）。
- **楼层徽标开关**：`showFloor` 关掉后 `cellsHtml` 干脆不生成 `.fz-fl`。

### 68.4 通用

- 右上角登录位显示用户名：`myNickname()` 先读 `__INITIAL_STATE__.user`，再退到页面上的
  `#userMe .name`；拿不到就空着（宁可只显示「登出」，不编名字）。
- 用户页开关 `userTable`：关（默认）＝新标签开原生页；开＝当前页跳过去让表格接管。
- 右上角「筛选」按钮和「工具」标签删了，筛选只走表头 ▾。
- 菜单瘦身成三项（换文件名 / 导出 CSV / 设置…），表格模式和详情页接管只留在设置面板。

### 68.5 断言

本地 `T88`（头像开关）、`T89`（楼主）、`T90`（楼层徽标）、`T91`（纯文字链接类）、
`T58/T59`（菜单三项）、`T74`（15 个开关）、`K2`（去掉描边后焦点仍在列头）、
`CU4`（桩子要带 fz- 类才"看得见"）；真机 `R45`（返回列表 + 单滚动条）、`R46`（属地有货）。

全量 **442 pass / 0 fail**（本地 349 + 真机 75 + 巡检 18）。

---

---

## 69. v1.2：又一轮 10 条（右键、快捷键、顶栏、属地）

### 69.1 「不着色」要一起管楼主

用户原话：「有回复的楼层不使用浅绿色底色和楼主的黄色标记都要一起实现」。
所以 `html.fz-notint` 现在撤三样：`.fz-haskid` 的浅绿底、`.fz-oprow` 的淡黄底、
`.fz-op` 徽标的黄底棕字（降级成灰字灰框）。左边那条绿线留着，那是"这楼有回复"的标记，不是底色。

### 69.2 顶栏：昵称 + 自己的头像

`renderAuth()` 以前只写「登出」两个字，中间那个 `.fz-user` 是个空 span。现在：
`myNickname()` 读 `__INITIAL_STATE__.user.userInfo.nickname`，退到 `#userMe .name`；
`myAvatar()` 读同一个 `userInfo.image`。**头像受「隐藏用户头像」开关控制**，勾着就不画那一块。

又踩到站点的 `visibility:hidden`（第三次：看图浮层、表格头像、这次顶栏头像），照样 `!important` 顶回来。

### 69.3 删掉的按钮和快捷键

- 工具栏右上角只剩 `⚙ 设置`：`⇅` 排序、`⇩` 导出、「工具」标签、「筛选」按钮全撤。
  排序改走列头（行为测试 S16/S17/S21 还在），导出走设置菜单。
- 右键不再接管：删掉 `contextmenu` 监听，自绘菜单成了死代码，浏览器原生菜单回来。
- 快捷键撤了四条：`Ctrl+Shift+E`、`Ctrl+F`、`Alt+Shift+E`、`Alt+Shift+A`（功能都在，只是不抢键）。
  `SHORTCUTS` 卡片从 12 条减到 5 条，菜单底部那句「点面板外面…」也删了。

### 69.4 三个细节

- **不标蓝拆成两个开关**：`linkPlainTitle` / `linkPlainImg`，CSS 分别管 `.fz-title` 和
  `.fz-link[data-i]` + `.fz-vplay`（视频那个按钮）。T91 先单开一个再单开另一个，确认互不影响。
- **主贴属地**：`readNotePage()` 从 state 的 `ipLocation` 取。**不能用 `readStateNote()`**，
  那个要求「有图才返回」，视频笔记会整个返回 null，属地也就没了。
  另外列表点进来时 `sessionStorage` 里那份缓存**没有 ip 字段**，所以合并 `dom` 的地方补了一句
  `if (!data.ip && dom.ip) data.ip = dom.ip`。实测六篇：站点公布了的就显示（四川），没公布的就是空。
- **`[偷笑R]` 这类表情代码**：`stripEmoji()` 加 `CODE_RE`，只清「方括号里以 R 结尾」的（小红书表情代码格式），
  `[已编辑]` 这种正文里真出现的方括号不动。

### 69.5 断言变动

- 本地：`T91` 改成「两个开关互不影响」，`T74` 16 个开关，`S12` 改成「工具栏没有排序/导出」，
  `CT1` 从「右键出菜单」改成「右键不接管」，`SA8` 改成「Ctrl+F 不被接管」，`SG1/SG3/T59b` 跟着卡片精简。
- 真机：`R6n`（右键不接管）、`R6u`（Ctrl+F 不接管）、`R28`（卡片五条）、
  `R6g`（探针换成「表格模式 / 翻同一篇」）、`R43`（工具组只剩 60px）。

全量 **432 pass / 0 fail**（本地 339 + 真机 75 + 巡检 18）。


## 70. 详情页正文话题可点：点 `#话题` 去搜这个（v1.24）

### 要解决的问题

详情页主贴和评论的正文里，`#话题` 一直只是普通文字（`escT()` 整段转义）。想顺着一个话题
看看别人的帖子，只能自己复制话题名、再去顶部搜索框粘贴回车，很别扭。

### 做法

`topicHtml(s)`（`escT` 旁边）把纯文本切成「普通文字 + 话题」两段：普通文字照常 `esc()`，
话题那一段生成一个和「封面图」同款的 `.fz-link`：

```
<a class="fz-link fz-topic" data-topic="巨石强森" title="搜「巨石强森」">#巨石强森</a>
```

- **文案保留原名**（`#` 也留着），不把 `#` 吃掉、不改写话题名；
- 只有话题是链接，其余仍是纯文本，字体/颜色/下划线底边全部沿用 `.fz-link`（`#0563c1` + 手型），
  和「封面图」「展开全文」长得一模一样；
- **话题名不能含空白**（空格是话题之间的分隔符），中文标点也要排除 ——
  否则「`#话题，后面的话`」会把逗号后面一起吞进话题名。长度上限 40 防误吞长串。

### 跳转：和搜索框走同一条路

新增 `searchTopic(kw)`，顶部搜索框回车**也改成调它**，两处共用同一个 URL 模板：

```js
location.href = location.origin + '/search_result?keyword=' +
  encodeURIComponent(kw) + '&source=web_explore_feed';
```

这样"点话题"和"搜索框输话题名回车"在代码层面就是同一条路，以后改了一边不会漏掉另一边。
（真机实测跳转结果：`/search_result?keyword=成绩&source=web_explore_feed`，和搜索框一致。）

### 只有详情页做，列表页不做

`cellsHtml()` 里用 `kind === 'main'` 判断：详情页主贴、详情页评论（`isCmt`）都走 `topicHtml`，
**瀑布流列表页的正文保持纯文本**。理由：列表页没有话题的点击入口（那里点击是进详情页），
做成链接会"看着能点、点了没反应"。评论行只出现在详情页，所以直接走 `topicHtml` 安全。

### 「展开全文」要跟着改

原来展开是把 `es.textContent = fl.dataset.full`（纯文本塞回去），一展开话题链接就没了。
改成 `es.innerHTML = topicHtml(fl.dataset.full || '')`，展开后话题照样可点。
`dataset.full` 读出来是浏览器解码后的纯文本，可以直接过 `topicHtml`。

### 点击处理

挂在详情表那条统一的 click 委托里（`.fz-full` 分支后面加 `.fz-topic` 分支），
`e.preventDefault() + e.stopPropagation()` 后调 `searchTopic(tp.dataset.topic)`。

### 断言（本地 T-topic / T-topicb / T-topicc）

- `T-topic`：`#巨石强森 #减重` → 两个 `.fz-topic` 链接、文案保留 `#`、`data-topic` 正确、其余文字还在；
- `T-topicb`：`看这个#硬汉，真的很猛` → 只认「硬汉」，逗号后面留在正文里；
- `T-topicc`：正文里的 `<img onerror=...>` 仍被转义成 `&lt;img`，不会因为加链接就漏 XSS。

真机另测：详情页 `.fz-topic` 全部是 `<a class="fz-link">`、颜色 `rgb(5,99,193)` + `cursor:pointer`；
点一下确实跳到 `/search_result?keyword=<话题名>&source=web_explore_feed`。

### 70.1 审查抓到并修掉的两处（v1.25）

1. **主贴行异步重画后 `tabindex` 丢失**（不是本次引入，但顺手修了）：
   详情主贴行有两处异步重画 —— 晚到数据补画（`cl0.innerHTML = cellsHtml(data,1,'main')`）
   和 `refreshMainMeta()` 里的重画 —— 都只换 `innerHTML`、**没补 `markKeyboard()`**。
   结果：行里所有链接（封面图 / 展开全文 / 赞收藏回复 / 话题）都失去 `tabindex`，键盘 Tab 不到。
   修法：两处重画后各补一次 `markKeyboard(cl)`。真机验证：重画前 14/14 可达 → 只重画变成 0/14 →
   补 `markKeyboard` 后 14/14 恢复。
2. **话题链接缺 `role="link"`**：`<a>` 没有 `href` 时浏览器/读屏不把它当链接。
   `topicHtml()` 生成的 `<a>` 显式带 `role="link"`（`markKeyboard` 会跳过已有 role 的元素，不会被改成 button）。

### 70.2 已知的边界情况（刻意不处理）

`topicHtml()` 的识别规则是「`#` + 非空非标点串（≤40 字）」。下面几种会识别偏差，
但都是低频场景、且后果很轻（多点/少点一个搜索链接，不会崩），**为保住真实话题的识别率而接受**：

| 输入 | 表现 | 说明 |
|---|---|---|
| `我学C#很久了` | `#很久了` 被当成话题 | `#` 前面紧贴拉丁字母；要排除就得要求「# 前必须是空白」，那 `了#破裂的友情` 这种真话题就识别不了了，更糟 |
| `见 http://x.com/a#anchor` | `#anchor` 被当成话题 | 正文裸 URL 在小红书里极少；点了顶多去搜 "anchor" |
| `#NBA(篮球)` | 只认 `NBA`，`(篮球)` 留在正文 | 话题名含英文括号；小红书话题名规范不含括号 |
| `#"怪"话题` | 不识别 | 引号在排除集里，「宁可不识别，也不吞错」 |

如果以后真机上发现某类话题被误伤，优先改「`#` 前后的字符判定」，别直接放宽排除集
（放宽的代价是把正文里的普通 `#` 也变成链接）。


## 附录 A · 功能索引

一张表回答"这个功能在哪儿实现、讲在哪一节"。功能名按用户看到的样子写，
改到某个功能时照着这张表往下翻就行。

### A.1 外壳与接管

| 用户看到的 | 主要实现 | 章节 |
| --- | --- | --- |
| Excel 外壳（标题栏 / 工具栏 / 公式栏 / 列号 / 表头 / 状态栏 / 工作表标签） | `injectCSS()`、`buildChrome()`、`COLW` | §5 |
| 标题变成「工作簿1」、favicon 换成绿的 | `applyTitle()`、`applyFavicon()`、`setCfg('docTitle')` | §16 |
| 首页瀑布流 → 一帖一行的表格 | `ensureBoard()`、`collectCards()`、`appendBoardRow()`、`buildRow()`、`orderRows()`、`fillBoard()` | §6 |
| 站点内容被藏掉（上方残留、登录框、推荐位） | `hideSiteHeader()`、`hideBeforeBoard()`、`hideBars()`、`hideEl()` | §6.4 |
| 藏起来的视频不出声 | `hushVideos()` / `unhushVideos()` | §26 |
| 进页面不闪原生页（幕布） | `curtainCheck()`、`dropCurtain()`、`html.fz-boot` | §40 |
| 数据从哪来（接口 > state > DOM） | `hookApi()`、`readInitialState()`、`readStateNote()`、`readNotePage()`、`absorbNote()` | §4 |
| 全局设置（表格模式 / 详情接管 / 文件名） | `CFG`、`setCfg()`、`store` | §16 |
| 临时关掉脚本 | `escapeAll()`、`html.fz-off`、`Alt+Shift+T` | §10 |

### A.2 详情页（笔记 + 评论）

| 用户看到的 | 主要实现 | 章节 |
| --- | --- | --- |
| 点行进笔记 / 新标签页打开 | `openNoteById()`、`openInNewTab()`、`noteHref()` | §7 |
| 主贴第 1 行、评论往下排（楼中楼缩进 + `↳ 回复 @某人`） | `maybeNoteSheet()`、`openNoteSheet()`、`cmtRowsHtml()`、`stateComments()` | §7、§8 |
| 评论默认只露第一条 + 「展开 N 条回复」 | `applyFold()`、`expanded`、`data-mode`（open/more/close） | §8.2 |
| 「展开 / 再加载」落在**本楼最底部**（单独一行 `.fz-trow`） | `floorToggleHtml()`、`cmtRowsHtml()` 的 `pend`/`closeFloor()` | §62 |
| 「展开 N 条回复 / 再加载几条」真去点站点 | `expandOnSite()`、`expandAllOnSite()`（派发 hover + 全套鼠标事件） | §8.2 |
| 楼中楼补全（state 只给第一条） | `pooledSubs()` + `cmtPool` / `cmtPoolNote` | §8.1 |
| 「加载评论 / 加载更多评论」（**唯一入口**） | `doLoadCmts()`、`pullMoreComments()`、`bindCmore()` | §7.1、§49 |
| 拉评论时滚谁（只滚详情自己的容器） | `cmtScrollers()`、`cmtScope()`、`cmtInScope()`、`cmtPageLevel()` | §47 |
| 拉评论时把首页按死 | `cmtFreezeFeed()` / `cmtThawFeed()` | §7.1 |
| 评论按钮下面的诊断串 | `cmtDiag`、`cmtState()`、`cmtReqN`、`cmtLastReqD` | §47 |
| 未登录被锁时的说法 | `cmtLoginWall()`（只看画得出来的那一条） | §7.1 |
| 主贴视频播放 | `playMainVideo()` | §26 |

### A.3 加载（列表 + 评论）

| 用户看到的 | 主要实现 | 章节 |
| --- | --- | --- |
| 表格末尾的「加载更多」 | `ensureMoreRow()`、`setMoreState()`、`paintMoreState()` | §6.4 |
| 点了之后「借站点的手」翻一页 | `loadMore()`、`pullMore()`、`nudgeSource()`、`fz-src-flow` | §6.4 |
| 让位时屏幕不变（保留工具条 + 遮罩铺满 + 克隆表格） | `yieldToSite(keepChrome)`、`makeCover()`、`.fz-keepchrome` 那组 CSS | §48 |
| 「正在加载」卡片（转圈 + 主/副文案 + 进度条 + 25s 保险丝） | `busyShow()`、`busySet()`、`busyHide()`、`.fz-busy` | §48 |
| **加载只认按钮**（滚到底 / 进页面 / 失败重试都不自动拉） | 删掉的 `bindScrollLoad()` / `autoMore()` / `toasyCmtKick()` + 详情滚动监听 | §49 |

### A.4 表格操作（Excel 那一套）

| 用户看到的 | 主要实现 | 章节 |
| --- | --- | --- |
| 表头筛选（赞 / 类型 / 作者 / 时间，选项从数据里长出来；被浮层挡住也点得动） | `FILT`、`applyFilter()`、筛选面板、`filterSummary()`、`headerHitAt()`、`bindHeaderFallback()` | §17、§27、§29、§30、§52 |
| 面板顶上的升/降序、`⇅` 排序面板、点列头排序 | `SORT`、`applySort()`、`sortLabel()` | §20 |
| 顶部搜索框（空格分词、说清搜的是什么） | `bindSearch()`、`applyFilter()`、`clearSearch()` | §24 |
| 选中整行 / Shift 连选 / ↑↓ 走 / `Ctrl+C` 复制成表 | `setSel()`、`SEL`、`moveSel()`、复制成 TSV | §22、§43 |
| `Ctrl+A` / `Ctrl+Shift+Home,End` 选区键 | 同上 + `navTo()` | §39 |
| 状态栏统计（平均值 / 计数 / 求和） | `selStats()`、`paintSelStats()`、`statNum()` | §41 |
| 状态栏「为什么只剩这几行」+ 一键退回 | `paintFilter()`、`filterSummary()`、`fz-clear` | §32 |
| 列宽拖动 / 双击按内容调宽 / 不许拖出屏幕 | `colDrag`、`fitCol()`、`W_LIST`/`W_DETAIL`、CSS 变量 | §44、§45、§46 |
| 右下角缩放（60%–160%，Ctrl+滚轮） | `setZoom()`、`ZOOM` | §33 |
| 右键菜单（复制 / 只复制这格 / 按这一列筛 / 导出 / 开笔记） | `showCtx()` | §38 |
| 截住的格子悬停看全文（同 tooltip 规则也用于双击调宽） | `cellTips()` | §35 |
| Excel 跳转键（Ctrl+Home / End、PageUp/Down） | `bindKeys()` | §36 |
| Tab 走遍所有能点的地方、装饰按钮不抢 Tab | `markKeyboard()`、`aria-hidden` 装饰件 | §19、§34 |
| 空表时说清为什么 + 一键去登录 / 再试一次 | `needNoData()`、`emptyReason()`、`nodataHtml()`、`retryFetch()` | §21 |
| 首次进来那句提示（只说一次） | `firstRunHint()`、`needHelp()` | §23 |

### A.5 内容与出口

| 用户看到的 | 主要实现 | 章节 |
| --- | --- | --- |
| 「封面图」+「图2/图3…」（笔记的图）／「图1/图2…」（评论配图）文字链接 + 点开看原图 | `imgLinkLabel()`、`imgLinks()`、`openImage()`、`galleryOf()`、`data-cov` | §18、§51 |
| 标题栏「评论 80/265」那个已展示数 / 表尾「已展示 80 条（评论 10 + 回复 7 + 未展开 63）」 | `cmtCounts()`、`cmtCountsOf()`、`cmtFolded()`、`cmtLoadedText()`、`updateNsStat()` | §53.4、§56 |
| 标题栏「评论 80/265」那个已展示数 / 表尾「已展示 80 条（评论 10 + 回复 7 + 未展开 63）」 | `cmtCounts()`、`cmtCountsOf()`、`cmtFolded()`、`cmtLoadedText()`、`updateNsStat()` | §53.4、§56 |
| 看图能 `←` `→` 翻同篇的图 | `viewerGo()`、`.fz-v-nav` | §18 |
| 长正文截 300 字 + 「展开全文」；导出给全文 | `longBody()`、`cellsHtml()`、`buildCsv()` | §25 |
| 详情页正文里的 `#话题` 可点，点了去搜这个话题（和顶部搜索框回车同一条路） | `topicHtml()`、`searchTopic()`、`.fz-topic` | §70 |
| 导出 CSV（BOM、只导看得见的行、详情去掉「操作」列） | `exportCsv()`、`buildCsv()`、`csvOf()` | §15 |
| 时间列（首页从笔记 id 的 ObjectId 前 8 位还原） | `noteIdTime()`、`noteIdMs()`、`shortTime()` | §6.5 |
| 顺着表往下读（‹ 上一篇 / 下一篇 ›，Alt+↑↓） | `saveQueue()`、`queueNav()`、`queueHref()` | §28 |

### A.6 借用原生界面

| 用户看到的 | 主要实现 | 章节 |
| --- | --- | --- |
| 登录 / 登出（调原生框、真退出） | `doLogin()`、`doLogout()`、`apiLogout()`、`isLoggedIn()` | §9 |
| 赞 / 收藏：点不动就红框圈出来让你点 | `siteAction()`、`press()`、`tryPress()`、`highlightEl()` | §9.5 |
| 回复：让位 + 聚焦原生输入框 | `siteAction('reply')` | §9.5 |
| 让位期间的「返回表格模式」按钮（屏幕正中；Esc / Ctrl+Shift+X 也行） | `showBackBtn()`、`hideBackBtn()`、`backToTable()`、`typingInBox()`、`.fz-back` | §50、§55 |
| 脚本点不动时的红框 / 压暗（聚光灯：框里亮、框外黑） | `highlightEl()`、`frameEl()`、`dimSite()`、`actOn()`、`tryPress()` | §54.3、§50 |
| 设置面板（8 个开关 + 高级设置 + 保存/恢复默认/导出） | `openSettings()`、`saveSettings()`、`SET_DEFS`、`setRow()`、`.fz-set` | §57 |
| 脚本点不动时的红框 / 压暗（聚光灯：框里亮、框外黑） | `highlightEl()`、`frameEl()`、`dimSite()`、`actOn()`、`tryPress()` | §54.3、§50 |

### A.7 排障（出问题时先看这里）

| 手段 | 入口 |
| --- | --- |
| 为什么没接管 | `document.documentElement.dataset.fzWhy`（`ok` / `warmup` / `no-data` / `throw:…`） |
| 只读探针（不改页面） | `window.__fzProbe.*`：`readNotePage` / `readComments` / `readStateNote` / `csv` / `cfg` / `setCfg` / `expandOnSite` / `expandAllOnSite` / `pullMore` / `rerenderCmts` / `selStats` … |
| 评论加载为什么没成 | 按钮下面那行灰字（`容器N·哨兵·hasMore·前→后·评论请求+N`） |
| 让位之后回不去了？ | 屏幕正中「返回表格模式」/ `Esc` / `Ctrl+Shift+X`（§50、§55） |
| 自测 | `node check.mjs`（本地 329）、`node check.mjs --real`（真机 68~71，游客数据不足时 SKIP）、`--sweep=6`（巡检 18） |
