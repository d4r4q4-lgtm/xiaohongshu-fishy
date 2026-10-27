# 开发文档

> 面向要改这个脚本的人。作者 **haozi**，版本 `0.12`。  
> 只讲实现与坑，不赘述使用方式（那在 [README](README.md)）。

---

## 1. 设计目标与取舍

| 目标           | 做法                                                | 为什么                       |
| ------------ | ------------------------------------------------- | ------------------------- |
| 看起来像真的 Excel | 自建一套固定定位的「外壳」（标题栏/工具栏/公式栏/列号/状态栏），并把表格放进 `body` 流 | 只做 CSS 变换看不出工具栏、列号这些"硬特征" |
| 原始数据不丢       | 把站点列表容器留在 DOM 里，只是隐藏并移出视觉                         | 站点自己的"加载更多"、虚拟滚动都依赖它      |
| 不改站点代码       | 全程只读 DOM/状态 + 派发事件 + 少量 DOM 挪动                    | 侵入越小，改版后越容易修              |
| 数据尽量拿全       | 三级来源：**拦截接口 > 页面状态 `__INITIAL_STATE__` > 扫描 DOM** | 任意一级失效还有后备                |

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
│  bindScrollLoad/bindKeys  滚动加载、快捷键      │
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

| 文件                               | 作用                                                   |
| -------------------------------- | ---------------------------------------------------- |
| `xiaohongshu-fishy.user.js`      | 全部功能，单文件                                             |
| `serve.mjs`                      | 本地只读更新源（`127.0.0.1:8125`），提供脚本、`/version`、`/hit`（安装页已删） |
| `check.mjs`                      | 一键跑本地两套 + 真机两套                                       |
| `sweep.mjs`                      | 真机巡检：列表 + 批量笔记 + 搜索页                                 |
| `real-check.mjs`                 | 真实站点单篇断言                                             |
| `cdp.mjs` / `cdp-lib.mjs`        | 用 CDP 驱动 headless Edge（注入脚本、求值、截图、真实鼠标）              |
| `test.html` / `test-scroll.html` | 本地单元用例（用假数据模拟真实结构）                                   |

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

### 6.3 隐藏原始列表（关键坑）

原始容器（`.fz-src`）要**留在视口内**，不能扔到 `left:-20000px`：

> 小红书用 **IntersectionObserver 观察列表底部的哨兵**来加载下一页。  
> 元素在视口外 → 永远不相交 → 永远不加载 → 表现就是"滚到 30 行就不动了"。

所以：

```css
html.fz.fz-table .fz-rows.fz-src{
  position:fixed; left:0; top:0; width:100%; height:100%;
  overflow:auto; opacity:0; pointer-events:none; z-index:-1;
}
```

三个连带坑：

1. **特异性**：`.fz-rows{position:static !important}`（0,3,1）会压掉 `.fz-src`（0,1,0），  
   必须写成 `html.fz.fz-table .fz-rows.fz-src`（0,4,1）。
2. **子元素不能强制塌陷**：`html.fz.fz-table .fz-rows > *{position:static;width:100%}` 会让  
   源列表的卡片高度塌陷成 0，容器 `scrollHeight == clientHeight`，滚不动。  
   必须写成 `:not(.fz-src) > *`。
3. **源容器要挪到 `body` 下**（`markSource`），否则它的祖先（`.main-container`）没法整块隐藏。

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
node check.mjs                       # 本地两套（约 5s）
node check.mjs --real --sweep=6      # 加上真机巡检 + 真实站点断言（约 2min）
```

| 套件                 | 条数 | 覆盖                                             |
| ------------------ | -- | ---------------------------------------------- |
| `test.html`        | 52 | 外壳结构、行/列、图片链接、查看器、详情接管、评论层级、state 解析、折叠三态、接口入树 |
| `test-scroll.html` | 18 | 滚动、站点重渲染自愈、搜索、登录/登出                            |
| `sweep.mjs`        | 15 | 真机：列表布局、列号一致性、批量笔记（图文/视频/多图/少评）、搜索页            |
| `real-check.mjs`   | 16 | 真机：单篇端到端                                       |

### 关键断言（都是踩过坑才加的）

```js
boardTop 必须落在 100~120          // 顶部不能有站点残留把表格顶下去
表格上方可见的 body 子元素数 === 0
列号格数 === 表格列数              // 加列忘改列号条会立刻报
主贴图片数 === 站点数据图数        // 防止 DOM 混进推荐位大图
出现「展开 0 条回复」= 直接 FAIL
boardActs（瀑布流的操作列）=== 0    // 操作列只该在详情页
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
> `Network.clearBrowserCookies` 可以重置配额，sweep 就是每 2 篇清一次。

---

## 12. 调试手段

| 手段                             | 用途                                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| `<html data-fz-why>`           | 接管状态：`ok/warmup/busy/closed/no-data/list/throw:...`                                          |
| `<html data-fz-ns>`            | 详情表内部状态（`cls/kids/in/q`）                                                                     |
| `window.__fzProbe`             | 只读函数集合：`readNotePage/readComments/readStateNote/noteParts/pickTime/badText/expandOnSite/...` |
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
