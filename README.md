# WebRTC Blocker

Chromium（Chrome / Edge）Manifest V3 扩展。安装后默认阻断所有页面及其 iframe 的 WebRTC 通信，可按域名白名单放行。

要求 Chrome / Edge **119 以上**、Node **24 以上**、pnpm。

## 开发

    pnpm install
    pnpm build        # 构建到 dist/
    pnpm dev          # watch 模式
    pnpm test         # Vitest
    pnpm typecheck    # tsc --noEmit

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

见下方清单。逃逸测试页：

    python3 -m http.server 8765 -d test-pages

然后访问 http://localhost:8765/escape.html
