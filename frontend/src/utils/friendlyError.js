// What to tell a person when a request failed — in their language, and in
// words they can act on.
//
// Before this, screens showed whatever was at hand: `err.message` ("Failed to
// fetch", "Load failed", or "Unexpected token '<' … is not valid JSON" when a
// proxy answered a deploy-time 502 with an HTML page), the server's English
// sentence for a rate limit with no hint of how long to wait, or nothing.
//
//   friendlyError(err, t)                       — a thrown error: apiJson's,
//                                                 httpError's, one of the app's
//                                                 own, or fetch's own
//   messageForResponse(res, body, fallback, t)  — a non-OK Response whose body
//                                                 was already read
//   await responseError(res, t)                 — a non-OK Response still unread
//   httpError(res, body, fallback)              — throw this for a non-OK
//                                                 Response, so the catch block's
//                                                 friendlyError knows the status
//   messageForCode(body, t)                     — the translation of a coded
//                                                 error, or null (the others
//                                                 all try it first)
//
// A 4xx with its own explanation (a validation refusal, "Bottle not found")
// keeps the server's words — those name the actual problem — unless it also
// carries a `code` that has a translation (messageForCode below).

// The messages browsers put on a fetch that never reached the server.
const NETWORK_FAILURE = /failed to fetch|load failed|networkerror|network request failed|network error/i;

// The rate limiters' catch-all wording ("Too many requests, please try again
// later"), as opposed to a 429 that names its own limit ("Account exports are
// limited to three per hour", "Another import is already being processed").
// Only the catch-all is replaced; a specific one says more than we could.
const GENERIC_LIMIT = /^too many (write |refresh )?(requests|attempts)\b/i;

/** Seconds the server asked us to wait (Retry-After on a 429), else null. */
export function retryAfterSeconds(res) {
  const raw = res?.headers?.get?.('Retry-After');
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

// i18next options, which a field of the error body must not be passed as.
const I18N_OPTIONS = new Set([
  'lng', 'lngs', 'fallbackLng', 'ns', 'context', 'defaultValue', 'replace', 'returnObjects',
  'returnDetails', 'joinArrays', 'postProcess', 'interpolation', 'keyPrefix', 'ordinal',
]);

/**
 * The person's-language sentence for a coded server error, or null.
 *
 * The server answers `{ error, code }`: `error` is English and stays (API
 * clients read it), `code` is a stable snake_case reason. When
 * `errors.codes.<code>` exists, that sentence replaces the English one, filled
 * from the body's other fields (`{{max}}` reads `max`). A code without a key
 * keeps the server's words, so codes can be added on the server first. Give a
 * code a key only when it means the same thing everywhere it is sent.
 */
export function messageForCode(body, t) {
  const code = body && body.code;
  if (typeof code !== 'string' || !/^\w+$/.test(code)) return null;
  const values = {};
  for (const [name, value] of Object.entries(body)) {
    if (!I18N_OPTIONS.has(name) && (typeof value === 'string' || typeof value === 'number')) values[name] = value;
  }
  const key = `errors.codes.${code}`;
  const message = t(key, '', values);
  return message && message !== key ? message : null;
}

export function messageForStatus(status, { body, retryAfter, fallback } = {}, t) {
  const coded = messageForCode(body, t);
  if (coded) return coded;
  const own = body && (body.error || body.message);
  const hasOwn = typeof own === 'string' && own !== '';
  if (status === 429) {
    if (hasOwn && !GENERIC_LIMIT.test(own)) return own;
    if (retryAfter && retryAfter < 60) {
      return t('errors.rateLimitedSoon', 'Too many requests in a short time. Try again in a few seconds.');
    }
    if (retryAfter) {
      const minutes = Math.ceil(retryAfter / 60);
      return t('errors.rateLimitedFor', 'Too many requests in a short time. Try again in {{minutes}} min.', { minutes });
    }
    return t('errors.rateLimited', 'Too many requests in a short time. Wait a few minutes and try again.');
  }
  if (status >= 500) {
    return t('errors.serverUnavailable', 'Cellarion could not answer just now. Try again in a moment.');
  }
  if (hasOwn) return own;
  if (fallback) return fallback;
  return t('errors.generic', 'Something went wrong. Please try again.');
}

/** A non-OK Response whose body was already read, worded for the person. */
export function messageForResponse(res, body, fallback, t) {
  return messageForStatus(res.status, { body, retryAfter: retryAfterSeconds(res), fallback }, t);
}

/**
 * The Error to throw for a non-OK Response whose body was already read.
 * `fallback` (already translated) is what to say when the server gave no
 * reason; the Error's own message is for logs only and never shown.
 */
export function httpError(res, body, fallback) {
  const err = new Error((body && (body.error || body.message)) || `Request failed (${res.status})`);
  err.status = res.status;
  err.body = body;
  if (fallback) err.fallback = fallback;
  const retryAfter = retryAfterSeconds(res);
  if (retryAfter) err.retryAfter = retryAfter;
  return err;
}

export function friendlyError(err, t) {
  if (err && typeof err.status === 'number') {
    return messageForStatus(err.status, { body: err.body, retryAfter: err.retryAfter, fallback: err.fallback }, t);
  }
  // A body that was not JSON: a proxy's HTML error page while the server restarts.
  if (err instanceof SyntaxError) {
    return t('errors.serverUnavailable', 'Cellarion could not answer just now. Try again in a moment.');
  }
  if (NETWORK_FAILURE.test(String(err?.message || ''))) {
    return t('errors.network', 'Cellarion could not be reached. Check your connection and try again.');
  }
  // One of the app's own (`new Error(t('…'))`) already says what happened. A
  // TypeError or other built-in is a crash's wording, never shown as is.
  if (err && err.constructor === Error && err.message) return err.message;
  return t('errors.generic', 'Something went wrong. Please try again.');
}

/** For a non-OK Response still unread: reads its body once and words it. */
export async function responseError(res, t) {
  const body = await res.json().catch(() => null);
  return messageForResponse(res, body, undefined, t);
}
