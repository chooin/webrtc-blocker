import type {
  IpHandlingPolicy,
  ReconcilePlan,
  RegistrationSpec,
  ScriptId,
  Settings,
} from './types';
import { toExcludeMatches } from './whitelist';

export const RTC_SCRIPT_ID: ScriptId = 'rtc-blocker';
export const MEDIA_SCRIPT_ID: ScriptId = 'media-blocker';

/** 与 scripts/build.mjs 的 IIFE 产物路径一一对应。 */
export const RTC_SCRIPT_FILE = 'injected/rtc.js';
export const MEDIA_SCRIPT_FILE = 'injected/media.js';

/**
 * privacy.network 是全局设置，无法按域名区分，故取三档折中：
 * 白名单非空时若仍用最严档，白名单站点在无代理环境下自己也连不上。
 */
export function ipHandlingPolicy(settings: Settings): IpHandlingPolicy {
  if (!settings.enabled) return 'default';
  return settings.whitelist.length === 0
    ? 'disable_non_proxied_udp'
    : 'default_public_interface_only';
}

function spec(id: ScriptId, file: string, excludeMatches: string[]): RegistrationSpec {
  return {
    id,
    js: [file],
    matches: ['<all_urls>'],
    excludeMatches,
    runAt: 'document_start',
    // allFrames + matchOriginAsFallback 一起封堵 about:blank / srcdoc iframe 逃逸。
    allFrames: true,
    matchOriginAsFallback: true,
    world: 'MAIN',
    persistAcrossSessions: true,
  };
}

export function desiredRegistrations(settings: Settings): RegistrationSpec[] {
  if (!settings.enabled) return [];
  const excludeMatches = toExcludeMatches(settings.whitelist);
  const out = [spec(RTC_SCRIPT_ID, RTC_SCRIPT_FILE, excludeMatches)];
  if (settings.blockMedia) {
    out.push(spec(MEDIA_SCRIPT_ID, MEDIA_SCRIPT_FILE, excludeMatches));
  }
  return out;
}

/**
 * 每次同步都以浏览器实际注册状态为准，而不是信任本地记忆：
 * 扩展更新后旧注册可能残留并指向已不存在的文件路径。
 * 已存在的一律走 update（即使内容未变）——多一次 API 调用，换掉一整类状态漂移问题。
 */
export function reconcile(
  currentIds: readonly string[],
  desired: readonly RegistrationSpec[],
): ReconcilePlan {
  const current = new Set(currentIds);
  const desiredIds = new Set(desired.map((d) => d.id as string));
  return {
    register: desired.filter((d) => !current.has(d.id)),
    update: desired.filter((d) => current.has(d.id)),
    unregister: [...current].filter((id) => !desiredIds.has(id)),
  };
}
