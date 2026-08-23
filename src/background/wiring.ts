import { isBlockEvent } from '../shared/messages';
import { getSettings, type SettingsArea } from '../shared/settings';
import { recordBlock, resetTab, type BadgeLike, type SessionArea } from './counter';
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

export function installListeners(env: BackgroundEnv): void {
  const counterDeps = { session: env.session, badge: env.badge };
  const syncDeps = { scripting: env.scripting, ipPolicy: env.ipPolicy };

  const sync = async (): Promise<void> => {
    await syncBlocking(await getSettings(env.settingsArea), syncDeps);
  };

  env.onInstalled.addListener(() => void sync());
  env.onStartup.addListener(() => void sync());

  env.onStorageChanged.addListener((_changes, area) => {
    // 只认 local。计数写在 session，若一并响应会形成"写计数 → 重新注册"的循环。
    if (area === 'local') void sync();
  });

  env.onMessage.addListener((message, sender) => {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return;
    if (!isBlockEvent(message)) return;
    void recordBlock(tabId, counterDeps);
  });

  env.onTabUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') void resetTab(tabId, counterDeps);
  });

  env.onTabRemoved.addListener((tabId) => void resetTab(tabId, counterDeps));
}
