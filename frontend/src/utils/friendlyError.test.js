import { friendlyError, responseError, httpError, messageForStatus } from './friendlyError';

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
