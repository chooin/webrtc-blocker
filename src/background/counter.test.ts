import { badgeText, counterKey, forgetTab, readCount, recordBlock, resetTab } from './counter';

function fakeDeps(initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...initial };
  const badges: { tabId?: number; text: string }[] = [];
  return {
    store,
    badges,
    deps: {
      session: {
        get: async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const key of list) {
            if (key in store) out[key] = store[key];
          }
          return out;
        },
        set: async (items: Record<string, unknown>) => {
          Object.assign(store, items);
        },
        remove: async (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
        },
      },
      badge: {
        setBadgeText: async (details: { tabId?: number; text: string }) => {
          badges.push(details);
        },
      },
    },
  };
}

describe('badgeText', () => {
  it('零次时不显示角标', () => {
    expect(badgeText(0)).toBe('');
    expect(badgeText(-1)).toBe('');
  });

  it('正常数字直接显示', () => {
    expect(badgeText(7)).toBe('7');
  });

  it('超过角标可容纳的宽度后收敛为 999+', () => {
    expect(badgeText(999)).toBe('999');
    expect(badgeText(1000)).toBe('999+');
  });
});

describe('recordBlock', () => {
  it('从零开始累加并写入角标', async () => {
    const { deps, badges, store } = fakeDeps();
    await expect(recordBlock(3, deps)).resolves.toBe(1);
    expect(store[counterKey(3)]).toBe(1);
    expect(badges).toEqual([{ tabId: 3, text: '1' }]);
  });

  it('多次拦截持续累加', async () => {
    const { deps } = fakeDeps();
    await recordBlock(3, deps);
    await expect(recordBlock(3, deps)).resolves.toBe(2);
  });

  it('不同标签页各自计数，互不干扰', async () => {
    const { deps } = fakeDeps();
    await recordBlock(1, deps);
    await recordBlock(2, deps);
    await expect(readCount(1, deps.session)).resolves.toBe(1);
    await expect(readCount(2, deps.session)).resolves.toBe(1);
  });

  it('存储里的脏值按 0 处理，不产生 NaN', async () => {
    const { deps } = fakeDeps({ [counterKey(9)]: 'oops' });
    await expect(recordBlock(9, deps)).resolves.toBe(1);
  });
});

describe('readCount / resetTab', () => {
  it('没有记录时读到 0', async () => {
    const { deps } = fakeDeps();
    await expect(readCount(42, deps.session)).resolves.toBe(0);
  });

  it('重置会删除记录并清空角标', async () => {
    const { deps, store, badges } = fakeDeps();
    await recordBlock(5, deps);
    badges.length = 0;
    await resetTab(5, deps);
    expect(counterKey(5) in store).toBe(false);
    expect(badges).toEqual([{ tabId: 5, text: '' }]);
  });
});

describe('forgetTab', () => {
  it('只清存储，不接触角标', async () => {
    const { deps, store } = fakeDeps();
    await recordBlock(5, deps);
    await forgetTab(5, deps.session);
    expect(counterKey(5) in store).toBe(false);
  });

  // 标签页关闭后 setBadgeText 必然被 Chrome 以 `No tab with id: N.` 拒绝。
  // forgetTab 的签名里根本没有 BadgeLike，这里再用一个只会报错的角标做一次实证。
  it('角标接口一调用就报错时，清理依旧成功', async () => {
    const { deps, store } = fakeDeps();
    await recordBlock(5, deps);
    deps.badge.setBadgeText = async () => {
      throw new Error('No tab with id: 5.');
    };
    await expect(forgetTab(5, deps.session)).resolves.toBeUndefined();
    expect(counterKey(5) in store).toBe(false);
  });

  it('没有记录时也不报错', async () => {
    const { deps } = fakeDeps();
    await expect(forgetTab(404, deps.session)).resolves.toBeUndefined();
  });
});
