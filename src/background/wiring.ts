import { desiredRegistrations, needsRepair } from '../core/policy';
import { isBlockEvent, isSyncRequest, type SyncResult } from '../shared/messages';
import { getSettings, type SettingsArea } from '../shared/settings';
import { clearSyncError, errorMessage, recordSyncError } from '../shared/sync-error';
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

/**
 * onMessage 与其它事件不同：监听器要能返回 true 才能保持应答通道打开，
 * 异步做完事情之后再调 sendResponse。返回 void 的 EventLike 表达不了这件事。
 */
interface MessageEventLike {
  addListener(
    callback: (
      message: unknown,
      sender: { tab?: { id?: number } },
      sendResponse: (response: unknown) => void,
    ) => boolean | void,
  ): void;
}

export interface BackgroundEnv {
  onInstalled: EventLike<[]>;
  onStartup: EventLike<[]>;
  onStorageChanged: EventLike<[Record<string, unknown>, string]>;
  onMessage: MessageEventLike;
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

  const syncOnce = async (): Promise<void> => {
    try {
      await syncBlocking(await getSettings(env.settingsArea), syncDeps);
    } catch (error) {
      // 记下来，好让 popup 明说「当前没有在拦截」，而不是照着设置显示「已拦截」。
      await recordSyncError(env.session, error);
      throw error;
    }
    await clearSyncError(env.session);
  };

  /*
   * 同步必须串行。reconcile 的形状是「先读浏览器实际注册状态，再据此增删」，
   * 两次同步交叠时，后一次读到的是前一次改到一半的状态：轻则重复注册同一个 id
   * 被 Chrome 拒绝——于是报出一个其实并不存在的失败；重则把前一次刚注册好的脚本
   * 当成多余的注销掉，真的停止拦截。
   *
   * 队列让每次同步都排在上一次结束之后。上一次失败也要继续排下去，
   * 所以 then 的两个分支是同一个函数：失败不能把后面的同步全堵死。
   */
  let queue: Promise<void> = Promise.resolve();
  const sync = (): Promise<void> => {
    queue = queue.then(syncOnce, syncOnce);
    return queue;
  };

  const runSync = (): void => run(sync(), '同步注册状态失败，扩展当前可能未在拦截');

  /**
   * 冷启动自检：onInstalled 只在安装/更新时来，onStartup 只在浏览器启动时来——
   * 「扩展被禁用之后重新启用」两个都不会来。注册若在此期间丢失，就再没有东西会补回来，
   * 而且不会有任何报错：popup 照着设置显示「已拦截」，其实一个页面都没拦。
   *
   * Service Worker 每次被唤醒都会跑到这里（每个标签页的每次导航都会唤醒它），
   * 所以这里只读、只在真的失衡时才动手。无条件重新注册的代价太大。
   */
  const repairIfNeeded = async (): Promise<void> => {
    const settings = await getSettings(env.settingsArea);
    const current = await env.scripting.getRegisteredContentScripts();
    if (!needsRepair(current.map((script) => script.id), desiredRegistrations(settings))) return;
    await sync();
  };

  env.onInstalled.addListener(runSync);
  env.onStartup.addListener(runSync);

  env.onStorageChanged.addListener((_changes, area) => {
    // 只认 local。计数写在 session，若一并响应会形成"写计数 → 重新注册"的循环。
    if (area === 'local') runSync();
  });

  env.onMessage.addListener((message, sender, sendResponse) => {
    /*
     * popup 的同步请求：跑一次同步，并把**这次**的结果回给它。
     *
     * popup 此前是「保存设置 → 立刻读 session 里的同步结果」，而那次同步是
     * storage.onChanged 触发的浮动 Promise，两者之间没有先后关系——读到的是上一次的结果。
     * 于是「这次改动恰好把注册搞坏」时红色横幅不会出现，popup 照常显示「已拦截」。
     *
     * 只认没有 tab 上下文的发送方，也就是扩展自己的页面。content script 发来的消息
     * 一律带 tab，页面即便骗过 relay 也驱动不了注册逻辑。
     */
    if (isSyncRequest(message) && sender.tab === undefined) {
      void sync().then(
        () => sendResponse({ error: null } satisfies SyncResult),
        (error: unknown) => sendResponse({ error: errorMessage(error) } satisfies SyncResult),
      );
      return true; // 保持应答通道打开，异步 sendResponse 才不会被丢弃
    }

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

  run(repairIfNeeded(), '冷启动自检失败，注册状态未知');
}
