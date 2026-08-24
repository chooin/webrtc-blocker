import { normalizeHost } from '../core/whitelist';
import { pageHost } from './page-host';

describe('pageHost', () => {
  it('http / https 页面给出域名', () => {
    expect(pageHost('https://meet.google.com/abc-def')).toBe('meet.google.com');
    expect(pageHost('http://example.com:8080/x')).toBe('example.com');
  });

  /**
   * 这一条是本文件存在的理由：normalizeHost 会把 chrome://extensions/ 归一成
   * 'extensions'，一个看起来像域名、实则毫无意义的值。照它渲染，popup 会在浏览器
   * 内部页面上摆出「放行本站」按钮，点一下就往白名单里塞一条垃圾，
   * 而扩展本来就注入不了这类页面，放行与否毫无区别。
   */
  it('浏览器内部页面不算站点', () => {
    expect(normalizeHost('chrome://extensions/')).toBe('extensions');
    expect(pageHost('chrome://extensions/')).toBe('');
    expect(pageHost('chrome://newtab/')).toBe('');
    expect(pageHost('edge://settings/')).toBe('');
    expect(pageHost('about:blank')).toBe('');
    expect(pageHost('devtools://devtools/bundled/x.html')).toBe('');
  });

  it('本地文件与扩展页面同样不算站点', () => {
    expect(pageHost('file:///Users/me/x.html')).toBe('');
    expect(pageHost('chrome-extension://abcdefg/popup/index.html')).toBe('');
  });

  it('拿不到 URL 时返回空串而不是抛错', () => {
    expect(pageHost('')).toBe('');
    expect(pageHost('不是 URL')).toBe('');
  });
});
