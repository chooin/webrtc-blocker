/**
 * 注册同步失败时的落盘记录。
 *
 * 这条链路存在的唯一理由：`registerContentScripts` 失败时扩展其实没有在拦截，
 * 而 popup 的状态是从设置推导的，会照常显示「已拦截」——静默失败叠加错误汇报，
 * 是这个扩展最坏的一种状态。把失败写进 storage.session，让 popup 能如实告知用户。
 *
 * 存 session 而不是 local：这是运行时状态，浏览器重启后必然重新同步一次，
 * 陈旧的错误不该跨会话吓唬用户。
 */
export const SYNC_ERROR_KEY = 'sync-error';

export interface SyncErrorRecord {
  message: string;
  at: number;
}

/** 只声明用得到的方法，形状与 background/counter.ts 的 SessionArea 一致。 */
export interface SyncErrorArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

/** 任何值都要能变成一句人话：抛出来的未必是 Error。 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message;
  const text = String(error);
  return text === '' ? '未知错误' : text;
}

export async function recordSyncError(area: SyncErrorArea, error: unknown): Promise<void> {
  const record: SyncErrorRecord = { message: errorMessage(error), at: Date.now() };
  await area.set({ [SYNC_ERROR_KEY]: record });
}

export async function clearSyncError(area: SyncErrorArea): Promise<void> {
  await area.remove(SYNC_ERROR_KEY);
}

/** 读不到、或读到形状不对的脏数据，一律当作「没有错误」。 */
export async function readSyncError(area: SyncErrorArea): Promise<string | null> {
  const raw = (await area.get(SYNC_ERROR_KEY))[SYNC_ERROR_KEY];
  if (typeof raw !== 'object' || raw === null) return null;
  const message = (raw as Partial<SyncErrorRecord>).message;
  return typeof message === 'string' && message !== '' ? message : null;
}
