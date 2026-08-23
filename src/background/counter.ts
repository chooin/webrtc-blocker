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

/** 标签页仍然存在（例如刚开始导航）时的重置：清计数，并把角标一起抹掉。 */
export async function resetTab(tabId: number, deps: CounterDeps): Promise<void> {
  await deps.session.remove(counterKey(tabId));
  await deps.badge.setBadgeText({ tabId, text: '' });
}

/**
 * 标签页已经关闭时的清理：只能动存储。
 * 对已消失的 tabId 调用 setBadgeText，Chrome 会以 `No tab with id: N.` 拒绝——
 * 那是每关一个标签页就必然发生一次的失败，所以这条路径刻意不接受 BadgeLike。
 */
export async function forgetTab(tabId: number, session: SessionArea): Promise<void> {
  await session.remove(counterKey(tabId));
}
