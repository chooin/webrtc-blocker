import { DEFAULT_SETTINGS, getSettings, mergeSettings, saveSettings } from './settings';

function fakeArea(initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...initial };
  return {
    store,
    get: async () => ({ ...store }),
    set: async (items: Record<string, unknown>) => {
      Object.assign(store, items);
    },
  };
}

describe('mergeSettings', () => {
  it('空存储回落到默认值：默认拦截 WebRTC、不拦媒体', () => {
    expect(mergeSettings({})).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toEqual({ enabled: true, blockMedia: false, whitelist: [] });
  });

  it('非布尔值的开关回落到默认，绝不静默变成"关闭"', () => {
    expect(mergeSettings({ enabled: 'nope' }).enabled).toBe(true);
    expect(mergeSettings({ blockMedia: 1 }).blockMedia).toBe(false);
  });

  it('保留合法的显式取值', () => {
    expect(mergeSettings({ enabled: false, blockMedia: true })).toMatchObject({
      enabled: false,
      blockMedia: true,
    });
  });

  it('白名单被归一、去重、排序，非字符串项被丢弃', () => {
    expect(mergeSettings({ whitelist: ['B.com', 'b.com:443', 42, '  ', 'a.com'] }).whitelist).toEqual(
      ['a.com', 'b.com'],
    );
  });

  it('白名单不是数组时回落到空数组', () => {
    expect(mergeSettings({ whitelist: 'a.com' }).whitelist).toEqual([]);
  });
});

describe('getSettings / saveSettings', () => {
  it('从存储读出并合并', async () => {
    const area = fakeArea({ enabled: false });
    await expect(getSettings(area)).resolves.toMatchObject({ enabled: false, blockMedia: false });
  });

  it('保存后返回合并结果，并只写入完整的三个字段', async () => {
    const area = fakeArea();
    const next = await saveSettings(area, { blockMedia: true });
    expect(next).toEqual({ enabled: true, blockMedia: true, whitelist: [] });
    expect(Object.keys(area.store).sort()).toEqual(['blockMedia', 'enabled', 'whitelist']);
  });

  it('部分更新不覆盖其他字段', async () => {
    const area = fakeArea({ enabled: false, whitelist: ['a.com'] });
    const next = await saveSettings(area, { blockMedia: true });
    expect(next).toEqual({ enabled: false, blockMedia: true, whitelist: ['a.com'] });
  });
});
