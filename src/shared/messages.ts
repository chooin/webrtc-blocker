import type { BlockedApi } from '../core/types';

export const BLOCK_EVENT_SOURCE = 'webrtc-blocker::block';

const KNOWN_APIS: readonly BlockedApi[] = [
  'RTCPeerConnection',
  'webkitRTCPeerConnection',
  'RTCDataChannel',
  'getUserMedia',
  'getDisplayMedia',
  'legacyGetUserMedia',
];

export interface BlockEvent {
  source: typeof BLOCK_EVENT_SOURCE;
  api: BlockedApi;
}

export function createBlockEvent(api: BlockedApi): BlockEvent {
  return { source: BLOCK_EVENT_SOURCE, api };
}

/**
 * 这条消息来自 MAIN world，页面可以随意伪造，所以必须严格校验形状。
 * 它只用于计数展示，不承载任何安全决策。
 */
export function isBlockEvent(data: unknown): data is BlockEvent {
  if (typeof data !== 'object' || data === null) return false;
  const candidate = data as Partial<BlockEvent>;
  if (candidate.source !== BLOCK_EVENT_SOURCE) return false;
  return KNOWN_APIS.includes(candidate.api as BlockedApi);
}
