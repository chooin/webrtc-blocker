import type { BlockedApi } from './types';
import { installRtcBlocker, installMediaBlocker } from './patch';

class FakePeerConnection {
  constructor(_config?: unknown) {}
}

function makeTarget(): Record<string, unknown> {
  const target: Record<string, unknown> = {};
  // RTCPeerConnection and webkitRTCPeerConnection with enumerable: false
  for (const key of ['RTCPeerConnection', 'webkitRTCPeerConnection']) {
    Object.defineProperty(target, key, {
      value: FakePeerConnection,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
  // RTCDataChannel with enumerable: true to test enumerable preservation in both directions
  Object.defineProperty(target, 'RTCDataChannel', {
    value: FakePeerConnection,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  return target;
}

describe('installRtcBlocker', () => {
  it('让 RTCPeerConnection 构造时抛错', () => {
    const target = makeTarget();
    installRtcBlocker(target);
    const Blocked = target.RTCPeerConnection as new () => unknown;
    expect(() => new Blocked()).toThrow();
  });

  it('同样覆盖 webkitRTCPeerConnection 与 RTCDataChannel', () => {
    const target = makeTarget();
    installRtcBlocker(target);
    for (const key of ['webkitRTCPeerConnection', 'RTCDataChannel'] as const) {
      const Blocked = target[key] as new () => unknown;
      expect(() => new Blocked()).toThrow();
    }
  });

  it('不在 target 上留下任何额外属性', () => {
    const target = makeTarget();
    const before = Object.getOwnPropertyNames(target).sort();
    installRtcBlocker(target);
    expect(Object.getOwnPropertyNames(target).sort()).toEqual(before);
  });

  it('保留原构造函数的 name 与 length，降低被特征检测的概率', () => {
    const target = makeTarget();
    installRtcBlocker(target);
    const Blocked = target.RTCPeerConnection as { name: string; length: number };
    expect(Blocked.name).toBe('FakePeerConnection');
    expect(Blocked.length).toBe(FakePeerConnection.length);
  });

  it('写入的属性不可配置、不可写，页面无法改回去', () => {
    const target = makeTarget();
    installRtcBlocker(target);
    const desc = Object.getOwnPropertyDescriptor(target, 'RTCPeerConnection');
    expect(desc?.configurable).toBe(false);
    expect(desc?.writable).toBe(false);
  });

  it('保留原属性的 enumerable 特性', () => {
    const target = makeTarget();
    installRtcBlocker(target);
    // RTCPeerConnection was enumerable: false, should stay false
    expect(Object.getOwnPropertyDescriptor(target, 'RTCPeerConnection')?.enumerable).toBe(false);
    // RTCDataChannel was enumerable: true, should stay true
    expect(Object.getOwnPropertyDescriptor(target, 'RTCDataChannel')?.enumerable).toBe(true);
  });

  it('重复调用幂等：不抛错、不二次包装', () => {
    const target = makeTarget();
    installRtcBlocker(target);
    const first = target.RTCPeerConnection;
    expect(() => installRtcBlocker(target)).not.toThrow();
    expect(target.RTCPeerConnection).toBe(first);
  });

  it('target 上缺少某个 API 时静默跳过', () => {
    const target: Record<string, unknown> = { RTCPeerConnection: FakePeerConnection };
    expect(() => installRtcBlocker(target)).not.toThrow();
    expect('webkitRTCPeerConnection' in target).toBe(false);
  });

  it('拦截发生时调用 reporter 并带上 API 名', () => {
    const target = makeTarget();
    const seen: BlockedApi[] = [];
    installRtcBlocker(target, (api) => seen.push(api));
    const Blocked = target.RTCPeerConnection as new () => unknown;
    expect(() => new Blocked()).toThrow();
    expect(seen).toEqual(['RTCPeerConnection']);
  });

  it('reporter 自身抛错不得影响拦截', () => {
    const target = makeTarget();
    installRtcBlocker(target, () => {
      throw new Error('遥测炸了');
    });
    const Blocked = target.RTCPeerConnection as new () => unknown;
    // Must throw TypeError (not the reporter's Error)
    expect(() => new Blocked()).toThrow(TypeError);
    // Must have the correct blocking message, not the reporter's message
    expect(() => new Blocked()).toThrow(/WebRTC is disabled/);
  });
});

function makeMediaTarget() {
  const mediaDevicesProto: Record<string, unknown> = {
    getUserMedia(_c?: unknown) {
      return Promise.resolve('real stream');
    },
    getDisplayMedia(_c?: unknown) {
      return Promise.resolve('real screen');
    },
    enumerateDevices() {
      return Promise.resolve(['device']);
    },
  };
  const navigatorProto: Record<string, unknown> = {
    getUserMedia(_c: unknown, _ok?: unknown, _err?: unknown) {},
  };
  const mediaDevices = Object.create(mediaDevicesProto) as Record<string, unknown>;
  const navigator = Object.create(navigatorProto) as Record<string, unknown>;
  navigator.mediaDevices = mediaDevices;

  return {
    target: {
      navigator,
      MediaDevices: { prototype: mediaDevicesProto },
      Navigator: { prototype: navigatorProto },
    },
    mediaDevicesProto,
    navigatorProto,
    mediaDevices,
    navigator,
  };
}

describe('installMediaBlocker', () => {
  it('getUserMedia 返回 reject 成 NotAllowedError 的 Promise，而不是同步抛错', async () => {
    const { target, mediaDevices } = makeMediaTarget();
    installMediaBlocker(target);
    const gum = mediaDevices.getUserMedia as () => Promise<unknown>;
    let promise: Promise<unknown>;
    expect(() => {
      promise = gum();
    }).not.toThrow();
    await expect(promise!).rejects.toMatchObject({ name: 'NotAllowedError' });
  });

  it('getDisplayMedia 同样被拒绝', async () => {
    const { target, mediaDevices } = makeMediaTarget();
    installMediaBlocker(target);
    const gdm = mediaDevices.getDisplayMedia as () => Promise<unknown>;
    await expect(gdm()).rejects.toMatchObject({ name: 'NotAllowedError' });
  });

  it('堵住通过 MediaDevices.prototype 的绕过路径', async () => {
    const { target, mediaDevicesProto, mediaDevices } = makeMediaTarget();
    installMediaBlocker(target);
    const viaProto = mediaDevicesProto.getUserMedia as (this: unknown) => Promise<unknown>;
    await expect(viaProto.call(mediaDevices)).rejects.toMatchObject({ name: 'NotAllowedError' });
  });

  it('legacy navigator.getUserMedia 走 error callback 而不是抛错', () => {
    const { target, navigator } = makeMediaTarget();
    installMediaBlocker(target);
    const legacy = navigator.getUserMedia as (
      c: unknown,
      ok: (s: unknown) => void,
      err: (e: unknown) => void,
    ) => void;
    const onError = vi.fn();
    const onSuccess = vi.fn();
    legacy({}, onSuccess, onError);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ name: 'NotAllowedError' });
  });

  it('不触碰 enumerateDevices', () => {
    const { target, mediaDevicesProto } = makeMediaTarget();
    const original = mediaDevicesProto.enumerateDevices;
    installMediaBlocker(target);
    expect(mediaDevicesProto.enumerateDevices).toBe(original);
  });

  it('target 上没有 navigator 时直接返回，不抛错', () => {
    expect(() => installMediaBlocker({})).not.toThrow();
  });

  it('重复调用幂等', () => {
    const { target, mediaDevices } = makeMediaTarget();
    installMediaBlocker(target);
    const first = mediaDevices.getUserMedia;
    expect(() => installMediaBlocker(target)).not.toThrow();
    expect(mediaDevices.getUserMedia).toBe(first);
  });

  it('拦截时上报正确的 API 名', async () => {
    const { target, mediaDevices } = makeMediaTarget();
    const seen: string[] = [];
    installMediaBlocker(target, (api) => seen.push(api));
    await (mediaDevices.getUserMedia as () => Promise<unknown>)().catch(() => undefined);
    expect(seen).toEqual(['getUserMedia']);
  });
});
