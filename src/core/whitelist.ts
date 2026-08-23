/** 单个 DNS 标签：字母数字开头结尾，中间可含连字符。也覆盖 punycode 与 IPv4 段。 */
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** URL 解析已经保证方括号里是合法 IPv6，这里只需确认它确实是那个形状。 */
const IPV6_LITERAL = /^\[[0-9a-f:.]+\]$/;

/**
 * WHATWG URL 解析给出的 hostname 不一定是"普通主机名"——`*` 不是禁用的主机码点，
 * `new URL('https://*').hostname` 就等于 `'*'`。而这些 host 会被原样拼进
 * Chrome 的 match pattern，后果是灾难性的：
 *   - `'*'`           → excludeMatches 变成全域通配，所有 http/https 页面都被排除，
 *                       注册还会成功、popup 照常显示「已拦截」——
 *                       一条存储值换来一次静默的全局失效。
 *   - `'*.a.com'`     → `*://*.*.a.com/*`，Chromium 判为 PARSE_ERROR_INVALID_HOST_WILDCARD，
 *                       整个 registerContentScripts 被拒，等于什么都没注册。
 * 今天的 popup 只会传入真实 tab.url，但 mergeSettings 明确承诺要扛住被写坏的存储，
 * 而白名单导入功能一旦落地，这条路径就直接对用户开放。故在此做白名单式校验。
 */
function isPlainHostname(host: string): boolean {
  if (host === '' || host.length > 253) return false;
  if (IPV6_LITERAL.test(host)) return true;
  // 刻意不接受下划线等 DNS 里少见的字符：宁可少放行一个内网域名，
  // 也不把没验证过的字符送进 match pattern。
  return host.split('.').every((label) => label.length <= 63 && DNS_LABEL.test(label));
}

/**
 * 把用户输入（裸域名 / host:port / 完整 URL）归一为可比较的小写 punycode host。
 * 无法解析、或解析结果不是普通主机名时返回空串，由调用方决定如何处理，绝不抛错。
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
  const trimmed = host.endsWith('.') ? host.slice(0, -1) : host;
  return isPlainHostname(trimmed) ? trimmed : '';
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
