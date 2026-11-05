// The registry of error codes with one fixed meaning (config/errorCodes.js):
// the body a route sends, the naming rules a translation depends on, and that
// every errorBody() call names a listed code and every listed code is sent.
const fs = require('fs');
const path = require('path');
const { ERROR_CODES, errorBody } = require('./errorCodes');

const SRC = path.join(__dirname, '..');
// The registry's own header shows errorBody() in an example; that is not a route sending it.
const REGISTRY = path.join(__dirname, 'errorCodes.js');

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(full);
    return entry.name.endsWith('.js') && !entry.name.endsWith('.test.js') && full !== REGISTRY ? [full] : [];
  });
}

const calls = sourceFiles(SRC).flatMap((file) =>
  [...fs.readFileSync(file, 'utf8').matchAll(/\berrorBody\(\s*(['"`])(.*?)\1/g)].map((m) => ({ file, code: m[2] })));

describe('errorBody', () => {
  test('sends the listed English with its code', () => {
    expect(errorBody('invalid_credentials')).toEqual({ error: 'Invalid credentials', code: 'invalid_credentials' });
  });

  test('sends extra fields along, filling any {{name}} in the sentence', () => {
    expect(errorBody('EMAIL_NOT_VERIFIED', { email: 'anna@example.com' })).toEqual({
      error: 'Please verify your email address before logging in.',
      code: 'EMAIL_NOT_VERIFIED',
      email: 'anna@example.com',
    });
  });

  test('refuses a code that is not listed', () => {
    expect(() => errorBody('no_such_code')).toThrow(/Unknown error code/);
  });
});

describe('the registry', () => {
  test('codes are plain, start with a letter and never look like a plural family', () => {
    for (const [code, sentence] of Object.entries(ERROR_CODES)) {
      expect(code).toMatch(/^[A-Za-z]\w*$/);
      expect(code).not.toMatch(/_(zero|one|two|few|many|other)$/);
      expect(typeof sentence).toBe('string');
      expect(sentence.trim()).not.toBe('');
    }
  });

  test('every errorBody() call names a listed code', () => {
    expect(calls.length).toBeGreaterThan(0);
    const unknown = calls.filter((c) => !(c.code in ERROR_CODES)).map((c) => `${path.relative(SRC, c.file)}: ${c.code}`);
    expect(unknown).toEqual([]);
  });

  test('every listed code is sent somewhere', () => {
    const sent = new Set(calls.map((c) => c.code));
    expect(Object.keys(ERROR_CODES).filter((code) => !sent.has(code))).toEqual([]);
  });
});
