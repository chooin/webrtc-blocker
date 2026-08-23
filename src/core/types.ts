export interface Settings {
  enabled: boolean;
  blockMedia: boolean;
  whitelist: string[];
}

export type ScriptId = 'rtc-blocker' | 'media-blocker';

export type IpHandlingPolicy =
  | 'default'
  | 'default_public_interface_only'
  | 'disable_non_proxied_udp';

/**
 * 与 chrome.scripting.RegisteredContentScript 字段一致的纯数据描述。
 * 刻意不引用 chrome 类型，好让 policy.ts 能在 node 环境下直接测试。
 */
export interface RegistrationSpec {
  id: ScriptId;
  js: string[];
  matches: string[];
  excludeMatches: string[];
  runAt: 'document_start';
  allFrames: true;
  matchOriginAsFallback: true;
  world: 'MAIN';
  persistAcrossSessions: true;
}

export interface ReconcilePlan {
  register: RegistrationSpec[];
  update: RegistrationSpec[];
  /** 可能含非本扩展登记的残留 id，故为 string 而非 ScriptId */
  unregister: string[];
}

export type BlockedApi =
  | 'RTCPeerConnection'
  | 'webkitRTCPeerConnection'
  | 'RTCDataChannel'
  | 'getUserMedia'
  | 'getDisplayMedia'
  | 'legacyGetUserMedia';

export type BlockReporter = (api: BlockedApi) => void;
