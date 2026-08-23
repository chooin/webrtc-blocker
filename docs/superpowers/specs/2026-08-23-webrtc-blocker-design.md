# WebRTC Blocker 浏览器扩展 — 设计文档

- 日期：2026-08-23
- 状态：待评审
- 目标平台：Chromium（Chrome / Edge）Manifest V3

## 1. 目标

提供一个浏览器扩展，安装后默认让浏览器无法建立 WebRTC 通信。用户可通过 popup 总开关整体停用，或按域名把个别站点加入白名单放行。

成功标准：

1. 安装并启用后，任意非白名单页面（含其所有 iframe）执行 `new RTCPeerConnection()` 抛出异常，无法建立 P2P 连接。
2. 白名单域名下 WebRTC 完全正常，且不存在"先坏后好"的时间窗。
3. 页面内的 JavaScript 无法通过任何手段解除对自身的封锁。
4. 核心判定逻辑由 Vitest 覆盖，不依赖真实浏览器即可验证。

## 2. 非目标

- 不支持 Firefox / Safari。
- 不做真实浏览器端到端自动化测试（v1）。
- 不拦截 `enumerateDevices` —— 列举设备不构成采集。
- 不提供独立 options 页与历史拦截日志（v1 只有 popup）。
- 不做代理配置、DNS、指纹等其他隐私功能。

## 3. 技术约束

### 3.1 为什么必须注入脚本

Chromium 没有"关闭 WebRTC"的官方开关。`chrome.privacy.network.webRTCIPHandlingPolicy` 只能收窄 ICE 候选的来源（降低 IP 泄漏），无法阻断通信本身；能真正关闭 WebRTC 内核的 `media.peerconnection.enabled` 是 Firefox 独有。

因此彻底禁用只能通过在页面主世界（MAIN world）替换 `RTCPeerConnection` 等全局构造函数实现。

### 3.2 最低浏览器版本：Chrome / Edge 119+

由 `chrome.scripting.registerContentScripts` 的 `matchOriginAsFallback`（Chrome 119+）决定。该字段是覆盖 `about:blank` / `srcdoc` 类 iframe 的必要条件，见 §6。

同链路上其他版本要求均低于 119：`world: "MAIN"`（102+）、`chrome.storage.session`（102+）。

## 4. 架构

### 4.1 核心原则：安全决策不下放到页面可达之处

MAIN world 与页面共享同一 JS 环境，页面可以监听、伪造、重放任何跨世界消息。因此"这个站点要不要拦截"绝不能由注入脚本自己判断，也不能由隔离世界通过消息告知——否则页面自己发一条同样的消息即可解封。

本设计把该决策提前到注入之前：Service Worker 依据设置，用 `chrome.scripting.registerContentScripts` 决定**注册哪些脚本、排除哪些域名**；浏览器在注入前完成裁决。注入脚本本身无状态、无异步、无条件分支——跑起来就打补丁。

### 4.2 组件

| 模块 | 世界 | 职责 |
|---|---|---|
| `src/core/types.ts` | — | 共享类型定义 |
| `src/core/patch.ts` | — | `installRtcBlocker(target)` / `installMediaBlocker(target)`，纯函数 |
| `src/core/whitelist.ts` | — | 域名匹配、白名单增删、生成 `excludeMatches` |
| `src/core/policy.ts` | — | 由设置推导期望注册集与 IP 策略；与实际注册集 reconcile |
| `src/injected/rtc.ts` | MAIN | 无条件 `installRtcBlocker(window)` |
| `src/injected/media.ts` | MAIN | 无条件 `installMediaBlocker(window)` |
| `src/relay/isolated.ts` | ISOLATED | 遥测中继：转发拦截事件给 SW。不参与安全决策 |
| `src/background/index.ts` | SW | 读设置 → 算策略 → 同步注册 + 设 privacy；维护计数与角标 |
| `src/popup/` | — | React UI：总开关、媒体开关、当前站点放行、本页拦截数 |
| `src/manifest.ts` | — | 以 TypeScript 生成 `manifest.json` |

### 4.3 数据流

```
chrome.storage.local { enabled, blockMedia, whitelist }
        |
        v
   core/policy.ts            <- 全部"要不要拦"的判断集中于此，纯函数
        |
        v
   Service Worker
     |-- scripting.{register,update,unregister}ContentScripts(...)
     |-- privacy.network.webRTCIPHandlingPolicy = ...
        |
        v   浏览器在注入前裁决（页面够不着这里）
   injected/rtc.js  +  injected/media.js   (MAIN, document_start, allFrames)
        |
        +-- installRtcBlocker(window) / installMediaBlocker(window)   [无条件]
                |
   页面 new RTCPeerConnection() --throw--> 站点走"不支持 WebRTC"降级分支
                |
                +-- postMessage --> relay --> SW 计数 --> 角标 / popup
```

