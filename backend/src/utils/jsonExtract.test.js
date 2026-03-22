const { extractFirstJsonObject, extractAiExplanation } = require('./jsonExtract');

// ─── extractFirstJsonObject ──────────────────────────────────────────────────

describe('extractFirstJsonObject', () => {
  test('extracts JSON from string with trailing text', () => {
    const input = '{"name":"Merlot","vintage":2020} some trailing commentary';
    const result = extractFirstJsonObject(input);
    expect(result).toBe('{"name":"Merlot","vintage":2020}');
    expect(JSON.parse(result)).toEqual({ name: 'Merlot', vintage: 2020 });
  });

  test('handles nested objects', () => {
    const input = '{"wine":{"name":"Barolo","region":{"country":"Italy"}}} extra text';
    const result = extractFirstJsonObject(input);
    expect(result).toBe('{"wine":{"name":"Barolo","region":{"country":"Italy"}}}');
    const parsed = JSON.parse(result);
    expect(parsed.wine.region.country).toBe('Italy');
  });

  test('handles quoted braces inside strings', () => {
    const input = '{"note":"contains { and } in text","ok":true} trailing';
    const result = extractFirstJsonObject(input);
    expect(result).toBe('{"note":"contains { and } in text","ok":true}');
    const parsed = JSON.parse(result);
    expect(parsed.note).toBe('contains { and } in text');
    expect(parsed.ok).toBe(true);
  });

  test('returns as-is if no balanced object', () => {
    const input = 'no json here at all';
    const result = extractFirstJsonObject(input);
    expect(result).toBe(input);
  });

  test('returns as-is for unbalanced braces', () => {
    const input = '{"name":"unclosed';
    const result = extractFirstJsonObject(input);
    expect(result).toBe(input);
  });

  test('handles escaped quotes inside strings', () => {
    const input = '{"note":"He said \\"hello\\"","vintage":2020} rest';
    const result = extractFirstJsonObject(input);
    expect(result).toBe('{"note":"He said \\"hello\\"","vintage":2020}');
  });

  test('handles text before the JSON object', () => {
    // walkBraces starts scanning from index 0 and depth increments on first '{'
    // but characters before { are output because depth=0
    // The function slices from 0 to closing brace, so leading text is included
    const input = 'prefix {"name":"test"} suffix';
    const result = extractFirstJsonObject(input);
    // It slices from 0 to closing brace+1, so prefix is included
    expect(result).toBe('prefix {"name":"test"}');
  });

  test('handles arrays inside objects', () => {
    const input = '{"grapes":["Merlot","Cabernet"],"vintage":2020} more text';
    const result = extractFirstJsonObject(input);
    // Arrays use [] not {}, so they don't affect brace depth
    expect(result).toBe('{"grapes":["Merlot","Cabernet"],"vintage":2020}');
    const parsed = JSON.parse(result);
    expect(parsed.grapes).toEqual(['Merlot', 'Cabernet']);
  });

  test('empty string returns as-is', () => {
    expect(extractFirstJsonObject('')).toBe('');
  });
});

// ─── extractAiExplanation ────────────────────────────────────────────────────

describe('extractAiExplanation', () => {
  test('extracts text after JSON object', () => {
    const input = '{"name":"Merlot"} This is a great everyday red wine.';
    const result = extractAiExplanation(input);
    expect(result).toBe('This is a great everyday red wine.');
  });

  test('strips "Reason:" prefix', () => {
    const input = '{"name":"Merlot"} Reason: This wine pairs well with steak.';
    const result = extractAiExplanation(input);
    expect(result).toBe('This wine pairs well with steak.');
  });

  test('strips bold markdown "**Reason**:" prefix', () => {
    const input = '{"name":"Merlot"} **Reason**: A full-bodied red.';
    const result = extractAiExplanation(input);
    expect(result).toBe('A full-bodied red.');
  });

  test('returns null if no explanation after JSON', () => {
    const input = '{"name":"Merlot"}';
    const result = extractAiExplanation(input);
    expect(result).toBeNull();
  });

  test('returns null if only whitespace after JSON', () => {
    const input = '{"name":"Merlot"}   ';
    const result = extractAiExplanation(input);
    expect(result).toBeNull();
  });

  test('returns null for null input', () => {
    expect(extractAiExplanation(null)).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(extractAiExplanation('')).toBeNull();
  });

  test('returns null for undefined', () => {
    expect(extractAiExplanation(undefined)).toBeNull();
  });

  test('returns null when no balanced JSON object is found', () => {
    const input = 'Just plain text with no braces';
    const result = extractAiExplanation(input);
    expect(result).toBeNull();
  });

  test('handles case-insensitive "reason" prefix', () => {
    const input = '{"ok":true} REASON: Uppercase reason text.';
    const result = extractAiExplanation(input);
    expect(result).toBe('Uppercase reason text.');
  });
});
