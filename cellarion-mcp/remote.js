/* The bridge's connection to the remote Cellarion server and the requests it
 * proxies. Kept apart from index.js (which reads its config and connects when
 * it is loaded) so the reconnect rule can be tested with a fake client.
 */
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

// A tool call carrying an idempotency_key is safe to send twice: the server
// answers the repeat with the first call's stored result instead of acting again.
const hasIdempotencyKey = (params) =>
  typeof params?.arguments?.idempotency_key === 'string' && params.arguments.idempotency_key.length > 0;

export function makeRemote(connect) {
  let client = null;

  // A failure without an answer from the server (a plain Error: dropped
  // connection, a proxy's 502/504 on the POST) or a closed connection leaves
  // this client unusable, so it is dropped and the next request reconnects.
  // Such a failure says nothing about whether the server ran the request, so
  // it is sent once more on a fresh connection only when `resend` says a
  // repeat is harmless; otherwise the error goes back to the AI, which can
  // read back what happened before trying again. Any other McpError (an error
  // the server answered with, a request timeout) comes back as is and the
  // connection is kept.
  async function call(fn, { resend = false } = {}) {
    if (!client) client = await connect();
    const used = client;
    try {
      return await fn(used);
    } catch (err) {
      if (err instanceof McpError && err.code !== ErrorCode.ConnectionClosed) throw err;
      if (client === used) client = null;
      try { await used.close(); } catch { /* already dead */ }
      if (!resend) throw err;
      if (!client) client = await connect();
      return fn(client);
    }
  }

  return {
    async open() {
      client = await connect();
      return client;
    },
    async close() {
      const open = client;
      client = null;
      await open?.close();
    },
    listTools: (params) => call((c) => c.listTools(params), { resend: true }),
    callTool: (params) => call((c) => c.callTool(params), { resend: hasIdempotencyKey(params) }),
    listResources: (params) => call((c) => c.listResources(params), { resend: true }),
    listResourceTemplates: (params) => call((c) => c.listResourceTemplates(params), { resend: true }),
    readResource: (params) => call((c) => c.readResource(params), { resend: true }),
  };
}
