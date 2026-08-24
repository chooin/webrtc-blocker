// 本文件刻意不 import 任何东西：scripts/build.mjs 用 Node 24 的原生类型剥离直接加载它，
// 类型剥离不会改写模块说明符。灰度图标不在 manifest 里（它们是运行时用
// chrome.action.setIcon 换上去的），所以必须在这里留一份路径，
// 好让构建期的产物断言也能覆盖到——否则改个文件名，Chrome 只会在运行时静默失败。
//
// 彩色那一组在 src/manifest.ts 里另有一份字面量：manifest.ts 同样不许 import，
// 没法从这里取。两份都被 build.mjs 的断言覆盖，任一处改名而产物没跟上都会让构建失败。
export const COLOR_ICON_FILES = {
  16: 'icons/icon-16.png',
  32: 'icons/icon-32.png',
  48: 'icons/icon-48.png',
  128: 'icons/icon-128.png',
} as const;

export const GRAY_ICON_FILES = {
  16: 'icons/icon-gray-16.png',
  32: 'icons/icon-gray-32.png',
  48: 'icons/icon-gray-48.png',
  128: 'icons/icon-gray-128.png',
} as const;
