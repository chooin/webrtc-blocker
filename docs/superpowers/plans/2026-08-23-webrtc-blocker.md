# WebRTC Blocker 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个 Chromium MV3 扩展，安装后默认阻断所有页面（含 iframe）的 WebRTC 通信，可按域名白名单放行。

**Architecture:** Service Worker 依据设置，用 `chrome.scripting.registerContentScripts` 动态注册 MAIN world 注入脚本，白名单通过 `excludeMatches` 排除——"是否拦截"的决策发生在注入之前，页面 JS 无法触及。注入脚本因此保持无状态、无异步、无条件分支。所有判定逻辑集中在 `src/core/` 三个纯模块中，不依赖 `chrome.*`，可在 Node 环境下用 Vitest 完整覆盖。

**Tech Stack:** TypeScript · Vite（Node API 多次构建）· Vitest · React（仅 popup）· pnpm · Node 24+

**Spec:** `docs/superpowers/specs/2026-08-23-webrtc-blocker-design.md`

## Global Constraints

- 目标平台：Chromium（Chrome / Edge）Manifest V3，**最低版本 Chrome / Edge 119**（`matchOriginAsFallback` 要求）。manifest 中必须声明 `"minimum_chrome_version": "119"`。
- Node 24+，包管理器 pnpm。
- `src/core/**` 与 `src/shared/**` **不得引用 `chrome.*` 任何 API**，必须可在 `environment: 'node'` 下直接测试。
- 注入脚本（`src/injected/**`）**不得读取任何状态、不得有异步、不得有条件分支**。它一旦执行就无条件打补丁。
- 幂等标记**不得写在 target 对象上**（对页面可见、可被伪造），必须使用闭包内的 `WeakSet`。
- 对**扩展不拥有的对象**（页面全局、原型链上的方法）的 `Object.defineProperty` 写入必须以 `try/catch` 包裹，失败时静默跳过——原因是这些属性可能已被设为 `configurable: false`，二次写入会抛 `TypeError`。对扩展自己新建的对象（如刚构造出来的替换函数）写 `name` / `length` 不适用此条：这类写入没有失败路径，包 `try/catch` 只会产生无法被测试覆盖的死代码。
- React 仅允许出现在 `src/popup/**`；`src/injected/**`、`src/relay/**`、`src/background/**` 不得引入任何框架依赖。
- 拦截语义：`RTCPeerConnection` 系构造函数**同步抛错**；`getUserMedia` / `getDisplayMedia` **返回 reject 成 `DOMException(..., 'NotAllowedError')` 的 Promise**。
- 不得拦截 `enumerateDevices`。
- 设置存 `chrome.storage.local`（**不是 `sync`**）；每标签页计数存 `chrome.storage.session`。
- 每个任务结束时提交一次 commit。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/core/types.ts` | 共享类型：`Settings` / `ScriptId` / `IpHandlingPolicy` / `RegistrationSpec` / `ReconcilePlan` / `BlockedApi` / `BlockReporter` |
| `src/core/whitelist.ts` | 域名归一化、白名单匹配与增删、生成 `excludeMatches` |
| `src/core/patch.ts` | `installRtcBlocker` / `installMediaBlocker`，纯函数，接收 window-like 对象 |
| `src/core/policy.ts` | 由 `Settings` 推导 IP 策略、期望注册集，以及与实际注册集的 reconcile |
| `src/shared/settings.ts` | `Settings` 的读写与容错合并（依赖注入 storage area） |
| `src/shared/messages.ts` | MAIN → ISOLATED 的遥测消息协议与校验 |
| `src/background/sync.ts` | `syncBlocking(settings, deps)`：执行 reconcile 计划并设置 IP 策略 |
| `src/background/counter.ts` | 每标签页拦截计数与角标文本 |
| `src/background/wiring.ts` | `installListeners(env)`：把 chrome 事件接到上面三者（env 为窄接口，便于测试） |
| `src/background/index.ts` | 用真实 `chrome.*` 构造 env 并调用 `installListeners`（5 行胶水） |
| `src/injected/report.ts` | `report(api)`：通过 `window.postMessage` 上报拦截 |
| `src/injected/rtc.ts` | 3 行：`installRtcBlocker(window, report)` |
| `src/injected/media.ts` | 3 行：`installMediaBlocker(window, report)` |
| `src/relay/isolated.ts` | ISOLATED world：转发遥测消息给 SW |
| `src/popup/{index.html,main.tsx,App.tsx,style.css}` | React popup |
| `src/manifest.ts` | **无任何 import**，导出 manifest 字面量（供 Node 24 类型剥离直接加载） |
| `scripts/build.mjs` | 调 Vite Node API 执行 1 次 ESM 构建 + 3 次 IIFE 构建，并写出 `manifest.json` |
| `test-pages/escape.html` | iframe 逃逸手动验收页 |

**为什么 `src/manifest.ts` 不能有 import：** `scripts/build.mjs` 用 `await import()` 直接加载它，靠 Node 24 的原生 TypeScript 类型剥离。类型剥离不改写模块说明符，一旦有 import 就要处理扩展名解析问题。所幸 manifest 需要的路径（`background/index.js`、`popup/index.html`、`relay/isolated.js`）与 `policy.ts` 需要的路径（`injected/rtc.js`、`injected/media.js`）**没有任何重叠**，各自内联定义即可，不产生重复。

---

## Task 1: 脚手架 + 类型 + 白名单

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `src/core/types.ts`, `src/core/whitelist.ts`
- Test: `src/core/whitelist.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `Settings { enabled: boolean; blockMedia: boolean; whitelist: string[] }`
  - `ScriptId = 'rtc-blocker' | 'media-blocker'`
  - `IpHandlingPolicy = 'default' | 'default_public_interface_only' | 'disable_non_proxied_udp'`
  - `RegistrationSpec`（见下方代码）
  - `ReconcilePlan { register: RegistrationSpec[]; update: RegistrationSpec[]; unregister: string[] }`
  - `BlockedApi`、`BlockReporter`
  - `normalizeHost(input: string): string`
  - `isWhitelisted(hostname: string, whitelist: readonly string[]): boolean`
  - `addToWhitelist(whitelist: readonly string[], host: string): string[]`
  - `removeFromWhitelist(whitelist: readonly string[], host: string): string[]`
  - `toExcludeMatches(whitelist: readonly string[]): string[]`

- [ ] **Step 1: 初始化项目并装依赖**

```bash
pnpm init
pnpm add react react-dom
pnpm add -D typescript vite vitest jsdom @vitejs/plugin-react \
  @testing-library/react @testing-library/dom \
  @types/chrome @types/react @types/react-dom
```

- [ ] **Step 2: 写 `package.json` 的字段与脚本**

把 `package.json` 中除 `dependencies` / `devDependencies` 外的部分替换为：

```json
{
  "name": "webrtc-blocker",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "build": "node scripts/build.mjs",
    "dev": "node scripts/build.mjs --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 3: 写 `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "moduleDetection": "force",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noEmit": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "types": ["chrome", "vitest/globals"]
  },
  "include": ["src", "scripts", "vitest.config.ts"]
}
```

- [ ] **Step 4: 写 `vitest.config.ts`**

默认 `environment: 'node'`；popup 测试用文件顶部的 `// @vitest-environment jsdom` 注释单独切换（比 `environmentMatchGlobs` 更稳定，后者在 Vitest 3 已废弃）。

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
```

- [ ] **Step 5: 写 `src/core/types.ts`**

```ts
export interface Settings {
  enabled: boolean;
  blockMedia: boolean;
  whitelist: string[];
}

export type ScriptId = 'rtc-blocker' | 'media-blocker';

export type IpHandlingPolicy =
  | 'default'
  | 'default_public_interface_only'
  | 'disable_non_proxied_udp';

/**
 * 与 chrome.scripting.RegisteredContentScript 字段一致的纯数据描述。
 * 刻意不引用 chrome 类型，好让 policy.ts 能在 node 环境下直接测试。
 */
export interface RegistrationSpec {
  id: ScriptId;
  js: string[];
  matches: string[];
  excludeMatches: string[];
  runAt: 'document_start';
  allFrames: true;
  matchOriginAsFallback: true;
  world: 'MAIN';
  persistAcrossSessions: true;
}

export interface ReconcilePlan {
  register: RegistrationSpec[];
  update: RegistrationSpec[];
  /** 可能含非本扩展登记的残留 id，故为 string 而非 ScriptId */
  unregister: string[];
}

export type BlockedApi =
  | 'RTCPeerConnection'
  | 'webkitRTCPeerConnection'
  | 'RTCDataChannel'
  | 'getUserMedia'
  | 'getDisplayMedia'
  | 'legacyGetUserMedia';

export type BlockReporter = (api: BlockedApi) => void;
```

- [ ] **Step 6: 写失败的白名单测试 `src/core/whitelist.test.ts`**

```ts
import {
  addToWhitelist,
  isWhitelisted,
  normalizeHost,
  removeFromWhitelist,
  toExcludeMatches,
} from './whitelist';

describe('normalizeHost', () => {
  it('小写化并去掉端口', () => {
    expect(normalizeHost('EXAMPLE.com:8443')).toBe('example.com');
  });

  it('接受完整 URL 并只取 host', () => {
    expect(normalizeHost('https://meet.google.com/abc-def')).toBe('meet.google.com');
  });

  it('把中文域名转成 punycode', () => {
    expect(normalizeHost('例子.测试')).toBe('xn--fsqu00a.xn--0zwm56d');
  });

  it('去掉根域末尾的点', () => {
    expect(normalizeHost('example.com.')).toBe('example.com');
  });

  it('无法解析时返回空串而不是抛错', () => {
    expect(normalizeHost('   ')).toBe('');
    expect(normalizeHost('http://')).toBe('');
  });
});

describe('isWhitelisted', () => {
  it('精确匹配', () => {
    expect(isWhitelisted('example.com', ['example.com'])).toBe(true);
  });

  it('覆盖子域', () => {
    expect(isWhitelisted('a.b.example.com', ['example.com'])).toBe(true);
  });

  it('不把 evilexample.com 当成 example.com 的子域', () => {
    expect(isWhitelisted('evilexample.com', ['example.com'])).toBe(false);
  });

  it('不反向匹配：白名单写子域时父域不放行', () => {
    expect(isWhitelisted('example.com', ['sub.example.com'])).toBe(false);
  });

  it('大小写不敏感', () => {
    expect(isWhitelisted('Meet.Google.COM', ['meet.google.com'])).toBe(true);
  });

  it('空白名单一律不放行', () => {
    expect(isWhitelisted('example.com', [])).toBe(false);
  });

  it('忽略白名单里的垃圾条目', () => {
    expect(isWhitelisted('example.com', ['   ', 'example.com'])).toBe(true);
    expect(isWhitelisted('example.com', ['   '])).toBe(false);
  });
});

describe('addToWhitelist / removeFromWhitelist', () => {
  it('新增后归一化并排序，保证输出稳定', () => {
    expect(addToWhitelist(['b.com'], 'A.com:443')).toEqual(['a.com', 'b.com']);
  });

  it('重复新增不产生重复项', () => {
    expect(addToWhitelist(['a.com'], 'a.com')).toEqual(['a.com']);
  });

  it('无效输入不改变白名单', () => {
    expect(addToWhitelist(['a.com'], '  ')).toEqual(['a.com']);
  });

  it('移除时同样按归一化后的 host 比对', () => {
    expect(removeFromWhitelist(['a.com', 'b.com'], 'A.com')).toEqual(['b.com']);
  });
});

