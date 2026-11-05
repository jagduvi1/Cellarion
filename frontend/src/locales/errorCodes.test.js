// @vitest-environment node
/**
 * Every `errors.codes.*` key names a code the server really sends.
 *
 * WHY THIS TEST EXISTS:
 * A server error `{ error, code }` is shown in the person's language when
 * `errors.codes.<code>` exists (utils/friendlyError.js, messageForCode). A key
 * whose code is misspelt, renamed or removed on the server is never shown, yet
 * translators keep translating it. This reads the backend source and fails on
 * such a key.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import en from './en/translation.json';

const BACKEND_SRC = fileURLToPath(new URL('../../../backend/src', import.meta.url));

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
    return entry.name.endsWith('.js') && !entry.name.endsWith('.test.js') ? [path] : [];
  });
}

const sentCodes = new Set(
  sourceFiles(BACKEND_SRC).flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(/\bcode:\s*['"](\w+)['"]/g)].map((m) => m[1]))
);

test('every translated error code is one the server sends', () => {
  const keys = Object.keys(en.errors.codes);
  expect(keys.length).toBeGreaterThan(0);
  expect(keys.filter((code) => !sentCodes.has(code))).toEqual([]);
});

test('error code keys are plain codes with a sentence each', () => {
  for (const [code, sentence] of Object.entries(en.errors.codes)) {
    expect(code).toMatch(/^\w+$/);
    // Weblate reads a key ending like this as a plural family and adds empty forms.
    expect(code).not.toMatch(/_(zero|one|two|few|many|other)$/);
    expect(typeof sentence).toBe('string');
    expect(sentence.trim()).not.toBe('');
  }
});
