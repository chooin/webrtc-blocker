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
