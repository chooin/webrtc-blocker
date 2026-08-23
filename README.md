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

逐条走下面十步（与设计文档 §15 一致）：

1. 默认状态下打开一个公开 WebRTC 测试页，确认无法获取 ICE 候选、控制台可见构造函数抛错。
2. 打开上面的逃逸测试页（动态创建 `about:blank` 与 `srcdoc` iframe 后取 `contentWindow.RTCPeerConnection`），确认同样被拦截。
3. 将该站点加入白名单，刷新后确认 WebRTC 立即恢复正常，且页面初始化过程中无失败迹象。
4. 移出白名单，刷新后确认恢复拦截。
5. 关闭总开关，确认全站 WebRTC 恢复正常；并在 SW 控制台执行 `chrome.privacy.network.webRTCIPHandlingPolicy.get({})` 确认取值已回到 `default`（该设置在 `chrome://settings` 界面中不可见，只能通过 API 读回）。
6. 打开媒体开关，确认网页摄像头/麦克风请求被拒绝且站点显示「权限被拒绝」类提示。
7. 关闭媒体开关，确认摄像头恢复可用，而 WebRTC 仍被拦截。
8. 更新扩展（重新加载已解压扩展）后，确认注册状态正确、无重复或失效注册。
9. 重启浏览器后确认拦截依然生效。
10. 确认角标计数随拦截增长、导航后归零。

第 6、7 步对应逃逸测试页最后一行 `getUserMedia`：媒体开关默认关闭，
所以默认设置下那一行显示「未拦截」是正确的，不是漏洞。

如果 popup 顶部出现红色警告横幅，说明 Service Worker 注册同步失败——
此时扩展**没有在拦截**，横幅上的原因就是排查起点，其余各条验收都无从谈起。
