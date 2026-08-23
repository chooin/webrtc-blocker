// 本文件刻意不 import 任何东西：scripts/build.mjs 用 Node 24 的原生 TypeScript
// 类型剥离直接加载它，而类型剥离不会改写模块说明符。
// 这里用到的产物路径与 core/policy.ts 用到的没有重叠，因此不存在重复定义。
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
  action: {
    default_popup: 'popup/index.html',
    default_title: 'WebRTC Blocker',
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
