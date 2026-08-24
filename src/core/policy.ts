import type {
  IpHandlingPolicy,
  ReconcilePlan,
  RegistrationSpec,
  ScriptId,
  Settings,
} from './types';
import { MEDIA_SCRIPT_FILE, RTC_SCRIPT_FILE } from './script-files';
import { toExcludeMatches } from './whitelist';

export const RTC_SCRIPT_ID: ScriptId = 'rtc-blocker';
export const MEDIA_SCRIPT_ID: ScriptId = 'media-blocker';

// 产物路径的唯一定义在 ./script-files，scripts/build.mjs 也是从那里读的。
export { MEDIA_SCRIPT_FILE, RTC_SCRIPT_FILE };

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

/**
 * 注册状态是否已经和设置对不上了，需要整轮重新同步。
 *
 * Service Worker 每次被唤醒都会跑一次自检，所以这个判断必须只读、且要便宜：
 * 无条件重新注册意味着每个标签页的每次导航都触发一轮 update，代价太大。
 *
 * 只看「该在的不在」和「不该在的还在」。`reconcile` 刻意把所有已存在的 id 放进
 * update（哪怕内容没变），所以 update 非空是常态，不能拿它当失衡的证据——
 * 拿它当证据的话，这个函数会永远返回 true，自检就退化成了无条件重注册。
 */
export function needsRepair(
  currentIds: readonly string[],
  desired: readonly RegistrationSpec[],
): boolean {
  const plan = reconcile(currentIds, desired);
  return plan.register.length > 0 || plan.unregister.length > 0;
}
