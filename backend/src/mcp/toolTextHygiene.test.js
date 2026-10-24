/**
 * MCP tool texts state what is true now.
 *
 * Every connected model reads each tool's title, description and parameter
 * descriptions in tools/list, every session. Those strings are instructions,
 * not a changelog: a support-ticket id or a "since <date>" means nothing to the
 * model, costs tokens, and sends internal references out of the system; a
 * sentence about a gap that has since closed steers the model wrong.
 */

const z = require('zod');
const { allTools } = require('./registry');

require('./tools/index'); // registers every tool

const tool = (name) => allTools().find((t) => t.name === name);

// A ticket/record id: eight lowercase hex characters with at least one digit
// and one letter (so plain numbers and ordinary words never match).
const HEX_ID = /\b(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{8}\b/g;
const ISO_DATE = /\b20\d\d-\d\d-\d\d\b/g;

/** Every `description` string inside a serialised JSON Schema. */
function schemaDescriptions(node, out = []) {
  if (node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    node.forEach((v) => schemaDescriptions(v, out));
    return out;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === 'description' && typeof v === 'string') out.push(v);
    else schemaDescriptions(v, out);
  }
  return out;
}

/** [label, text] for every model-facing string of every registered tool. */
function toolTexts() {
  const texts = [];
  for (const t of allTools()) {
    texts.push([`${t.name}.title`, t.title || '']);
    texts.push([`${t.name}.description`, t.description || '']);
    const schema = z.toJSONSchema(z.object(t.inputSchema || {}));
    schemaDescriptions(schema).forEach((d, i) => texts.push([`${t.name}.inputSchema[${i}]`, d]));
  }
  return texts;
}

describe('MCP tool texts carry no ticket ids or dated history', () => {
  test('there are tools to check', () => {
    expect(allTools().length).toBeGreaterThan(50);
  });

  test('no title, description or parameter description carries a ticket/record id', () => {
    const offenders = [];
    for (const [label, text] of toolTexts()) {
      for (const m of text.matchAll(HEX_ID)) offenders.push(`${label}: ${m[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  test('no title, description or parameter description carries a date, except as an e.g. example', () => {
    const offenders = [];
    for (const [label, text] of toolTexts()) {
      for (const m of text.matchAll(ISO_DATE)) {
        const before = text.slice(Math.max(0, m.index - 12), m.index);
        if (!/e\.g\./.test(before)) offenders.push(`${label}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('MCP tool texts point at tools that exist', () => {
  test('add_bottle sends rack placement to place_bottle, not to the web app', () => {
    expect(tool('place_bottle')).toBeDefined();
    expect(tool('add_bottle').description).toMatch(/place_bottle/);
    expect(tool('add_bottle').description).not.toMatch(/web app/);
  });

  test('request_wine_addition names the idempotency key as the retry path, not a read-back it has no tool for', () => {
    const d = tool('request_wine_addition').description;
    expect(d).toMatch(/idempotency_key/);
    expect(d).not.toMatch(/list_history/);
    expect(d).not.toMatch(/read back/);
  });

  test('the ticket writes keep their read-back through list_my_tickets', () => {
    expect(tool('list_my_tickets')).toBeDefined();
    for (const n of ['create_support_ticket', 'reply_to_ticket']) {
      expect(tool(n).description).toMatch(/read back with list_my_tickets/);
    }
  });
});
