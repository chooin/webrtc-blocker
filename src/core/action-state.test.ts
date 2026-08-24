import type { Settings } from './types';
import { actionState } from './action-state';

const settings = (over: Partial<Settings> = {}): Settings => ({
  enabled: true,
  blockMedia: false,
  whitelist: [],
  ...over,
});

describe('actionState', () => {
  it('开关开着且不在白名单：正在拦', () => {
    expect(actionState(settings(), 'example.com')).toBe('blocking');
  });

  it('总开关关闭：没在拦', () => {
    expect(actionState(settings({ enabled: false }), 'example.com')).toBe('disabled');
  });

  it('本站在白名单：放行', () => {
    expect(actionState(settings({ whitelist: ['example.com'] }), 'example.com')).toBe('allowed');
  });

  it('子域也算在白名单里', () => {
    expect(actionState(settings({ whitelist: ['example.com'] }), 'a.example.com')).toBe('allowed');
  });

  it('相似域名不算——evilexample.com 不该被 example.com 放行', () => {
    expect(actionState(settings({ whitelist: ['example.com'] }), 'evilexample.com')).toBe(
      'blocking',
    );
  });

  it('注入不了的页面（host 为空）单独一档，不能报成正在拦', () => {
    // chrome:// 这类页面上扩展本来就不工作。显示「正在拦」是撒谎。
    expect(actionState(settings(), '')).toBe('inapplicable');
  });

  it('注入不了的页面优先于总开关状态——那里开关开着也一样不工作', () => {
    // 报 OFF 会让人以为是自己关的，其实是这类页面本就注入不进去。
    expect(actionState(settings({ enabled: false }), '')).toBe('inapplicable');
  });

  it('总开关关闭优先于白名单：此时白名单没有意义', () => {
    expect(actionState(settings({ enabled: false, whitelist: ['example.com'] }), 'example.com')).toBe(
      'disabled',
    );
  });
});
