// What to tell a person when a request failed — in their language, and in
// words they can act on.
//
// Before this, screens showed whatever was at hand: `err.message` ("Failed to
// fetch", "Load failed", or "Unexpected token '<' … is not valid JSON" when a
// proxy answered a deploy-time 502 with an HTML page), the server's English
// sentence for a rate limit with no hint of how long to wait, or nothing.
//
//   friendlyError(err, t)            — a thrown error: apiJson's, httpError's,
//                                      one of the app's own, or fetch's own
//   await responseError(res, t)      — a non-OK Response still in hand
//   httpError(res, body, fallback)   — throw this for a non-OK Response, so the
//                                      catch block's friendlyError knows the status
//
// A 4xx with its own explanation (a validation refusal, "Bottle not found")
// keeps the server's words — those name the actual problem.

// The messages browsers put on a fetch that never reached the server.
const NETWORK_FAILURE = /failed to fetch|load failed|networkerror|network request failed|network error/i;

/** Seconds the server asked us to wait (Retry-After on a 429), else null. */
export function retryAfterSeconds(res) {
  const raw = res?.headers?.get?.('Retry-After');
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

export function messageForStatus(status, { body, retryAfter, fallback } = {}, t) {
  if (status === 429) {
    if (retryAfter) {
      const minutes = Math.max(1, Math.ceil(retryAfter / 60));
      return t('errors.rateLimitedFor', 'That was a lot of changes in a short time. Try again in {{minutes}} min.', { minutes });
    }
    return t('errors.rateLimited', 'That was a lot of changes in a short time. Wait a few minutes and try again.');
  }
  if (status >= 500) {
    return t('errors.serverUnavailable', 'Cellarion could not answer just now. Try again in a moment.');
  }
  const own = body && (body.error || body.message);
  if (typeof own === 'string' && own) return own;
  if (fallback) return fallback;
  return t('errors.generic', 'Something went wrong. Please try again.');
}

/** The Error to throw for a non-OK Response whose body was already read. */
export function httpError(res, body, fallback) {
  const err = new Error((body && (body.error || body.message)) || fallback || `Request failed (${res.status})`);
  err.status = res.status;
  err.body = body;
  const retryAfter = retryAfterSeconds(res);
  if (retryAfter) err.retryAfter = retryAfter;
  return err;
}

export function friendlyError(err, t) {
  if (err && typeof err.status === 'number') {
    return messageForStatus(err.status, { body: err.body, retryAfter: err.retryAfter, fallback: err.message }, t);
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

/** For a non-OK Response still in hand: reads its body once and words it. */
export async function responseError(res, t) {
  const body = await res.json().catch(() => null);
  return messageForStatus(res.status, { body, retryAfter: retryAfterSeconds(res) }, t);
}