describe('toExcludeMatches', () => {
  it('每个域名产出裸域与通配子域两条模式', () => {
    expect(toExcludeMatches(['example.com'])).toEqual([
      '*://example.com/*',
      '*://*.example.com/*',
    ]);
  });

  it('跳过无效条目', () => {
    expect(toExcludeMatches(['  ', 'a.com'])).toEqual(['*://a.com/*', '*://*.a.com/*']);
  });

  it('空白名单产出空数组', () => {
    expect(toExcludeMatches([])).toEqual([]);
  });
});
```

- [ ] **Step 7: 运行测试，确认失败**

Run: `pnpm test`
Expected: FAIL —— `Failed to resolve import "./whitelist"`

- [ ] **Step 8: 实现 `src/core/whitelist.ts`**

```ts
/**
 * 把用户输入（裸域名 / host:port / 完整 URL）归一为可比较的小写 punycode host。
 * 无法解析时返回空串，由调用方决定如何处理，绝不抛错。
 */
export function normalizeHost(input: string): string {
  const raw = input.trim().toLowerCase();
  if (raw === '') return '';
  const candidate = raw.includes('://') ? raw : `https://${raw}`;
  let host: string;
  try {
    host = new URL(candidate).hostname;
  } catch {
    return '';
  }
  return host.endsWith('.') ? host.slice(0, -1) : host;
}

/**
 * 只有精确相等或真正的子域才算命中。
 * 用 `.${w}` 做后缀比较是关键：直接 endsWith(w) 会让 evilexample.com 命中 example.com。
 */
export function isWhitelisted(hostname: string, whitelist: readonly string[]): boolean {
  const host = normalizeHost(hostname);
  if (host === '') return false;
  return whitelist.some((entry) => {
    const w = normalizeHost(entry);
    if (w === '') return false;
    return host === w || host.endsWith(`.${w}`);
  });
}

/** 归一 + 去重 + 排序：输出稳定才能避免 excludeMatches 无谓变化导致的重复注册。 */
function canonicalize(whitelist: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const entry of whitelist) {
    const h = normalizeHost(entry);
    if (h !== '') seen.add(h);
  }
  return [...seen].sort();
}

export function addToWhitelist(whitelist: readonly string[], host: string): string[] {
  const w = normalizeHost(host);
  if (w === '') return canonicalize(whitelist);
  return canonicalize([...whitelist, w]);
}

export function removeFromWhitelist(whitelist: readonly string[], host: string): string[] {
  const w = normalizeHost(host);
  return canonicalize(whitelist).filter((h) => h !== w);
}

/**
 * Chromium 的 `*.example.com` 主机模式据文档亦匹配 example.com 本身，
 * 两条模式存在冗余。此处刻意保留：冗余无副作用，而一旦该行为与文档不符，
 * 白名单静默失效的代价远高于多写一条模式。
 */
export function toExcludeMatches(whitelist: readonly string[]): string[] {
  const out: string[] = [];
  for (const w of canonicalize(whitelist)) {
    out.push(`*://${w}/*`, `*://*.${w}/*`);
  }
  return out;
}
```

- [ ] **Step 9: 运行测试与类型检查**

Run: `pnpm test && pnpm typecheck`
Expected: 全部 PASS，typecheck 无输出

- [ ] **Step 10: 提交**

`.gitignore` 已存在于仓库中，**不要覆盖它**——它含有本次执行所需的条目。

```bash
git add -A
git commit -m "feat: 项目脚手架与白名单域名匹配逻辑"
```

---

## Task 2: RTC 构造函数拦截

**Files:**
- Create: `src/core/patch.ts`
- Test: `src/core/patch.test.ts`

**Interfaces:**
- Consumes: `BlockedApi`、`BlockReporter`（Task 1）
- Produces: `installRtcBlocker(target: Record<string, unknown>, report?: BlockReporter): void`

- [ ] **Step 1: 写失败的测试 `src/core/patch.test.ts`**

```ts
import type { BlockedApi } from './types';
import { installRtcBlocker } from './patch';

class FakePeerConnection {
  constructor(_config?: unknown) {}
}

