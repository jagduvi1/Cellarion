/**
 * Eval-harness logic (pure part). The runner itself needs a live stack + API
 * key (opt-in, run.js); everything judgeable without either is pinned here —
 * including that the REAL cases file is structurally valid, so a typo in a
 * case fails CI instead of the first paid eval run.
 */
const { toAnthropicTools, judgeCase, assertValidCases, caseApplies } = require('./lib');
const { CASES } = require('./cases');
const { allTools } = require('../registry');
require('../tools');

describe('toAnthropicTools', () => {
  test('maps name/description/inputSchema and defaults a missing schema', () => {
    const out = toAnthropicTools([
      { name: 'a', description: 'd', inputSchema: { type: 'object', properties: { x: {} } } },
      { name: 'b' },
    ]);
    expect(out[0]).toEqual({ name: 'a', description: 'd', input_schema: { type: 'object', properties: { x: {} } } });
    expect(out[1].input_schema).toEqual({ type: 'object', properties: {} });
  });
});

describe('judgeCase', () => {
  const use = (name, input = {}) => ({ name, input });

  test('tool: exact first call passes, wrong tool / no call fails', () => {
    const kase = { expect: { tool: 'search_bottles' } };
    expect(judgeCase(kase, [use('search_bottles')]).pass).toBe(true);
    expect(judgeCase(kase, [use('list_cellars')]).pass).toBe(false);
    expect(judgeCase(kase, []).pass).toBe(false);
  });

  test('anyOf accepts any listed first move; judges only the FIRST call', () => {
    const kase = { expect: { anyOf: ['list_racks', 'list_cellars'] } };
    expect(judgeCase(kase, [use('list_cellars'), use('get_rack')]).pass).toBe(true);
    expect(judgeCase(kase, [use('get_rack'), use('list_racks')]).pass).toBe(false);
  });

  test('none passes only with zero tool calls', () => {
    expect(judgeCase({ expect: { none: true } }, []).pass).toBe(true);
    expect(judgeCase({ expect: { none: true } }, [use('list_cellars')]).pass).toBe(false);
  });

  test('args predicate constrains the first call input', () => {
    const kase = { expect: { tool: 'search_bottles' }, args: (a) => /barolo/i.test(a.query || '') };
    expect(judgeCase(kase, [use('search_bottles', { query: 'Barolo 2015' })]).pass).toBe(true);
    expect(judgeCase(kase, [use('search_bottles', { query: 'rioja' })]).pass).toBe(false);
    expect(judgeCase(kase, [use('search_bottles', {})]).pass).toBe(false);
  });

  test('orNone: a write case accepts a no-tool confirmation but still rejects the WRONG tool', () => {
    const kase = { expect: { tool: 'create_cellar', orNone: true } };
    expect(judgeCase(kase, []).pass).toBe(true);                      // confirmed first — OK
    expect(judgeCase(kase, [use('create_cellar')]).pass).toBe(true);  // acted — OK
    expect(judgeCase(kase, [use('consume_bottle')]).pass).toBe(false); // wrong tool — still a fail
  });
});

describe('caseApplies', () => {
  test('a tool/anyOf case applies only when a listed tool is advertised', () => {
    const advertised = new Set(['search_bottles', 'consume_bottle']);
    expect(caseApplies({ expect: { tool: 'consume_bottle' } }, advertised)).toBe(true);
    expect(caseApplies({ expect: { tool: 'set_vintage_price' } }, advertised)).toBe(false); // somm-only, not advertised
    expect(caseApplies({ expect: { anyOf: ['set_vintage_price', 'search_bottles'] } }, advertised)).toBe(true);
  });

  test('a none case always applies (it asserts NO tool is called)', () => {
    expect(caseApplies({ expect: { none: true } }, new Set())).toBe(true);
  });
});

describe('the shipped cases', () => {
  test('are structurally valid', () => {
    expect(assertValidCases(CASES)).toBe(true);
    expect(CASES.length).toBeGreaterThanOrEqual(12);
  });

  test('every expected tool name actually exists in the registry (no drift)', () => {
    const names = new Set(allTools().map((t) => t.name));
    for (const kase of CASES) {
      for (const name of kase.expect.anyOf || (kase.expect.tool ? [kase.expect.tool] : [])) {
        if (!names.has(name)) throw new Error(`case ${kase.id} expects unknown tool "${name}"`);
      }
    }
    expect(true).toBe(true);
  });

  test('cover the Phase-2 write surface + export tools', () => {
    const expected = new Set(CASES.flatMap((k) => k.expect.anyOf || (k.expect.tool ? [k.expect.tool] : [])));
    for (const t of ['consume_bottle', 'resolve_wine', 'bulk_add', 'create_cellar', 'move_bottle',
      'export_cellar', 'get_account_export', 'list_maturity_queue']) {
      expect(expected.has(t)).toBe(true);
    }
  });
});
