import {
  SYNC_ERROR_KEY,
  clearSyncError,
  errorMessage,
  readSyncError,
  recordSyncError,
} from './sync-error';

function fakeArea(initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...initial };
  return {
    store,
    area: {
      get: async (keys: string | string[]) => {
        const out: Record<string, unknown> = {};
        for (const key of Array.isArray(keys) ? keys : [keys]) {
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

describe('errorMessage', () => {
  it('取 Error 的 message', () => {
    expect(errorMessage(new Error('registerContentScripts 被拒绝'))).toBe(
      'registerContentScripts 被拒绝',
    );
  });

  it('抛出来的不是 Error 时也要给出人话', () => {
    expect(errorMessage('裸字符串')).toBe('裸字符串');
    expect(errorMessage(undefined)).toBe('undefined');
    expect(errorMessage(new Error(''))).toBe('Error');
  });
});

describe('recordSyncError / readSyncError / clearSyncError', () => {
  it('记录后能原样读回', async () => {
    const { area } = fakeArea();
    await recordSyncError(area, new Error('匹配模式非法'));
    await expect(readSyncError(area)).resolves.toBe('匹配模式非法');
  });

  it('同时记下发生时间，便于判断新旧', async () => {
    const { area, store } = fakeArea();
    await recordSyncError(area, new Error('x'));
    expect(typeof (store[SYNC_ERROR_KEY] as { at?: unknown }).at).toBe('number');
  });

  it('清除后读回 null', async () => {
    const { area } = fakeArea();
    await recordSyncError(area, new Error('x'));
    await clearSyncError(area);
    await expect(readSyncError(area)).resolves.toBeNull();
  });

  it('没有记录时读回 null', async () => {
    const { area } = fakeArea();
    await expect(readSyncError(area)).resolves.toBeNull();
  });

  it('存储里的脏数据一律当作没有错误，绝不把 popup 弄崩', async () => {
    for (const dirty of ['字符串', 42, null, {}, { message: 7 }, { message: '' }]) {
      const { area } = fakeArea({ [SYNC_ERROR_KEY]: dirty });
      await expect(readSyncError(area)).resolves.toBeNull();
    }
  });
});