function makeTarget(): Record<string, unknown> {
  const target: Record<string, unknown> = {};
  for (const key of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel']) {
    Object.defineProperty(target, key, {
      value: FakePeerConnection,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
  return target;
}

describe('installRtcBlocker', () => {
  it('让 RTCPeerConnection 构造时抛错', () => {
    const target = makeTarget();
    installRtcBlocker(target);
    const Blocked = target.RTCPeerConnection as new () => unknown;
    expect(() => new Blocked()).toThrow();
  });

  it('同样覆盖 webkitRTCPeerConnection 与 RTCDataChannel', () => {
    const target = makeTarget();
    installRtcBlocker(target);
    for (const key of ['webkitRTCPeerConnection', 'RTCDataChannel'] as const) {
      const Blocked = target[key] as new () => unknown;
      expect(() => new Blocked()).toThrow();
    }
  });

  it('不在 target 上留下任何额外属性', () => {
    const target = makeTarget();
    const before = Object.getOwnPropertyNames(target).sort();
    installRtcBlocker(target);
    expect(Object.getOwnPropertyNames(target).sort()).toEqual(before);
  });

  it('保留原构造函数的 name 与 length，降低被特征检测的概率', () => {
    const target = makeTarget();
    installRtcBlocker(target);
    const Blocked = target.RTCPeerConnection as { name: string; length: number };
    expect(Blocked.name).toBe('FakePeerConnection');
    expect(Blocked.length).toBe(FakePeerConnection.length);
  });

  it('写入的属性不可配置、不可写，页面无法改回去', () => {
    const target = makeTarget();
    installRtcBlocker(target);
    const desc = Object.getOwnPropertyDescriptor(target, 'RTCPeerConnection');
    expect(desc?.configurable).toBe(false);
    expect(desc?.writable).toBe(false);
  });

  it('保留原属性的 enumerable 特性', () => {
    const target = makeTarget();
    installRtcBlocker(target);
    expect(Object.getOwnPropertyDescriptor(target, 'RTCPeerConnection')?.enumerable).toBe(false);
  });

  it('重复调用幂等：不抛错、不二次包装', () => {
    const target = makeTarget();
    installRtcBlocker(target);
    const first = target.RTCPeerConnection;
    expect(() => installRtcBlocker(target)).not.toThrow();
    expect(target.RTCPeerConnection).toBe(first);
  });

  it('target 上缺少某个 API 时静默跳过', () => {
    const target: Record<string, unknown> = { RTCPeerConnection: FakePeerConnection };
    expect(() => installRtcBlocker(target)).not.toThrow();
    expect('webkitRTCPeerConnection' in target).toBe(false);
  });

  it('拦截发生时调用 reporter 并带上 API 名', () => {
    const target = makeTarget();
    const seen: BlockedApi[] = [];
    installRtcBlocker(target, (api) => seen.push(api));
    const Blocked = target.RTCPeerConnection as new () => unknown;
    expect(() => new Blocked()).toThrow();
    expect(seen).toEqual(['RTCPeerConnection']);
  });

  it('reporter 自身抛错不得影响拦截', () => {
    const target = makeTarget();
    installRtcBlocker(target, () => {
      throw new Error('遥测炸了');
    });
    const Blocked = target.RTCPeerConnection as new () => unknown;
    expect(() => new Blocked()).toThrow();
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm test src/core/patch.test.ts`
Expected: FAIL —— `Failed to resolve import "./patch"`

- [ ] **Step 3: 实现 `src/core/patch.ts` 的 RTC 部分**

```ts
import type { BlockedApi, BlockReporter } from './types';

const RTC_CONSTRUCTORS = [
  'RTCPeerConnection',
  'webkitRTCPeerConnection',
  'RTCDataChannel',
] as const;

/**
 * 幂等标记必须放在闭包里。写在 target 上的标记对页面可见，
 * 页面伪造一个就能骗过补丁，等于自己开了后门。
 */
const patchedRtcTargets = new WeakSet<object>();

/**
 * 以不可写、不可配置的属性写入，防止页面改回原值。
 * 保留原描述符的 enumerable，避免属性形状变化被特征检测。
 * 若属性已被锁定，defineProperty 会抛 TypeError —— 那说明补丁已在位，目的已达成，静默跳过。
 */
function defineLocked(holder: object, key: string, value: unknown): void {
  const previous = Object.getOwnPropertyDescriptor(holder, key);
  try {
    Object.defineProperty(holder, key, {
      value,
      writable: false,
      configurable: false,
      enumerable: previous?.enumerable ?? false,
    });
  } catch {
    // 已被锁定，无需处理
  }
}

/** 遥测永远不能影响拦截本身，故单独吞掉 reporter 的异常。 */
function safeReport(report: BlockReporter | undefined, api: BlockedApi): void {
  if (report === undefined) return;
  try {
    report(api);
  } catch {
    // 忽略
  }
}

function makeThrowingConstructor(
  original: unknown,
  api: BlockedApi,
  report: BlockReporter | undefined,
): unknown {
  const name = typeof original === 'function' ? original.name : api;
  const length = typeof original === 'function' ? original.length : 0;

  const Blocked = function (): never {
    safeReport(report, api);
    throw new TypeError(
      `Failed to construct '${name}': WebRTC is disabled by the WebRTC Blocker extension.`,
    );
  };

  Object.defineProperty(Blocked, 'name', { value: name, configurable: true });
  Object.defineProperty(Blocked, 'length', { value: length, configurable: true });
  return Blocked;
}

export function installRtcBlocker(
  target: Record<string, unknown>,
  report?: BlockReporter,
): void {
  if (patchedRtcTargets.has(target)) return;
  patchedRtcTargets.add(target);

  for (const api of RTC_CONSTRUCTORS) {
    const original = target[api];
    if (original === undefined) continue;
    defineLocked(target, api, makeThrowingConstructor(original, api, report));
  }
}
```

- [ ] **Step 4: 运行测试与类型检查**

Run: `pnpm test src/core/patch.test.ts && pnpm typecheck`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/patch.ts src/core/patch.test.ts
git commit -m "feat: RTCPeerConnection 系构造函数拦截"
```

---

## Task 3: 媒体采集拦截

**Files:**
- Modify: `src/core/patch.ts`（追加 media 部分）
- Modify: `src/core/patch.test.ts`（追加 media 用例）

**Interfaces:**
- Consumes: `defineLocked` / `safeReport`（Task 2，模块内私有）
- Produces:
  - `MediaTargetLike`（见下）
  - `installMediaBlocker(target: MediaTargetLike, report?: BlockReporter): void`

**关键点：** `getUserMedia` 定义在 `MediaDevices.prototype` 上，只改 `navigator.mediaDevices` 的自有属性会被 `MediaDevices.prototype.getUserMedia.call(navigator.mediaDevices)` 绕过。因此必须把原型和实例**都**打上补丁。`navigator.getUserMedia`（legacy）同理，要连 `Navigator.prototype` 一起处理。

- [ ] **Step 1: 追加失败的测试到 `src/core/patch.test.ts`**

```ts
import { installMediaBlocker } from './patch';

function makeMediaTarget() {
  const mediaDevicesProto: Record<string, unknown> = {
    getUserMedia(_c?: unknown) {
      return Promise.resolve('real stream');
    },
    getDisplayMedia(_c?: unknown) {
      return Promise.resolve('real screen');
    },
    enumerateDevices() {
      return Promise.resolve(['device']);
    },
  };
  const navigatorProto: Record<string, unknown> = {
    getUserMedia(_c: unknown, _ok?: unknown, _err?: unknown) {},
  };
  const mediaDevices = Object.create(mediaDevicesProto) as Record<string, unknown>;
  const navigator = Object.create(navigatorProto) as Record<string, unknown>;
  navigator.mediaDevices = mediaDevices;

  return {
    target: {
      navigator,
      MediaDevices: { prototype: mediaDevicesProto },
      Navigator: { prototype: navigatorProto },
    },
    mediaDevicesProto,
    navigatorProto,
    mediaDevices,
    navigator,
  };
}

describe('installMediaBlocker', () => {
  it('getUserMedia 返回 reject 成 NotAllowedError 的 Promise，而不是同步抛错', async () => {
    const { target, mediaDevices } = makeMediaTarget();
    installMediaBlocker(target);
    const gum = mediaDevices.getUserMedia as () => Promise<unknown>;
    let promise: Promise<unknown>;
    expect(() => {
      promise = gum();
    }).not.toThrow();
    await expect(promise!).rejects.toMatchObject({ name: 'NotAllowedError' });
  });

  it('getDisplayMedia 同样被拒绝', async () => {
    const { target, mediaDevices } = makeMediaTarget();
    installMediaBlocker(target);
    const gdm = mediaDevices.getDisplayMedia as () => Promise<unknown>;
    await expect(gdm()).rejects.toMatchObject({ name: 'NotAllowedError' });
  });

  it('堵住通过 MediaDevices.prototype 的绕过路径', async () => {
    const { target, mediaDevicesProto, mediaDevices } = makeMediaTarget();
    installMediaBlocker(target);
    const viaProto = mediaDevicesProto.getUserMedia as (this: unknown) => Promise<unknown>;
    await expect(viaProto.call(mediaDevices)).rejects.toMatchObject({ name: 'NotAllowedError' });
  });

  it('legacy navigator.getUserMedia 走 error callback 而不是抛错', () => {
    const { target, navigator } = makeMediaTarget();
    installMediaBlocker(target);
    const legacy = navigator.getUserMedia as (
      c: unknown,
      ok: (s: unknown) => void,
      err: (e: unknown) => void,
    ) => void;
    const onError = vi.fn();
    const onSuccess = vi.fn();
    legacy({}, onSuccess, onError);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ name: 'NotAllowedError' });
  });

  it('不触碰 enumerateDevices', () => {
    const { target, mediaDevicesProto } = makeMediaTarget();
    const original = mediaDevicesProto.enumerateDevices;
    installMediaBlocker(target);
    expect(mediaDevicesProto.enumerateDevices).toBe(original);
  });

  it('target 上没有 navigator 时直接返回，不抛错', () => {
    expect(() => installMediaBlocker({})).not.toThrow();
  });

  it('重复调用幂等', () => {
    const { target, mediaDevices } = makeMediaTarget();
    installMediaBlocker(target);
    const first = mediaDevices.getUserMedia;
    expect(() => installMediaBlocker(target)).not.toThrow();
    expect(mediaDevices.getUserMedia).toBe(first);
  });

  it('拦截时上报正确的 API 名', async () => {
    const { target, mediaDevices } = makeMediaTarget();
    const seen: string[] = [];
    installMediaBlocker(target, (api) => seen.push(api));
    await (mediaDevices.getUserMedia as () => Promise<unknown>)().catch(() => undefined);
    expect(seen).toEqual(['getUserMedia']);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm test src/core/patch.test.ts`
Expected: FAIL —— `installMediaBlocker is not a function`

- [ ] **Step 3: 追加实现到 `src/core/patch.ts`**

```ts
export interface MediaTargetLike {
  navigator?: Record<string, unknown> & { mediaDevices?: Record<string, unknown> };
  MediaDevices?: { prototype?: Record<string, unknown> };
  Navigator?: { prototype?: Record<string, unknown> };
}

const patchedMediaHolders = new WeakSet<object>();

/**
 * 模仿"用户拒绝授权"——这是每个站点都写过 catch 分支的路径。
 * 若改成同步抛错，那是浏览器里从不会出现的行为，会把站点推进没人测过的代码路径。
 */
function notAllowed(): DOMException {
  return new DOMException(
    'Permission denied by the WebRTC Blocker extension.',
    'NotAllowedError',
  );
}

function makeRejectingMethod(
  original: unknown,
  api: BlockedApi,
  exposedName: string,
  report: BlockReporter | undefined,
): unknown {
  const length = typeof original === 'function' ? original.length : 1;
  const blocked = function (): Promise<never> {
    safeReport(report, api);
    return Promise.reject(notAllowed());
  };
  Object.defineProperty(blocked, 'name', { value: exposedName, configurable: true });
  Object.defineProperty(blocked, 'length', { value: length, configurable: true });
  return blocked;
}

function makeLegacyMethod(
  original: unknown,
  report: BlockReporter | undefined,
): unknown {
  const length = typeof original === 'function' ? original.length : 3;
  const blocked = function (
    _constraints: unknown,
    _onSuccess?: unknown,
    onError?: unknown,
  ): void {
    safeReport(report, 'legacyGetUserMedia');
    if (typeof onError === 'function') {
      (onError as (e: unknown) => void)(notAllowed());
    }
  };
  Object.defineProperty(blocked, 'name', { value: 'getUserMedia', configurable: true });
  Object.defineProperty(blocked, 'length', { value: length, configurable: true });
  return blocked;
}

export function installMediaBlocker(
  target: MediaTargetLike,
  report?: BlockReporter,
): void {
  const nav = target.navigator;
  if (nav === undefined) return;

  // 原型和实例都要打：只改实例会被 MediaDevices.prototype.getUserMedia.call(...) 绕过。
  const mediaHolders: Record<string, unknown>[] = [];
  const mediaProto = target.MediaDevices?.prototype;
  if (mediaProto !== undefined) mediaHolders.push(mediaProto);
  if (nav.mediaDevices !== undefined) mediaHolders.push(nav.mediaDevices);

  for (const holder of mediaHolders) {
    if (patchedMediaHolders.has(holder)) continue;
    patchedMediaHolders.add(holder);
    for (const api of ['getUserMedia', 'getDisplayMedia'] as const) {
      const original = holder[api];
      if (original === undefined) continue;
      defineLocked(holder, api, makeRejectingMethod(original, api, api, report));
    }
  }

  const legacyHolders: Record<string, unknown>[] = [];
  const navProto = target.Navigator?.prototype;
  if (navProto !== undefined) legacyHolders.push(navProto);
  legacyHolders.push(nav);

  for (const holder of legacyHolders) {
    if (patchedMediaHolders.has(holder)) continue;
    if (holder.getUserMedia === undefined) continue;
    patchedMediaHolders.add(holder);
    defineLocked(holder, 'getUserMedia', makeLegacyMethod(holder.getUserMedia, report));
  }
}
```

- [ ] **Step 4: 运行测试与类型检查**

Run: `pnpm test && pnpm typecheck`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/patch.ts src/core/patch.test.ts
git commit -m "feat: 媒体采集拦截，走 NotAllowedError 拒绝语义"
```

---

## Task 4: 策略推导

**Files:**
- Create: `src/core/policy.ts`
- Test: `src/core/policy.test.ts`

**Interfaces:**
- Consumes: `Settings` / `IpHandlingPolicy` / `RegistrationSpec` / `ReconcilePlan` / `ScriptId`（Task 1）、`toExcludeMatches`（Task 1）
- Produces:
  - `RTC_SCRIPT_ID = 'rtc-blocker'`、`MEDIA_SCRIPT_ID = 'media-blocker'`
  - `RTC_SCRIPT_FILE = 'injected/rtc.js'`、`MEDIA_SCRIPT_FILE = 'injected/media.js'`
  - `ipHandlingPolicy(settings: Settings): IpHandlingPolicy`
  - `desiredRegistrations(settings: Settings): RegistrationSpec[]`
  - `reconcile(currentIds: readonly string[], desired: readonly RegistrationSpec[]): ReconcilePlan`

- [ ] **Step 1: 写失败的测试 `src/core/policy.test.ts`**

```ts
import type { Settings } from './types';
import {
  MEDIA_SCRIPT_ID,
  RTC_SCRIPT_ID,
  desiredRegistrations,
  ipHandlingPolicy,
  reconcile,
} from './policy';

function settings(patch: Partial<Settings> = {}): Settings {
  return { enabled: true, blockMedia: false, whitelist: [], ...patch };
}

describe('ipHandlingPolicy', () => {
  it('总开关关闭时恢复浏览器默认，不留副作用', () => {
    expect(ipHandlingPolicy(settings({ enabled: false }))).toBe('default');
  });

  it('启用且白名单为空时用最严档', () => {
    expect(ipHandlingPolicy(settings())).toBe('disable_non_proxied_udp');
  });

  it('启用且白名单非空时降到中档，否则白名单站点自己也连不上', () => {
    expect(ipHandlingPolicy(settings({ whitelist: ['a.com'] }))).toBe(
      'default_public_interface_only',
    );
  });

  it('关闭时即使有白名单也回到默认', () => {
    expect(ipHandlingPolicy(settings({ enabled: false, whitelist: ['a.com'] }))).toBe('default');
  });
});

describe('desiredRegistrations', () => {
  it('总开关关闭时不注册任何脚本', () => {
    expect(desiredRegistrations(settings({ enabled: false }))).toEqual([]);
  });

  it('默认只注册 rtc-blocker', () => {
    expect(desiredRegistrations(settings()).map((s) => s.id)).toEqual([RTC_SCRIPT_ID]);
  });

  it('打开媒体开关后追加 media-blocker', () => {
    expect(desiredRegistrations(settings({ blockMedia: true })).map((s) => s.id)).toEqual([
      RTC_SCRIPT_ID,
      MEDIA_SCRIPT_ID,
    ]);
  });

  it('关闭总开关时媒体开关不起作用', () => {
    expect(desiredRegistrations(settings({ enabled: false, blockMedia: true }))).toEqual([]);
  });

  it('每条注册都带上封堵 iframe 逃逸所需的字段', () => {
    const [spec] = desiredRegistrations(settings());
    expect(spec).toMatchObject({
      matches: ['<all_urls>'],
      runAt: 'document_start',
      allFrames: true,
      matchOriginAsFallback: true,
      world: 'MAIN',
      persistAcrossSessions: true,
    });
  });

  it('白名单转成 excludeMatches', () => {
    const [spec] = desiredRegistrations(settings({ whitelist: ['a.com'] }));
    expect(spec?.excludeMatches).toEqual(['*://a.com/*', '*://*.a.com/*']);
  });

  it('两个脚本共用同一份 excludeMatches', () => {
    const specs = desiredRegistrations(settings({ blockMedia: true, whitelist: ['a.com'] }));
    expect(specs[0]?.excludeMatches).toEqual(specs[1]?.excludeMatches);
  });
});

describe('reconcile', () => {
  it('首次同步：全部走 register', () => {
    const desired = desiredRegistrations(settings());
    const plan = reconcile([], desired);
    expect(plan.register.map((s) => s.id)).toEqual([RTC_SCRIPT_ID]);
    expect(plan.update).toEqual([]);
    expect(plan.unregister).toEqual([]);
  });

  it('已注册的走 update', () => {
    const desired = desiredRegistrations(settings());
    const plan = reconcile([RTC_SCRIPT_ID], desired);
    expect(plan.register).toEqual([]);
    expect(plan.update.map((s) => s.id)).toEqual([RTC_SCRIPT_ID]);
  });

  it('关闭总开关后把现有注册全部注销', () => {
    const plan = reconcile([RTC_SCRIPT_ID, MEDIA_SCRIPT_ID], []);
    expect(plan.unregister.sort()).toEqual([MEDIA_SCRIPT_ID, RTC_SCRIPT_ID].sort());
  });

  it('清理扩展更新后残留的陌生注册', () => {
    const plan = reconcile(['stale-from-old-version'], desiredRegistrations(settings()));
    expect(plan.unregister).toEqual(['stale-from-old-version']);
    expect(plan.register.map((s) => s.id)).toEqual([RTC_SCRIPT_ID]);
  });

  it('关掉媒体开关时只注销 media-blocker', () => {
    const plan = reconcile([RTC_SCRIPT_ID, MEDIA_SCRIPT_ID], desiredRegistrations(settings()));
    expect(plan.unregister).toEqual([MEDIA_SCRIPT_ID]);
    expect(plan.update.map((s) => s.id)).toEqual([RTC_SCRIPT_ID]);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm test src/core/policy.test.ts`
Expected: FAIL —— `Failed to resolve import "./policy"`

- [ ] **Step 3: 实现 `src/core/policy.ts`**

```ts
import type {
  IpHandlingPolicy,
  ReconcilePlan,
  RegistrationSpec,
  ScriptId,
  Settings,
} from './types';
import { toExcludeMatches } from './whitelist';

export const RTC_SCRIPT_ID: ScriptId = 'rtc-blocker';
export const MEDIA_SCRIPT_ID: ScriptId = 'media-blocker';

/** 与 scripts/build.mjs 的 IIFE 产物路径一一对应。 */
export const RTC_SCRIPT_FILE = 'injected/rtc.js';
export const MEDIA_SCRIPT_FILE = 'injected/media.js';

/**
 * privacy.network 是全局设置，无法按域名区分，故取三档折中：
 * 白名单非空时若仍用最严档，白名单站点在无代理环境下自己也连不上。
 */
export function ipHandlingPolicy(settings: Settings): IpHandlingPolicy {
  if (!settings.enabled) return 'default';
  return settings.whitelist.length === 0
    ? 'disable_non_proxied_udp'
    : 'default_public_interface_only';
}

function spec(id: ScriptId, file: string, excludeMatches: string[]): RegistrationSpec {
  return {
    id,
    js: [file],
    matches: ['<all_urls>'],
    excludeMatches,
    runAt: 'document_start',
    // allFrames + matchOriginAsFallback 一起封堵 about:blank / srcdoc iframe 逃逸。
    allFrames: true,
    matchOriginAsFallback: true,
    world: 'MAIN',
    persistAcrossSessions: true,
  };
}

export function desiredRegistrations(settings: Settings): RegistrationSpec[] {
  if (!settings.enabled) return [];
  const excludeMatches = toExcludeMatches(settings.whitelist);
  const out = [spec(RTC_SCRIPT_ID, RTC_SCRIPT_FILE, excludeMatches)];
  if (settings.blockMedia) {
    out.push(spec(MEDIA_SCRIPT_ID, MEDIA_SCRIPT_FILE, excludeMatches));
  }
  return out;
}

/**
 * 每次同步都以浏览器实际注册状态为准，而不是信任本地记忆：
 * 扩展更新后旧注册可能残留并指向已不存在的文件路径。
 * 已存在的一律走 update（即使内容未变）——多一次 API 调用，换掉一整类状态漂移问题。
 */
export function reconcile(
  currentIds: readonly string[],
  desired: readonly RegistrationSpec[],
): ReconcilePlan {
  const current = new Set(currentIds);
  const desiredIds = new Set(desired.map((d) => d.id as string));
  return {
    register: desired.filter((d) => !current.has(d.id)),
    update: desired.filter((d) => current.has(d.id)),
    unregister: [...current].filter((id) => !desiredIds.has(id)),
  };
}
```

- [ ] **Step 4: 运行测试与类型检查**

Run: `pnpm test && pnpm typecheck`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/policy.ts src/core/policy.test.ts
git commit -m "feat: 注册策略推导与 reconcile"
```

---

## Task 5: 设置读写与遥测消息协议

**Files:**
- Create: `src/shared/settings.ts`, `src/shared/messages.ts`
- Test: `src/shared/settings.test.ts`, `src/shared/messages.test.ts`

**Interfaces:**
- Consumes: `Settings`、`BlockedApi`（Task 1）、`normalizeHost`（Task 1）
- Produces:
  - `DEFAULT_SETTINGS: Settings`
  - `SettingsArea { get(keys: null): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> }`
  - `mergeSettings(raw: Record<string, unknown>): Settings`
  - `getSettings(area: SettingsArea): Promise<Settings>`
  - `saveSettings(area: SettingsArea, patch: Partial<Settings>): Promise<Settings>`
  - `BLOCK_EVENT_SOURCE`、`BlockEvent { source: string; api: BlockedApi }`
  - `createBlockEvent(api: BlockedApi): BlockEvent`
  - `isBlockEvent(data: unknown): data is BlockEvent`

- [ ] **Step 1: 写失败的测试 `src/shared/settings.test.ts`**

```ts
import { DEFAULT_SETTINGS, getSettings, mergeSettings, saveSettings } from './settings';

function fakeArea(initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...initial };
  return {
    store,
    get: async () => ({ ...store }),
    set: async (items: Record<string, unknown>) => {
      Object.assign(store, items);
    },
  };
}

describe('mergeSettings', () => {
  it('空存储回落到默认值：默认拦截 WebRTC、不拦媒体', () => {
    expect(mergeSettings({})).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toEqual({ enabled: true, blockMedia: false, whitelist: [] });
  });

  it('非布尔值的开关回落到默认，绝不静默变成"关闭"', () => {
    expect(mergeSettings({ enabled: 'nope' }).enabled).toBe(true);
    expect(mergeSettings({ blockMedia: 1 }).blockMedia).toBe(false);
  });

  it('保留合法的显式取值', () => {
    expect(mergeSettings({ enabled: false, blockMedia: true })).toMatchObject({
      enabled: false,
      blockMedia: true,
    });
  });

  it('白名单被归一、去重、排序，非字符串项被丢弃', () => {
    expect(mergeSettings({ whitelist: ['B.com', 'b.com:443', 42, '  ', 'a.com'] }).whitelist).toEqual(
      ['a.com', 'b.com'],
    );
  });

  it('白名单不是数组时回落到空数组', () => {
    expect(mergeSettings({ whitelist: 'a.com' }).whitelist).toEqual([]);
  });
});

describe('getSettings / saveSettings', () => {
  it('从存储读出并合并', async () => {
    const area = fakeArea({ enabled: false });
    await expect(getSettings(area)).resolves.toMatchObject({ enabled: false, blockMedia: false });
  });

  it('保存后返回合并结果，并只写入完整的三个字段', async () => {
    const area = fakeArea();
    const next = await saveSettings(area, { blockMedia: true });
    expect(next).toEqual({ enabled: true, blockMedia: true, whitelist: [] });
    expect(Object.keys(area.store).sort()).toEqual(['blockMedia', 'enabled', 'whitelist']);
  });

  it('部分更新不覆盖其他字段', async () => {
    const area = fakeArea({ enabled: false, whitelist: ['a.com'] });
    const next = await saveSettings(area, { blockMedia: true });
    expect(next).toEqual({ enabled: false, blockMedia: true, whitelist: ['a.com'] });
  });
});
```

- [ ] **Step 2: 写失败的测试 `src/shared/messages.test.ts`**

```ts
import { BLOCK_EVENT_SOURCE, createBlockEvent, isBlockEvent } from './messages';

describe('block event 协议', () => {
  it('创建的消息带上固定 source 与 API 名', () => {
    expect(createBlockEvent('RTCPeerConnection')).toEqual({
      source: BLOCK_EVENT_SOURCE,
      api: 'RTCPeerConnection',
    });
  });

  it('识别自己创建的消息', () => {
    expect(isBlockEvent(createBlockEvent('getUserMedia'))).toBe(true);
  });

  it('拒绝 source 不匹配的消息', () => {
    expect(isBlockEvent({ source: 'somebody-else', api: 'RTCPeerConnection' })).toBe(false);
  });

  it('拒绝 api 不在白名单内的消息，防止把任意字符串写进计数键', () => {
    expect(isBlockEvent({ source: BLOCK_EVENT_SOURCE, api: 'evil' })).toBe(false);
  });

  it('拒绝非对象输入而不抛错', () => {
    for (const bad of [null, undefined, 42, 'x', []]) {
      expect(isBlockEvent(bad)).toBe(false);
    }
  });
});
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `pnpm test src/shared`
Expected: FAIL —— 两个模块都无法解析

- [ ] **Step 4: 实现 `src/shared/settings.ts`**

```ts
import type { Settings } from '../core/types';
import { normalizeHost } from '../core/whitelist';

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  blockMedia: false,
  whitelist: [],
};

export interface SettingsArea {
  get(keys: null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * 存储内容可能来自旧版本或被外部写坏。任何不合法的值一律回落到默认，
 * 尤其是 enabled —— 绝不能因为读到脏数据就静默关闭防护。
 */
export function mergeSettings(raw: Record<string, unknown>): Settings {
  const rawList = Array.isArray(raw.whitelist) ? raw.whitelist : [];
  const hosts = new Set<string>();
  for (const entry of rawList) {
    if (typeof entry !== 'string') continue;
    const host = normalizeHost(entry);
    if (host !== '') hosts.add(host);
  }
  return {
    enabled: bool(raw.enabled, DEFAULT_SETTINGS.enabled),
    blockMedia: bool(raw.blockMedia, DEFAULT_SETTINGS.blockMedia),
    whitelist: [...hosts].sort(),
  };
}

export async function getSettings(area: SettingsArea): Promise<Settings> {
  return mergeSettings(await area.get(null));
}

export async function saveSettings(
  area: SettingsArea,
  patch: Partial<Settings>,
): Promise<Settings> {
  const next = mergeSettings({ ...(await area.get(null)), ...patch });
  await area.set({ ...next });
  return next;
}
```

- [ ] **Step 5: 实现 `src/shared/messages.ts`**

```ts
import type { BlockedApi } from '../core/types';

export const BLOCK_EVENT_SOURCE = 'webrtc-blocker::block';

const KNOWN_APIS: readonly BlockedApi[] = [
  'RTCPeerConnection',
  'webkitRTCPeerConnection',
  'RTCDataChannel',
  'getUserMedia',
  'getDisplayMedia',
  'legacyGetUserMedia',
];

export interface BlockEvent {
  source: typeof BLOCK_EVENT_SOURCE;
  api: BlockedApi;
}

export function createBlockEvent(api: BlockedApi): BlockEvent {
  return { source: BLOCK_EVENT_SOURCE, api };
}

/**
 * 这条消息来自 MAIN world，页面可以随意伪造，所以必须严格校验形状。
 * 它只用于计数展示，不承载任何安全决策。
 */
export function isBlockEvent(data: unknown): data is BlockEvent {
  if (typeof data !== 'object' || data === null) return false;
  const candidate = data as Partial<BlockEvent>;
  if (candidate.source !== BLOCK_EVENT_SOURCE) return false;
  return KNOWN_APIS.includes(candidate.api as BlockedApi);
}
```

- [ ] **Step 6: 运行测试与类型检查**

Run: `pnpm test && pnpm typecheck`
Expected: 全部 PASS

- [ ] **Step 7: 提交**

```bash
git add src/shared
git commit -m "feat: 设置读写容错与遥测消息协议"
```

---

## Task 6: 注册同步

**Files:**
- Create: `src/background/sync.ts`
- Test: `src/background/sync.test.ts`

**Interfaces:**
- Consumes: `Settings` / `RegistrationSpec`（Task 1）、`desiredRegistrations` / `ipHandlingPolicy` / `reconcile`（Task 4）
- Produces:
  - `ScriptingLike`、`IpPolicyLike`、`SyncDeps`（见下）
  - `syncBlocking(settings: Settings, deps: SyncDeps): Promise<void>`

- [ ] **Step 1: 写失败的测试 `src/background/sync.test.ts`**

```ts
import type { Settings } from '../core/types';
import { MEDIA_SCRIPT_ID, RTC_SCRIPT_ID } from '../core/policy';
import { syncBlocking } from './sync';

function settings(patch: Partial<Settings> = {}): Settings {
  return { enabled: true, blockMedia: false, whitelist: [], ...patch };
}

function fakeDeps(currentIds: string[] = []) {
  const calls: string[] = [];
  let registered = currentIds.map((id) => ({ id }));
  const scripting = {
    getRegisteredContentScripts: async () => registered,
    registerContentScripts: async (scripts: { id: string }[]) => {
      calls.push(`register:${scripts.map((s) => s.id).join(',')}`);
      registered = [...registered, ...scripts.map((s) => ({ id: s.id }))];
    },
    updateContentScripts: async (scripts: { id: string }[]) => {
      calls.push(`update:${scripts.map((s) => s.id).join(',')}`);
    },
    unregisterContentScripts: async (filter: { ids: string[] }) => {
      calls.push(`unregister:${filter.ids.join(',')}`);
      registered = registered.filter((s) => !filter.ids.includes(s.id));
    },
  };
  const ipPolicy = {
    set: async (details: { value: string }) => {
      calls.push(`ip:${details.value}`);
    },
  };
  return { calls, deps: { scripting, ipPolicy } };
}

describe('syncBlocking', () => {
  it('首次同步注册 rtc-blocker 并设成最严 IP 策略', async () => {
    const { calls, deps } = fakeDeps();
    await syncBlocking(settings(), deps);
    expect(calls).toEqual([`register:${RTC_SCRIPT_ID}`, 'ip:disable_non_proxied_udp']);
  });

  it('注销必须排在注册之前，否则复用同一 id 会失败', async () => {
    const { calls, deps } = fakeDeps(['stale']);
    await syncBlocking(settings(), deps);
    expect(calls.indexOf('unregister:stale')).toBeLessThan(calls.indexOf(`register:${RTC_SCRIPT_ID}`));
  });

  it('已注册的走 update 而不是重复 register', async () => {
    const { calls, deps } = fakeDeps([RTC_SCRIPT_ID]);
    await syncBlocking(settings(), deps);
    expect(calls).toContain(`update:${RTC_SCRIPT_ID}`);
    expect(calls.some((c) => c.startsWith('register:'))).toBe(false);
  });

  it('打开媒体开关后追加注册 media-blocker', async () => {
    const { calls, deps } = fakeDeps([RTC_SCRIPT_ID]);
    await syncBlocking(settings({ blockMedia: true }), deps);
    expect(calls).toContain(`register:${MEDIA_SCRIPT_ID}`);
  });

  it('关闭总开关时注销全部脚本并把 IP 策略恢复默认', async () => {
    const { calls, deps } = fakeDeps([RTC_SCRIPT_ID, MEDIA_SCRIPT_ID]);
    await syncBlocking(settings({ enabled: false }), deps);
    expect(calls).toContain(`unregister:${RTC_SCRIPT_ID},${MEDIA_SCRIPT_ID}`);
    expect(calls).toContain('ip:default');
  });

  it('无事可做时不调用任何 scripting 写接口，但仍会同步 IP 策略', async () => {
    const { calls, deps } = fakeDeps();
    await syncBlocking(settings({ enabled: false }), deps);
    expect(calls).toEqual(['ip:default']);
  });

  it('白名单非空时 IP 策略降到中档', async () => {
    const { calls, deps } = fakeDeps();
    await syncBlocking(settings({ whitelist: ['a.com'] }), deps);
    expect(calls).toContain('ip:default_public_interface_only');
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm test src/background/sync.test.ts`
Expected: FAIL —— `Failed to resolve import "./sync"`

- [ ] **Step 3: 实现 `src/background/sync.ts`**

```ts
import type { RegistrationSpec, Settings } from '../core/types';
import { desiredRegistrations, ipHandlingPolicy, reconcile } from '../core/policy';

/** 只声明用得到的方法，好让测试传入普通对象而不必 mock 整个 chrome 命名空间。 */
export interface ScriptingLike {
  getRegisteredContentScripts(): Promise<{ id: string }[]>;
  registerContentScripts(scripts: RegistrationSpec[]): Promise<void>;
  updateContentScripts(scripts: RegistrationSpec[]): Promise<void>;
  unregisterContentScripts(filter: { ids: string[] }): Promise<void>;
}

export interface IpPolicyLike {
  set(details: { value: string }): Promise<void>;
}

export interface SyncDeps {
  scripting: ScriptingLike;
  ipPolicy: IpPolicyLike;
}

export async function syncBlocking(settings: Settings, deps: SyncDeps): Promise<void> {
  const current = await deps.scripting.getRegisteredContentScripts();
  const plan = reconcile(
    current.map((script) => script.id),
    desiredRegistrations(settings),
  );

  // 顺序要紧：先注销再注册，否则复用同一 id 时 register 会因 id 已存在而失败。
  if (plan.unregister.length > 0) {
    await deps.scripting.unregisterContentScripts({ ids: plan.unregister });
  }
  if (plan.register.length > 0) {
    await deps.scripting.registerContentScripts(plan.register);
  }
  if (plan.update.length > 0) {
    await deps.scripting.updateContentScripts(plan.update);
  }

  await deps.ipPolicy.set({ value: ipHandlingPolicy(settings) });
}
```

- [ ] **Step 4: 运行测试与类型检查**

Run: `pnpm test && pnpm typecheck`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/background/sync.ts src/background/sync.test.ts
git commit -m "feat: 注册状态同步与 IP 策略下发"
```

---

## Task 7: 拦截计数与角标

**Files:**
- Create: `src/background/counter.ts`
- Test: `src/background/counter.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `SessionArea`、`BadgeLike`、`CounterDeps`（见下）
  - `counterKey(tabId: number): string`
  - `badgeText(count: number): string`
  - `recordBlock(tabId: number, deps: CounterDeps): Promise<number>`
  - `readCount(tabId: number, session: SessionArea): Promise<number>`
  - `resetTab(tabId: number, deps: CounterDeps): Promise<void>`

- [ ] **Step 1: 写失败的测试 `src/background/counter.test.ts`**

```ts
import { badgeText, counterKey, readCount, recordBlock, resetTab } from './counter';

function fakeDeps(initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...initial };
  const badges: { tabId?: number; text: string }[] = [];
  return {
    store,
    badges,
    deps: {
      session: {
        get: async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const key of list) {
            if (key in store) out[key] = store[key];
          }
          return out;
        },
        set: async (items: Record<string, unknown>) => {
          Object.assign(store, items);
        },
        remove: async (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
        },
      },
      badge: {
        setBadgeText: async (details: { tabId?: number; text: string }) => {
          badges.push(details);
        },
      },
    },
  };
}

describe('badgeText', () => {
  it('零次时不显示角标', () => {
    expect(badgeText(0)).toBe('');
    expect(badgeText(-1)).toBe('');
  });

  it('正常数字直接显示', () => {
    expect(badgeText(7)).toBe('7');
  });

  it('超过角标可容纳的宽度后收敛为 999+', () => {
    expect(badgeText(999)).toBe('999');
    expect(badgeText(1000)).toBe('999+');
  });
});

describe('recordBlock', () => {
  it('从零开始累加并写入角标', async () => {
    const { deps, badges, store } = fakeDeps();
    await expect(recordBlock(3, deps)).resolves.toBe(1);
    expect(store[counterKey(3)]).toBe(1);
    expect(badges).toEqual([{ tabId: 3, text: '1' }]);
  });

  it('多次拦截持续累加', async () => {
    const { deps } = fakeDeps();
    await recordBlock(3, deps);
    await expect(recordBlock(3, deps)).resolves.toBe(2);
  });

  it('不同标签页各自计数，互不干扰', async () => {
    const { deps } = fakeDeps();
    await recordBlock(1, deps);
    await recordBlock(2, deps);
    await expect(readCount(1, deps.session)).resolves.toBe(1);
    await expect(readCount(2, deps.session)).resolves.toBe(1);
  });

  it('存储里的脏值按 0 处理，不产生 NaN', async () => {
    const { deps } = fakeDeps({ [counterKey(9)]: 'oops' });
    await expect(recordBlock(9, deps)).resolves.toBe(1);
  });
});

describe('readCount / resetTab', () => {
  it('没有记录时读到 0', async () => {
    const { deps } = fakeDeps();
    await expect(readCount(42, deps.session)).resolves.toBe(0);
  });

  it('重置会删除记录并清空角标', async () => {
    const { deps, store, badges } = fakeDeps();
    await recordBlock(5, deps);
    badges.length = 0;
    await resetTab(5, deps);
    expect(counterKey(5) in store).toBe(false);
    expect(badges).toEqual([{ tabId: 5, text: '' }]);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm test src/background/counter.test.ts`
Expected: FAIL —— `Failed to resolve import "./counter"`

- [ ] **Step 3: 实现 `src/background/counter.ts`**

```ts
export interface SessionArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface BadgeLike {
  setBadgeText(details: { tabId?: number; text: string }): Promise<void>;
}

export interface CounterDeps {
  session: SessionArea;
  badge: BadgeLike;
}

export function counterKey(tabId: number): string {
  return `blocked:${tabId}`;
}

/** 角标宽度有限，超过四字符会被截断，所以先自行收敛。 */
export function badgeText(count: number): string {
  if (count <= 0) return '';
  return count > 999 ? '999+' : String(count);
}

export async function readCount(tabId: number, session: SessionArea): Promise<number> {
  const key = counterKey(tabId);
  const raw = (await session.get(key))[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
}

/**
 * 计数写 storage.session 而不是 SW 内存：MV3 的 Service Worker 空闲约 30 秒即终止，
 * 内存态会在用户还盯着同一个页面时凭空清零。
 */
export async function recordBlock(tabId: number, deps: CounterDeps): Promise<number> {
  const next = (await readCount(tabId, deps.session)) + 1;
  await deps.session.set({ [counterKey(tabId)]: next });
  await deps.badge.setBadgeText({ tabId, text: badgeText(next) });
  return next;
}

export async function resetTab(tabId: number, deps: CounterDeps): Promise<void> {
  await deps.session.remove(counterKey(tabId));
  await deps.badge.setBadgeText({ tabId, text: '' });
}
```

- [ ] **Step 4: 运行测试与类型检查**

Run: `pnpm test && pnpm typecheck`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/background/counter.ts src/background/counter.test.ts
git commit -m "feat: 每标签页拦截计数与角标"
```

---

## Task 8: Service Worker 事件接线

**Files:**
- Create: `src/background/wiring.ts`, `src/background/index.ts`
- Test: `src/background/wiring.test.ts`

**Interfaces:**
- Consumes: `getSettings` / `SettingsArea`（Task 5）、`isBlockEvent`（Task 5）、`syncBlocking` / `SyncDeps`（Task 6）、`recordBlock` / `resetTab` / `CounterDeps`（Task 7）
- Produces:
  - `BackgroundEnv`（见下）
  - `installListeners(env: BackgroundEnv): void`

**为什么拆成 `wiring.ts` + `index.ts`：** `index.ts` 一旦被 import 就会执行副作用，难以测试。把接线逻辑做成接收窄接口的 `installListeners(env)`，测试就能传假 env 并手动触发监听器；`index.ts` 只负责用真实 `chrome.*` 构造 env。

- [ ] **Step 1: 写失败的测试 `src/background/wiring.test.ts`**

```ts
import { BLOCK_EVENT_SOURCE } from '../shared/messages';
import { RTC_SCRIPT_ID } from '../core/policy';
import { counterKey } from './counter';
import { installListeners } from './wiring';

function fakeEnv() {
  // 用 any[] 而不是 never[]：假 env 要同时满足 BackgroundEnv 里六个形参各异的
  // EventLike，收窄签名只会把实现者卷进 TypeScript 的函数变型规则里，与被测行为无关。
  const listeners: Record<string, ((...args: any[]) => void)[]> = {};
  const listen = (name: string) => ({
    addListener: (fn: (...args: any[]) => void) => {
      (listeners[name] ??= []).push(fn);
    },
  });

  const settingsStore: Record<string, unknown> = {};
  const sessionStore: Record<string, unknown> = {};
  const calls: string[] = [];
  const badges: { tabId?: number; text: string }[] = [];
  let registered: { id: string }[] = [];

  const env = {
    onInstalled: listen('onInstalled'),
    onStartup: listen('onStartup'),
    onStorageChanged: listen('onStorageChanged'),
    onMessage: listen('onMessage'),
    onTabUpdated: listen('onTabUpdated'),
    onTabRemoved: listen('onTabRemoved'),
    settingsArea: {
      get: async () => ({ ...settingsStore }),
      set: async (items: Record<string, unknown>) => {
        Object.assign(settingsStore, items);
      },
    },
    session: {
      get: async (keys: string | string[]) => {
        const list = Array.isArray(keys) ? keys : [keys];
        const out: Record<string, unknown> = {};
        for (const k of list) if (k in sessionStore) out[k] = sessionStore[k];
        return out;
      },
      set: async (items: Record<string, unknown>) => {
        Object.assign(sessionStore, items);
      },
      remove: async (keys: string | string[]) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete sessionStore[k];
      },
    },
    badge: {
      setBadgeText: async (d: { tabId?: number; text: string }) => {
        badges.push(d);
      },
    },
    scripting: {
      getRegisteredContentScripts: async () => registered,
      registerContentScripts: async (s: { id: string }[]) => {
        calls.push(`register:${s.map((x) => x.id).join(',')}`);
        registered = [...registered, ...s.map((x) => ({ id: x.id }))];
      },
      updateContentScripts: async () => {
        calls.push('update');
      },
      unregisterContentScripts: async () => {
        calls.push('unregister');
      },
    },
    ipPolicy: {
      set: async (d: { value: string }) => {
        calls.push(`ip:${d.value}`);
      },
    },
  };

  // 监听器内部是 void sync() 这类浮动 Promise，让出一轮事件循环才能观察到副作用。
  const fire = async (name: string, ...args: unknown[]) => {
    for (const fn of listeners[name] ?? []) fn(...args);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  return { env, fire, calls, badges, sessionStore };
}

describe('installListeners', () => {
  it('安装时同步一次注册状态', async () => {
    const { env, fire, calls } = fakeEnv();
    installListeners(env);
    await fire('onInstalled');
    expect(calls).toContain(`register:${RTC_SCRIPT_ID}`);
  });

  it('浏览器启动时同步一次', async () => {
    const { env, fire, calls } = fakeEnv();
    installListeners(env);
    await fire('onStartup');
    expect(calls).toContain('ip:disable_non_proxied_udp');
  });

  it('local 区域的设置变化触发重新同步', async () => {
    const { env, fire, calls } = fakeEnv();
    installListeners(env);
    await fire('onStorageChanged', {}, 'local');
    expect(calls).toContain(`register:${RTC_SCRIPT_ID}`);
  });

  it('session 区域的变化不触发同步，避免计数写入引起注册风暴', async () => {
    const { env, fire, calls } = fakeEnv();
    installListeners(env);
    await fire('onStorageChanged', {}, 'session');
    expect(calls).toEqual([]);
  });

  it('收到合法遥测消息时给对应标签页计数', async () => {
    const { env, fire, sessionStore } = fakeEnv();
    installListeners(env);
    await fire(
      'onMessage',
      { source: BLOCK_EVENT_SOURCE, api: 'RTCPeerConnection' },
      { tab: { id: 11 } },
    );
    expect(sessionStore[counterKey(11)]).toBe(1);
  });

  it('形状不合法的消息被忽略', async () => {
    const { env, fire, sessionStore } = fakeEnv();
    installListeners(env);
    await fire('onMessage', { source: 'forged', api: 'RTCPeerConnection' }, { tab: { id: 11 } });
    expect(Object.keys(sessionStore)).toEqual([]);
  });

  it('没有标签页上下文的消息被忽略', async () => {
    const { env, fire, sessionStore } = fakeEnv();
    installListeners(env);
    await fire('onMessage', { source: BLOCK_EVENT_SOURCE, api: 'RTCPeerConnection' }, {});
    expect(Object.keys(sessionStore)).toEqual([]);
  });

  it('页面开始导航时清空该标签页计数', async () => {
    const { env, fire, sessionStore } = fakeEnv();
    installListeners(env);
    await fire('onMessage', { source: BLOCK_EVENT_SOURCE, api: 'RTCPeerConnection' }, { tab: { id: 11 } });
    await fire('onTabUpdated', 11, { status: 'loading' });
    expect(counterKey(11) in sessionStore).toBe(false);
  });

  it('导航完成事件不清空计数，否则会把本次页面的拦截数抹掉', async () => {
    const { env, fire, sessionStore } = fakeEnv();
    installListeners(env);
    await fire('onMessage', { source: BLOCK_EVENT_SOURCE, api: 'RTCPeerConnection' }, { tab: { id: 11 } });
    await fire('onTabUpdated', 11, { status: 'complete' });
    expect(sessionStore[counterKey(11)]).toBe(1);
  });

  it('标签页关闭时清理记录', async () => {
    const { env, fire, sessionStore } = fakeEnv();
    installListeners(env);
    await fire('onMessage', { source: BLOCK_EVENT_SOURCE, api: 'RTCPeerConnection' }, { tab: { id: 11 } });
    await fire('onTabRemoved', 11);
    expect(counterKey(11) in sessionStore).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm test src/background/wiring.test.ts`
Expected: FAIL —— `Failed to resolve import "./wiring"`

- [ ] **Step 3: 实现 `src/background/wiring.ts`**

```ts
import { isBlockEvent } from '../shared/messages';
import { getSettings, type SettingsArea } from '../shared/settings';
import { recordBlock, resetTab, type BadgeLike, type SessionArea } from './counter';
import { syncBlocking, type IpPolicyLike, type ScriptingLike } from './sync';

interface EventLike<Args extends unknown[]> {
  addListener(callback: (...args: Args) => void): void;
}

export interface BackgroundEnv {
  onInstalled: EventLike<[]>;
  onStartup: EventLike<[]>;
  onStorageChanged: EventLike<[Record<string, unknown>, string]>;
  onMessage: EventLike<[unknown, { tab?: { id?: number } }]>;
  onTabUpdated: EventLike<[number, { status?: string }]>;
  onTabRemoved: EventLike<[number]>;
  settingsArea: SettingsArea;
  session: SessionArea;
  badge: BadgeLike;
  scripting: ScriptingLike;
  ipPolicy: IpPolicyLike;
}

export function installListeners(env: BackgroundEnv): void {
  const counterDeps = { session: env.session, badge: env.badge };
  const syncDeps = { scripting: env.scripting, ipPolicy: env.ipPolicy };

  const sync = async (): Promise<void> => {
    await syncBlocking(await getSettings(env.settingsArea), syncDeps);
  };

  env.onInstalled.addListener(() => void sync());
  env.onStartup.addListener(() => void sync());

  env.onStorageChanged.addListener((_changes, area) => {
    // 只认 local。计数写在 session，若一并响应会形成"写计数 → 重新注册"的循环。
    if (area === 'local') void sync();
  });

  env.onMessage.addListener((message, sender) => {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return;
    if (!isBlockEvent(message)) return;
    void recordBlock(tabId, counterDeps);
  });

  env.onTabUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') void resetTab(tabId, counterDeps);
  });

  env.onTabRemoved.addListener((tabId) => void resetTab(tabId, counterDeps));
}
```

- [ ] **Step 4: 实现 `src/background/index.ts`**

```ts
import { installListeners } from './wiring';

/**
 * chrome.privacy 的 ChromeSetting 在不同 @types/chrome 版本间对 Promise 的支持不一致，
 * 统一用 callback 形式包一层，行为在所有版本上都确定。
 */
const ipPolicy = {
  set: (details: { value: string }): Promise<void> =>
    new Promise((resolve) => {
      chrome.privacy.network.webRTCIPHandlingPolicy.set(details, () => resolve());
    }),
};

installListeners({
  onInstalled: chrome.runtime.onInstalled,
  onStartup: chrome.runtime.onStartup,
  onStorageChanged: chrome.storage.onChanged,
  onMessage: chrome.runtime.onMessage,
  onTabUpdated: chrome.tabs.onUpdated,
  onTabRemoved: chrome.tabs.onRemoved,
  settingsArea: chrome.storage.local,
  session: chrome.storage.session,
  badge: chrome.action,
  scripting: chrome.scripting,
  ipPolicy,
});
```

若 `@types/chrome` 的事件签名与 `BackgroundEnv` 不完全兼容，在**该属性上**加最小范围的 `as unknown as` 断言并写明原因，不要放宽 `BackgroundEnv` 的类型。

- [ ] **Step 5: 运行测试与类型检查**

Run: `pnpm test && pnpm typecheck`
Expected: 全部 PASS

- [ ] **Step 6: 提交**

```bash
git add src/background
git commit -m "feat: Service Worker 事件接线"
```

---

## Task 9: 注入脚本、manifest 与构建流水线

**Files:**
- Create: `src/injected/report.ts`, `src/injected/rtc.ts`, `src/injected/media.ts`
- Create: `src/relay/isolated.ts`
- Create: `src/manifest.ts`
- Create: `scripts/build.mjs`
- Create: `src/popup/index.html`, `src/popup/main.tsx`（Task 10 会填充 `App.tsx`，此处先放最小可构建版本）

**Interfaces:**
- Consumes: `installRtcBlocker` / `installMediaBlocker` / `MediaTargetLike`（Task 2、3）、`createBlockEvent` / `isBlockEvent`（Task 5）
- Produces: `dist/` 中可被 Chrome 加载的完整扩展

- [ ] **Step 1: 写注入脚本**

`src/injected/report.ts`：

```ts
import type { BlockedApi } from '../core/types';
import { createBlockEvent } from '../shared/messages';

/** 遥测是尽力而为的：失败绝不能影响拦截本身。 */
export function report(api: BlockedApi): void {
  try {
    window.postMessage(createBlockEvent(api), '*');
  } catch {
    // 忽略
  }
}
```

`src/injected/rtc.ts`：

```ts
import { installRtcBlocker } from '../core/patch';
import { report } from './report';

// 无状态、无异步、无条件分支：是否注入本脚本由 Service Worker 在注入前裁决。
installRtcBlocker(window as unknown as Record<string, unknown>, report);
```

`src/injected/media.ts`：

```ts
import { installMediaBlocker, type MediaTargetLike } from '../core/patch';
import { report } from './report';

installMediaBlocker(window as unknown as MediaTargetLike, report);
```

`src/relay/isolated.ts`：

```ts
import { isBlockEvent } from '../shared/messages';

// 运行在隔离世界，唯一职责是把 MAIN world 的遥测转给 Service Worker。
// 这条链路不承载任何安全决策，页面伪造消息最多让计数不准。
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (!isBlockEvent(event.data)) return;
  void chrome.runtime.sendMessage(event.data).catch(() => {
    // Service Worker 尚未就绪或已终止，丢弃即可。
  });
});
```

- [ ] **Step 2: 写 `src/manifest.ts`**

**这个文件不得包含任何 `import`** —— `scripts/build.mjs` 靠 Node 24 的原生类型剥离直接 `import()` 它。

```ts
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
```

- [ ] **Step 3: 写 popup 的最小可构建骨架**

`src/popup/index.html`：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>WebRTC Blocker</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

`src/popup/main.tsx`（Task 10 会替换为接入 `App` 的版本）：

```tsx
import { createRoot } from 'react-dom/client';

const container = document.getElementById('root');
if (container !== null) {
  createRoot(container).render(<p>WebRTC Blocker</p>);
}
```

- [ ] **Step 4: 写 `scripts/build.mjs`**

```js
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import react from '@vitejs/plugin-react';
import { build } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = resolve(root, 'src');
const outDir = resolve(root, 'dist');
const watch = process.argv.includes('--watch');

// Rollup 的 iife 格式不允许多入口（"IIFE output formats are not supported for
// code-splitting builds"），而 content script 又必须是自包含单文件，
// 所以每个注入脚本各构建一次。
const iifeTargets = [
  { entry: 'src/injected/rtc.ts', out: 'injected/rtc.js' },
  { entry: 'src/injected/media.ts', out: 'injected/media.js' },
  { entry: 'src/relay/isolated.ts', out: 'relay/isolated.js' },
];

async function writeManifest() {
  // Node 24 原生支持 TypeScript 类型剥离，可直接 import .ts。
  const { manifest } = await import(pathToFileURL(resolve(srcDir, 'manifest.ts')).href);
  await mkdir(outDir, { recursive: true });
  await writeFile(
    resolve(outDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
}

// root 设为 src，好让 popup/index.html 输出到 dist/popup/index.html
// 而不是 dist/src/popup/index.html。
async function buildEsm() {
  await build({
    root: srcDir,
    configFile: false,
    plugins: [react()],
    build: {
      outDir,
      emptyOutDir: false,
      target: 'chrome119',
      minify: false,
      sourcemap: false,
      watch: watch ? {} : null,
      rollupOptions: {
        input: {
          'background/index': resolve(srcDir, 'background/index.ts'),
          'popup/index': resolve(srcDir, 'popup/index.html'),
        },
        output: {
          format: 'es',
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  });
}

async function buildIife({ entry, out }) {
  await build({
    root,
    configFile: false,
    build: {
      outDir,
      emptyOutDir: false,
      target: 'chrome119',
      minify: false,
      sourcemap: false,
      watch: watch ? {} : null,
      lib: {
        entry: resolve(root, entry),
        formats: ['iife'],
        name: '__webrtcBlocker',
        fileName: () => out,
      },
    },
  });
}

if (!watch) {
  await rm(outDir, { recursive: true, force: true });
}
await writeManifest();
await buildEsm();
for (const target of iifeTargets) {
  await buildIife(target);
}
```

- [ ] **Step 5: 构建并逐项校验产物**

```bash
pnpm build
test -f dist/manifest.json
test -f dist/background/index.js
test -f dist/popup/index.html
test -f dist/injected/rtc.js
test -f dist/injected/media.js
test -f dist/relay/isolated.js
echo "所有产物就位"
```

Expected: 六个 `test` 全部通过，最后打印 `所有产物就位`

- [ ] **Step 6: 校验注入脚本确实是自包含单文件**

Content script 不能含 `import` / `export` —— 这是 IIFE 构建是否真的生效的关键判据。

```bash
for f in dist/injected/rtc.js dist/injected/media.js dist/relay/isolated.js; do
  if grep -qE '^\s*(import|export)\s' "$f"; then
    echo "失败：$f 含 ESM 语法，未打成自包含 IIFE"; exit 1
  fi
done
grep -q 'RTCPeerConnection' dist/injected/rtc.js || { echo "失败：rtc.js 未包含拦截逻辑"; exit 1; }
grep -q 'getDisplayMedia' dist/injected/media.js || { echo "失败：media.js 未包含拦截逻辑"; exit 1; }
echo "注入脚本格式正确"
```

Expected: 打印 `注入脚本格式正确`

- [ ] **Step 7: 校验 manifest 关键字段**

```bash
node -e "
const m = require('./dist/manifest.json');
const fail = (msg) => { console.error('失败：' + msg); process.exit(1); };
if (m.manifest_version !== 3) fail('manifest_version 必须为 3');
if (m.minimum_chrome_version !== '119') fail('minimum_chrome_version 必须为 119');
for (const p of ['storage','scripting','privacy']) if (!m.permissions.includes(p)) fail('缺少权限 ' + p);
if (!m.host_permissions.includes('<all_urls>')) fail('缺少 <all_urls>');
if (m.background.type !== 'module') fail('service worker 必须声明为 module');
const cs = m.content_scripts[0];
if (cs.world !== 'ISOLATED') fail('relay 必须运行在隔离世界');
if (cs.run_at !== 'document_start') fail('relay 必须在 document_start 运行');
if (cs.all_frames !== true) fail('relay 必须覆盖所有 frame');
if (cs.match_origin_as_fallback !== true) fail('relay 必须设置 match_origin_as_fallback');
console.log('manifest 校验通过');
"
```

Expected: 打印 `manifest 校验通过`

- [ ] **Step 8: 在 Chrome 中加载并确认无报错**

打开 `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选择 `dist/` 目录。

确认：扩展卡片上没有红色错误；点击「Service Worker」打开控制台，无异常抛出。

- [ ] **Step 9: 运行完整测试与类型检查**

Run: `pnpm test && pnpm typecheck`
Expected: 全部 PASS

- [ ] **Step 10: 提交**

```bash
git add src/injected src/relay src/manifest.ts src/popup scripts/build.mjs
git commit -m "feat: 注入脚本、manifest 与多格式构建流水线"
```

---

## Task 10: Popup 界面

**Files:**
- Create: `src/popup/App.tsx`, `src/popup/style.css`
- Modify: `src/popup/main.tsx`
- Test: `src/popup/App.test.tsx`

**Interfaces:**
- Consumes: `Settings`（Task 1）、`isWhitelisted` / `addToWhitelist` / `removeFromWhitelist` / `normalizeHost`（Task 1）、`getSettings` / `saveSettings`（Task 5）、`readCount`（Task 7）
- Produces:
  - `PopupApi { getSettings(): Promise<Settings>; saveSettings(patch: Partial<Settings>): Promise<Settings>; getActiveHost(): Promise<string>; getBlockedCount(): Promise<number> }`
  - `App({ api }: { api: PopupApi }): React.ReactElement`

**为什么 `App` 接收 `api` 而不是直接调 `chrome.*`：** 让组件测试不必伪造整个 chrome 命名空间，同时把"当前标签页是什么"这类只有真实环境才知道的事挡在组件外面。

- [ ] **Step 1: 写失败的测试 `src/popup/App.test.tsx`**

```tsx
// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Settings } from '../core/types';
import { App, type PopupApi } from './App';

function fakeApi(overrides: Partial<Settings> = {}, host = 'example.com', count = 0) {
  let settings: Settings = { enabled: true, blockMedia: false, whitelist: [], ...overrides };
  const saved: Partial<Settings>[] = [];
  const api: PopupApi = {
    getSettings: async () => settings,
    saveSettings: async (patch) => {
      saved.push(patch);
      settings = { ...settings, ...patch };
      return settings;
    },
    getActiveHost: async () => host,
    getBlockedCount: async () => count,
  };
  return { api, saved, current: () => settings };
}

describe('App', () => {
  it('展示当前站点域名', async () => {
    const { api } = fakeApi();
    render(<App api={api} />);
    expect(await screen.findByText('example.com')).toBeTruthy();
  });

  it('默认状态显示该站点已被拦截', async () => {
    const { api } = fakeApi();
    render(<App api={api} />);
    expect(await screen.findByText('已拦截')).toBeTruthy();
  });

  it('站点在白名单中时显示已放行', async () => {
    const { api } = fakeApi({ whitelist: ['example.com'] });
    render(<App api={api} />);
    expect(await screen.findByText('已放行')).toBeTruthy();
  });

  it('总开关关闭时也显示已放行', async () => {
    const { api } = fakeApi({ enabled: false });
    render(<App api={api} />);
    expect(await screen.findByText('已放行')).toBeTruthy();
  });

  it('切换总开关会写入设置', async () => {
    const { api, saved } = fakeApi();
    render(<App api={api} />);
    await userEvent.click(await screen.findByLabelText('启用 WebRTC 拦截'));
    await waitFor(() => expect(saved).toContainEqual({ enabled: false }));
  });

  it('切换媒体开关会写入设置', async () => {
    const { api, saved } = fakeApi();
    render(<App api={api} />);
    await userEvent.click(await screen.findByLabelText('同时拦截摄像头与麦克风'));
    await waitFor(() => expect(saved).toContainEqual({ blockMedia: true }));
  });

  it('点击放行本站会把域名加入白名单', async () => {
    const { api, current } = fakeApi();
    render(<App api={api} />);
    await userEvent.click(await screen.findByRole('button', { name: '放行本站' }));
    await waitFor(() => expect(current().whitelist).toEqual(['example.com']));
  });

  it('已放行时按钮变为恢复拦截，点击后移出白名单', async () => {
    const { api, current } = fakeApi({ whitelist: ['example.com'] });
    render(<App api={api} />);
    await userEvent.click(await screen.findByRole('button', { name: '恢复拦截本站' }));
    await waitFor(() => expect(current().whitelist).toEqual([]));
  });

  it('展示本页拦截次数', async () => {
    const { api } = fakeApi({}, 'example.com', 7);
    render(<App api={api} />);
    expect(await screen.findByText('7')).toBeTruthy();
  });

  it('无法取得当前站点时不渲染白名单按钮', async () => {
    const { api } = fakeApi({}, '');
    render(<App api={api} />);
    // 必须先等载入完成再断言，否则"还在显示载入中"也会让这条用例通过，等于没测到。
    await screen.findByLabelText('启用 WebRTC 拦截');
    expect(screen.queryByRole('button', { name: '放行本站' })).toBeNull();
  });
});
```

- [ ] **Step 2: 安装缺失的测试依赖并运行，确认失败**

```bash
pnpm add -D @testing-library/user-event
pnpm test src/popup/App.test.tsx
```

Expected: FAIL —— `Failed to resolve import "./App"`

- [ ] **Step 3: 实现 `src/popup/App.tsx`**

```tsx
import { useCallback, useEffect, useState } from 'react';
import type { Settings } from '../core/types';
import { addToWhitelist, isWhitelisted, removeFromWhitelist } from '../core/whitelist';
import './style.css';

export interface PopupApi {
  getSettings(): Promise<Settings>;
  saveSettings(patch: Partial<Settings>): Promise<Settings>;
  getActiveHost(): Promise<string>;
  getBlockedCount(): Promise<number>;
}

export function App({ api }: { api: PopupApi }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [host, setHost] = useState('');
  const [count, setCount] = useState(0);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [loaded, activeHost, blocked] = await Promise.all([
        api.getSettings(),
        api.getActiveHost(),
        api.getBlockedCount(),
      ]);
      if (!alive) return;
      setSettings(loaded);
      setHost(activeHost);
      setCount(blocked);
    })();
    return () => {
      alive = false;
    };
  }, [api]);

  const update = useCallback(
    async (patch: Partial<Settings>) => {
      setSettings(await api.saveSettings(patch));
    },
    [api],
  );

  if (settings === null) return <main className="popup">载入中…</main>;

  const allowed = !settings.enabled || (host !== '' && isWhitelisted(host, settings.whitelist));

  return (
    <main className="popup">
      <label className="row">
        <input
          type="checkbox"
          aria-label="启用 WebRTC 拦截"
          checked={settings.enabled}
          onChange={(event) => void update({ enabled: event.target.checked })}
        />
        <span>启用 WebRTC 拦截</span>
      </label>

      <label className="row">
        <input
          type="checkbox"
          aria-label="同时拦截摄像头与麦克风"
          checked={settings.blockMedia}
          onChange={(event) => void update({ blockMedia: event.target.checked })}
        />
        <span>同时拦截摄像头与麦克风</span>
      </label>

      {host !== '' && (
        <section className="site">
          <p className="host">{host}</p>
          <p className={allowed ? 'state state-allowed' : 'state state-blocked'}>
            {allowed ? '已放行' : '已拦截'}
          </p>
          <button
            type="button"
            onClick={() =>
              void update({
                whitelist: isWhitelisted(host, settings.whitelist)
                  ? removeFromWhitelist(settings.whitelist, host)
                  : addToWhitelist(settings.whitelist, host),
              })
            }
          >
            {isWhitelisted(host, settings.whitelist) ? '恢复拦截本站' : '放行本站'}
          </button>
        </section>
      )}

      <p className="count">
        本页已拦截 <strong>{count}</strong> 次
      </p>
    </main>
  );
}
```

注意：状态文案由 `allowed` 决定（总开关关闭时也是"已放行"），而按钮文案只由白名单决定——这两件事不是一回事，混用会让"总开关关闭时按钮显示恢复拦截"这种矛盾出现。

- [ ] **Step 4: 写 `src/popup/style.css`**

```css
.popup {
  box-sizing: border-box;
  width: 280px;
  padding: 14px;
  font: 13px/1.6 system-ui, -apple-system, "PingFang SC", sans-serif;
}

.row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 10px;
  cursor: pointer;
}

.site {
  padding: 10px;
  margin: 12px 0;
  background: rgba(127, 127, 127, 0.12);
  border-radius: 6px;
}

.host {
  margin: 0 0 4px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.state {
  margin: 0 0 8px;
  font-size: 12px;
}

.state-blocked { color: #c0392b; }
.state-allowed { color: #1e8449; }

.site button {
  width: 100%;
  padding: 6px;
  cursor: pointer;
}

.count {
  margin: 0;
  font-size: 12px;
  opacity: 0.75;
}
```

- [ ] **Step 5: 用真实 chrome API 实现 `src/popup/main.tsx`**

```tsx
import { createRoot } from 'react-dom/client';
import { normalizeHost } from '../core/whitelist';
import { readCount } from '../background/counter';
import { getSettings, saveSettings } from '../shared/settings';
import { App, type PopupApi } from './App';

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

const api: PopupApi = {
  getSettings: () => getSettings(chrome.storage.local),
  saveSettings: (patch) => saveSettings(chrome.storage.local, patch),
  getActiveHost: async () => normalizeHost((await activeTab())?.url ?? ''),
  getBlockedCount: async () => {
    const id = (await activeTab())?.id;
    return id === undefined ? 0 : readCount(id, chrome.storage.session);
  },
};

const container = document.getElementById('root');
if (container !== null) {
  createRoot(container).render(<App api={api} />);
}
```

`normalizeHost` 对 `chrome://` / `about:` 之类无法注入的页面会返回空串，App 因此自动隐藏白名单按钮——正是我们要的行为。

- [ ] **Step 6: 运行测试与类型检查**

Run: `pnpm test && pnpm typecheck`
Expected: 全部 PASS

- [ ] **Step 7: 重新构建并在浏览器中确认 popup 可用**

```bash
pnpm build
```

在 `chrome://extensions` 点击「重新加载」，然后点击扩展图标，确认 popup 正常渲染、两个开关可切换、域名与状态显示正确。

- [ ] **Step 8: 提交**

```bash
git add src/popup
git commit -m "feat: popup 界面与白名单操作"
```

---

## Task 11: 逃逸测试页、README 与手动验收

**Files:**
- Create: `test-pages/escape.html`
- Create: `README.md`

**Interfaces:**
- Consumes: 完整的 `dist/` 构建产物
- Produces: 可复现的手动验收流程

- [ ] **Step 1: 写 `test-pages/escape.html`**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>WebRTC 逃逸测试</title>
    <style>
      body { font: 14px/1.7 system-ui, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 16px; }
      li { margin-bottom: 6px; }
      .blocked { color: #1e8449; font-weight: 600; }
      .leaked { color: #c0392b; font-weight: 600; }
    </style>
  </head>
  <body>
    <h1>WebRTC 逃逸测试</h1>
    <p>全部条目都应显示 <span class="blocked">已拦截</span>。任何一条显示 <span class="leaked">未拦截</span> 都是漏洞。</p>
    <ul id="results"></ul>
    <script>
      const results = document.getElementById('results');

      function record(label, getConstructor) {
        const li = document.createElement('li');
        let verdict = '未拦截';
        let ok = false;
        try {
          const PC = getConstructor();
          if (typeof PC !== 'function') {
            verdict = '已拦截（构造函数不可用）';
            ok = true;
          } else {
            new PC();
          }
        } catch (error) {
          verdict = '已拦截（' + error.name + '）';
          ok = true;
        }
        li.innerHTML = label + '：<span class="' + (ok ? 'blocked' : 'leaked') + '">' + verdict + '</span>';
        results.appendChild(li);
      }

      function frameConstructor(configure) {
        const frame = document.createElement('iframe');
        configure(frame);
        document.body.appendChild(frame);
        const PC = frame.contentWindow.RTCPeerConnection;
        frame.remove();
        return PC;
      }

      record('顶层 window', () => window.RTCPeerConnection);
      record('webkit 前缀别名', () => window.webkitRTCPeerConnection);
      record('about:blank iframe', () => frameConstructor(() => {}));
      record('srcdoc iframe', () => frameConstructor((f) => { f.srcdoc = '<p>x</p>'; }));
      record('data: URL iframe', () => frameConstructor((f) => { f.src = 'data:text/html,<p>x</p>'; }));
      record('getUserMedia（仅在媒体开关打开时应被拦截）', () => navigator.mediaDevices.getUserMedia);
    </script>
  </body>
</html>
```

- [ ] **Step 2: 写 `README.md`**

```markdown
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
```

- [ ] **Step 3: 执行手动验收清单**

逐项确认，全部通过才算完成：

1. 默认状态下访问 `http://localhost:8765/escape.html`，**前五项**全部显示「已拦截」。
2. 打开一个公开 WebRTC 测试页，确认无法获取 ICE 候选。
3. 在 popup 中点击「放行本站」，刷新后逃逸测试页前五项全部显示「未拦截」，且页面加载过程中无失败迹象。
4. 点击「恢复拦截本站」，刷新后前五项重新全部显示「已拦截」。
5. 关闭总开关，刷新确认全站恢复正常；在 Service Worker 控制台执行 `chrome.privacy.network.webRTCIPHandlingPolicy.get({})`，确认取值已回到 `default`（该设置在 `chrome://settings` 界面中不可见，只能通过 API 读回）。
6. 重新打开总开关，打开媒体开关，刷新逃逸测试页，确认第六项 `getUserMedia` 也显示「已拦截」。
7. 关闭媒体开关，刷新确认 `getUserMedia` 恢复可用，而前五项仍为「已拦截」。
8. 在 `chrome://extensions` 点击「重新加载」模拟扩展更新，刷新页面确认拦截依旧生效；在 SW 控制台执行 `chrome.scripting.getRegisteredContentScripts()`，确认没有重复或失效的注册项。
9. 重启浏览器后访问逃逸测试页，确认拦截依然生效。
10. 观察扩展图标角标：随拦截次数增长，导航到新页面后归零。

- [ ] **Step 4: 运行完整验证**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: 测试全绿、类型检查无输出、构建成功

- [ ] **Step 5: 提交**

```bash
git add README.md test-pages
git commit -m "docs: README 与 iframe 逃逸手动验收测试页"
```
