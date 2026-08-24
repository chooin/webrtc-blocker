import { counterKey, forgetTab, readCount, recordBlock, resetTab } from './counter';

function fakeSession(initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...initial };
  return {
    store,
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
  };
}

describe('recordBlock', () => {
  it('从零开始累加', async () => {
    const { session, store } = fakeSession();
    await expect(recordBlock(3, session)).resolves.toBe(1);
    expect(store[counterKey(3)]).toBe(1);
  });

  it('多次拦截持续累加', async () => {
    const { session } = fakeSession();
    await recordBlock(3, session);
    await expect(recordBlock(3, session)).resolves.toBe(2);
  });

  it('不同标签页各自计数，互不干扰', async () => {
    const { session } = fakeSession();
    await recordBlock(1, session);
    await recordBlock(2, session);
    await expect(readCount(1, session)).resolves.toBe(1);
    await expect(readCount(2, session)).resolves.toBe(1);
  });

  it('存储里的脏值按 0 处理，不产生 NaN', async () => {
    const { session } = fakeSession({ [counterKey(9)]: 'oops' });
    await expect(recordBlock(9, session)).resolves.toBe(1);
  });
});

describe('readCount / resetTab', () => {
  it('没有记录时读到 0', async () => {
    const { session } = fakeSession();
    await expect(readCount(42, session)).resolves.toBe(0);
  });

  it('重置只删除记录，重画交给调用方', async () => {
    const { session, store } = fakeSession();
    await recordBlock(5, session);
    await resetTab(5, session);
    expect(counterKey(5) in store).toBe(false);
  });
});

describe('forgetTab', () => {
  it('只清存储', async () => {
    const { session, store } = fakeSession();
    await recordBlock(5, session);
    await forgetTab(5, session);
    expect(counterKey(5) in store).toBe(false);
  });

  it('没有记录时也不报错', async () => {
    const { session } = fakeSession();
    await expect(forgetTab(404, session)).resolves.toBeUndefined();
  });
});
