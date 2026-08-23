// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Settings } from '../core/types';
import { App, type PopupApi } from './App';

function fakeApi(
  overrides: Partial<Settings> = {},
  host = 'example.com',
  count = 0,
  // 大多数用例只关心一个固定值；「保存后同步状态是否变化」这类用例
  // 需要在多次调用间返回不同结果，故也接受一个取值函数。
  syncError: string | null | (() => string | null) = null,
) {
  let settings: Settings = { enabled: true, blockMedia: false, whitelist: [], ...overrides };
  const saved: Partial<Settings>[] = [];
  const readSyncError = typeof syncError === 'function' ? syncError : () => syncError;
  const api: PopupApi = {
    getSettings: async () => settings,
    saveSettings: async (patch) => {
      saved.push(patch);
      settings = { ...settings, ...patch };
      return settings;
    },
    getActiveHost: async () => host,
    getBlockedCount: async () => count,
    getSyncError: async () => readSyncError(),
  };
  return { api, saved, current: () => settings };
}

describe('App', () => {
  it('展示当前站点域名', async () => {
    const { api } = fakeApi();
    render(<App api={api} />);
    expect(await screen.findByText('example.com')).toBeTruthy();
  });

  it('默认状态显示该站点已被拦截', async () => {
    const { api } = fakeApi();
    render(<App api={api} />);
    expect(await screen.findByText('已拦截')).toBeTruthy();
  });

  it('站点在白名单中时显示已放行', async () => {
    const { api } = fakeApi({ whitelist: ['example.com'] });
    render(<App api={api} />);
    expect(await screen.findByText('已放行')).toBeTruthy();
  });

  it('总开关关闭时也显示已放行', async () => {
    const { api } = fakeApi({ enabled: false });
    render(<App api={api} />);
    expect(await screen.findByText('已放行')).toBeTruthy();
  });

  it('切换总开关会写入设置', async () => {
    const { api, saved } = fakeApi();
    render(<App api={api} />);
    await userEvent.click(await screen.findByLabelText('启用 WebRTC 拦截'));
    await waitFor(() => expect(saved).toContainEqual({ enabled: false }));
  });

  it('切换媒体开关会写入设置', async () => {
    const { api, saved } = fakeApi();
    render(<App api={api} />);
    await userEvent.click(await screen.findByLabelText('同时拦截摄像头与麦克风'));
    await waitFor(() => expect(saved).toContainEqual({ blockMedia: true }));
  });

  it('点击放行本站会把域名加入白名单', async () => {
    const { api, current } = fakeApi();
    render(<App api={api} />);
    await userEvent.click(await screen.findByRole('button', { name: '放行本站' }));
    await waitFor(() => expect(current().whitelist).toEqual(['example.com']));
  });

  it('已放行时按钮变为恢复拦截，点击后移出白名单', async () => {
    const { api, current } = fakeApi({ whitelist: ['example.com'] });
    render(<App api={api} />);
    await userEvent.click(await screen.findByRole('button', { name: '恢复拦截本站' }));
    await waitFor(() => expect(current().whitelist).toEqual([]));
  });

  it('总开关关闭且本站不在白名单时按钮仍显示放行本站', async () => {
    const { api } = fakeApi({ enabled: false });
    render(<App api={api} />);
    expect(await screen.findByText('已放行')).toBeTruthy();
    expect(await screen.findByRole('button', { name: '放行本站' })).toBeTruthy();
  });

  it('展示本页拦截次数', async () => {
    const { api } = fakeApi({}, 'example.com', 7);
    render(<App api={api} />);
    expect(await screen.findByText('7')).toBeTruthy();
  });

  it('无法取得当前站点时不渲染白名单按钮', async () => {
    const { api } = fakeApi({}, '');
    render(<App api={api} />);
    // 必须先等载入完成再断言，否则"还在显示载入中"也会让这条用例通过，等于没测到。
    await screen.findByLabelText('启用 WebRTC 拦截');
    expect(screen.queryByRole('button', { name: '放行本站' })).toBeNull();
  });
});

/**
 * popup 的拦截状态是从设置推导的。注册同步失败时扩展其实没有在拦截，
 * 而界面会照常显示「已拦截」——静默失败叠加错误汇报是最坏的一种状态。
 * 这一组用例保证那种状态一定会被摆到用户面前。
 */
describe('App 的失败提示', () => {
  it('注册同步失败时给出显眼的警告横幅', async () => {
    const { api } = fakeApi({}, 'example.com', 0, 'PARSE_ERROR_INVALID_HOST_WILDCARD');
    render(<App api={api} />);
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain('拦截未生效');
    expect(banner.textContent).toContain('PARSE_ERROR_INVALID_HOST_WILDCARD');
  });

  it('没有失败时不出现警告横幅', async () => {
    const { api } = fakeApi();
    render(<App api={api} />);
    // 同样要先等载入完成，否则"还在载入"也能让断言通过。
    await screen.findByLabelText('启用 WebRTC 拦截');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('载入失败时把原因摆出来，而不是永远卡在载入中', async () => {
    const { api } = fakeApi();
    const failing: PopupApi = {
      ...api,
      getSettings: async () => {
        throw new Error('storage 读取失败');
      },
    };
    render(<App api={failing} />);
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain('storage 读取失败');
    expect(screen.queryByText('载入中…')).toBeNull();
  });

  it('保存失败时把原因摆出来，而不是只留在控制台里', async () => {
    const { api } = fakeApi();
    const failing: PopupApi = {
      ...api,
      saveSettings: async () => {
        throw new Error('storage 写入失败');
      },
    };
    render(<App api={failing} />);
    await userEvent.click(await screen.findByLabelText('启用 WebRTC 拦截'));
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain('storage 写入失败');
  });

  it('保存成功且同步问题已经解决时，警告横幅才会消失', async () => {
    // 第一次读（初始载入）报错，第二次读（保存触发的重新同步）恢复正常——
    // 横幅消失必须是"重新读到了好消息"，不能是"保存这个动作本身"。
    let calls = 0;
    const { api } = fakeApi({}, 'example.com', 0, () => (calls++ === 0 ? '旧的失败' : null));
    render(<App api={api} />);
    await screen.findByRole('alert');
    await userEvent.click(await screen.findByLabelText('同时拦截摄像头与麦克风'));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('同步失败仍未解决时，保存成功也不能把警告横幅擦掉', async () => {
    // 这是上一轮修复要堵死的那类失败：一次成功的保存悄悄抹掉了
    // 「Service Worker 注册同步失败」的红色横幅，而扩展其实什么都没拦截。
    const { api } = fakeApi({}, 'example.com', 0, '持续存在的失败');
    render(<App api={api} />);
    await screen.findByRole('alert');
    await userEvent.click(await screen.findByLabelText('同时拦截摄像头与麦克风'));
    await waitFor(() => expect(screen.queryAllByRole('alert')).not.toHaveLength(0));
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain('持续存在的失败');
  });

  it('getSyncError 读取失败不会连累整个弹窗：设置界面照常渲染', async () => {
    const { api } = fakeApi();
    const failing: PopupApi = {
      ...api,
      getSyncError: async () => {
        throw new Error('sync 状态读取失败');
      },
    };
    render(<App api={failing} />);
    expect(await screen.findByLabelText('启用 WebRTC 拦截')).toBeTruthy();
    expect(await screen.findByText('example.com')).toBeTruthy();
  });
});
