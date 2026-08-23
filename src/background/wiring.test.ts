import { BLOCK_EVENT_SOURCE } from '../shared/messages';
import { SYNC_ERROR_KEY, readSyncError } from '../shared/sync-error';
import { RTC_SCRIPT_ID } from '../core/policy';
import { counterKey } from './counter';
import { installListeners } from './wiring';

interface FailureOptions {
  /** registerContentScripts 被 Chrome 拒绝，例如白名单产出了非法 match pattern。 */
  registerError?: string;
  /** setBadgeText 报错，模拟对已关闭标签页写角标时的 `No tab with id: N.`。 */
  badgeError?: string;
}

function fakeEnv(options: FailureOptions = {}) {
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
        if (options.badgeError !== undefined) throw new Error(options.badgeError);
        badges.push(d);
      },
    },
    scripting: {
      getRegisteredContentScripts: async () => registered,
      registerContentScripts: async (s: { id: string }[]) => {
        if (options.registerError !== undefined) throw new Error(options.registerError);
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

  /**
   * 标签页关闭时写角标，Chrome 必然以 `No tab with id: N.` 拒绝——
   * 每关一个标签页就发生一次，永远如此。这两条用例把这条路径钉在"只动存储"上。
   */
  it('标签页关闭时不写角标', async () => {
    const { env, fire, badges } = fakeEnv();
    installListeners(env);
    await fire('onMessage', { source: BLOCK_EVENT_SOURCE, api: 'RTCPeerConnection' }, { tab: { id: 11 } });
    badges.length = 0;
    await fire('onTabRemoved', 11);
    expect(badges).toEqual([]);
  });

  it('角标接口对已关闭标签页报错时，关闭路径压根不会碰它', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { env, fire, sessionStore } = fakeEnv({ badgeError: 'No tab with id: 11.' });
    installListeners(env);
    sessionStore[counterKey(11)] = 3;
    await fire('onTabRemoved', 11);
    expect(counterKey(11) in sessionStore).toBe(false);
    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it('导航开始时仍然清空角标——那个标签页还活着', async () => {
    const { env, fire, badges } = fakeEnv();
    installListeners(env);
    await fire('onTabUpdated', 11, { status: 'loading' });
    expect(badges).toEqual([{ tabId: 11, text: '' }]);
  });
});

/**
 * 注册失败时扩展其实没有在拦截，而 popup 的状态是从设置推导的，会照常显示「已拦截」。
 * 静默失败叠加错误汇报是最坏的一种状态，所以失败必须落盘，成功必须把它清掉。
 */
describe('installListeners 的同步失败上报', () => {
  it('注册被拒绝时把原因写进 session', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { env, fire } = fakeEnv({ registerError: 'PARSE_ERROR_INVALID_HOST_WILDCARD' });
    installListeners(env);
    await fire('onInstalled');
    await expect(readSyncError(env.session)).resolves.toBe('PARSE_ERROR_INVALID_HOST_WILDCARD');
    logged.mockRestore();
  });

  it('失败会被记进日志，而不是变成没人接的浮动 Promise', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { env, fire } = fakeEnv({ registerError: 'boom' });
    installListeners(env);
    await fire('onInstalled');
    expect(logged).toHaveBeenCalled();
    expect(String(logged.mock.calls[0]?.[0])).toContain('[webrtc-blocker]');
    logged.mockRestore();
  });

  it('注册失败时依然下发 IP 策略，第二道防线不能跟着一起倒', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { env, fire, calls } = fakeEnv({ registerError: 'boom' });
    installListeners(env);
    await fire('onInstalled');
    expect(calls).toContain('ip:disable_non_proxied_udp');
    logged.mockRestore();
  });

  it('下一次同步成功后清掉此前记录的失败', async () => {
    const { env, fire, sessionStore } = fakeEnv();
    sessionStore[SYNC_ERROR_KEY] = { message: '上一次的失败', at: 1 };
    installListeners(env);
    await fire('onInstalled');
    expect(SYNC_ERROR_KEY in sessionStore).toBe(false);
  });

  it('一切正常时不会凭空写出失败记录', async () => {
    const { env, fire } = fakeEnv();
    installListeners(env);
    await fire('onInstalled');
    await expect(readSyncError(env.session)).resolves.toBeNull();
  });
});
