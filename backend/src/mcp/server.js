const { toolsForScopes, resourcesForScopes, promptsForScopes } = require('./registry');
const { INSTRUCTIONS, PUBLIC_INSTRUCTIONS } = require('./instructions');
const pkg = require('../../package.json');
require('./tools');     // register all tools (side-effect)
require('./resources'); // register all resources (side-effect)
require('./prompts');   // register all prompts (side-effect)

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
const { takeMutationSlot, ipKeyFor, WRITE_WINDOW_MS } = require('./mutationBudget');
// Cross-request tool-call budget per caller (user id / anon IP) — caps read
// amplification the per-request cap and per-IP HTTP limiter can't (M-4).
const { withinCallBudget } = require('./callBudget');

const callBudgetExceeded = () =>
  rateLimited('Too many Cellarion tool calls in a short time — pause a moment and continue. This protects the shared service.');

// Aggregate usage counters behind the admin view (GET /api/admin/mcp/usage).
// record() is fire-and-forget and no-ops without a live Mongo connection, so
// the directly-unit-tested wrappers below stay pure in jest.
const McpUsageStat = require('../models/McpUsageStat');
function recordUsage(ctx, kind, name, error) {
  McpUsageStat.record({ surface: ctx.anonymous ? 'public' : 'personal', kind, name, error });
}

// Run a handler and count it into McpUsageStat WITHOUT changing its calling
// convention: a sync value stays a sync value, a sync throw stays a sync
// throw, a promise gets its settlement recorded in passing. Prompt handlers
// are pure/synchronous and their tests pin that — wrapping everything in a
// promise here would silently break them.
function withUsage(ctx, kind, name, run, isError = () => false) {
  let out;
  try {
    out = run();
  } catch (err) {
    recordUsage(ctx, kind, name, true);
    throw err;
  }
  if (out && typeof out.then === 'function') {
    return out.then(
      (v) => { recordUsage(ctx, kind, name, !!isError(v)); return v; },
      (err) => { recordUsage(ctx, kind, name, true); throw err; }
    );
  }
  recordUsage(ctx, kind, name, !!isError(out));
  return out;
}

// Wrap a tool handler with the per-request call budget (+ the per-user
// mutation budget for non-read-only tools). `state` is shared by all tools of
// ONE request's server instance (fresh per request in stateless mode).
// Exported for unit testing — jest cannot load the ESM SDK, so buildServer
// itself is covered by the smoke test instead.
// Every exit path is counted into McpUsageStat (budget refusals included —
// an admin diagnosing "why does my AI keep failing" needs to see them). The
// wrapper stays synchronous on the refusal paths — callers (and tests) rely
// on the original sync-value / sync-throw semantics.
function budgetedHandler(tool, ctx, state) {
  return (args) => {
    state.calls += 1;
    const maxCalls = state.max || MAX_CALLS_PER_REQUEST;
    if (state.calls > maxCalls) {
      recordUsage(ctx, 'tool', tool.name, true);
      return rateLimited(`Too many tool calls in one request (max ${maxCalls}). Send fewer calls per batch and paginate instead.`);
    }
    // Cross-request caller budget — bounds read amplification (M-4).
    if (!withinCallBudget(ctx)) {
      recordUsage(ctx, 'tool', tool.name, true);
      return callBudgetExceeded();
    }
    if (tool.annotations?.readOnlyHint === false) {
      // Fail-closed for the anonymous surface (audit P6-L2): if a mutating
      // tool is ever mis-scoped 'public', refuse cleanly instead of running a
      // userless mutation (and crashing on ctx.user.id below).
      if (ctx.anonymous || !ctx.user) {
        recordUsage(ctx, 'tool', tool.name, true);
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: { code: 'forbidden_scope', message: 'Mutations need an authenticated connection.' } }) }],
        };
      }
      if (!takeMutationSlot(String(ctx.user.id), 1, ipKeyFor(ctx))) {
        recordUsage(ctx, 'tool', tool.name, true);
        return rateLimited('Too many cellar changes in a short time — wait a few minutes before mutating again. Reads still work.');
      }
    }
    const run = withUsage(ctx, 'tool', tool.name, () => tool.handler(args || {}, ctx), (out) => out && out.isError);
    // Idempotency-claim hygiene (prior-audit M2): replay() reserves the key
    // BEFORE the mutation; a call that then fails never reaches logAction, so
    // its pending claim must be dropped here or the key stays locked until the
    // stale window. One place instead of a release call in every tool's every
    // fail path. Success paths are untouched (logAction completed the claim).
    const key = args?.idempotency_key;
    if (key && ctx.user && run && typeof run.then === 'function') {
      const { releaseClaim } = require('./actionLedger');
      return run.then(
        // idempotencyBusy = the error IS the idempotency conflict — a live
        // twin owns the claim; deleting it here would unlock a double-exec.
        async (out) => { if (out && out.isError && !out.idempotencyBusy) await releaseClaim(ctx, key); return out; },
        async (err) => { await releaseClaim(ctx, key); throw err; }
      );
    }
    return run;
  };
}

