import type { Settings } from './types';
import { isWhitelisted } from './whitelist';

/**
 * 工具栏图标此刻该表达的状态。
 *
 * 存在的理由和 popup/page-status.ts 是同一条：不能让用户以为自己被保护着。
 * 区别在于这里只回答「按设置，这个标签页该不该被拦」——它不做实测，
 * 也就管不了「页面在设置生效前就加载了」那一种。那一格由 popup 承担。
 */
export type ActionState =
  /** 该拦：图标彩色，badge 留给拦截计数 */
  | 'blocking'
  /** 总开关关闭 */
  | 'disabled'
  /** 本站在白名单里 */
  | 'allowed'
  /** chrome:// 这类注入不进去的页面：扩展在这儿本来就不工作 */
  | 'inapplicable';

export function actionState(settings: Settings, host: string): ActionState {
  // 这一条必须排在最前面。那些页面上扩展根本没被注入，
  // 报「正在拦」是撒谎；报 OFF 也是撒谎——会让人以为是自己关的开关。
  if (host === '') return 'inapplicable';
  if (!settings.enabled) return 'disabled';
  return isWhitelisted(host, settings.whitelist) ? 'allowed' : 'blocking';
}
