/**
 * Every `errors.codes.*` translation belongs to a code the server lists.
 *
 * WHY THIS TEST EXISTS:
 * A server error `{ error, code }` is shown in the person's language when
 * `errors.codes.<code>` exists (utils/friendlyError.js, messageForCode). Only
 * a code with one fixed meaning can be translated, and those are listed with
 * their English in backend/src/config/errorCodes.js. A key for a code that is
 * not listed (misspelt, renamed, or one the server sends with several
 * meanings) is refused here, and so is a translation that asks for a value
 * the English never names.
 */
import backendErrorCodes from '../../../backend/src/config/errorCodes.js';
import en from './en/translation.json';

const { ERROR_CODES } = backendErrorCodes;
const PLURAL = /_(zero|one|two|few|many|other)$/;
const placeholders = (sentence) => new Set([...sentence.matchAll(/\{\{\s*(\w+)/g)].map((m) => m[1]));

test('every translated error code is listed on the server', () => {
  const keys = Object.keys(en.errors.codes);
  expect(keys.length).toBeGreaterThan(0);
  expect(keys.map((key) => key.replace(PLURAL, '')).filter((code) => !(code in ERROR_CODES))).toEqual([]);
});

test('a translation only uses values the server sends with that code', () => {
  for (const [key, sentence] of Object.entries(en.errors.codes)) {
    const code = key.replace(PLURAL, '');
    // The values a code's English names are the ones every route sending it
    // must pass to errorBody(); anything else may be missing from the body.
    const sent = placeholders(ERROR_CODES[code] || '');
    const missing = [...placeholders(sentence)].filter((name) => !sent.has(name));
    expect({ key, missing }).toEqual({ key, missing: [] });
  }
});