遥测链路（最后一跳）不可信，仅影响计数准确性，不影响拦截。

## 5. 拦截语义

原则：**模仿浏览器真实存在的失败模式**，而不是发明新的失败模式。站点已经为真实失败写好了 catch 分支。

### 5.1 RTC（`injected/rtc.ts`，`enabled` 时注册）

覆盖目标：

- `RTCPeerConnection`
- `webkitRTCPeerConnection`（Chrome 至今保留的前缀别名，遗漏等于未拦截）
- `RTCDataChannel`（防御性覆盖）

行为：构造函数同步抛出错误，等价于"本浏览器不支持 WebRTC"。

实现要求：

- 替换后的构造函数需保留 `name` 与 `length`，降低被特征检测的概率。
- 保存原始引用于闭包中，不挂到任何页面可达的属性上。
- 用 `Object.defineProperty` 写入，并设 `configurable: false`，防止页面改回去。
- 幂等性判定不得依赖写在 target 上的标记（那对页面可见，可被伪造以骗过补丁）。改用闭包内的 `WeakSet<object>` 记录已处理过的 target。
- 因 `configurable: false` 会让二次 `defineProperty` 抛 `TypeError`，所有写入均以 `try/catch` 包裹；失败时静默跳过（意味着该属性已被锁定，目的已达成）。这两条共同保证：重复调用不二次包装、不丢失原始引用、不抛错。
- 目标上不存在的 API 静默跳过，不得抛错。

### 5.2 媒体采集（`injected/media.ts`，`enabled && blockMedia` 时注册）

覆盖目标：

- `navigator.mediaDevices.getUserMedia`
- `navigator.mediaDevices.getDisplayMedia`
- `navigator.getUserMedia`（legacy 回调式）

行为：**返回 reject 成 `DOMException(..., 'NotAllowedError')` 的 Promise**，等价于"用户拒绝授权"。legacy 回调式版本则调用其 error callback，传入同样的 `DOMException`。

不覆盖 `enumerateDevices`。

理由：`getUserMedia` 返回 Promise，同步抛错是浏览器中从不出现的行为，会把站点推入未测试过的代码路径；而 `NotAllowedError` 是每个站点都处理过的路径。

### 5.3 遥测

拦截发生时，注入脚本以 `window.postMessage` 发出 `{ source: 'webrtc-blocker', api: 'RTCPeerConnection' | ... }`。`relay/isolated.ts` 监听并转发给 SW。

该消息可被页面伪造，仅用于计数展示。

## 6. iframe 逃逸对策

页面可通过以下方式取得未打补丁的构造函数：

```js
const f = document.createElement('iframe');
document.body.appendChild(f);
const PC = f.contentWindow.RTCPeerConnection;
```

`about:blank` / `srcdoc` / `data:` 类 iframe 继承父页面 origin，其 URL 不匹配任何 `matches` 模式，普通 content script 不会注入。

对策：所有注入脚本注册时均设

- `allFrames: true`
- `matchOriginAsFallback: true`
- `runAt: 'document_start'`

这是最低版本被定在 Chrome 119 的直接原因。

## 7. 状态模型

```ts
// chrome.storage.local
interface Settings {
  enabled: boolean;     // 默认 true
  blockMedia: boolean;  // 默认 false
  whitelist: string[];  // 域名，如 ["meet.google.com"]
}
```

使用 `storage.local` 而非 `storage.sync`：白名单是本机安全策略，不应因在另一台设备上放行某站点而自动在本机开口。

每标签页拦截计数写入 `chrome.storage.session`（而非 SW 内存），因为 MV3 Service Worker 空闲约 30 秒即终止，内存态会丢失。页面导航时重置该标签页计数。

## 8. 策略推导（`core/policy.ts`）

全部为纯函数，无 `chrome.*` 依赖。

### 8.1 IP 处理策略

`privacy.network.webRTCIPHandlingPolicy` 是**全局**设置，无法按域名区分。故取三档：

| 条件 | 取值 | 理由 |
|---|---|---|
| `!enabled` | `default` | 用户已整体停用，不应残留副作用 |
| `enabled && whitelist 为空` | `disable_non_proxied_udp` | 最严，JS 层被绕过时的第二道防线 |
| `enabled && whitelist 非空` | `default_public_interface_only` | 若仍用最严档，白名单站点在无代理时也连不上；此档防内网 IP 泄漏但不阻断通信 |

