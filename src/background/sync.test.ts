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

  /**
   * 脚本注册被 Chrome 拒绝，恰恰是最需要网络层兜底的时刻。
   * 若在这里提前 return，第一道和第二道防线会一起消失。
   */
  it('脚本注册失败时仍然下发 IP 策略，并把失败继续抛出去', async () => {
    const { calls, deps } = fakeDeps();
    deps.scripting.registerContentScripts = async () => {
      throw new Error('PARSE_ERROR_INVALID_HOST_WILDCARD');
    };
    await expect(syncBlocking(settings(), deps)).rejects.toThrow(
      'PARSE_ERROR_INVALID_HOST_WILDCARD',
    );
    expect(calls).toContain('ip:disable_non_proxied_udp');
  });

  it('IP 策略自己失败时也会抛出去，不会被静默吞掉', async () => {
    const { deps } = fakeDeps();
    deps.ipPolicy.set = async () => {
      throw new Error('privacy 权限被撤销');
    };
    await expect(syncBlocking(settings(), deps)).rejects.toThrow('privacy 权限被撤销');
  });

  it('两处都失败时优先报出更接近根因的注册失败', async () => {
    const { deps } = fakeDeps();
    deps.scripting.registerContentScripts = async () => {
      throw new Error('注册失败');
    };
    deps.ipPolicy.set = async () => {
      throw new Error('IP 策略失败');
    };
    await expect(syncBlocking(settings(), deps)).rejects.toThrow('注册失败');
  });
});
