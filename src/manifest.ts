// 本文件刻意不 import 任何东西：scripts/build.mjs 用 Node 24 的原生 TypeScript
// 类型剥离直接加载它，而类型剥离不会改写模块说明符。
// 这里用到的产物路径与 core/script-files.ts 用到的没有重叠，因此不存在重复定义；
// build.mjs 会在构建结束后断言这里引用的每个文件都真的落在 dist/ 里。
const ICONS = {
  16: 'icons/icon-16.png',
  32: 'icons/icon-32.png',
  48: 'icons/icon-48.png',
  128: 'icons/icon-128.png',
} as const;

export const manifest = {
  manifest_version: 3,
  name: 'WebRTC Blocker',
  version: '0.1.0',
  description: '默认禁用 WebRTC 通信，可按域名白名单放行。',
  // matchOriginAsFallback 要求 Chrome 119+，它是封堵 about:blank iframe 逃逸的必要条件。
  minimum_chrome_version: '119',
  permissions: ['storage', 'scripting', 'privacy'],
  host_permissions: ['<all_urls>'],
  background: {
    service_worker: 'background/index.js',
    type: 'module',
  },
  // 没有 128×128 图标的扩展会被 Chrome 应用商店直接拒收，
  // 本地加载时也只会显示通用拼图占位图。
  icons: ICONS,
  action: {
    default_popup: 'popup/index.html',
    default_title: 'WebRTC Blocker',
    default_icon: ICONS,
  },
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['relay/isolated.js'],
      run_at: 'document_start',
      all_frames: true,
      match_origin_as_fallback: true,
      world: 'ISOLATED',
    },
  ],
} as const;
