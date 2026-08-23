import {
  addToWhitelist,
  isWhitelisted,
  normalizeHost,
  removeFromWhitelist,
  toExcludeMatches,
} from './whitelist';

describe('normalizeHost', () => {
  it('小写化并去掉端口', () => {
    expect(normalizeHost('EXAMPLE.com:8443')).toBe('example.com');
  });

  it('接受完整 URL 并只取 host', () => {
    expect(normalizeHost('https://meet.google.com/abc-def')).toBe('meet.google.com');
  });

  it('把中文域名转成 punycode', () => {
    expect(normalizeHost('例子.测试')).toBe('xn--fsqu00a.xn--0zwm56d');
  });

  it('去掉根域末尾的点', () => {
    expect(normalizeHost('example.com.')).toBe('example.com');
  });

  it('无法解析时返回空串而不是抛错', () => {
    expect(normalizeHost('   ')).toBe('');
    expect(normalizeHost('http://')).toBe('');
  });

  // 这些值都能被 WHATWG URL 解析成功，却不是普通主机名。
  // 放行任何一个，它都会被原样拼进 Chrome 的 match pattern：
  // '*' 让 excludeMatches 覆盖全网（静默全局失效），
  // 带通配的其余几个会让整个 registerContentScripts 被拒（同样静默、同样全局）。
  it('通配符主机一律拒绝，否则一条存储值就能让全站放行', () => {
    expect(normalizeHost('*')).toBe('');
    expect(normalizeHost('*.example.com')).toBe('');
    expect(normalizeHost('ex*ample.com')).toBe('');
  });

  it('空标签的主机一律拒绝', () => {
    expect(normalizeHost('..')).toBe('');
    expect(normalizeHost('a..b.com')).toBe('');
  });

  it('标签不得以连字符开头或结尾', () => {
    expect(normalizeHost('-a.com')).toBe('');
    expect(normalizeHost('a-.com')).toBe('');
  });

  it('IPv6 字面量、IPv4 与 punycode 依旧放行', () => {
    expect(normalizeHost('[::1]')).toBe('[::1]');
    expect(normalizeHost('192.168.1.1')).toBe('192.168.1.1');
    expect(normalizeHost('xn--fsqu00a.xn--0zwm56d')).toBe('xn--fsqu00a.xn--0zwm56d');
    expect(normalizeHost('localhost')).toBe('localhost');
  });
});

describe('isWhitelisted', () => {
  it('精确匹配', () => {
    expect(isWhitelisted('example.com', ['example.com'])).toBe(true);
  });

  it('覆盖子域', () => {
    expect(isWhitelisted('a.b.example.com', ['example.com'])).toBe(true);
  });

  it('不把 evilexample.com 当成 example.com 的子域', () => {
    expect(isWhitelisted('evilexample.com', ['example.com'])).toBe(false);
  });

  it('不反向匹配：白名单写子域时父域不放行', () => {
    expect(isWhitelisted('example.com', ['sub.example.com'])).toBe(false);
  });

  it('大小写不敏感', () => {
    expect(isWhitelisted('Meet.Google.COM', ['meet.google.com'])).toBe(true);
  });

  it('空白名单一律不放行', () => {
    expect(isWhitelisted('example.com', [])).toBe(false);
  });

  it('忽略白名单里的垃圾条目', () => {
    expect(isWhitelisted('example.com', ['   ', 'example.com'])).toBe(true);
    expect(isWhitelisted('example.com', ['   '])).toBe(false);
  });
});

describe('addToWhitelist / removeFromWhitelist', () => {
  it('新增后归一化并排序，保证输出稳定', () => {
    expect(addToWhitelist(['b.com'], 'A.com:443')).toEqual(['a.com', 'b.com']);
  });

  it('重复新增不产生重复项', () => {
    expect(addToWhitelist(['a.com'], 'a.com')).toEqual(['a.com']);
  });

  it('无效输入不改变白名单', () => {
    expect(addToWhitelist(['a.com'], '  ')).toEqual(['a.com']);
  });

  it('移除时同样按归一化后的 host 比对', () => {
    expect(removeFromWhitelist(['a.com', 'b.com'], 'A.com')).toEqual(['b.com']);
  });
});

describe('toExcludeMatches', () => {
  it('每个域名产出裸域与通配子域两条模式', () => {
    expect(toExcludeMatches(['example.com'])).toEqual([
      '*://example.com/*',
      '*://*.example.com/*',
    ]);
  });

  it('跳过无效条目', () => {
    expect(toExcludeMatches(['  ', 'a.com'])).toEqual(['*://a.com/*', '*://*.a.com/*']);
  });

  it('空白名单产出空数组', () => {
    expect(toExcludeMatches([])).toEqual([]);
  });

  it('通配符条目不会变成排除全网的模式', () => {
    expect(toExcludeMatches(['*'])).toEqual([]);
    expect(toExcludeMatches(['*.example.com'])).toEqual([]);
    expect(toExcludeMatches(['*', 'a.com'])).toEqual(['*://a.com/*', '*://*.a.com/*']);
  });
});
