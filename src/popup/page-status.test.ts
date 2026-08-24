import { pageStatus } from './page-status';

describe('pageStatus', () => {
  it('该拦、且实测确实拦住了，才叫已拦截', () => {
    expect(pageStatus(true, true)).toBe('blocked');
  });

  it('该放行、且实测确实没拦，才叫已放行', () => {
    expect(pageStatus(false, false)).toBe('allowed');
  });

  it('该拦却没拦住：这是设置改了但页面还没重新加载', () => {
    // 这正是此前 popup 谎称「已拦截」的那一格：设置刚打开，
    // 当前页面是在打开之前加载的，补丁根本没进去。
    expect(pageStatus(true, false)).toBe('stale');
  });

  it('该放行却还拦着：同样是没重新加载，只是方向相反', () => {
    expect(pageStatus(false, true)).toBe('stale');
  });

  it('探测不出结果时如实说无法确认，不许倒向任何一边', () => {
    expect(pageStatus(true, null)).toBe('unknown');
    expect(pageStatus(false, null)).toBe('unknown');
  });
});
