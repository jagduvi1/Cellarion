/**
 * Every MCP tool schema must be fully typed.
 *
 * WHY (user report 2026-08-21, reproduced against Home Assistant's own
 * converter). HA's MCP client runs every tool's inputSchema through
 * voluptuous_openapi.convert_to_voluptuous — see
 * homeassistant/components/mcp/coordinator.py — which raises
 *
 *     ValueError: Invalid schema, missing type
 *
 * on any node lacking a `type` keyword. `z.any()` serialises to a bare `{}`,
 * which is valid JSON Schema and unusable there. And HA aborts the ENTIRE
 * config entry when one tool fails to convert, so a single untyped node in a
 * single tool takes all ~108 Cellarion tools offline in Home Assistant. The
 * blast radius is the reason this is a guard and not a lint note.
 *
 * The trap this test exists to catch is the SECOND-ORDER one: the obvious fix
 * for `z.any()` is a union, and `z.union([..., z.array(z.any())])` still
 * fails, because the empty `{}` just moves into `items` where nobody looks.
 * A reviewer reading the diff would see types everywhere and approve it.
 *
 * anyOf/oneOf without a sibling `type` is FINE — verified against the same
 * converter, and our other tools have shipped 26 such nodes since July while
 * HA worked. This test therefore checks only for the empty object.
 */

const z = require('zod');
const { allTools } = require('./registry');

require('./tools/index'); // registers every tool

// Keys whose VALUE is a container of schemas, not a schema itself. An empty
// one is not a defect: a tool with no parameters serialises to
// `properties: {}`, and HA's converter accepts that happily — verified
// against convert_to_voluptuous alongside the real defect, so this exclusion
// is measured rather than assumed.
const CONTAINER_KEYS = new Set(['properties', 'patternProperties', '$defs', 'definitions']);
// Annotations, which may legitimately be empty and are never schema nodes.
const ANNOTATION_KEYS = new Set(['description', 'title', 'default', 'examples']);

/**
 * Every path in `node` that is an empty object standing where a SCHEMA
 * belongs — the shape HA rejects.
 */
function findEmptySchemas(node, path = '', inContainer = false) {
  if (node === null || typeof node !== 'object') return [];
  if (Array.isArray(node)) {
    return node.flatMap((v, i) => findEmptySchemas(v, `${path}[${i}]`));
  }
  // An empty container ({} of no properties) is fine; an empty schema is not.
  if (Object.keys(node).length === 0) return inContainer ? [] : [path || '(root)'];
  return Object.entries(node)
    .filter(([k]) => !ANNOTATION_KEYS.has(k))
    .flatMap(([k, v]) => findEmptySchemas(v, `${path}.${k}`, CONTAINER_KEYS.has(k)));
}

describe('MCP tool schemas are fully typed (Home Assistant compatibility)', () => {
  const tools = allTools();

  it('registers tools to check', () => {
    expect(tools.length).toBeGreaterThan(50);
  });

  it('no tool schema contains an untyped {} node', () => {
    const offenders = [];
    for (const tool of tools) {
      let serialised;
      try {
        serialised = z.toJSONSchema(z.object(tool.inputSchema || {}));
      } catch (err) {
        offenders.push(`${tool.name}: schema failed to serialise — ${err.message}`);
        continue;
      }
      for (const p of findEmptySchemas(serialised)) {
        offenders.push(`${tool.name}${p}`);
      }
    }
    // Named individually: the useful failure message is WHICH node, because
    // the fix differs per field and the path is where the reader must look.
    expect(offenders).toEqual([]);
  });

  it('analyze_cellar filters[].value keeps its real contract — scalars AND arrays', () => {
    const tool = allTools().find((t) => t.name === 'analyze_cellar');
    const value = z.toJSONSchema(z.object(tool.inputSchema))
      .properties.filters.items.properties.value;

    // Typed, so HA can convert it…
    expect(value.anyOf).toBeDefined();
    expect(value.anyOf.every((v) => 'type' in v)).toBe(true);

    // …and still accepts every shape the query engine takes: scalars for
    // eq/gt/contains, an array for `in` and the two-element `between`.
    const types = value.anyOf.map((v) => v.type);
    expect(types).toEqual(expect.arrayContaining(['string', 'number', 'boolean', 'array']));

    // The second-order trap: the array branch must not hide an empty {}.
    const arrayBranch = value.anyOf.find((v) => v.type === 'array');
    expect(findEmptySchemas(arrayBranch)).toEqual([]);
  });

  it('the runtime still accepts the values the engine documents', () => {
    const tool = allTools().find((t) => t.name === 'analyze_cellar');
    const schema = z.object(tool.inputSchema);
    const ok = (value) => schema.safeParse({ filters: [{ field: 'purchase.price', op: 'eq', value }] }).success;

    expect(ok('Barolo')).toBe(true);      // contains / eq on a string field
    expect(ok(42)).toBe(true);            // gt / lt on a number field
    expect(ok(true)).toBe(true);          // boolean field
    expect(ok([10, 50])).toBe(true);      // between
    expect(ok(['a', 'b'])).toBe(true);    // in
    // An object was never a legal filter value; the engine casts scalars.
    expect(ok({ nested: 1 })).toBe(false);
  });
});
