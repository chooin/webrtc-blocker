/**
 * 把用户输入（裸域名 / host:port / 完整 URL）归一为可比较的小写 punycode host。
 * 无法解析时返回空串，由调用方决定如何处理，绝不抛错。
 */
export function normalizeHost(input: string): string {
  const raw = input.trim().toLowerCase();
  if (raw === '') return '';
  const candidate = raw.includes('://') ? raw : `https://${raw}`;
  let host: string;
  try {
    host = new URL(candidate).hostname;
  } catch {
    return '';
  }
  return host.endsWith('.') ? host.slice(0, -1) : host;
}

/**
 * 只有精确相等或真正的子域才算命中。
 * 用 `.${w}` 做后缀比较是关键：直接 endsWith(w) 会让 evilexample.com 命中 example.com。
 */
export function isWhitelisted(hostname: string, whitelist: readonly string[]): boolean {
  const host = normalizeHost(hostname);
  if (host === '') return false;
  return whitelist.some((entry) => {
    const w = normalizeHost(entry);
    if (w === '') return false;
    return host === w || host.endsWith(`.${w}`);
  });
}

/** 归一 + 去重 + 排序：输出稳定才能避免 excludeMatches 无谓变化导致的重复注册。 */
function canonicalize(whitelist: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const entry of whitelist) {
    const h = normalizeHost(entry);
    if (h !== '') seen.add(h);
  }
  return [...seen].sort();
}

export function addToWhitelist(whitelist: readonly string[], host: string): string[] {
  const w = normalizeHost(host);
  if (w === '') return canonicalize(whitelist);
  return canonicalize([...whitelist, w]);
}

export function removeFromWhitelist(whitelist: readonly string[], host: string): string[] {
  const w = normalizeHost(host);
  return canonicalize(whitelist).filter((h) => h !== w);
}

/**
 * Chromium 的 `*.example.com` 主机模式据文档亦匹配 example.com 本身，
 * 两条模式存在冗余。此处刻意保留：冗余无副作用，而一旦该行为与文档不符，
 * 白名单静默失效的代价远高于多写一条模式。
 */
export function toExcludeMatches(whitelist: readonly string[]): string[] {
  const out: string[] = [];
  for (const w of canonicalize(whitelist)) {
    out.push(`*://${w}/*`, `*://*.${w}/*`);
  }
  return out;
}
