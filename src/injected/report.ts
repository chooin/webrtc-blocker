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
