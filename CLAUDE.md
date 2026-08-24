# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Chromium（Chrome / Edge）Manifest V3 扩展：默认阻断所有页面及 iframe 的 WebRTC，可按域名白名单放行。
要求 Chrome / Edge 119+、Node 24+、pnpm。代码注释、文档与提交信息一律用中文。

## 常用命令

```bash
pnpm install
pnpm build                              # 构建到 dist/，末尾会跑产物断言
pnpm dev                                # watch 模式（跳过产物断言）
pnpm test                               # Vitest 全量
pnpm test src/core/whitelist.test.ts    # 跑单个测试文件
pnpm vitest run -t "evilexample"        # 按用例名过滤
pnpm typecheck                          # tsc --noEmit
node scripts/make-icons.mjs             # 仅在需要改图形时重新生成图标（图标已提交进仓库）
```

装载扩展：`chrome://extensions` → 开发者模式 → 「加载已解压的扩展程序」→ 选 `dist/`。

手动验收（清单见 README「手动验收」十步）：`python3 -m http.server 8765 -d test-pages`，
然后访问 <http://localhost:8765/escape.html>。**必须走 `http://localhost`**——
`navigator.mediaDevices` 只存在于安全上下文，用 `file://` 打开会让 `getUserMedia` 那行失去判别力。

## 架构

### 核心原则：安全决策不下放到页面可达之处

MAIN world 与页面共享 JS 环境，页面能监听、伪造、重放任何跨世界消息。所以
「这个站点要不要拦截」**绝不能**由注入脚本判断，也不能由隔离世界通过消息告知。

决策被提前到注入之前：Service Worker 依设置调
`chrome.scripting.registerContentScripts`，决定注册哪些脚本、用 `excludeMatches` 排除哪些域名，
浏览器在注入前完成裁决。这条约束决定了下面几乎所有的设计取舍。

```
chrome.storage.local { enabled, blockMedia, whitelist }
        ↓
   core/policy.ts          ← 所有「要不要拦」的判断集中在此，纯函数
        ↓
   Service Worker (background/sync.ts)
     ├─ scripting.{register,update,unregister}ContentScripts
     └─ privacy.network.webRTCIPHandlingPolicy      ← 第二道防线
        ↓  浏览器在注入前裁决（页面够不着这里）
   injected/rtc.js + injected/media.js   (MAIN, document_start, allFrames)
        ↓
   页面 new RTCPeerConnection() → throw
        └─ postMessage → relay/isolated.ts → SW 计数 → 角标 / popup
```

遥测链路（最后一跳）不可信，只影响计数展示，不影响拦截。

### 分层与可测性

`src/core/**` 与 `src/shared/**` 是纯逻辑，**不得引用任何 `chrome.*` API**——这是
Vitest 能以 `environment: 'node'` 跑主力测试的前提，别为了图方便破坏它。

`src/background/**` 每个模块只声明自己用得到的窄结构接口（`ScriptingLike` / `BadgeLike` /
`SessionArea` / `IpPolicyLike` / `SettingsArea`），测试传普通对象即可，无需 mock 整个 chrome 命名空间。
真实 `chrome.*` 只在 `src/background/index.ts` 这一个接缝处注入。新增背景逻辑时沿用这个模式。

同理，popup 的所有浏览器访问收敛在 `PopupApi` 接口里，`main.tsx` 负责接真实 chrome，
`App.tsx` 只吃这个接口。

## 改动前必须知道的不变量

违反以下任何一条，失败通常是**运行时静默的**（Chrome 不注入、注册整体被拒、popup 照常显示「已拦截」）：

- **注入脚本必须无状态、无异步、无条件分支**（`src/injected/**` 各 3 行）。一旦执行就无条件打补丁。
- **注入脚本刻意不压缩。** 任何人能打开 `dist/injected/*.js` 逐行读懂注入了什么，是这个隐私扩展
  值得信任的理由。`scripts/build.mjs` 的 `UNMINIFIED_MARKERS` 拿源码里三条独有注释去产物里核对；
  改动那三条注释（`patch.ts` / `messages.ts` 里）要同步更新常量。popup 则正常压缩。
- **`src/manifest.ts` 与 `src/core/script-files.ts` 不得有任何 `import`。** `build.mjs` 用 Node 24
  原生类型剥离直接 `import()` 它们，类型剥离不改写模块说明符。产物路径由此单一来源：
  `policy.ts` 从 `script-files.ts` re-export，`build.mjs` 直接读，改名字两头一起变。
- **幂等标记必须存在闭包 `WeakSet` 里**，不能写在 target 上——写在 target 上页面可见、可伪造，等于开后门。
- 对**扩展不拥有的对象**（页面全局、原型链方法）`defineProperty` 必须 `try/catch`（属性可能已
  `configurable: false`）。对自己刚新建的函数写 `name` / `length` 不适用，包了只会产生无法覆盖的死代码。
- **拦截语义模仿浏览器真实存在的失败模式**：RTC 构造函数**同步抛错**（等价「不支持 WebRTC」）；
  `getUserMedia` / `getDisplayMedia` **返回 reject 成 `NotAllowedError` DOMException 的 Promise**
  （等价「用户拒绝授权」）。同步抛错是浏览器里从不出现的行为，会把站点推进没人测过的分支。
