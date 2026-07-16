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
 * Optional `args(input) => boolean` further constrains the first call's input.
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
  if (!picked) return { pass: false, picked, detail: `no tool call, expected ${allowed.join('|')}` };
  if (!allowed.includes(picked)) {
    return { pass: false, picked, detail: `picked ${picked}, expected ${allowed.join('|')}` };
  }
  if (kase.args && !kase.args(toolUses[0].input || {})) {
    return { pass: false, picked, detail: `picked ${picked} but args failed the case predicate: ${JSON.stringify(toolUses[0].input)}` };
  }
  return { pass: true, picked, detail: `picked ${picked}` };
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
    if (k.args && typeof k.args !== 'function') throw new Error(`eval case ${k.id}: args must be a function`);
  }
  return true;
}

module.exports = { toAnthropicTools, judgeCase, assertValidCases };
