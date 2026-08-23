import type { Settings } from './types';
import {
  MEDIA_SCRIPT_ID,
  RTC_SCRIPT_ID,
  desiredRegistrations,
  ipHandlingPolicy,
  reconcile,
} from './policy';

function settings(patch: Partial<Settings> = {}): Settings {
  return { enabled: true, blockMedia: false, whitelist: [], ...patch };
}

describe('ipHandlingPolicy', () => {
  it('总开关关闭时恢复浏览器默认，不留副作用', () => {
    expect(ipHandlingPolicy(settings({ enabled: false }))).toBe('default');
  });

  it('启用且白名单为空时用最严档', () => {
    expect(ipHandlingPolicy(settings())).toBe('disable_non_proxied_udp');
  });

  it('启用且白名单非空时降到中档，否则白名单站点自己也连不上', () => {
    expect(ipHandlingPolicy(settings({ whitelist: ['a.com'] }))).toBe(
      'default_public_interface_only',
    );
  });

  it('关闭时即使有白名单也回到默认', () => {
    expect(ipHandlingPolicy(settings({ enabled: false, whitelist: ['a.com'] }))).toBe('default');
  });
});

describe('desiredRegistrations', () => {
  it('总开关关闭时不注册任何脚本', () => {
    expect(desiredRegistrations(settings({ enabled: false }))).toEqual([]);
  });

  it('默认只注册 rtc-blocker', () => {
    expect(desiredRegistrations(settings()).map((s) => s.id)).toEqual([RTC_SCRIPT_ID]);
  });

  it('打开媒体开关后追加 media-blocker', () => {
    expect(desiredRegistrations(settings({ blockMedia: true })).map((s) => s.id)).toEqual([
      RTC_SCRIPT_ID,
      MEDIA_SCRIPT_ID,
    ]);
  });

  it('关闭总开关时媒体开关不起作用', () => {
    expect(desiredRegistrations(settings({ enabled: false, blockMedia: true }))).toEqual([]);
  });

  it('每条注册都带上封堵 iframe 逃逸所需的字段', () => {
    const [spec] = desiredRegistrations(settings());
    expect(spec).toMatchObject({
      matches: ['<all_urls>'],
      runAt: 'document_start',
      allFrames: true,
      matchOriginAsFallback: true,
      world: 'MAIN',
      persistAcrossSessions: true,
    });
  });

  it('白名单转成 excludeMatches', () => {
    const [spec] = desiredRegistrations(settings({ whitelist: ['a.com'] }));
    expect(spec?.excludeMatches).toEqual(['*://a.com/*', '*://*.a.com/*']);
  });

  it('两个脚本共用同一份 excludeMatches', () => {
    const specs = desiredRegistrations(settings({ blockMedia: true, whitelist: ['a.com'] }));
    expect(specs[0]?.excludeMatches).toEqual(specs[1]?.excludeMatches);
  });
});

describe('reconcile', () => {
  it('首次同步：全部走 register', () => {
    const desired = desiredRegistrations(settings());
    const plan = reconcile([], desired);
    expect(plan.register.map((s) => s.id)).toEqual([RTC_SCRIPT_ID]);
    expect(plan.update).toEqual([]);
    expect(plan.unregister).toEqual([]);
  });

  it('已注册的走 update', () => {
    const desired = desiredRegistrations(settings());
    const plan = reconcile([RTC_SCRIPT_ID], desired);
    expect(plan.register).toEqual([]);
    expect(plan.update.map((s) => s.id)).toEqual([RTC_SCRIPT_ID]);
  });

  it('关闭总开关后把现有注册全部注销', () => {
    const plan = reconcile([RTC_SCRIPT_ID, MEDIA_SCRIPT_ID], []);
    expect(plan.unregister.sort()).toEqual([MEDIA_SCRIPT_ID, RTC_SCRIPT_ID].sort());
  });

  it('清理扩展更新后残留的陌生注册', () => {
    const plan = reconcile(['stale-from-old-version'], desiredRegistrations(settings()));
    expect(plan.unregister).toEqual(['stale-from-old-version']);
    expect(plan.register.map((s) => s.id)).toEqual([RTC_SCRIPT_ID]);
  });

  it('关掉媒体开关时只注销 media-blocker', () => {
    const plan = reconcile([RTC_SCRIPT_ID, MEDIA_SCRIPT_ID], desiredRegistrations(settings()));
    expect(plan.unregister).toEqual([MEDIA_SCRIPT_ID]);
    expect(plan.update.map((s) => s.id)).toEqual([RTC_SCRIPT_ID]);
  });
});