### 8.2 期望注册集

```ts
function desiredRegistrations(s: Settings): RegisteredContentScript[]
```

- `enabled === false` → 空集
- 否则包含 `rtc-blocker`；`blockMedia === true` 时再加 `media-blocker`
- 每项：`matches: ['<all_urls>']`、`excludeMatches: toExcludeMatches(s.whitelist)`、`world: 'MAIN'`、`runAt: 'document_start'`、`allFrames: true`、`matchOriginAsFallback: true`

`toExcludeMatches(['example.com'])` → `['*://example.com/*', '*://*.example.com/*']`

Chromium 的 `*.example.com` 主机模式据文档亦匹配 `example.com` 本身，故两条模式存在冗余。此处刻意保留两条：冗余无副作用，而一旦该行为在某版本上与文档不符，白名单静默失效的代价远高于多一条模式。实现时应在此处留注释说明。

### 8.3 Reconcile

```ts
function reconcile(current: ScriptId[], desired: RegisteredContentScript[]):
  { register: RegisteredContentScript[]; update: RegisteredContentScript[]; unregister: ScriptId[] }
```

虽然 `persistAcrossSessions` 默认为 `true`，扩展更新后旧注册仍可能残留并指向旧文件路径，故每次同步都先 `getRegisteredContentScripts()` 读取实际状态再做差集。

## 9. 生命周期

SW 在以下时机重算并同步（注册集 + privacy 设置）：

- `chrome.runtime.onInstalled` —— 安装与更新
- `chrome.runtime.onStartup` —— 浏览器启动
- `chrome.storage.onChanged` —— 用户改动设置

`relay/isolated.ts` 由 `manifest.json` 静态声明（ISOLATED world、`document_start`、`allFrames`），无需动态管理——它不做安全决策，在白名单站点上运行也只是收不到消息。

## 10. 权限

| 权限 | 用途 |
|---|---|
| `storage` | 设置与每标签页计数（含 `storage.session`） |
| `scripting` | 动态注册 / 更新 / 注销注入脚本 |
| `privacy` | 设置 `webRTCIPHandlingPolicy` |
| `host_permissions: ["<all_urls>"]` | 注入所有站点；popup 读取当前标签页 URL |

不申请 `tabs`：`<all_urls>` 已足以让 `chrome.tabs.query` 返回 URL。

## 11. Popup（React）

三块内容：

1. 总开关（`enabled`）
2. 媒体采集开关（`blockMedia`），默认关闭
3. 当前站点：显示域名 + 状态（已拦截 / 已放行）+ 一键加入/移出白名单；显示本页拦截次数

React 仅参与 popup 的构建产物，注入脚本与 SW 不引入任何框架依赖。

## 12. 项目结构与构建

```
webrtc-blocker/
├─ src/
│  ├─ core/{types,patch,whitelist,policy}.ts
│  ├─ injected/{rtc,media}.ts
│  ├─ relay/isolated.ts
│  ├─ background/index.ts
│  ├─ popup/{index.html,main.tsx,App.tsx,style.css}
│  └─ manifest.ts
├─ scripts/build.mjs
├─ docs/superpowers/specs/
├─ vitest.config.ts
├─ tsconfig.json
└─ package.json
```

### 12.1 为什么需要多次构建

Content script 不能是 ES module——必须是自包含单文件，不能有 `import` 或 code splitting。而 MV3 的 Service Worker 与 popup 均可为 ESM。Rollup 单次构建只能产出一种格式，且 `iife` 格式不允许多入口（"IIFE output formats are not supported for code-splitting builds"）。

因此 `scripts/build.mjs` 调用 Vite Node API 依次执行四次构建：

1. ESM：`background/index.ts` + `popup/index.html`
2. IIFE 单入口：`injected/rtc.ts`
3. IIFE 单入口：`injected/media.ts`
4. IIFE 单入口：`relay/isolated.ts`

随后求值 `src/manifest.ts` 并写出 `dist/manifest.json`。

### 12.2 npm scripts

| 脚本 | 作用 |
|---|---|
| `pnpm build` | 完整构建到 `dist/` |
| `pnpm dev` | watch 模式构建，供 `chrome://extensions` 加载已解压扩展 |
| `pnpm test` | Vitest 单次运行 |
| `pnpm test:watch` | Vitest watch |
| `pnpm typecheck` | `tsc --noEmit` |

### 12.3 依赖

运行时：`react`、`react-dom`（仅 popup）

开发：`typescript`、`vite`、`@vitejs/plugin-react`、`vitest`、`jsdom`、`@testing-library/react`、`@types/chrome`、`@types/react`、`@types/react-dom`

