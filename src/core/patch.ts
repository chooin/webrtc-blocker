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
