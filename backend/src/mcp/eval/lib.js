// Pure helpers for the MCP tool-selection eval (plan §9). Kept free of SDK /
// network / API dependencies so they are unit-testable in jest.

/**
 * Map MCP tools/list entries to Anthropic Messages-API tool definitions.
 * tools/list already carries JSON Schema (the server converts zod shapes),
 * so this is a rename, not a conversion.
 */
function toAnthropicTools(mcpTools) {
  return mcpTools.map((t) => ({
    name: t.name,
    description: t.description || '',
    input_schema: t.inputSchema || { type: 'object', properties: {} },
  }));
}

/**
 * Judge one eval case against the tool_use blocks of the model's FIRST
 * response. Case shapes:
 *   { expect: { tool: 'name' } }            — first call must be this tool
 *   { expect: { anyOf: ['a', 'b'] } }       — first call must be one of these
 *   { expect: { none: true } }              — model must call NO tool
 * Optional modifiers:
 *   expect.orNone — for a consequential WRITE, a no-tool first response (the
 *     model asking to confirm before mutating — exactly what the instructions
 *     tell it to do) is ALSO acceptable. The meaningful failure such a case
 *     still catches is the model reaching for the WRONG tool.
 *   args(input) => boolean — further constrains the first call's input.
 * Returns { pass, picked, detail }.
 */
function judgeCase(kase, toolUses) {
  const picked = toolUses.length ? toolUses[0].name : null;
  if (kase.expect.none) {
    return {
      pass: toolUses.length === 0,
      picked,
      detail: toolUses.length === 0 ? 'no tool (correct)' : `called ${picked}, expected none`,
    };
  }
  const allowed = kase.expect.anyOf || [kase.expect.tool];
  if (!picked) {
    if (kase.expect.orNone) return { pass: true, picked, detail: 'no tool — confirmation first (accepted for a write)' };
    return { pass: false, picked, detail: `no tool call, expected ${allowed.join('|')}` };
  }
  if (!allowed.includes(picked)) {
    return { pass: false, picked, detail: `picked ${picked}, expected ${allowed.join('|')}` };
  }
  if (kase.args && !kase.args(toolUses[0].input || {})) {
    return { pass: false, picked, detail: `picked ${picked} but args failed the case predicate: ${JSON.stringify(toolUses[0].input)}` };
  }
  return { pass: true, picked, detail: `picked ${picked}` };
}

/**
 * True when a case is judgeable against the tools ACTUALLY advertised to the
 * eval's token. The tool surface is scope- and role-filtered per token (a
 * non-somm token never sees the sommelier tools; a read-only token sees no
 * write tools), so a case expecting a tool the token can't see isn't a failure
 * — it's out of scope for this run and must be SKIPPED, not counted against the
 * accuracy gate. `none` cases always apply (they assert no tool is called).
 * @param {object} kase
 * @param {Set<string>} advertised  tool names from the live tools/list
 */
function caseApplies(kase, advertised) {
  if (kase.expect.none) return true;
  const names = kase.expect.anyOf || [kase.expect.tool];
  return names.some((n) => advertised.has(n));
}

/** Validate the shape of a cases array at load time (fail fast on typos). */
function assertValidCases(cases) {
  const ids = new Set();
  for (const k of cases) {
    if (!k.id || ids.has(k.id)) throw new Error(`eval case: missing/duplicate id "${k.id}"`);
    ids.add(k.id);
    if (typeof k.prompt !== 'string' || !k.prompt.trim()) throw new Error(`eval case ${k.id}: prompt required`);
    const e = k.expect || {};
    const modes = [e.tool, e.anyOf, e.none].filter((v) => v !== undefined).length;
    if (modes !== 1) throw new Error(`eval case ${k.id}: expect needs exactly one of tool|anyOf|none`);
    if (e.anyOf && (!Array.isArray(e.anyOf) || !e.anyOf.length)) throw new Error(`eval case ${k.id}: anyOf must be a non-empty array`);
    if (e.orNone !== undefined && typeof e.orNone !== 'boolean') throw new Error(`eval case ${k.id}: orNone must be a boolean`);
    if (e.orNone && e.none) throw new Error(`eval case ${k.id}: orNone is meaningless on a none case`);
    if (k.args && typeof k.args !== 'function') throw new Error(`eval case ${k.id}: args must be a function`);
  }
  return true;
}

module.exports = { toAnthropicTools, judgeCase, assertValidCases, caseApplies };