Node 24+，pnpm。

## 13. 测试策略

采用 TDD：`core/` 三个纯模块先写测试再写实现，随后才是胶水层与 manifest。

### 13.1 core 层（主力，`environment: 'node'`）

`patch.test.ts` —— 传入字面量对象作为 target：

- 调用后 `new target.RTCPeerConnection()` 抛错
- `webkitRTCPeerConnection`、`RTCDataChannel` 同样被覆盖
- 原始引用被保存且不暴露在 target 上任何属性
- 重复调用幂等：不二次包装、原始引用不丢
- target 上缺少某 API 时静默跳过、不抛错
- 替换后的构造函数 `name` 与 `length` 与原始一致
- 属性 `configurable: false`，页面无法改回
- `installMediaBlocker`：`getUserMedia` / `getDisplayMedia` 返回 rejected Promise，reason 为 `NotAllowedError` 的 `DOMException`；legacy 回调式版本调用 error callback
- `installMediaBlocker` 不触碰 `enumerateDevices`

`whitelist.test.ts`：

- `example.com` 覆盖 `sub.example.com`
- `example.com` **不**匹配 `evilexample.com`（前缀误匹配，是此类代码的经典缺陷）
- 大小写不敏感
- 带端口的 host 正确归一
- punycode / 中文域名归一
- `toExcludeMatches` 生成两条模式且顺序稳定

`policy.test.ts`：

- IP 策略三档全覆盖
- `desiredRegistrations` 在 `enabled` / `blockMedia` 四种组合下的结果
- `reconcile` 的 register / update / unregister 三类差集，含"实际有残留、期望为空"的更新后场景

### 13.2 background 层（`environment: 'node'` + 手写 chrome 测试替身）

- storage 变化后，是否以正确参数调用了 `updateContentScripts` / `registerContentScripts` / `unregisterContentScripts`
- privacy 设置是否随策略切换
- 遥测消息到达后计数与角标是否正确更新，导航后是否重置

### 13.3 popup 层（`environment: 'jsdom'`）

- 开关渲染与切换写入 storage
- 当前站点状态展示与白名单增删

### 13.4 不做的部分

v1 不做真实浏览器端到端自动化测试。核心判定逻辑已被第一层覆盖；剩余风险集中在 manifest 与注册参数是否正确，用手动验收清单（§15）覆盖更划算。若后续需要，可补 Playwright 加载已解压扩展的 E2E。

## 14. 已知限制

1. `privacy.network` 为全局设置，无法按域名区分，故采用 §8.1 的三档折中。白名单非空时，非白名单站点的网络层防护会从最严档降为中档；JS 层拦截不受影响。
2. 无痕窗口需用户手动勾选"允许在无痕模式下运行"，否则扩展完全不生效。
3. 扩展页面、Chrome 应用商店等受保护页面无法注入，属浏览器限制。
4. 遥测计数可被页面伪造（多报或少报），仅供展示，不作为安全依据。
5. 若浏览器未来引入新的 WebRTC 入口 API，需要补充覆盖列表。

## 15. 手动验收清单

1. 默认状态下打开一个公开 WebRTC 测试页，确认无法获取 ICE 候选、控制台可见构造函数抛错。
2. 打开专门的 iframe 逃逸测试页（动态创建 `about:blank` 与 `srcdoc` iframe 后取 `contentWindow.RTCPeerConnection`），确认同样被拦截。
3. 将该站点加入白名单，刷新后确认 WebRTC 立即恢复正常，且页面初始化过程中无失败迹象。
4. 移出白名单，刷新后确认恢复拦截。
5. 关闭总开关，确认全站 WebRTC 恢复正常；并在 SW 控制台执行 `chrome.privacy.network.webRTCIPHandlingPolicy.get({})` 确认取值已回到 `default`（该设置在 `chrome://settings` 界面中不可见，只能通过 API 读回）。
6. 打开媒体开关，确认网页摄像头/麦克风请求被拒绝且站点显示"权限被拒绝"类提示。
7. 关闭媒体开关，确认摄像头恢复可用，而 WebRTC 仍被拦截。
8. 更新扩展（重新加载已解压扩展）后，确认注册状态正确、无重复或失效注册。
9. 重启浏览器后确认拦截依然生效。
10. 确认角标计数随拦截增长、导航后归零。

## 16. 未来可能的扩展

- 独立 options 页与历史拦截日志
- Playwright 端到端测试
- Firefox 支持（可复用 `core/`，额外利用 `browser.privacy.network.peerConnectionEnabled` 从内核层关闭）
- 白名单导入 / 导出
