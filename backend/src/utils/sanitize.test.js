const { stripHtml, isSafeUrl, sanitizeGrapeNames } = require('./sanitize');

// ─── sanitizeGrapeNames ──────────────────────────────────────────────────────

describe('sanitizeGrapeNames', () => {
  test('non-array input yields [] (never throws)', () => {
    expect(sanitizeGrapeNames(undefined)).toEqual([]);
    expect(sanitizeGrapeNames(null)).toEqual([]);
    expect(sanitizeGrapeNames('Syrah')).toEqual([]);
    expect(sanitizeGrapeNames({ length: 1e12 })).toEqual([]);
  });

  test('trims entries and drops empties and non-strings', () => {
    expect(sanitizeGrapeNames(['  Syrah  ', '', '   ', 42, null, 'Grenache']))
      .toEqual(['Syrah', 'Grenache']);
  });

  test('strips HTML from grape names', () => {
    expect(sanitizeGrapeNames(['<b>Syrah</b>', '<script>x</script>Merlot']))
      .toEqual(['Syrah', 'xMerlot']);
  });

  test('caps at 5 grapes by default', () => {
    const many = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    expect(sanitizeGrapeNames(many)).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  test('caps each name at 100 chars', () => {
    const long = 'x'.repeat(250);
    const [out] = sanitizeGrapeNames([long]);
    expect(out).toHaveLength(100);
  });

  test('dedupes case-insensitively, keeps first casing', () => {
    expect(sanitizeGrapeNames(['Syrah', 'syrah', 'SYRAH', 'Merlot']))
      .toEqual(['Syrah', 'Merlot']);
  });
});

// ─── stripHtml ───────────────────────────────────────────────────────────────

describe('stripHtml', () => {
  test('null returns null', () => {
    expect(stripHtml(null)).toBeNull();
  });

  test('undefined returns undefined', () => {
    expect(stripHtml(undefined)).toBeUndefined();
  });

  test('empty string returns empty string', () => {
    expect(stripHtml('')).toBe('');
  });

  test('plain text passes through unchanged', () => {
    expect(stripHtml('Just a normal sentence')).toBe('Just a normal sentence');
  });

  test('strips simple tags', () => {
    expect(stripHtml('<b>hello</b>')).toBe('hello');
  });

  test('strips nested tags', () => {
    expect(stripHtml('<div><p>nested <strong>content</strong></p></div>')).toBe('nested content');
  });

  test('strips self-closing tags', () => {
    expect(stripHtml('before<br/>after')).toBe('beforeafter');
  });

  test('handles <script>alert(1)</script>', () => {
    expect(stripHtml('<script>alert(1)</script>')).toBe('alert(1)');
  });

  test('handles nested injection <scr<script>ipt>alert(1)</script>', () => {
    // The character-by-character depth tracking means:
    // <scr<script>  — first '<' sets depth=1, 's','c','r' skipped (depth>0),
    // second '<' sets depth=2, 'script' skipped, '>' decrements depth to 1
    // 'ipt' skipped (depth still 1), '>' decrements depth to 0
    // 'alert(1)' output, then '<script>' strips again
    const result = stripHtml('<scr<script>ipt>alert(1)</script>');
    expect(result).toBe('alert(1)');
    expect(result).not.toContain('<');
    expect(result).not.toContain('>');
  });

  test('handles tags with attributes', () => {
    expect(stripHtml('<a href="http://evil.com" onclick="steal()">Click me</a>')).toBe('Click me');
  });

  test('truncates strings exceeding 10000 characters instead of throwing', () => {
    const longStr = 'x'.repeat(10_001);
    expect(() => stripHtml(longStr)).not.toThrow();
    // Only the first 10,000 chars are processed; the rest is dropped so the
    // downstream per-field length checks produce their normal 400s.
    expect(stripHtml(longStr)).toBe('x'.repeat(10_000));
  });

  test('drops tags in the truncated tail beyond 10000 characters', () => {
    const longStr = 'x'.repeat(10_000) + '<script>alert(1)</script>';
    expect(stripHtml(longStr)).toBe('x'.repeat(10_000));
  });

  test('handles strings at exactly 10000 characters unchanged', () => {
    const exactStr = 'x'.repeat(10_000);
    expect(() => stripHtml(exactStr)).not.toThrow();
    expect(stripHtml(exactStr)).toBe(exactStr);
  });

  test('trims whitespace from result', () => {
    expect(stripHtml('  <b>hello</b>  ')).toBe('hello');
  });

  test('returns 0 (falsy number) unchanged', () => {
    // 0 is falsy so the !str guard returns it as-is
    expect(stripHtml(0)).toBe(0);
  });
});

// ─── isSafeUrl ───────────────────────────────────────────────────────────────

describe('isSafeUrl', () => {
  test('http URL returns true', () => {
    expect(isSafeUrl('http://example.com')).toBe(true);
  });

  test('https URL returns true', () => {
    expect(isSafeUrl('https://example.com/path?q=1')).toBe(true);
  });

  test('javascript: protocol returns false', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
  });

  test('data: protocol returns false', () => {
    expect(isSafeUrl('data:text/html,<h1>Hi</h1>')).toBe(false);
  });

  test('ftp: protocol returns false', () => {
    expect(isSafeUrl('ftp://files.example.com')).toBe(false);
  });

  test('null returns false', () => {
    expect(isSafeUrl(null)).toBe(false);
  });

  test('undefined returns false', () => {
    expect(isSafeUrl(undefined)).toBe(false);
  });

  test('empty string returns false', () => {
    expect(isSafeUrl('')).toBe(false);
  });

  test('invalid URL returns false', () => {
    expect(isSafeUrl('not-a-url')).toBe(false);
  });

  test('relative path returns false (not a valid URL)', () => {
    expect(isSafeUrl('/relative/path')).toBe(false);
  });

  test('URL with port is allowed', () => {
    expect(isSafeUrl('https://localhost:3000/api')).toBe(true);
  });

  test('JAVASCRIPT: (uppercase) returns false', () => {
    // new URL normalizes the protocol to lowercase
    expect(isSafeUrl('JAVASCRIPT:alert(1)')).toBe(false);
  });
});
