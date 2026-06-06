/**
 * Resolve an apiFetch (or src/api/* client) call to its parsed JSON body,
 * throwing on a non-2xx response.
 *
 * `apiFetch` — and the typed helpers in src/api/* that wrap it — resolve to a
 * raw `Response` and only reject on a network failure. Callers therefore have
 * to remember to check `res.ok` and call `res.json()` themselves; forgetting
 * either is silent, because a `Response` is always truthy. That footgun has
 * caused real bugs (e.g. treating the Response as the parsed body, or navigating
 * after a failed save). Pass the call's Response — or, more conveniently, its
 * Promise — here to get the body back or a thrown Error.
 *
 *   const { post } = await apiJson(createBlogPost(apiFetch, data));
 *   const data = await apiJson(apiFetch('/api/foo'));
 *
 * On a non-2xx response the thrown Error's message is taken from the body's
 * `error`/`message` field (falling back to the status code), and the Error
 * carries `.status` and `.body` for callers that need to branch on them.
 *
 * @param {Response|Promise<Response>} resOrPromise - an apiFetch call or its result
 * @returns {Promise<any>} parsed JSON body (null when the body is empty/invalid)
 * @throws {Error} on a non-2xx response; `.status` and `.body` are attached
 */
export async function apiJson(resOrPromise) {
  const res = await resOrPromise;
  // A 204 or an empty/invalid body shouldn't crash the caller — treat as null.
  const body = await res.json().catch(() => null);

  if (!res.ok) {
    const message =
      (body && (body.error || body.message)) || `Request failed (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    err.body = body;
    throw err;
  }

  return body;
}
