import type { Settings } from '../core/types';
import { normalizeHost } from '../core/whitelist';

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  blockMedia: false,
  whitelist: [],
};

export interface SettingsArea {
  get(keys: null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * 存储内容可能来自旧版本或被外部写坏。任何不合法的值一律回落到默认，
 * 尤其是 enabled —— 绝不能因为读到脏数据就静默关闭防护。
 */
export function mergeSettings(raw: Record<string, unknown>): Settings {
  const rawList = Array.isArray(raw.whitelist) ? raw.whitelist : [];
  const hosts = new Set<string>();
  for (const entry of rawList) {
    if (typeof entry !== 'string') continue;
    const host = normalizeHost(entry);
    if (host !== '') hosts.add(host);
  }
  return {
    enabled: bool(raw.enabled, DEFAULT_SETTINGS.enabled),
    blockMedia: bool(raw.blockMedia, DEFAULT_SETTINGS.blockMedia),
    whitelist: [...hosts].sort(),
  };
}

export async function getSettings(area: SettingsArea): Promise<Settings> {
  return mergeSettings(await area.get(null));
}

export async function saveSettings(
  area: SettingsArea,
  patch: Partial<Settings>,
): Promise<Settings> {
  const next = mergeSettings({ ...(await area.get(null)), ...patch });
  await area.set({ ...next });
  return next;
}
