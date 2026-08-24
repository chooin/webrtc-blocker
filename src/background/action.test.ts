import { badgeText, refreshAction } from './action';
import { COLOR_ICON_FILES, GRAY_ICON_FILES } from '../core/icon-files';

function fakeAction() {
  const calls: { icon?: Record<number, string>; color?: string; text?: string } = {};
  const order: string[] = [];
  const action = {
    setIcon: async (d: { path: Record<number, string> }) => {
      calls.icon = d.path;
      order.push('icon');
    },
    setBadgeBackgroundColor: async (d: { color: string }) => {
      calls.color = d.color;
      order.push('color');
    },
    setBadgeText: async (d: { text: string }) => {
      calls.text = d.text;
      order.push('text');
    },
  };
  return { deps: { action }, calls, order };
}

describe('badgeText', () => {
  it('没拦到东西时不显示角标', () => {
    expect(badgeText(0)).toBe('');
    expect(badgeText(-1)).toBe('');
  });

  it('超过三位数收敛成 999+，避免被角标宽度截断', () => {
    expect(badgeText(999)).toBe('999');
    expect(badgeText(1000)).toBe('999+');
  });
});

describe('refreshAction', () => {
  it('正在拦：彩色图标，角标留给拦截计数', async () => {
    const { deps, calls } = fakeAction();
    await refreshAction(1, 'blocking', 7, deps);
    expect(calls.icon).toEqual({ ...COLOR_ICON_FILES });
    expect(calls.text).toBe('7');
  });

  it('正在拦且还没拦到东西：角标是空的——正常状态不该在工具栏上持续喊话', async () => {
    const { deps, calls } = fakeAction();
    await refreshAction(1, 'blocking', 0, deps);
    expect(calls.icon).toEqual({ ...COLOR_ICON_FILES });
    expect(calls.text).toBe('');
  });

  it('总开关关闭：灰图标 + OFF', async () => {
    const { deps, calls } = fakeAction();
    await refreshAction(1, 'disabled', 0, deps);
    expect(calls.icon).toEqual({ ...GRAY_ICON_FILES });
    expect(calls.text).toBe('OFF');
  });

  it('本站在白名单：灰图标 + 破折号', async () => {
    const { deps, calls } = fakeAction();
    await refreshAction(1, 'allowed', 0, deps);
    expect(calls.icon).toEqual({ ...GRAY_ICON_FILES });
    expect(calls.text).toBe('—');
  });

  it('注入不了的页面：灰图标但角标为空，不能写 OFF', async () => {
    // 写 OFF 会被读成「是我关的开关」，而那类页面开着也一样不工作。
    const { deps, calls } = fakeAction();
    await refreshAction(1, 'inapplicable', 0, deps);
    expect(calls.icon).toEqual({ ...GRAY_ICON_FILES });
    expect(calls.text).toBe('');
  });

  it('没在保护的状态共用中性灰，与「正在拦」的绿区分开', async () => {
    const blocking = fakeAction();
    await refreshAction(1, 'blocking', 1, blocking.deps);
    const off = fakeAction();
    await refreshAction(1, 'disabled', 0, off.deps);
    expect(blocking.calls.color).not.toBe(off.calls.color);
  });

  it('先写底色再写文字，否则会闪一下「新文字配旧底色」', async () => {
    const { deps, order } = fakeAction();
    await refreshAction(1, 'disabled', 0, deps);
    expect(order.indexOf('color')).toBeLessThan(order.indexOf('text'));
  });
});
