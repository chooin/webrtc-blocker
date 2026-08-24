export interface SessionArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export function counterKey(tabId: number): string {
  return `blocked:${tabId}`;
}

export async function readCount(tabId: number, session: SessionArea): Promise<number> {
  const key = counterKey(tabId);
  const raw = (await session.get(key))[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
}

/**
 * 计数写 storage.session 而不是 SW 内存：MV3 的 Service Worker 空闲约 30 秒即终止，
 * 内存态会在用户还盯着同一个页面时凭空清零。
 *
 * 这里只动计数，不碰角标：角标现在由 background/action.ts 按**状态**统一重画。
 * 两个写入者各写各的，就会出现「刚写上的 OFF 被一次计数更新抹成空」这种覆盖。
 */
export async function recordBlock(tabId: number, session: SessionArea): Promise<number> {
  const next = (await readCount(tabId, session)) + 1;
  await session.set({ [counterKey(tabId)]: next });
  return next;
}

/** 标签页仍然存在（例如刚开始导航）时的重置：只清计数，重画交给调用方。 */
export async function resetTab(tabId: number, session: SessionArea): Promise<void> {
  await session.remove(counterKey(tabId));
}

/**
 * 标签页已经关闭时的清理：只能动存储。
 * 对已消失的 tabId 写角标或图标，Chrome 会以 `No tab with id: N.` 拒绝——
 * 那是每关一个标签页就必然发生一次的失败，所以这条路径绝不能顺手去重画。
 */
export async function forgetTab(tabId: number, session: SessionArea): Promise<void> {
  await session.remove(counterKey(tabId));
}
