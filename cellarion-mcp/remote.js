/* The bridge's connection to the remote Cellarion server and the requests it
 * proxies. Kept apart from index.js (which reads its config and connects when
 * it is loaded) so the reconnect rule can be tested with a fake client.
 */
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// A tool call carrying an idempotency_key is safe to send twice: the server
// answers the repeat with the first call's stored result instead of acting again.
const hasIdempotencyKey = (params) =>
  typeof params?.arguments?.idempotency_key === 'string' && params.arguments.idempotency_key.length > 0;

// The server answers HTTP 404 when the session a request names has expired or
// is unknown to it (idle or age limit, a server restart), and it does so
// before running anything. The SDK raises it as a StreamableHTTPError whose
// code is the HTTP status.
const sessionGone = (err) => err instanceof StreamableHTTPError && err.code === 404;

export function makeRemote(connect) {
  let client = null;
  // The connect() under way, shared by every caller that needs a client in
  // the meantime: two calls failing at the same moment open one new
  // connection, not two (the second would replace the first and leak it).
  let connecting = null;

  function connected() {
    if (client) return Promise.resolve(client);
    if (!connecting) {
      connecting = connect()
        .then((c) => { client = c; return c; })
        .finally(() => { connecting = null; });
    }
    return connecting;
  }

  // Tools the server marks readOnlyHint: true in the tool lists proxied so
  // far. A call to one of them only reads, so it is safe to send twice. A tool
  // the bridge has not seen listed as read-only counts as a write. Kept across
  // reconnects: the list belongs to the server, not to one connection.
  let readOnlyTools = new Set();

  function rememberReadOnly(params, result) {
    const names = (result?.tools || [])
      .filter((t) => t?.annotations?.readOnlyHint === true && typeof t.name === 'string')
      .map((t) => t.name);
    // A list without a cursor starts a full list; a later page adds to it.
    if (params?.cursor) names.forEach((name) => readOnlyTools.add(name));
    else readOnlyTools = new Set(names);
  }

  // A failure without an answer from the server (a plain Error: dropped
  // connection, a proxy's 502/504 on the POST) or a closed connection leaves
  // this client unusable, so it is dropped and the next request reconnects.
  // Such a failure says nothing about whether the server ran the request, so
  // it is sent once more on a fresh connection only when `resend` says a
  // repeat is harmless; otherwise the error goes back to the AI, which can
  // read back what happened before trying again. An expired session (404) is
  // the exception: nothing ran, so the request is always sent once more on a
  // fresh session. A 401 or 429 also comes before anything runs, but a fresh
  // session gets the same answer, so those follow the general rule. Any other
  // McpError (an error the server answered with, a request timeout) comes
  // back as is and the connection is kept.
  async function call(fn, { resend = false } = {}) {
    const used = await connected();
    try {
      return await fn(used);
    } catch (err) {
      if (err instanceof McpError && err.code !== ErrorCode.ConnectionClosed) throw err;
      if (client === used) client = null;
      try { await used.close(); } catch { /* already dead */ }
      if (!resend && !sessionGone(err)) throw err;
      return fn(await connected());
    }
  }

  return {
    open: connected,
    async close() {
      const open = client;
      client = null;
      await open?.close();
    },
    async listTools(params) {
      const result = await call((c) => c.listTools(params), { resend: true });
      rememberReadOnly(params, result);
      return result;
    },
    callTool: (params) => call((c) => c.callTool(params), {
      resend: hasIdempotencyKey(params) || readOnlyTools.has(params?.name),
    }),
    listResources: (params) => call((c) => c.listResources(params), { resend: true }),
    listResourceTemplates: (params) => call((c) => c.listResourceTemplates(params), { resend: true }),
    readResource: (params) => call((c) => c.readResource(params), { resend: true }),
  };
}
