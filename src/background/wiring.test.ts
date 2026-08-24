import { BLOCK_EVENT_SOURCE, createSyncRequest } from '../shared/messages';
import { SYNC_ERROR_KEY, readSyncError } from '../shared/sync-error';
import { RTC_SCRIPT_ID } from '../core/policy';
import { counterKey } from './counter';
import { installListeners } from './wiring';

interface FailureOptions {
  /** registerContentScripts 被 Chrome 拒绝，例如白名单产出了非法 match pattern。 */
  registerError?: string;
  /** setBadgeText 报错，模拟对已关闭标签页写角标时的 `No tab with id: N.`。 */
  badgeError?: string;
  /** 预置浏览器侧已有的注册，用来构造「冷启动时注册还在 / 已经丢了」两种局面。 */
  initialRegistered?: { id: string }[];
  /**
   * 让 scripting 的每个写操作在开始与结束之间让出一轮事件循环，
   * 并各记一条标记。两次同步若交叠，标记会穿插，序列一看便知。
   */
  traceAsync?: boolean;
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

  const yieldIfTracing = async () => {
    if (options.traceAsync === true) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  const tabUrls: Record<number, string> = { 11: 'https://example.com/x', 12: 'https://other.test/' };
  const settingsStore: Record<string, unknown> = {};
  const sessionStore: Record<string, unknown> = {};
  const calls: string[] = [];
  const badges: { tabId?: number; text: string }[] = [];
  const icons: { tabId?: number; gray: boolean }[] = [];
  let registered: { id: string }[] = options.initialRegistered ?? [];

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
    action: {
      setBadgeText: async (d: { tabId?: number; text: string }) => {
        if (options.badgeError !== undefined) throw new Error(options.badgeError);
        badges.push(d);
      },
      setBadgeBackgroundColor: async () => {},
      setIcon: async (d: { tabId?: number; path: Record<number, string> }) => {
        icons.push({ tabId: d.tabId, gray: String(d.path[16]).includes('gray') });
      },
    },
    tabs: {
      get: async (tabId: number) => {
        if (!(tabId in tabUrls)) throw new Error(`No tab with id: ${tabId}.`);
        return { url: tabUrls[tabId] };
      },
      list: async () => Object.entries(tabUrls).map(([id, url]) => ({ id: Number(id), url })),
    },
    scripting: {
      getRegisteredContentScripts: async () => registered,
      registerContentScripts: async (s: { id: string }[]) => {
        if (options.registerError !== undefined) throw new Error(options.registerError);
        calls.push(`register:${s.map((x) => x.id).join(',')}`);
        await yieldIfTracing();
        registered = [...registered, ...s.map((x) => ({ id: x.id }))];
        if (options.traceAsync === true) calls.push('register:end');
      },
      updateContentScripts: async () => {
        calls.push('update');
        await yieldIfTracing();
        if (options.traceAsync === true) calls.push('update:end');
      },
      unregisterContentScripts: async () => {
        calls.push('unregister');
        await yieldIfTracing();
        if (options.traceAsync === true) calls.push('unregister:end');
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

  /** 同步链上有多个 await，单次让出不够；反复让出直到副作用落定。 */
  const settle = async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  return { env, fire, settle, calls, badges, icons, sessionStore, tabUrls };
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
    // 冷启动自检本身会同步一次，所以断言的是「这个事件之后没有新增调用」，
    // 而不是「一条调用都没有」。
    const { env, fire, settle, calls } = fakeEnv();
    installListeners(env);
    await settle();
    const before = calls.length;
    await fire('onStorageChanged', {}, 'session');
    expect(calls).toHaveLength(before);
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
    const { env, fire, badges, sessionStore } = fakeEnv();
    installListeners(env);
    await fire('onMessage', { source: BLOCK_EVENT_SOURCE, api: 'RTCPeerConnection' }, { tab: { id: 11 } });
    badges.length = 0;
    await fire('onTabUpdated', 11, { status: 'loading' });
    // 导航后这个标签页会被按状态重画若干次，断言看最后一次：计数已清、角标随之为空。
    expect(counterKey(11) in sessionStore).toBe(false);
    expect(badges.at(-1)).toEqual({ tabId: 11, text: '' });
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

describe('Service Worker 冷启动自检', () => {
  it('注册丢失时，不等任何事件就补回来', async () => {
    // onInstalled 只在安装/更新时触发，onStartup 只在浏览器启动时触发——
    // 「扩展被禁用后重新启用」两个都不会来，注册若在此期间丢了就再也补不回来，
    // 而且不会有任何报错：popup 照常显示「已拦截」，其实什么都没拦。
    const { env, settle, calls } = fakeEnv({ initialRegistered: [] });
    installListeners(env);
    await settle();
    expect(calls).toContain(`register:${RTC_SCRIPT_ID}`);
  });

  it('注册齐全时只读不写——每次唤醒都无条件重注册的代价太大', async () => {
    const { env, settle, calls } = fakeEnv({ initialRegistered: [{ id: RTC_SCRIPT_ID }] });
    installListeners(env);
    await settle();
    expect(calls).toEqual([]);
  });

  it('残留了不该在的注册时同样会修', async () => {
    const { env, settle, calls } = fakeEnv({
      initialRegistered: [{ id: RTC_SCRIPT_ID }, { id: 'stale-from-old-version' }],
    });
    installListeners(env);
    await settle();
    expect(calls).toContain('unregister');
  });
});

describe('popup 发起的同步请求', () => {
  const fromPopup = {}; // 扩展自身页面发来的消息没有 tab 上下文

  it('应答里带回的是这次同步的结果，而不是上一次留下的记录', async () => {
    const { env, fire, settle } = fakeEnv();
    installListeners(env);
    await settle();
    const answered = new Promise((resolve) => {
      void fire('onMessage', createSyncRequest(), fromPopup, resolve);
    });
    expect(await answered).toEqual({ error: null });
  });

  it('这次同步失败时如实带回失败原因', async () => {
    const { env, fire, settle } = fakeEnv({ registerError: '非法的 match pattern' });
    installListeners(env);
    await settle();
    const answered = new Promise((resolve) => {
      void fire('onMessage', createSyncRequest(), fromPopup, resolve);
    });
    expect(await answered).toEqual({ error: '非法的 match pattern' });
  });

  it('带 tab 上下文的同步请求被忽略——这条通道只对扩展自己开放', async () => {
    const { env, fire, settle, calls } = fakeEnv({ initialRegistered: [{ id: RTC_SCRIPT_ID }] });
    installListeners(env);
    await settle();
    let answered = false;
    await fire('onMessage', createSyncRequest(), { tab: { id: 7 } }, () => {
      answered = true;
    });
    await settle();
    expect(answered).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('同步的串行化', () => {
  it('两次同步不会交叠——reconcile 读的必须是上一次改完之后的状态', async () => {
    // 交叠的后果是实打实的：后一次读到前一次改到一半的注册状态，
    // 轻则重复注册同一个 id 被 Chrome 拒绝（报出一个并不存在的失败），
    // 重则把前一次刚注册好的脚本当成多余的注销掉。
    const { env, fire, settle, calls } = fakeEnv({
      initialRegistered: [{ id: RTC_SCRIPT_ID }],
      traceAsync: true,
    });
    installListeners(env);
    await settle();

    void fire('onStorageChanged', {}, 'local');
    void fire('onStorageChanged', {}, 'local');
    await settle();

    const updates = calls.filter((c) => c.startsWith('update'));
    expect(updates).toEqual(['update', 'update:end', 'update', 'update:end']);
  });
});

describe('工具栏状态', () => {
  it('默认设置下是彩色图标：这个标签页正在被保护', async () => {
    const { env, settle, icons, badges } = fakeEnv();
    installListeners(env);
    await settle();
    expect(icons.at(-1)?.gray).toBe(false);
    // 「正在拦」且还没拦到东西，角标留空——正常状态不该在工具栏上持续喊话。
    expect(badges.at(-1)?.text).toBe('');
  });

  it('总开关关闭后，每个标签页都换成灰图标 + OFF', async () => {
    const { env, fire, settle, icons, badges } = fakeEnv();
    env.settingsArea.set({ enabled: false });
    installListeners(env);
    await settle();
    icons.length = 0;
    badges.length = 0;
    await fire('onStorageChanged', {}, 'local');
    await settle();
    expect(icons.every((i) => i.gray)).toBe(true);
    expect(new Set(badges.map((b) => b.text))).toEqual(new Set(['OFF']));
    // 假环境里有两个标签页，两个都要重画——设置是全局的。
    expect(new Set(badges.map((b) => b.tabId))).toEqual(new Set([11, 12]));
  });

  it('白名单站点是灰图标 + 破折号，与「总开关关了」区分得开', async () => {
    const { env, settle, icons, badges } = fakeEnv();
    env.settingsArea.set({ whitelist: ['example.com'] });
    installListeners(env);
    await settle();
    const tab11 = badges.filter((b) => b.tabId === 11).at(-1);
    const tab12 = badges.filter((b) => b.tabId === 12).at(-1);
    expect(tab11?.text).toBe('—');
    expect(tab12?.text).toBe('');
    expect(icons.filter((i) => i.tabId === 11).at(-1)?.gray).toBe(true);
    expect(icons.filter((i) => i.tabId === 12).at(-1)?.gray).toBe(false);
  });

  it('注入不了的页面是灰图标 + 空角标，不能写成 OFF', async () => {
    // 写 OFF 会被读成「是我关的开关」，而那类页面开着也一样不工作。
    const { env, fire, settle, icons, badges, tabUrls } = fakeEnv();
    tabUrls[11] = 'chrome://extensions/';
    installListeners(env);
    await settle();
    icons.length = 0;
    badges.length = 0;
    await fire('onTabUpdated', 11, { status: 'complete' });
    expect(icons.at(-1)?.gray).toBe(true);
    expect(badges.at(-1)?.text).toBe('');
  });

  it('拦到东西后角标显示计数', async () => {
    const { env, fire, settle, badges } = fakeEnv();
    installListeners(env);
    await settle();
    await fire('onMessage', { source: BLOCK_EVENT_SOURCE, api: 'RTCPeerConnection' }, { tab: { id: 11 } });
    await settle();
    expect(badges.at(-1)).toEqual({ tabId: 11, text: '1' });
  });

  it('重画途中某个标签页恰好关闭，不该连累其余标签页', async () => {
    // 列出标签页与逐个重画之间总有时间差，Chrome 会以 `No tab with id: N.` 拒绝。
    // 这是每关一个标签页就可能发生一次的事，不能让它把整轮重画中断掉。
    const { env, fire, settle, badges } = fakeEnv();
    installListeners(env);
    await settle();
    const original = env.action.setIcon;
    env.action.setIcon = async (d: { tabId?: number; path: Record<number, string> }) => {
      if (d.tabId === 11) throw new Error('No tab with id: 11.');
      return original(d);
    };
    badges.length = 0;
    await fire('onStorageChanged', {}, 'local');
    await settle();
    expect(badges.map((b) => b.tabId)).toContain(12);
    expect(badges.map((b) => b.tabId)).not.toContain(11);
  });
});
