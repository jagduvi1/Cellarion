const { sanitizeForumHtml, visibleTextLength, ALLOWED_TAGS } = require('./sanitizeHtml');

describe('sanitizeForumHtml', () => {
  test('returns empty string for non-string input', () => {
    expect(sanitizeForumHtml(null)).toBe('');
    expect(sanitizeForumHtml(undefined)).toBe('');
    expect(sanitizeForumHtml(42)).toBe('');
    expect(sanitizeForumHtml({})).toBe('');
  });

  test('preserves all whitelisted tags', () => {
    const input = '<p>plain</p><p><strong>bold</strong> <em>italic</em> <s>strike</s> <u>underline</u></p>';
    const out = sanitizeForumHtml(input);
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<em>italic</em>');
    expect(out).toContain('<s>strike</s>');
    expect(out).toContain('<u>underline</u>');
  });

  test('preserves blockquote and list structure', () => {
    const input = '<blockquote><p>quoted</p></blockquote><ul><li>one</li><li>two</li></ul><ol><li>first</li></ol>';
    const out = sanitizeForumHtml(input);
    expect(out).toContain('<blockquote>');
    expect(out).toContain('<ul>');
    expect(out).toContain('<ol>');
    expect(out).toContain('<li>one</li>');
  });

  // ── XSS payloads ───────────────────────────────────────────────────────────

  test('strips <script> tags entirely', () => {
    const input = '<p>hi</p><script>alert(1)</script>';
    expect(sanitizeForumHtml(input)).toBe('<p>hi</p>');
  });

  test('strips inline event handlers (onclick, onerror, onload)', () => {
    const input = '<p onclick="alert(1)">hi</p>';
    const out = sanitizeForumHtml(input);
    expect(out).not.toContain('onclick');
    expect(out).toContain('hi');
  });

  test('strips style attributes (no CSS-based exfil/cover attacks)', () => {
    const input = '<p style="position:fixed;left:0;top:0;width:100vw;height:100vh">x</p>';
    const out = sanitizeForumHtml(input);
    expect(out).not.toContain('style');
  });

  test('strips class and id attributes', () => {
    const input = '<p class="evil" id="x">hi</p>';
    const out = sanitizeForumHtml(input);
    expect(out).not.toContain('class');
    expect(out).not.toContain('id="x"');
  });

  test('strips <iframe>, <img>, <video>, <object>, <embed>', () => {
    const input = '<iframe src="//evil"></iframe><img src=x onerror=alert(1)><video><source src="x"></video><object data="x"></object><embed src="x">';
    const out = sanitizeForumHtml(input);
    expect(out).not.toContain('<iframe');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<video');
    expect(out).not.toContain('<object');
    expect(out).not.toContain('<embed');
  });

  test('strips <a> with javascript: scheme (and other non-http schemes)', () => {
    expect(sanitizeForumHtml('<a href="javascript:alert(1)">click</a>')).not.toContain('javascript');
    expect(sanitizeForumHtml('<a href="data:text/html,<script>alert(1)</script>">x</a>')).not.toContain('data:');
    expect(sanitizeForumHtml('<a href="vbscript:msgbox(1)">x</a>')).not.toContain('vbscript');
  });

  test('keeps <a> with http, https, and mailto schemes', () => {
    expect(sanitizeForumHtml('<a href="https://example.com">x</a>')).toContain('href="https://example.com"');
    expect(sanitizeForumHtml('<a href="http://example.com">x</a>')).toContain('href="http://example.com"');
    expect(sanitizeForumHtml('<a href="mailto:a@b.c">x</a>')).toContain('mailto:a@b.c');
  });

  test('forces target=_blank and rel=noopener noreferrer nofollow on links', () => {
    const out = sanitizeForumHtml('<a href="https://example.com">x</a>');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
  });

  test('does not allow span, div, or other layout tags', () => {
    expect(sanitizeForumHtml('<div><span>hello</span></div>')).toBe('hello');
    expect(sanitizeForumHtml('<table><tr><td>x</td></tr></table>')).toBe('x');
    expect(sanitizeForumHtml('<form><input value=x></form>')).toBe('');
  });

  test('strips data attributes (forward-compat: future custom nodes use sanitize-html opts to allow)', () => {
    const out = sanitizeForumHtml('<a href="https://x.com" data-tracking="evil">x</a>');
    expect(out).not.toContain('data-tracking');
  });

  test('keeps <br> for soft line breaks', () => {
    expect(sanitizeForumHtml('line1<br>line2')).toContain('<br');
  });

  test('exposes the allowlist for documentation and frontend mirroring', () => {
    expect(ALLOWED_TAGS).toContain('p');
    expect(ALLOWED_TAGS).toContain('a');
    expect(ALLOWED_TAGS).not.toContain('script');
    expect(ALLOWED_TAGS).not.toContain('iframe');
  });
});

describe('visibleTextLength', () => {
  test('returns 0 for non-string input', () => {
    expect(visibleTextLength(null)).toBe(0);
    expect(visibleTextLength(undefined)).toBe(0);
    expect(visibleTextLength(42)).toBe(0);
  });

  test('counts only visible characters, not HTML tags', () => {
    expect(visibleTextLength('<p>Hello</p>')).toBe(5);
    expect(visibleTextLength('<p><strong>Hi</strong></p>')).toBe(2);
  });

  test('collapses whitespace so a wall of <br> does not inflate the count', () => {
    expect(visibleTextLength('Hello<br><br><br>world')).toBe(11); // "Hello world"
  });

  test('handles empty content', () => {
    expect(visibleTextLength('')).toBe(0);
    expect(visibleTextLength('<p></p>')).toBe(0);
    expect(visibleTextLength('<p>   </p>')).toBe(0);
  });
});
