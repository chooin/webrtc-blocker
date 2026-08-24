# WebRTC Blocker

Chromium（Chrome / Edge）Manifest V3 扩展。安装后默认阻断所有页面及其 iframe 的 WebRTC 通信，可按域名白名单放行。

要求 Chrome / Edge **119 以上**、Node **24 以上**、pnpm。

## 开发

    pnpm install
    pnpm build        # 构建到 dist/
    pnpm dev          # watch 模式
    pnpm test         # Vitest
    pnpm typecheck    # tsc --noEmit

图标是脚本生成后提交进仓库的，只有需要改图形时才重新跑：

    node scripts/make-icons.mjs   # 重新生成 src/icons/icon-{16,32,48,128}.png

在 `chrome://extensions` 开启开发者模式，「加载已解压的扩展程序」选择 `dist/` 目录。

## 工作原理

Service Worker 依据设置，用 `chrome.scripting.registerContentScripts` 决定是否注册 MAIN world 注入脚本，白名单通过 `excludeMatches` 排除。因此「是否拦截」的决策发生在注入之前，页面 JavaScript 无法通过伪造消息解除对自身的封锁；注入脚本本身无状态、无异步、无条件分支。

`allFrames` 与 `matchOriginAsFallback` 一起封堵通过 `about:blank` / `srcdoc` / `data:` iframe 取得未打补丁构造函数的逃逸路径。

`chrome.privacy.network.webRTCIPHandlingPolicy` 作为第二道防线，在 JS 层被绕过时限制 IP 泄漏。它是全局设置，白名单非空时会从最严档降为中档，否则白名单站点自己也无法连接。

设计文档见 `docs/superpowers/specs/2026-08-23-webrtc-blocker-design.md`。

## 已知限制

- **无痕窗口默认不生效。** 需要在 `chrome://extensions` 的扩展详情页手动勾选「在无痕模式下启用」。
- **扩展页面、Chrome 应用商店等受保护页面无法注入**，属浏览器限制。
- **`webRTCIPHandlingPolicy` 是全局设置**，无法按域名区分。白名单非空时它会从最严档降到中档，非白名单站点的网络层防护随之减弱；JS 层拦截不受影响。
- **角标计数可被页面伪造**（多报或少报）。它只用于展示，不作为安全依据。
- 若浏览器将来引入新的 WebRTC 入口 API，需要补充 `src/core/patch.ts` 中的覆盖列表。

## 手动验收

先起一个本地服务器提供逃逸测试页——**必须走 `http://localhost`**，
因为 `navigator.mediaDevices` 只存在于安全上下文，用 `file://` 打开会让 `getUserMedia`
那一行无条件显示「已拦截」，失去判别力：

    python3 -m http.server 8765 -d test-pages

然后访问 <http://localhost:8765/escape.html>。

逐条走下面十二步：

1. 默认状态下打开一个公开 WebRTC 测试页，确认无法获取 ICE 候选、控制台可见构造函数抛错。
2. 打开上面的逃逸测试页，确认**「页面的第一个脚本」那一行显示「已拦截」**。这一行最要紧：其余各行只能证明补丁最终在位，只有它能证明补丁赶在了页面自己的代码之前。
3. 同一页上确认四种 iframe 逃逸路径（`about:blank`、`srcdoc`、不等 load 的同步读取、`data:`）全部显示「已拦截」。
4. 将该站点加入白名单，刷新后确认 WebRTC 立即恢复正常，且页面初始化过程中无失败迹象。
5. 移出白名单，刷新后确认恢复拦截。
6. 关闭总开关，确认全站 WebRTC 恢复正常；并在 SW 控制台执行 `chrome.privacy.network.webRTCIPHandlingPolicy.get({})` 确认取值已回到 `default`（该设置在 `chrome://settings` 界面中不可见，只能通过 API 读回）。
7. **不刷新页面**，把总开关重新打开，然后打开 popup：站点状态应显示「需重新加载」并给出重新加载按钮，**不能**显示「已拦截」——补丁只在文档加载时进入页面，此刻它确实没在拦。点重新加载后状态应变成「已拦截」。
8. 打开媒体开关，确认网页摄像头/麦克风请求被拒绝且站点显示「权限被拒绝」类提示。
9. 关闭媒体开关，确认摄像头恢复可用，而 WebRTC 仍被拦截。
10. 更新扩展（重新加载已解压扩展）后，确认注册状态正确、无重复或失效注册。
11. 重启浏览器后确认拦截依然生效。
12. 确认角标计数随拦截增长、导航后归零。

第 8、9 步对应逃逸测试页 `getUserMedia` 那一行：媒体开关默认关闭，
所以默认设置下那一行显示「未拦截」是正确的，不是漏洞。

逃逸测试页最后一行「Web Worker 哨兵」的读法与其余各行**相反**：
它显示「已拦截（RTCPeerConnection=undefined…）」是符合预期的现状——
扩展进不了 Worker 的全局作用域，今天没事只因为浏览器没在那儿暴露 API。
那一行一旦变成「未拦截」，说明浏览器开始在 Worker 里提供 WebRTC，
这个扩展会在那条路径上静默失效，需要重新设计而不是就地改。

如果 popup 顶部出现红色警告横幅，说明 Service Worker 注册同步失败——
此时扩展**没有在拦截**，横幅上的原因就是排查起点，其余各条验收都无从谈起。
横幅显示「无法确认拦截是否生效」时同样不能继续：那代表 popup 连 Service Worker 都没问到，
状态是未知而不是正常。

## 图标署名

工具栏图标与 popup 品牌栏的图形，基于 **WebRTC 官方标志**（五个彩色圆排成正五边形，
中间压一个白色对话气泡），外加一道阻断斜杠——这是个拦截器，图标不该只说「这里有 WebRTC」。

> Copyright The WebRTC project authors.
> 依 3-clause BSD License 授权：<https://webrtc.org/license/>
> 标志出处：<https://webrtc.org/press/>

BSD 允许再分发与修改，条件是保留上面这段版权声明。本仓库没有复制官方 SVG 的任何代码，
`scripts/make-icons.mjs` 是按其几何参数（五个圆的圆心与半径、气泡圆角矩形与尾巴顶点）
重建的；那些参数是从官方 SVG 的 path 与 transform 里解出来的。

**这个扩展与 WebRTC 项目没有任何隶属关系，也未获其背书。**
