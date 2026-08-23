import { isBlockEvent } from '../shared/messages';
import { getSettings, type SettingsArea } from '../shared/settings';
import { clearSyncError, recordSyncError } from '../shared/sync-error';
import {
  forgetTab,
  recordBlock,
  resetTab,
  type BadgeLike,
  type SessionArea,
} from './counter';
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

/**
 * 事件监听器不能返回 Promise，所有副作用都是浮动的。
 * 浮动不等于可以不管：这里给每一条都装上真正的兜底，失败至少要留下痕迹。
 */
function run(task: Promise<unknown>, what: string): void {
  void task.catch((error: unknown) => {
    console.error(`[webrtc-blocker] ${what}`, error);
  });
}

export function installListeners(env: BackgroundEnv): void {
  const counterDeps = { session: env.session, badge: env.badge };
  const syncDeps = { scripting: env.scripting, ipPolicy: env.ipPolicy };

  const sync = async (): Promise<void> => {
    try {
      await syncBlocking(await getSettings(env.settingsArea), syncDeps);
    } catch (error) {
      // 记下来，好让 popup 明说「当前没有在拦截」，而不是照着设置显示「已拦截」。
      await recordSyncError(env.session, error);
      throw error;
    }
    await clearSyncError(env.session);
  };

  const runSync = (): void => run(sync(), '同步注册状态失败，扩展当前可能未在拦截');

  env.onInstalled.addListener(runSync);
  env.onStartup.addListener(runSync);

  env.onStorageChanged.addListener((_changes, area) => {
    // 只认 local。计数写在 session，若一并响应会形成"写计数 → 重新注册"的循环。
    if (area === 'local') runSync();
  });

  env.onMessage.addListener((message, sender) => {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return;
    if (!isBlockEvent(message)) return;
    run(recordBlock(tabId, counterDeps), '记录拦截计数失败');
  });

  env.onTabUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') run(resetTab(tabId, counterDeps), '重置标签页计数失败');
  });

  // 标签页已经不存在了，只能清存储；写角标必然被 Chrome 以 `No tab with id` 拒绝。
  env.onTabRemoved.addListener((tabId) => run(forgetTab(tabId, env.session), '清理标签页计数失败'));
}
