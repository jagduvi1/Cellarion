import i18next from 'i18next';
import { friendlyError, responseError, httpError, messageForStatus, messageForCode } from './friendlyError';

// t returns the inline English (with {{minutes}} filled in) so the assertions
// read as what a person sees.
const t = (key, fallback, opts) => String(fallback).replace('{{minutes}}', opts?.minutes);

const response = (status, body, headers = {}) => ({
  ok: status < 400,
  status,
  headers: { get: (name) => headers[name] ?? null },
  json: async () => {
    if (body instanceof Error) throw body;
    return body;
  },
});

describe('friendlyError', () => {
  test('a fetch that never reached the server is a connection problem, not "Failed to fetch"', () => {
    expect(friendlyError(new TypeError('Failed to fetch'), t)).toMatch(/could not be reached/);
    expect(friendlyError(new TypeError('Load failed'), t)).toMatch(/could not be reached/);
  });

  test("a proxy's HTML error page is the server being unavailable, not a JSON parse error", () => {
    expect(friendlyError(new SyntaxError("Unexpected token '<', \"<html>\" is not valid JSON"), t))
      .toMatch(/could not answer just now/);
  });

  test("the app's own errors keep their words; a crash's wording is never shown", () => {
    expect(friendlyError(new Error('The weekly export allowance is used up.'), t)).toBe('The weekly export allowance is used up.');
    expect(friendlyError(new TypeError("Cannot read properties of undefined (reading 'items')"), t))
      .toBe('Something went wrong. Please try again.');
  });

  test('a rate limit says how long to wait when the server said so', () => {
    const err = httpError(response(429, null, { 'Retry-After': '540' }), { error: 'Too many write requests' });
    expect(friendlyError(err, t)).toMatch(/Try again in 9 min/);
  });

  test("a refused request keeps the server's own reason", () => {
    const err = httpError(response(400, null), { error: 'Rack is full' }, 'fallback');
    expect(friendlyError(err, t)).toBe('Rack is full');
  });

  test('a 5xx never shows the server text', () => {
    const err = httpError(response(502, null), { error: 'upstream connect error' });
    expect(friendlyError(err, t)).toMatch(/could not answer just now/);
  });
});

describe('responseError', () => {
  test('reads a Response once and words it, even when the body is not JSON', async () => {
    expect(await responseError(response(503, new SyntaxError('bad')), t)).toMatch(/could not answer/);
    expect(await responseError(response(429, {}), t)).toMatch(/Wait a few minutes/);
  });
});

describe('messageForStatus', () => {
  test('falls back to the given message, then a generic one', () => {
    expect(messageForStatus(404, { fallback: 'The rack could not be deleted.' }, t)).toBe('The rack could not be deleted.');
    expect(messageForStatus(404, {}, t)).toBe('Something went wrong. Please try again.');
  });
});

describe('rate limits', () => {
  test('a 429 that names its own limit keeps those words', () => {
    const err = httpError(response(429, null, { 'Retry-After': '3000' }), { error: 'Account exports are limited to three per hour' });
    expect(friendlyError(err, t)).toBe('Account exports are limited to three per hour');
  });

  test('a short wait is "a few seconds", not "1 min"', () => {
    const err = httpError(response(429, null, { 'Retry-After': '10' }), { error: 'Too many requests, please try again later' });
    expect(friendlyError(err, t)).toMatch(/Try again in a few seconds/);
  });
});

test("httpError's own message is for logs: a 4xx without a reason is never \"Request failed (404)\"", () => {
  expect(friendlyError(httpError(response(404, null), null), t)).toBe('Something went wrong. Please try again.');
  expect(friendlyError(httpError(response(404, null), null, 'The entry could not be deleted.'), t)).toBe('The entry could not be deleted.');
});

describe('coded errors', () => {
  // A t that knows two codes and otherwise behaves like the one above.
  const coded = (key, fallback, opts) => ({
    'errors.codes.invalid_credentials': 'Feil brukernavn eller passord.',
    'errors.codes.key_cap': `Du kan ha ${opts?.max} nøkler.`,
  })[key] ?? t(key, fallback, opts);

  test("a code with a translation is said in the person's language, filled from the body", () => {
    const err = httpError(response(401, null), { error: 'Invalid credentials', code: 'invalid_credentials' });
    expect(friendlyError(err, coded)).toBe('Feil brukernavn eller passord.');
    expect(messageForCode({ error: 'Maximum of 3 keys', code: 'key_cap', max: 3 }, coded)).toBe('Du kan ha 3 nøkler.');
  });

  test("a code without a translation keeps the server's words", () => {
    const err = httpError(response(409, null), { error: 'This bottle has already left the cellar', code: 'state_changed' });
    expect(friendlyError(err, coded)).toBe('This bottle has already left the cellar');
  });

  test('a translated code wins over the generic rate-limit and outage wording', () => {
    expect(messageForStatus(429, { body: { error: 'Too many requests', code: 'invalid_credentials' } }, coded))
      .toBe('Feil brukernavn eller passord.');
    expect(messageForStatus(503, { body: { error: 'x', code: 'invalid_credentials' } }, coded))
      .toBe('Feil brukernavn eller passord.');
  });

  test('a t that answers with the key (a test stub, a missing key) counts as no translation', () => {
    const identity = (key) => key;
    expect(messageForCode({ error: 'Invalid credentials', code: 'invalid_credentials' }, identity)).toBeNull();
  });

  test('only plain codes are looked up, and body fields never become i18next options', () => {
    const seen = [];
    const spy = (key, fallback, opts) => { seen.push([key, opts]); return ''; };
    expect(messageForCode({ code: 'a.b' }, spy)).toBeNull();
    expect(messageForCode({ code: 'x', lng: 'de', max: 2, nested: { a: 1 } }, spy)).toBeNull();
    expect(seen).toEqual([['errors.codes.x', { code: 'x', max: 2 }]]);
  });

  test('with real i18next: a missing key is null, a language without the key falls back to English', async () => {
    const i18n = i18next.createInstance();
    await i18n.init({
      lng: 'nb',
      fallbackLng: 'en',
      resources: { en: { translation: { errors: { codes: { key_cap: 'At most {{max}} keys.' } } } }, nb: { translation: {} } },
      interpolation: { escapeValue: false },
    });
    const realT = i18n.t.bind(i18n);
    expect(messageForCode({ code: 'key_cap', max: 3 }, realT)).toBe('At most 3 keys.');
    expect(messageForCode({ code: 'not_translated' }, realT)).toBeNull();
  });
});
