import { BLOCK_EVENT_SOURCE, createBlockEvent, isBlockEvent } from './messages';

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
