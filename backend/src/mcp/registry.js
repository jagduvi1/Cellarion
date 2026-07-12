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
  if (typeof def.scope !== 'string') {
    throw new Error(`registerTool(${def.name}): scope is required`);
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
  return Array.isArray(tokenScopes) && tokenScopes.includes(required);
}

/** The subset of registered tools a token with `tokenScopes` may see and call. */
function toolsForScopes(tokenScopes) {
  return tools.filter((t) => scopeSatisfies(tokenScopes, t.scope));
}

/** All registered tools (for tests / introspection). */
function allTools() {
  return tools.slice();
}

module.exports = { registerTool, toolsForScopes, scopeSatisfies, allTools };