- **不得拦截 `enumerateDevices`。**
- **`allFrames` + `matchOriginAsFallback` + `document_start` 三者缺一不可**，它们一起封堵
  `about:blank` / `srcdoc` / `data:` iframe 取未打补丁构造函数的逃逸路径，也是最低版本被钉在
  Chrome 119 的直接原因。
- **白名单 host 采用白名单式校验**（`core/whitelist.ts` 的 `isPlainHostname`）。`new URL('https://*').hostname`
  等于 `'*'`，原样拼进 match pattern 会让 `excludeMatches` 变成全域通配（静默全局失效）或让
  `registerContentScripts` 整体被拒。IP 字面量只发精确匹配，不发 `*.` 子域模式。
- **子域匹配用 `.${w}` 后缀比较**，直接 `endsWith(w)` 会让 `evilexample.com` 命中 `example.com`。
- 设置存 `chrome.storage.local`（**不是 `sync`**）；每标签页计数与同步错误存 `chrome.storage.session`
  （MV3 SW 空闲约 30 秒即终止，内存态会凭空清零）。`onStorageChanged` **只响应 `local`**，
  否则「写计数 → 重新注册」会成环。
- **注册同步失败必须写进 session 并在 popup 上如实显示**（`shared/sync-error.ts`）。
  静默失败叠加错误汇报——popup 照着设置显示「已拦截」而其实没在拦——是这个扩展最坏的状态。
- **popup 的站点状态必须来自实测，不能由设置推导**（`popup/page-status.ts`）。
  注入脚本只在文档加载时进入页面，没有追溯力：刚装上扩展、刚把开关拨回开、刚把域名移出白名单时，
  当前这个已经加载完的页面里根本没有补丁。popup 因此要实测（`isPageBlocked` 在 MAIN world 里
  查 `RTCPeerConnection` 是不是原生实现），与设置对不上就显示「需重新加载」。
  探测**不许 `new` 一个来试**：那会触发补丁的遥测，把「开了一下 popup」记成一次拦截。
- **popup 改完设置后必须走请求-应答确认同步结果**（`shared/messages.ts` 的 `SyncRequest`）。
  `storage.onChanged` 触发的同步是浮动 Promise，保存后立刻读 session 读到的是**上一次**的结果——
  这次改动恰好把注册搞坏时，红条不会出现。应答读不懂时要显示「无法确认」，不许降级成「没问题」。
- **同步必须串行**（`background/wiring.ts` 里的 `queue`）。reconcile 是「先读实际注册状态、再据此增删」，
  两次同步交叠时后一次会读到改到一半的状态：轻则重复注册同一个 id 被拒（报出并不存在的失败），
  重则把前一次刚注册的脚本当成多余的注销掉。
- **Service Worker 每次唤醒都会跑冷启动自检**（`needsRepair`），所以它必须只读、只在真失衡时动手：
  每个标签页的每次导航都会唤醒 SW，无条件重注册的代价太大。
- **`test-pages/escape.html` 里的首行内联探针必须保持为文档的第一个脚本。**
  其余各行只能证明补丁最终在位，只有它能证明补丁赶在了页面自己的代码之前。
- **图标图形是 WebRTC 官方标志（3-clause BSD）加一道阻断斜杠**，`scripts/make-icons.mjs`
  与 `popup/App.tsx` 的 `BrandGlyph` 必须是同一组几何——那边改比例这里要跟着换算，
  否则工具栏和 popup 会显示成两个不一样的标志。BSD 要求保留版权声明：
  脚本头部与 README「图标署名」一节各有一份，删任何一份都是违反授权。
  历史上这两处曾长期是镜像关系而无人发现（注释声称一致，但没有任何东西验证），
  所以改完要用逐像素比对核实，别只靠肉眼。
- **Worker 是覆盖边界，不是待修的 bug。** MV3 没有任何机制能往 Worker 的全局作用域注入代码；
  今天不出事只因为 `RTCPeerConnection` 是 `[Exposed=Window]`。escape.html 的 Worker 哨兵行
  读法与其余各行相反：显示「已拦截」才是符合预期的现状。
- **React 只允许出现在 `src/popup/**`**；`injected` / `relay` / `background` 不得引入框架依赖。
- reconcile 每次都以浏览器实际注册状态为准，已存在的一律走 `update`（哪怕内容没变）；
  执行顺序**先注销再注册**，否则复用同一 id 时 register 会因 id 已存在而失败。

## 测试

TDD：`core/` 三个纯模块先写测试再写实现。测试与实现同目录（`*.test.ts`）。
默认 `environment: 'node'`；需要 DOM 的文件在首行加 `// @vitest-environment jsdom`
（目前只有 `src/popup/App.test.tsx`）。

不做真实浏览器 E2E——核心判定已被 core 层覆盖，剩余风险（manifest 与注册参数）用 README 的手动验收清单覆盖。

## 提交

Conventional Commits + 中文描述，scope 用模块名：`fix(core): …` / `feat(popup): …` / `build(build): …`。
描述写「改完之后世界变成什么样」，不是「做了什么操作」。

## 文档

- 设计文档：`docs/superpowers/specs/2026-08-23-webrtc-blocker-design.md`（架构、拦截语义、已知限制、验收清单）
- 实现计划：`docs/superpowers/plans/2026-08-23-webrtc-blocker.md`（11 个任务的逐条约束与理由）
