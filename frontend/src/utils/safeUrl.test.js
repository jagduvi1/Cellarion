import safeUrl from './safeUrl';

describe('safeUrl', () => {
  // -------------------------------------------------------------------------
  // Safe URLs pass through
  // -------------------------------------------------------------------------
  test('returns http:// URLs unchanged', () => {
    expect(safeUrl('http://example.com/page?a=1')).toBe('http://example.com/page?a=1');
  });

  test('returns https:// URLs unchanged', () => {
    expect(safeUrl('https://cellarion.app/wines/123')).toBe('https://cellarion.app/wines/123');
  });

  test('trims leading/trailing whitespace from an otherwise safe URL', () => {
    expect(safeUrl('  https://example.com  ')).toBe('https://example.com');
    expect(safeUrl('\n\thttp://example.com')).toBe('http://example.com');
  });

  // -------------------------------------------------------------------------
  // Dangerous schemes are blocked — the sanitizer returns null
  // -------------------------------------------------------------------------
  test('blocks javascript: URLs (returns null)', () => {
    expect(safeUrl('javascript:alert(1)')).toBeNull();
  });

  test('blocks data: URLs (returns null)', () => {
    expect(safeUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
  });

  test('blocks uppercase and mixed-case dangerous schemes', () => {
    expect(safeUrl('JAVASCRIPT:alert(1)')).toBeNull();
    expect(safeUrl('JavaScript:alert(1)')).toBeNull();
    expect(safeUrl('DATA:text/html,x')).toBeNull();
    expect(safeUrl('DaTa:text/html,x')).toBeNull();
  });

  test('blocks dangerous schemes preceded by leading whitespace', () => {
    expect(safeUrl('   javascript:alert(1)')).toBeNull();
    expect(safeUrl('\t\njavascript:alert(1)')).toBeNull();
    expect(safeUrl(' data:text/html,x')).toBeNull();
  });

  test('blocks dangerous schemes preceded by control characters', () => {
    // \u0000 and \u0001 are not stripped by trim(), so the string still does
    // not start with http(s):// and is rejected.
    expect(safeUrl('\u0000javascript:alert(1)')).toBeNull();
    expect(safeUrl('\u0001javascript:alert(1)')).toBeNull();
    expect(safeUrl('\u0000data:text/html,x')).toBeNull();
  });

  test('control characters that trim() does not strip also invalidate safe URLs', () => {
    // Allowlist approach: \u0001 is not whitespace, so the string no longer
    // starts with http:// and is (conservatively) rejected.
    expect(safeUrl('\u0001https://example.com')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Non-absolute-http(s) URLs are rejected (strict allowlist)
  // -------------------------------------------------------------------------
  test('blocks protocol-relative URLs', () => {
    expect(safeUrl('//evil.example.com/x')).toBeNull();
  });

  test('blocks relative URLs', () => {
    expect(safeUrl('/wines/123')).toBeNull();
    expect(safeUrl('wines/123')).toBeNull();
    expect(safeUrl('../up')).toBeNull();
  });

  test('blocks other schemes (ftp, mailto, vbscript, file)', () => {
    expect(safeUrl('ftp://example.com/f')).toBeNull();
    expect(safeUrl('mailto:user@example.com')).toBeNull();
    expect(safeUrl('vbscript:msgbox(1)')).toBeNull();
    expect(safeUrl('file:///etc/passwd')).toBeNull();
  });

  test('blocks uppercase HTTP/HTTPS schemes too (case-sensitive allowlist)', () => {
    // Documents actual behavior: the allowlist is lowercase-only, so an
    // uppercase-scheme URL is (conservatively) rejected, not passed through.
    expect(safeUrl('HTTPS://example.com')).toBeNull();
    expect(safeUrl('HTTP://example.com')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Empty / null / non-string input
  // -------------------------------------------------------------------------
  test('returns null for empty, null, and undefined input', () => {
    expect(safeUrl('')).toBeNull();
    expect(safeUrl(null)).toBeNull();
    expect(safeUrl(undefined)).toBeNull();
  });

  test('returns null for whitespace-only input', () => {
    expect(safeUrl('   ')).toBeNull();
  });

  test('returns null for non-string input', () => {
    expect(safeUrl(42)).toBeNull();
    expect(safeUrl({})).toBeNull();
    expect(safeUrl(['https://example.com'])).toBeNull();
  });
});
