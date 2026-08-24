import type { ActionState } from '../core/action-state';
import { COLOR_ICON_FILES, GRAY_ICON_FILES } from '../core/icon-files';

/** 只声明用得到的方法，好让测试传入普通对象而不必 mock 整个 chrome 命名空间。 */
export interface ActionLike {
  setBadgeText(details: { tabId?: number; text: string }): Promise<void>;
  setBadgeBackgroundColor(details: { tabId?: number; color: string }): Promise<void>;
  setIcon(details: { tabId?: number; path: Record<number, string> }): Promise<void>;
}

export interface ActionDeps {
  action: ActionLike;
}

/** 角标宽度有限，超过四字符会被截断，所以先自行收敛。 */
export function badgeText(count: number): string {
  if (count <= 0) return '';
  return count > 999 ? '999+' : String(count);
}

/** 与 popup 的「已拦截 = 绿」一致：这是扩展正常工作的状态，不该长得像报错。 */
const BLOCKING_COLOR = '#0e9f6e';
/** 没在保护的三种情形共用中性灰：它们不是错误，只是没在保护。 */
const IDLE_COLOR = '#6b6f76';

/**
 * 这个标签页此刻该显示什么。
 *
 * 「正在拦」刻意让 badge 保持空（除非拦到了东西）：正常状态不该在工具栏上持续喊话。
 * 反过来说，**badge 非空一律意味着「有事」**——OFF / — 是没在保护，数字是拦到了东西。
 */
function appearance(state: ActionState, count: number): { text: string; color: string } {
  switch (state) {
    case 'blocking':
      return { text: badgeText(count), color: BLOCKING_COLOR };
    case 'disabled':
      return { text: 'OFF', color: IDLE_COLOR };
    case 'allowed':
      return { text: '—', color: IDLE_COLOR };
    case 'inapplicable':
      // chrome:// 这类页面上扩展本来就不工作，写 OFF 会被读成「是我关的开关」。
      return { text: '', color: IDLE_COLOR };
  }
}

/**
 * 按状态重画工具栏图标与 badge。
 *
 * 图标只有「彩色 / 灰」两种：灰即「这个标签页没有在被保护」，三种成因由 badge 文字区分。
 * 颜色先于文字写入——反过来的话，会有一瞬间新文字配着上一次的底色。
 */
export async function refreshAction(
  tabId: number,
  state: ActionState,
  count: number,
  deps: ActionDeps,
): Promise<void> {
  const { text, color } = appearance(state, count);
  await deps.action.setIcon({
    tabId,
    path: state === 'blocking' ? { ...COLOR_ICON_FILES } : { ...GRAY_ICON_FILES },
  });
  await deps.action.setBadgeBackgroundColor({ tabId, color });
  await deps.action.setBadgeText({ tabId, text });
}
