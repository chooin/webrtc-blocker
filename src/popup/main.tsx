import { createRoot } from 'react-dom/client';
import { readCount } from '../background/counter';
import { createSyncRequest, isSyncResult } from '../shared/messages';
import { getSettings, saveSettings } from '../shared/settings';
import { readSyncError } from '../shared/sync-error';
import { App, type PopupApi } from './App';
import { pageHost } from './host';

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/**
 * 在页面的 MAIN world 里跑，判断 RTCPeerConnection 是不是已经被补丁替掉了。
 *
 * 刻意不去 new 一个来试：构造会触发补丁的遥测，把「用户开了一下 popup」记成一次拦截，
 * 计数就不再是页面行为的反映了。改看函数源码——原生实现是 [native code]，
 * 补丁是普通 function，读得出来。构造函数整个不存在时同样算「用不了」。
 *
 * 这个函数会被序列化后送进页面，捕获不到外面任何变量，必须自包含。
 *
 * 局限：它运行在页面自己的 realm 里，页面有能力对它撒谎（比如改掉
 * Function.prototype.toString，或者先把原生构造函数藏进闭包再删掉全局属性）。
 * 但撒谎只有在**补丁不在位**时才做得到——补丁一旦装上就是 non-configurable 的。
 * 也就是说，页面能把「没拦住」伪装成「已拦截」，却没法把「已拦截」伪装成别的。
 * 这比此前「完全按设置推导」严格得多，但它不是一个防篡改的证明，别当成那个用。
 */
function probeBlocked(): boolean {
  const ctor = (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
  if (typeof ctor !== 'function') return true;
  try {
    return !Function.prototype.toString.call(ctor).includes('[native code]');
  } catch {
    return false;
  }
}

const api: PopupApi = {
  getSettings: () => getSettings(chrome.storage.local),
  saveSettings: (patch) => saveSettings(chrome.storage.local, patch),
  getActiveHost: async () => pageHost((await activeTab())?.url ?? ''),
  getBlockedCount: async () => {
    const id = (await activeTab())?.id;
    return id === undefined ? 0 : readCount(id, chrome.storage.session);
  },
  getSyncError: () => readSyncError(chrome.storage.session),
  requestSync: async () => {
    const response: unknown = await chrome.runtime.sendMessage(createSyncRequest());
    // 应答读不懂时必须抛错，交给 App 显示「无法确认」。
    // 把读不懂降级成「没有错误」，就又回到了静默假保证。
    if (!isSyncResult(response)) throw new Error('Service Worker 没有给出可识别的应答');
    return response.error;
  },
  isPageBlocked: async () => {
    const tab = await activeTab();
    // 非 http/https 的标签页本来就注入不进去，探测无意义。
    if (tab?.id === undefined || pageHost(tab.url ?? '') === '') return null;
    try {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: probeBlocked,
      });
      return typeof injection?.result === 'boolean' ? injection.result : null;
    } catch {
      // 注入不进去（页面还在加载、受限页面等）——如实报告「测不出来」。
      return null;
    }
  },
  reloadPage: async () => {
    const id = (await activeTab())?.id;
    if (id !== undefined) await chrome.tabs.reload(id);
  },
};

const container = document.getElementById('root');
if (container !== null) {
  createRoot(container).render(<App api={api} />);
}
