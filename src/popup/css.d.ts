/**
 * `App.tsx` 对 style.css 做纯副作用 import（构建期由 Vite 处理，运行期靠 <link> 注入）。
 * tsconfig 未启用 "vite/client"，TS 因此不认识 `.css` 模块，需要这条最小声明。
 */
declare module '*.css';
