import type { Settings } from '../core/types';
import { MEDIA_SCRIPT_ID, RTC_SCRIPT_ID } from '../core/policy';
import { syncBlocking } from './sync';

function settings(patch: Partial<Settings> = {}): Settings {
  return { enabled: true, blockMedia: false, whitelist: [], ...patch };
}

function fakeDeps(currentIds: string[] = []) {
  const calls: string[] = [];
  let registered = currentIds.map((id) => ({ id }));
  const scripting = {
    getRegisteredContentScripts: async () => registered,
    registerContentScripts: async (scripts: { id: string }[]) => {
      calls.push(`register:${scripts.map((s) => s.id).join(',')}`);
      registered = [...registered, ...scripts.map((s) => ({ id: s.id }))];
    },
    updateContentScripts: async (scripts: { id: string }[]) => {
      calls.push(`update:${scripts.map((s) => s.id).join(',')}`);
    },
    unregisterContentScripts: async (filter: { ids: string[] }) => {
      calls.push(`unregister:${filter.ids.join(',')}`);
      registered = registered.filter((s) => !filter.ids.includes(s.id));
    },
  };
  const ipPolicy = {
    set: async (details: { value: string }) => {
      calls.push(`ip:${details.value}`);
    },
  };
  return { calls, deps: { scripting, ipPolicy } };
}

describe('syncBlocking', () => {
  it('首次同步注册 rtc-blocker 并设成最严 IP 策略', async () => {
    const { calls, deps } = fakeDeps();
    await syncBlocking(settings(), deps);
    expect(calls).toEqual([`register:${RTC_SCRIPT_ID}`, 'ip:disable_non_proxied_udp']);
  });

  it('注销必须排在注册之前，否则复用同一 id 会失败', async () => {
    const { calls, deps } = fakeDeps(['stale']);
    await syncBlocking(settings(), deps);
    expect(calls.indexOf('unregister:stale')).toBeLessThan(calls.indexOf(`register:${RTC_SCRIPT_ID}`));
  });

  it('已注册的走 update 而不是重复 register', async () => {
    const { calls, deps } = fakeDeps([RTC_SCRIPT_ID]);
    await syncBlocking(settings(), deps);
    expect(calls).toContain(`update:${RTC_SCRIPT_ID}`);
    expect(calls.some((c) => c.startsWith('register:'))).toBe(false);
  });

  it('打开媒体开关后追加注册 media-blocker', async () => {
    const { calls, deps } = fakeDeps([RTC_SCRIPT_ID]);
    await syncBlocking(settings({ blockMedia: true }), deps);
    expect(calls).toContain(`register:${MEDIA_SCRIPT_ID}`);
  });

  it('关闭总开关时注销全部脚本并把 IP 策略恢复默认', async () => {
    const { calls, deps } = fakeDeps([RTC_SCRIPT_ID, MEDIA_SCRIPT_ID]);
    await syncBlocking(settings({ enabled: false }), deps);
    expect(calls).toContain(`unregister:${RTC_SCRIPT_ID},${MEDIA_SCRIPT_ID}`);
    expect(calls).toContain('ip:default');
  });

  it('无事可做时不调用任何 scripting 写接口，但仍会同步 IP 策略', async () => {
    const { calls, deps } = fakeDeps();
    await syncBlocking(settings({ enabled: false }), deps);
    expect(calls).toEqual(['ip:default']);
  });

  it('白名单非空时 IP 策略降到中档', async () => {
    const { calls, deps } = fakeDeps();
    await syncBlocking(settings({ whitelist: ['a.com'] }), deps);
    expect(calls).toContain('ip:default_public_interface_only');
  });
});
