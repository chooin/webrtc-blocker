/**
 * 当前标签页的**实际**拦截状态。
 *
 * 存在的理由：此前 popup 的状态完全由设置推导——「开关是开的、域名不在白名单里」
 * 就显示「已拦截」。但注入脚本只在文档加载时进入页面，没有追溯力：
 * 刚装上扩展、刚把开关拨回开、刚把域名移出白名单时，**当前这个已经加载完的页面
 * 里根本没有补丁**，WebRTC 照常可用，popup 却言之凿凿说已拦截。
 *
 * 所以这里要的是设置（应该怎样）与实测（实际怎样）两个输入，而不是一个。
 */
export type PageStatus =
  /** 该拦，实测也确实拦住了 */
  | 'blocked'
  /** 该放行，实测也确实没拦 */
  | 'allowed'
  /** 设置与实际对不上：页面是在设置生效之前加载的，重新加载才会一致 */
  | 'stale'
  /** 探测不出来（页面还在加载、注入不进去等）——不许倒向任何一边 */
  | 'unknown';

export function pageStatus(shouldBlock: boolean, blocked: boolean | null): PageStatus {
  if (blocked === null) return 'unknown';
  if (blocked !== shouldBlock) return 'stale';
  return shouldBlock ? 'blocked' : 'allowed';
}
