import { normalizeHost } from './whitelist';

/**
 * 只有真正能被注入的页面才配拥有站点卡片。
 *
 * `normalizeHost('chrome://extensions/')` 会得到 'extensions'——一个看起来像域名、
 * 实则毫无意义的值。照它渲染出「放行本站」按钮，点一下就往白名单里塞一条垃圾，
 * 而扩展本来就注入不了 chrome:// 页面，放行与否毫无区别。
 * 故在这里就把非 http/https 的标签页判为"没有站点"，交给 App 既有的
 * 「没有 host 就不渲染站点卡片」逻辑处理。
 */
export function pageHost(url: string): string {
  let scheme: string;
  try {
    scheme = new URL(url).protocol;
  } catch {
    return '';
  }
  if (scheme !== 'http:' && scheme !== 'https:') return '';
  return normalizeHost(url);
}
