// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Settings } from '../core/types';
import { App, type PopupApi } from './App';

function fakeApi(overrides: Partial<Settings> = {}, host = 'example.com', count = 0) {
  let settings: Settings = { enabled: true, blockMedia: false, whitelist: [], ...overrides };
  const saved: Partial<Settings>[] = [];
  const api: PopupApi = {
    getSettings: async () => settings,
    saveSettings: async (patch) => {
      saved.push(patch);
      settings = { ...settings, ...patch };
      return settings;
    },
    getActiveHost: async () => host,
    getBlockedCount: async () => count,
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
