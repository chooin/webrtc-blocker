import {
  BLOCK_EVENT_SOURCE,
  SYNC_REQUEST_SOURCE,
  createBlockEvent,
  createSyncRequest,
  isBlockEvent,
  isSyncRequest,
  isSyncResult,
} from './messages';

describe('block event 协议', () => {
  it('创建的消息带上固定 source 与 API 名', () => {
    expect(createBlockEvent('RTCPeerConnection')).toEqual({
      source: BLOCK_EVENT_SOURCE,
      api: 'RTCPeerConnection',
    });
  });

  it('识别自己创建的消息', () => {
    expect(isBlockEvent(createBlockEvent('getUserMedia'))).toBe(true);
  });

  it('拒绝 source 不匹配的消息', () => {
    expect(isBlockEvent({ source: 'somebody-else', api: 'RTCPeerConnection' })).toBe(false);
  });

  it('拒绝 api 不在白名单内的消息，防止把任意字符串写进计数键', () => {
    expect(isBlockEvent({ source: BLOCK_EVENT_SOURCE, api: 'evil' })).toBe(false);
  });

  it('拒绝非对象输入而不抛错', () => {
    for (const bad of [null, undefined, 42, 'x', []]) {
      expect(isBlockEvent(bad)).toBe(false);
    }
  });
});

describe('同步请求协议', () => {
  it('创建的请求带上固定 source', () => {
    expect(createSyncRequest()).toEqual({ source: SYNC_REQUEST_SOURCE });
  });

  it('识别自己创建的请求', () => {
    expect(isSyncRequest(createSyncRequest())).toBe(true);
  });

  it('拒绝 source 不匹配的请求', () => {
    expect(isSyncRequest({ source: BLOCK_EVENT_SOURCE })).toBe(false);
  });

  it('拒绝非对象输入而不抛错', () => {
    for (const bad of [null, undefined, 42, 'x', []]) {
      expect(isSyncRequest(bad)).toBe(false);
    }
  });

  it('识别形状合法的应答，包括「没有错误」这种情况', () => {
    expect(isSyncResult({ error: null })).toBe(true);
    expect(isSyncResult({ error: '注册被拒绝' })).toBe(true);
  });

  it('拒绝形状不对的应答——读不懂就不能假装拦截正常', () => {
    for (const bad of [null, undefined, {}, { error: 42 }, { error: undefined }]) {
      expect(isSyncResult(bad)).toBe(false);
    }
  });
});
