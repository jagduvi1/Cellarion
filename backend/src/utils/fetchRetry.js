/**
 * Shared fetch retry/backoff helper for outbound AI-provider calls
 * (Voyage / OpenAI-compatible LLM + embedding endpoints).
 *
 * One implementation so retry-after parsing, backoff caps, and error shaping
 * can't drift between the chat path (services/aiProvider.js) and the
 * embedding path (services/embedding.js).
 *
 * Behaviour:
 *  - retries responses matching `retryable` (default: 429 only) up to
 *    `maxRetries`, honouring a numeric Retry-After header (unparseable or
 *    date-format values fall back to the backoff delay) and capping every
 *    wait at `maxWaitMs` so a hostile/huge header can't park a request
 *  - cancels the body of a response it is about to retry, so the pooled
 *    undici connection is released instead of being held until GC
 *  - maps TimeoutError/AbortError to a plain Error with status 504 and a
 *    "<label> request timed out after <ms>ms" message
 *  - shapes terminal HTTP errors as Object.assign(new Error, { status,
 *    headers }) with the body truncated to 500 chars
 */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function responseError(res, label) {
  let body = '';
  try { body = await res.text(); } catch (_) { /* ignore */ }
  return Object.assign(
    new Error(`${label} error ${res.status}: ${body.slice(0, 500)}`),
    { status: res.status, headers: res.headers }
  );
}

/**
 * Run `doFetch` until it returns an ok Response, retrying retryable statuses.
 *
 * @param {() => Promise<Response>} doFetch – performs one attempt
 * @param {object}   opts
 * @param {number}   [opts.maxRetries=2]  – retry budget for retryable statuses
 * @param {number}   [opts.timeoutMs]     – used only in the timeout error message
 * @param {string}   [opts.label='AI']    – provider name for error messages
 * @param {(status: number) => boolean} [opts.retryable] – which statuses retry (default 429 only)
 * @param {number}   [opts.maxWaitMs=64000] – hard cap on any single wait
 * @param {(waitMs: number, attempt: number) => void} [opts.onRetry] – observability hook
 * @returns {Promise<Response>} the ok response
 */
async function fetchWithRetry(doFetch, {
  maxRetries = 2,
  timeoutMs,
  label = 'AI',
  retryable = (status) => status === 429,
  maxWaitMs = 64000,
  onRetry,
} = {}) {
  let delay = 2000; // ms — initial backoff

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res;
    try {
      res = await doFetch();
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw Object.assign(
          new Error(`${label} request timed out after ${timeoutMs}ms`),
          { status: 504 }
        );
      }
      throw err;
    }

    if (res.ok) return res;

    if (retryable(res.status) && attempt < maxRetries) {
      // Honour a numeric Retry-After; date-format or garbage values fall back
      // to the backoff delay. Cap every wait — a huge header must not park
      // the caller (label-scan imports hold budget slots while waiting).
      const retryAfter = parseInt(res.headers.get('retry-after'), 10);
      let waitMs = retryAfter > 0
        ? retryAfter * 1000
        : delay + Math.floor(Math.random() * 500);
      waitMs = Math.min(waitMs, maxWaitMs);

      // Release the pooled connection before sleeping — an unread error body
      // keeps the undici socket reserved until GC.
      try { await res.body?.cancel?.(); } catch (_) { /* ignore */ }

      // Observability only — a throwing hook must not abort the retry loop.
      if (onRetry) { try { onRetry(waitMs, attempt + 1); } catch (_) { /* ignore */ } }
      await sleep(waitMs);
      delay = Math.min(delay * 2, maxWaitMs);
      continue;
    }

    throw await responseError(res, label);
  }

  // Unreachable: the final attempt either returned or threw above.
  throw Object.assign(new Error(`${label}: retries exhausted`), { status: 429 });
}

module.exports = { fetchWithRetry, sleep };
