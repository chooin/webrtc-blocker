import { BLOCK_EVENT_SOURCE } from '../shared/messages';
import { RTC_SCRIPT_ID } from '../core/policy';
import { counterKey } from './counter';
import { installListeners } from './wiring';

function fakeEnv() {
  // 用 any[] 而不是 never[]：假 env 要同时满足 BackgroundEnv 里六个形参各异的
  // EventLike，收窄签名只会把实现者卷进 TypeScript 的函数变型规则里，与被测行为无关。
  const listeners: Record<string, ((...args: any[]) => void)[]> = {};
  const listen = (name: string) => ({
    addListener: (fn: (...args: any[]) => void) => {
      (listeners[name] ??= []).push(fn);
    },
  });

  const settingsStore: Record<string, unknown> = {};
  const sessionStore: Record<string, unknown> = {};
  const calls: string[] = [];
  const badges: { tabId?: number; text: string }[] = [];
  let registered: { id: string }[] = [];

  const env = {
    onInstalled: listen('onInstalled'),
    onStartup: listen('onStartup'),
    onStorageChanged: listen('onStorageChanged'),
    onMessage: listen('onMessage'),
    onTabUpdated: listen('onTabUpdated'),
    onTabRemoved: listen('onTabRemoved'),
    settingsArea: {
      get: async () => ({ ...settingsStore }),
      set: async (items: Record<string, unknown>) => {
        Object.assign(settingsStore, items);
      },
    },
    session: {
      get: async (keys: string | string[]) => {
        const list = Array.isArray(keys) ? keys : [keys];
        const out: Record<string, unknown> = {};
        for (const k of list) if (k in sessionStore) out[k] = sessionStore[k];
        return out;
      },
      set: async (items: Record<string, unknown>) => {
        Object.assign(sessionStore, items);
      },
      remove: async (keys: string | string[]) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete sessionStore[k];
      },
    },
    badge: {
      setBadgeText: async (d: { tabId?: number; text: string }) => {
        badges.push(d);
      },
    },
    scripting: {
      getRegisteredContentScripts: async () => registered,
      registerContentScripts: async (s: { id: string }[]) => {
        calls.push(`register:${s.map((x) => x.id).join(',')}`);
        registered = [...registered, ...s.map((x) => ({ id: x.id }))];
      },
      updateContentScripts: async () => {
        calls.push('update');
      },
      unregisterContentScripts: async () => {
        calls.push('unregister');
      },
    },
    ipPolicy: {
      set: async (d: { value: string }) => {
        calls.push(`ip:${d.value}`);
      },
    },
  };

  // 监听器内部是 void sync() 这类浮动 Promise，让出一轮事件循环才能观察到副作用。
  const fire = async (name: string, ...args: unknown[]) => {
    for (const fn of listeners[name] ?? []) fn(...args);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  return { env, fire, calls, badges, sessionStore };
}

describe('installListeners', () => {
  it('安装时同步一次注册状态', async () => {
    const { env, fire, calls } = fakeEnv();
    installListeners(env);
    await fire('onInstalled');
    expect(calls).toContain(`register:${RTC_SCRIPT_ID}`);
  });

  it('浏览器启动时同步一次', async () => {
    const { env, fire, calls } = fakeEnv();
    installListeners(env);
    await fire('onStartup');
    expect(calls).toContain('ip:disable_non_proxied_udp');
  });

  it('local 区域的设置变化触发重新同步', async () => {
    const { env, fire, calls } = fakeEnv();
    installListeners(env);
    await fire('onStorageChanged', {}, 'local');
    expect(calls).toContain(`register:${RTC_SCRIPT_ID}`);
  });

  it('session 区域的变化不触发同步，避免计数写入引起注册风暴', async () => {
    const { env, fire, calls } = fakeEnv();
    installListeners(env);
    await fire('onStorageChanged', {}, 'session');
    expect(calls).toEqual([]);
  });

  it('收到合法遥测消息时给对应标签页计数', async () => {
    const { env, fire, sessionStore } = fakeEnv();
    installListeners(env);
    await fire(
      'onMessage',
      { source: BLOCK_EVENT_SOURCE, api: 'RTCPeerConnection' },
      { tab: { id: 11 } },
    );
    expect(sessionStore[counterKey(11)]).toBe(1);
  });

  it('形状不合法的消息被忽略', async () => {
    const { env, fire, sessionStore } = fakeEnv();
    installListeners(env);
    await fire('onMessage', { source: 'forged', api: 'RTCPeerConnection' }, { tab: { id: 11 } });
    expect(Object.keys(sessionStore)).toEqual([]);
  });

  it('没有标签页上下文的消息被忽略', async () => {
    const { env, fire, sessionStore } = fakeEnv();
    installListeners(env);
    await fire('onMessage', { source: BLOCK_EVENT_SOURCE, api: 'RTCPeerConnection' }, {});
    expect(Object.keys(sessionStore)).toEqual([]);
  });

  it('页面开始导航时清空该标签页计数', async () => {
    const { env, fire, sessionStore } = fakeEnv();
    installListeners(env);
    await fire('onMessage', { source: BLOCK_EVENT_SOURCE, api: 'RTCPeerConnection' }, { tab: { id: 11 } });
    await fire('onTabUpdated', 11, { status: 'loading' });
    expect(counterKey(11) in sessionStore).toBe(false);
  });

  it('导航完成事件不清空计数，否则会把本次页面的拦截数抹掉', async () => {
    const { env, fire, sessionStore } = fakeEnv();
    installListeners(env);
    await fire('onMessage', { source: BLOCK_EVENT_SOURCE, api: 'RTCPeerConnection' }, { tab: { id: 11 } });
    await fire('onTabUpdated', 11, { status: 'complete' });
    expect(sessionStore[counterKey(11)]).toBe(1);
  });

  it('标签页关闭时清理记录', async () => {
    const { env, fire, sessionStore } = fakeEnv();
    installListeners(env);
    await fire('onMessage', { source: BLOCK_EVENT_SOURCE, api: 'RTCPeerConnection' }, { tab: { id: 11 } });
    await fire('onTabRemoved', 11);
    expect(counterKey(11) in sessionStore).toBe(false);
  });
});
