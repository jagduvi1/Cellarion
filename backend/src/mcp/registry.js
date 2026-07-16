// Declarative MCP tool registry.
//
// Each tool is a plain object: { name, title, description, scope, inputSchema,
// annotations, handler }. One registry drives (a) the tools advertised to a
// client — filtered to the token's scopes, so a `read`-only token never even
// sees write tools — and (b) which handler runs. Adding a tool is declarative;
// no route wiring, no per-endpoint scope check to forget.
//
// `scope` is the token scope a tool requires: 'public' (any authenticated
// token), or one of the SCOPE_ALLOWLIST scopes ('read' | 'consume' | 'write' |
// …). This mirrors the default-deny philosophy of middleware/apiTokenAuth.js —
// the tool surface a caller sees is exactly the powers they granted.

const tools = [];

/**
 * Register an MCP tool. Throws on a duplicate name (a programming error).
 * @param {object} def
 * @param {string}   def.name          unique snake_case tool name
 * @param {string}   def.title         short human-readable title
 * @param {string}   def.description   when + what — drives model tool-selection
 * @param {string}   def.scope         required token scope ('public' | 'read' | …)
 * @param {object}   [def.inputSchema] zod raw shape ({} = no params)
 * @param {object}   [def.annotations] MCP hints (readOnlyHint, destructiveHint, …)
 * @param {Function} def.handler       async (args, ctx) => ({ content: [...] })
 */
function registerTool(def) {
  if (!def || typeof def.name !== 'string' || typeof def.handler !== 'function') {
    throw new Error('registerTool: name and handler are required');
  }
  // scope is a single scope string, or an array of accepted scopes.
  const scopeOk = typeof def.scope === 'string'
    || (Array.isArray(def.scope) && def.scope.length > 0 && def.scope.every((s) => typeof s === 'string'));
  if (!scopeOk) {
    throw new Error(`registerTool(${def.name}): scope (string or non-empty string[]) is required`);
  }
  if (tools.some((t) => t.name === def.name)) {
    throw new Error(`registerTool: duplicate tool name "${def.name}"`);
  }
  tools.push({ inputSchema: {}, annotations: {}, ...def });
}

/**
 * True when a token carrying `tokenScopes` may reach a tool requiring `required`.
 * 'public' tools are reachable by any authenticated token; every other tool
 * requires the token to carry that exact scope.
 */
function scopeSatisfies(tokenScopes, required) {
  if (required === 'public') return true;
  // A tool may accept ANY of several scopes (e.g. undo_last, reachable by a
  // consume OR a write token — it reverses both kinds of mutation).
  const accepted = Array.isArray(required) ? required : [required];
  return Array.isArray(tokenScopes) && accepted.some((r) => tokenScopes.includes(r));
}

/**
 * The subset of registered tools a caller may see and call. Filtered by token
 * scope AND, when a tool declares `requireRole: ['somm', 'admin']`, by the
 * caller's roles — role-gated tools are structurally INVISIBLE to callers
 * without the role, not merely rejected. Roles come from the auth layer:
 * fresh from the User document on every `cel_` token request (revoking the
 * somm role cuts the tools off immediately); from the JWT claims for browser
 * sessions (bounded by the 15-minute access-token lifetime, same as REST).
 */
function toolsForScopes(tokenScopes, roles = []) {
  return tools.filter((t) => {
    if (!scopeSatisfies(tokenScopes, t.scope)) return false;
    if (t.requireRole && !t.requireRole.some((r) => roles.includes(r))) return false;
    return true;
  });
}

/** All registered tools (for tests / introspection). */
function allTools() {
  return tools.slice();
}

// ── Resources ────────────────────────────────────────────────────────────────
// MCP resources are read-only context a client can attach (cellar://snapshot,
// cellarion://about, …). Same declarative registry + scope model as tools: a
// resource is only registered on a request's server when the caller's scopes
// satisfy it, so a read-scoped surface stays read-scoped.

const resources = [];

/**
 * Register an MCP resource.
 * @param {object} def
 * @param {string}   def.name          unique name
 * @param {string}   [def.uri]         static URI (exactly one of uri/uriTemplate)
 * @param {string}   [def.uriTemplate] RFC 6570 template, e.g. 'cellar://bottle/{id}'
 * @param {string}   def.title
 * @param {string}   def.description
 * @param {string}   [def.mimeType]    default application/json
 * @param {string}   def.scope         'public' | 'read' | …
 * @param {Function} def.handler       async (uri, params, ctx) => ({ contents: [...] })
 */
function registerResource(def) {
  if (!def || typeof def.name !== 'string' || typeof def.handler !== 'function') {
    throw new Error('registerResource: name and handler are required');
  }
  if (typeof def.scope !== 'string') {
    throw new Error(`registerResource(${def.name}): scope is required`);
  }
  if (!def.uri === !def.uriTemplate) {
    throw new Error(`registerResource(${def.name}): exactly one of uri / uriTemplate is required`);
  }
  if (resources.some((r) => r.name === def.name)) {
    throw new Error(`registerResource: duplicate resource name "${def.name}"`);
  }
  resources.push({ mimeType: 'application/json', ...def });
}

/** The subset of registered resources a token with `tokenScopes` may read. */
function resourcesForScopes(tokenScopes) {
  return resources.filter((r) => scopeSatisfies(tokenScopes, r.scope));
}

/** All registered resources (for tests / introspection). */
function allResources() {
  return resources.slice();
}

// ── Prompts ──────────────────────────────────────────────────────────────────
// MCP prompts are user-invokable workflow templates (slash-commands in most
// clients): parameterized messages that teach the calling model HOW to run a
// multi-tool Cellarion workflow well. Static templates only — a prompt handler
// interpolates its arguments into text and never touches the DB (the tools it
// directs the model to are where data comes from), so prompts/get is ~free.
// Same declarative registry + structural scope gate as tools and resources: a
// prompt is only registered on a request's server when the caller's scopes
// satisfy it, so a read-only token never sees a write-workflow prompt whose
// tools it could not call.

const prompts = [];

/**
 * Register an MCP prompt.
 * @param {object} def
 * @param {string}   def.name         unique snake_case name
 * @param {string}   def.title        short human-readable title
 * @param {string}   def.description  when to use — shown in client prompt pickers
 * @param {string}   def.scope        'public' | 'read' | 'write' | …
 * @param {object}   [def.argsSchema] zod raw shape; MCP prompt args are strings
 * @param {Function} def.handler      (args) => ({ messages: [...] }) — must be pure
 */
function registerPrompt(def) {
  if (!def || typeof def.name !== 'string' || typeof def.handler !== 'function') {
    throw new Error('registerPrompt: name and handler are required');
  }
  if (typeof def.scope !== 'string') {
    throw new Error(`registerPrompt(${def.name}): scope is required`);
  }
  if (prompts.some((p) => p.name === def.name)) {
    throw new Error(`registerPrompt: duplicate prompt name "${def.name}"`);
  }
  prompts.push({ argsSchema: {}, ...def });
}

/** The subset of registered prompts a token with `tokenScopes` may use. */
function promptsForScopes(tokenScopes) {
  return prompts.filter((p) => scopeSatisfies(tokenScopes, p.scope));
}

/** All registered prompts (for tests / introspection). */
function allPrompts() {
  return prompts.slice();
}

module.exports = {
  registerTool, toolsForScopes, scopeSatisfies, allTools,
  registerResource, resourcesForScopes, allResources,
  registerPrompt, promptsForScopes, allPrompts,
};
