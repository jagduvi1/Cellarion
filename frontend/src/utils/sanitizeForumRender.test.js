import { sanitizeForumRender, extractForumPlainText } from './sanitizeForumRender';

describe('sanitizeForumRender', () => {
  it('keeps allowlisted forum markup', () => {
    const html = '<p>Hello <strong>world</strong> <em>wine</em></p><ul><li>one</li></ul>';
    expect(sanitizeForumRender(html)).toBe(html);
  });

  it('strips HTML-profile tags outside the forum allowlist (img, h1, table)', () => {
    // Regression: USE_PROFILES:{html:true} used to override ALLOWED_TAGS,
    // letting any HTML-profile markup through the defense-in-depth layer.
    const out = sanitizeForumRender('<h1>t</h1><img src="x.png"><table><tr><td>c</td></tr></table><p>ok</p>');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<h1');
    expect(out).not.toContain('<table');
    expect(out).toContain('<p>ok</p>');
  });

  it('strips non-allowlisted attributes (style, class)', () => {
    const out = sanitizeForumRender('<p style="color:red" class="x">ok</p>');
    expect(out).toBe('<p>ok</p>');
  });

  it('forces target=_blank and rel on links', () => {
    const out = sanitizeForumRender('<a href="https://example.com">link</a>');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
  });

  it('returns empty string for non-string input', () => {
    expect(sanitizeForumRender(null)).toBe('');
    expect(sanitizeForumRender(undefined)).toBe('');
    expect(sanitizeForumRender(42)).toBe('');
  });
});

describe('extractForumPlainText', () => {
  it('strips all markup and collapses whitespace', () => {
    expect(extractForumPlainText('<p>Hello  <strong>world</strong></p>\n<p>two</p>')).toBe('Hello world two');
  });

  it('handles malformed input safely', () => {
    expect(extractForumPlainText('<script>alert(1)</script>ok')).toBe('ok');
  });
});