// Build a per-request MCP server exposing ONLY the tools the caller's token
// scopes allow. Because a disallowed tool is never registered on this server, it
// is not merely hidden from tools/list — it is uncallable (a tools/call for it
// gets "unknown tool"). So scope enforcement is structural, not a filter a
// client could talk around. ctx = { user, scopes }.
//
// opts.session (mcp/sessions.js) switches on STATEFUL extras: the resources
// subscribe capability + handlers wired to the event bus (plan §4), and an
// externally-owned call-budget state that the route resets per request (a
// long-lived session must budget per REQUEST, not per lifetime).
async function buildServer(ctx, opts = {}) {
  const { McpServer, ResourceTemplate } = await loadSdk();
  const server = new McpServer(
    // The anonymous surface announces itself distinctly — different name and
    // instructions, so a client connected to both never confuses the two.
    { name: ctx.anonymous ? 'cellarion-public' : 'cellarion', version: pkg.version },
    {
      instructions: ctx.anonymous ? PUBLIC_INSTRUCTIONS : INSTRUCTIONS,
      ...(opts.session ? { capabilities: { resources: { subscribe: true, listChanged: false } } } : {}),
    }
  );
  const state = opts.callState || { calls: 0 };
  // The anonymous surface gets a tighter per-request batch budget (audit
  // P6-L3): 20 read_guide calls at the 30k cap would be ~600KB from one
  // unauthenticated 10KB request. Authenticated callers keep the full cap.
  if (ctx.anonymous) state.max = 10;
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
  // Prompts: static workflow templates behind the same structural scope gate.
  // Handlers are pure (no DB), but they still count against the per-request
  // call budget so a batched prompts/get flood is bounded like everything else.
  for (const prompt of promptsForScopes(ctx.scopes)) {
    server.registerPrompt(
      prompt.name,
      { title: prompt.title, description: prompt.description, argsSchema: prompt.argsSchema },
      budgetedPromptHandler(prompt, ctx, state)
    );
  }
  if (opts.session) await wireSubscriptions(server, ctx, opts.session);
  return server;
}

// Which event-bus events invalidate which subscribable resources. The bus
// stays dumb (nudges, no payloads) and so do the pushes: a client gets
// notifications/resources/updated and re-reads the resource — same
// refresh-on-nudge contract as the web app's /api/events/stream.
const EVENT_RESOURCE_MAP = {
  stats_changed: ['cellar://snapshot', 'cellar://stats'],
  notification: ['cellarion://alerts'],
};

// Session mode: handle resources/subscribe + unsubscribe, and fan event-bus
// nudges into notifications/resources/updated for the URIs this session
// subscribed to. Only STATIC resources the caller's scopes can read are
// subscribable (templates would need per-id invalidation the bus cannot give).
async function wireSubscriptions(server, ctx, session) {
  const types = await import('@modelcontextprotocol/sdk/types.js');
  const subscribable = new Set(
    resourcesForScopes(ctx.scopes).filter((r) => r.uri && Object.values(EVENT_RESOURCE_MAP).flat().includes(r.uri)).map((r) => r.uri)
  );
  server.server.setRequestHandler(types.SubscribeRequestSchema, async (request) => {
    const uri = String(request.params?.uri || '');
    if (!subscribable.has(uri)) {
      throw new Error(`Resource ${uri} is not subscribable. Subscribable: ${[...subscribable].join(', ') || '(none for these scopes)'}`);
    }
    session.subscriptions.add(uri);
    if (!session.busUnsub) {
      session.busUnsub = eventBusRef().addListener(session.userId, (event) => {
        for (const u of EVENT_RESOURCE_MAP[event] || []) {
          if (session.subscriptions.has(u)) {
            // Only a DELIVERED push counts as session activity (audit LOW-2:
            // refreshing on every user event — including web-app activity the
            // session never subscribed to — would keep an otherwise-dead
            // session, and any stale privileges in it, warm for the full 2h).
            session.lastSeenAt = Date.now();
            server.server.sendResourceUpdated({ uri: u }).catch((err) => {
              // Most commonly: the client never opened (or lost) its
              // standalone GET stream — the push has nowhere to go. Logged,
              // not thrown: the subscription stays; the next push retries.
              console.warn(`[mcp] resources/updated push for ${u} failed: ${err?.message || err}`);
            });
          }
        }
      });
    }
    return {};
  });
  server.server.setRequestHandler(types.UnsubscribeRequestSchema, async (request) => {
    session.subscriptions.delete(String(request.params?.uri || ''));
    return {};
  });
}

