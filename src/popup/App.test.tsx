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
  // 只有少数用例关心「实测状态」与「同步请求」，单开一个可选对象，
  // 免得每个既有调用点都要补一串位置参数。
  extra: {
    /** 实测这个页面拦没拦住。省略时模拟「页面就是在当前设置下加载的」，即两者一致。 */
    pageBlocked?: boolean | null;
    /** popup 主动请求同步时的结果。省略时沿用 syncError。 */
    requestSync?: () => Promise<string | null>;
  } = {},
) {
  let settings: Settings = { enabled: true, blockMedia: false, whitelist: [], ...overrides };
  const saved: Partial<Settings>[] = [];
  const reloaded: number[] = [];
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
    requestSync: extra.requestSync ?? (async () => readSyncError()),
    isPageBlocked: async () =>
      extra.pageBlocked === undefined
        ? settings.enabled && !settings.whitelist.includes(host)
        : extra.pageBlocked,
    reloadPage: async () => {
      reloaded.push(1);
    },
  };
  return { api, saved, reloaded, current: () => settings };
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

  it('设置说要拦、但这个页面实测没被拦时，如实说需要重新加载', async () => {
    // 补丁只在文档加载时进入页面，没有追溯力：刚装上扩展、刚把开关拨回开、
    // 刚把域名移出白名单时，当前这个已经加载完的页面里根本没有补丁。
    // 此前 popup 照着设置显示「已拦截」，这正是最坏的那种状态。
    const { api } = fakeApi({}, 'example.com', 0, null, { pageBlocked: false });
    render(<App api={api} />);
    expect(await screen.findByText('需重新加载')).toBeTruthy();
    expect(screen.queryByText('已拦截')).toBeNull();
  });

  it('反过来也一样：设置已放行、页面却还拦着，同样提示重新加载', async () => {
    const { api } = fakeApi({ whitelist: ['example.com'] }, 'example.com', 0, null, {
      pageBlocked: true,
    });
    render(<App api={api} />);
    expect(await screen.findByText('需重新加载')).toBeTruthy();
    expect(screen.queryByText('已放行')).toBeNull();
  });

  it('实测还没回来时显示「检测中…」——「无法确认」是要用户警觉的状态，不能当加载占位符', async () => {
    let settle: (value: boolean | null) => void = () => {};
    const { api } = fakeApi();
    const slow: PopupApi = {
      ...api,
      isPageBlocked: () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    };
    render(<App api={slow} />);
    expect(await screen.findByText('检测中…')).toBeTruthy();
    expect(screen.queryByText('无法确认')).toBeNull();
    settle(true);
    expect(await screen.findByText('已拦截')).toBeTruthy();
  });

  it('实测不出结果时显示「无法确认」，不许谎称已拦截', async () => {
    const { api } = fakeApi({}, 'example.com', 0, null, { pageBlocked: null });
    render(<App api={api} />);
    expect(await screen.findByText('无法确认')).toBeTruthy();
    expect(screen.queryByText('已拦截')).toBeNull();
  });

  it('点「重新加载」会真的重新加载当前页', async () => {
    const { api, reloaded } = fakeApi({}, 'example.com', 0, null, { pageBlocked: false });
    render(<App api={api} />);
    await userEvent.click(await screen.findByText('重新加载'));
    await waitFor(() => expect(reloaded).toHaveLength(1));
  });

  it('保存后的横幅依据的是这次同步的结果，而不是 session 里上一次的记录', async () => {
    // 这是修掉的那个竞态：storage.onChanged 触发的同步是浮动 Promise，
    // popup 保存完立刻读 session 读到的是上一次的结果（这里是 null），
    // 于是「这次改动恰好把注册搞坏」时红条不会出现。
    const { api } = fakeApi({}, 'example.com', 0, null, {
      requestSync: async () => '注册被拒绝：非法的 match pattern',
    });
    render(<App api={api} />);
    await userEvent.click(await screen.findByLabelText('同时拦截摄像头与麦克风'));
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain('非法的 match pattern');
  });

  it('同步请求送不到 Service Worker 时说「无法确认」，不当作没问题', async () => {
    const { api } = fakeApi({}, 'example.com', 0, null, {
      requestSync: async () => {
        throw new Error('接收端不存在');
      },
    });
    render(<App api={api} />);
    await userEvent.click(await screen.findByLabelText('同时拦截摄像头与麦克风'));
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain('无法确认拦截是否生效');
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
