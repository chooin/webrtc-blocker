// 本文件刻意不 import 任何东西：scripts/build.mjs 用 Node 24 的原生 TypeScript
// 类型剥离直接加载它，而类型剥离不会改写模块说明符（无扩展名的 './types' 解析不了）。
// 构建产物路径由此只有这一份定义：policy.ts 从这里 re-export，build.mjs 直接 import，
// 改名字时两边一起变，不可能只改一头。
export const RTC_SCRIPT_FILE = 'injected/rtc.js';
export const MEDIA_SCRIPT_FILE = 'injected/media.js';