// Lazy accessor keeps the event bus off this module's require path for tests
// that mock it wholesale.
function eventBusRef() {
  return require('../services/eventBus');
}

// Prompt variant of budgetedHandler. Over budget we throw — synchronously,
// same as before instrumentation — and the SDK surfaces it as a JSON-RPC
// error for prompts/get (same convention as resources).
function budgetedPromptHandler(prompt, ctx, state) {
  return (args) => {
    state.calls += 1;
    const maxCalls = state.max || MAX_CALLS_PER_REQUEST;
    if (state.calls > maxCalls) {
      recordUsage(ctx, 'prompt', prompt.name, true);
      throw new Error(`rate_limited: too many calls in one request (max ${maxCalls})`);
    }
    if (!withinCallBudget(ctx)) {
      recordUsage(ctx, 'prompt', prompt.name, true);
      throw new Error('rate_limited: too many Cellarion tool calls in a short time');
    }
    return withUsage(ctx, 'prompt', prompt.name, () => prompt.handler(args || {}, ctx));
  };
}

// Resource variant of budgetedHandler. SDK callbacks: static resources get
// (uri, extra); template resources get (uri, variables, extra). Over budget we
// throw — synchronously, same as before instrumentation — and the SDK surfaces
// it as a JSON-RPC error for resources/read (there is no isError envelope for
// resources like there is for tool results).
function budgetedResourceHandler(rsrc, ctx, state) {
  return (uri, varsOrExtra) => {
    state.calls += 1;
    const maxCalls = state.max || MAX_CALLS_PER_REQUEST;
    if (state.calls > maxCalls) {
      recordUsage(ctx, 'resource', rsrc.name, true);
      throw new Error(`rate_limited: too many calls in one request (max ${maxCalls})`);
    }
    if (!withinCallBudget(ctx)) {
      recordUsage(ctx, 'resource', rsrc.name, true);
      throw new Error('rate_limited: too many Cellarion tool calls in a short time');
    }
    const params = rsrc.uriTemplate ? (varsOrExtra || {}) : {};
    return withUsage(ctx, 'resource', rsrc.name, () => rsrc.handler(uri, params, ctx));
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

// Initialize a STATEFUL session (plan §4): a long-lived server+transport pair
// keyed by Mcp-Session-Id, giving the client a standalone GET/SSE stream and
// resources/subscribe pushes. Returns true when the request was handled, or
// false when a session cap was hit — the caller then falls back to stateless
// mode, which degrades subscriptions only (every tool still works).
async function initStatefulSession(req, res, ctx) {
  const { createSession, destroySession } = require('./sessions');
  const session = createSession({ userId: ctx.user.id, tokenId: ctx.req?.apiToken?.id });
  if (!session) return false;
  try {
    const { StreamableHTTPServerTransport } = await loadSdk();
    // The session owns a MUTABLE ctx: the route swaps ctx.req on every request
    // so audit attribution (ip/UA/token) follows the actual caller. Concurrent
    // POSTs on one session may interleave req refs — same-user cosmetic only.
    session.ctx = { user: ctx.user, scopes: ctx.scopes, req: ctx.req };
    const server = await buildServer(session.ctx, { session, callState: session.callState });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => session.id,
      // The SDK fires this on DELETE (explicit session termination).
      onsessionclosed: () => destroySession(session.id, 'client_delete'),
    });
    transport.onclose = () => destroySession(session.id, 'transport_closed');
    session.server = server;
    session.transport = transport;
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    return true;
  } catch (err) {
    destroySession(session.id, 'init_failed');
    throw err;
  }
}

// buildServer/loadSdk are internal; the budget wrappers are exported for unit
// tests (jest cannot load the ESM SDK, so buildServer is covered by smoke.js).
module.exports = {
  handleMcpRequest, initStatefulSession,
  budgetedHandler, budgetedResourceHandler, budgetedPromptHandler, MAX_CALLS_PER_REQUEST,
  takeMutationSlot, WRITE_WINDOW_MS, EVENT_RESOURCE_MAP,
};
