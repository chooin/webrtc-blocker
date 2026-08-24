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

export const SYNC_REQUEST_SOURCE = 'webrtc-blocker::sync-request';

export interface SyncRequest {
  source: typeof SYNC_REQUEST_SOURCE;
}

/**
 * popup 用它请求 Service Worker「现在重新同步一次注册，并把结果告诉我」。
 *
 * 存在的理由是时序：设置写进 storage 之后，`storage.onChanged` 触发的同步是个
 * 浮动的 Promise，popup 无从知道它跑完没有。此前 popup 保存完就去读 session 里的
 * 同步结果，读到的其实是**上一次**的——这次改动恰好把注册搞坏时，红色横幅不会出现。
 * 改成请求-应答之后，popup 拿到的是这次同步确定的结果。
 */
export function createSyncRequest(): SyncRequest {
  return { source: SYNC_REQUEST_SOURCE };
}

export function isSyncRequest(data: unknown): data is SyncRequest {
  if (typeof data !== 'object' || data === null) return false;
  return (data as Partial<SyncRequest>).source === SYNC_REQUEST_SOURCE;
}

/** 同步请求的应答：error 为 null 表示这次同步确实成功了。 */
export interface SyncResult {
  error: string | null;
}

/**
 * 应答形状不对时一律当作「读不懂」，由调用方按「无法确认」处理。
 * 绝不能把读不懂降级成「没有错误」——那又回到了静默假保证。
 */
export function isSyncResult(data: unknown): data is SyncResult {
  if (typeof data !== 'object' || data === null) return false;
  const error = (data as Partial<SyncResult>).error;
  return error === null || (typeof error === 'string' && error !== '');
}
