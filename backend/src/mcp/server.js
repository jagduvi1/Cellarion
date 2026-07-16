const { toolsForScopes, resourcesForScopes } = require('./registry');
const { INSTRUCTIONS } = require('./instructions');
const pkg = require('../../package.json');
require('./tools');     // register all tools (side-effect)
require('./resources'); // register all resources (side-effect)

// The MCP SDK is ESM-only (`type: module`), so this CommonJS module loads it via
// dynamic import() and caches the classes. Loaded lazily (first request) so the
// backend boot doesn't pay for it and tests can require this module freely.
let sdkPromise;
function loadSdk() {
  if (!sdkPromise) {
    sdkPromise = Promise.all([
      import('@modelcontextprotocol/sdk/server/mcp.js'),
      import('@modelcontextprotocol/sdk/server/streamableHttp.js'),
    ]).then(([mcp, http]) => ({
      McpServer: mcp.McpServer,
      ResourceTemplate: mcp.ResourceTemplate,
      StreamableHTTPServerTransport: http.StreamableHTTPServerTransport,
    })).catch((err) => {
      // Never cache a rejected import. A transient first-load failure (e.g.
      // EMFILE under load) would otherwise poison every future /api/mcp request
      // until a process restart; clearing the cache lets the next request retry.
      sdkPromise = undefined;
      throw err;
    });
  }
  return sdkPromise;
}

// A JSON-RPC body may be a BATCH (array) of calls, so one HTTP request can fan
// out to many tool invocations — and /api/mcp is exempt from the write limiter
// while apiLimiter counts requests, not calls. This per-request budget caps that
// amplification: generous for a legitimate agent turn, far below abuse scale.
const MAX_CALLS_PER_REQUEST = 20;

const rateLimited = (message) => ({
  isError: true,
  content: [{ type: 'text', text: JSON.stringify({ error: { code: 'rate_limited', message } }) }],
});

// MUTATING tools additionally ride the same per-user budget as REST writes
// (the admin-tunable write limiter number, per 15 minutes). /api/mcp is exempt
// from the HTTP writeLimiter because one POST can't be classified — so the
// classification happens HERE, per tool call, where readOnlyHint tells us the
// truth. An agent looping consumes hits exactly the wall a looping REST client
// would. Batch tools (bulk_add) charge one slot PER ITEM through the same
// module, so a case of 12 costs 12 — see mcp/mutationBudget.js.
const { takeMutationSlot, WRITE_WINDOW_MS } = require('./mutationBudget');

// Wrap a tool handler with the per-request call budget (+ the per-user
// mutation budget for non-read-only tools). `state` is shared by all tools of
// ONE request's server instance (fresh per request in stateless mode).
// Exported for unit testing — jest cannot load the ESM SDK, so buildServer
// itself is covered by the smoke test instead.
function budgetedHandler(tool, ctx, state) {
  return (args) => {
    state.calls += 1;
    if (state.calls > MAX_CALLS_PER_REQUEST) {
      return rateLimited(`Too many tool calls in one request (max ${MAX_CALLS_PER_REQUEST}). Send fewer calls per batch and paginate instead.`);
    }
    if (tool.annotations?.readOnlyHint === false && !takeMutationSlot(String(ctx.user.id))) {
      return rateLimited('Too many cellar changes in a short time — wait a few minutes before mutating again. Reads still work.');
    }
    return tool.handler(args || {}, ctx);
  };
}

// Build a per-request MCP server exposing ONLY the tools the caller's token
// scopes allow. Because a disallowed tool is never registered on this server, it
// is not merely hidden from tools/list — it is uncallable (a tools/call for it
// gets "unknown tool"). So scope enforcement is structural, not a filter a
// client could talk around. ctx = { user, scopes }.
async function buildServer(ctx) {
  const { McpServer, ResourceTemplate } = await loadSdk();
  const server = new McpServer(
    { name: 'cellarion', version: pkg.version },
    { instructions: INSTRUCTIONS }
  );
  const state = { calls: 0 };
  for (const tool of toolsForScopes(ctx.scopes, ctx.user?.roles || [])) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      budgetedHandler(tool, ctx, state)
    );
  }
  // Resources ride the same structural scope gate and the same per-request
  // call budget as tools (a resources/read does comparable DB work).
  for (const rsrc of resourcesForScopes(ctx.scopes)) {
    const meta = { title: rsrc.title, description: rsrc.description, mimeType: rsrc.mimeType };
    const wrapped = budgetedResourceHandler(rsrc, ctx, state);
    if (rsrc.uriTemplate) {
      server.registerResource(rsrc.name, new ResourceTemplate(rsrc.uriTemplate, { list: undefined }), meta, wrapped);
    } else {
      server.registerResource(rsrc.name, rsrc.uri, meta, wrapped);
    }
  }
  return server;
}

// Resource variant of budgetedHandler. SDK callbacks: static resources get
// (uri, extra); template resources get (uri, variables, extra). Over budget we
// throw — the SDK surfaces it as a JSON-RPC error for resources/read (there is
// no isError envelope for resources like there is for tool results).
function budgetedResourceHandler(rsrc, ctx, state) {
  return (uri, varsOrExtra) => {
    state.calls += 1;
    if (state.calls > MAX_CALLS_PER_REQUEST) {
      throw new Error(`rate_limited: too many calls in one request (max ${MAX_CALLS_PER_REQUEST})`);
    }
    const params = rsrc.uriTemplate ? (varsOrExtra || {}) : {};
    return rsrc.handler(uri, params, ctx);
  };
}

// Serve one stateless Streamable HTTP request. A fresh server + transport per
// request (no held session) is the cheapest mode and suits read-mostly use;
// both are torn down when the response closes so nothing leaks between requests.
async function handleMcpRequest(req, res, ctx) {
  const { StreamableHTTPServerTransport } = await loadSdk();
  const server = await buildServer(ctx);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    // transport.close() and server.close() are async — a synchronous try/catch
    // cannot swallow a rejected promise, and Node 20's default policy turns an
    // unhandled rejection on this per-request hot path into a process crash.
    // `.then(fn).catch()` captures both a synchronous throw and a rejection.
    // server.close() also closes the transport, so closing both is intentionally
    // idempotent (the second close is a harmless no-op) — defensive in case a
    // future SDK version stops cascading.
    Promise.resolve().then(() => transport.close()).catch(() => {});
    Promise.resolve().then(() => server.close()).catch(() => {});
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

// buildServer/loadSdk are internal; the budget wrappers are exported for unit
// tests (jest cannot load the ESM SDK, so buildServer is covered by smoke.js).
module.exports = {
  handleMcpRequest,
  budgetedHandler, budgetedResourceHandler, MAX_CALLS_PER_REQUEST,
  takeMutationSlot, WRITE_WINDOW_MS,
};
