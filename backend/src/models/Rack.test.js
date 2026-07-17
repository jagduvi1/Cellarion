/**
 * Rack index guard (MCP-audit H2 / prior-audit M4).
 *
 * "One slot per bottle across ALL racks" is enforced ONLY by the unique
 * multikey index on slots.bottle — per-document optimistic concurrency can't
 * see two racks each admitting the same bottle at once. rackOps.test.js
 * SIMULATES the E11000 by mocking rack.save, so nothing else would catch
 * someone dropping `unique: true` (which would silently let a bottle live in
 * two racks). This asserts the declaration directly (no DB).
 */
const Rack = require('./Rack');

describe('Rack indexes', () => {
  const indexes = Rack.schema.indexes();

  test('unique multikey partial index on slots.bottle (one slot per bottle, cross-rack)', () => {
    const slotBottle = indexes.find(([fields]) => fields['slots.bottle'] === 1);
    expect(slotBottle).toBeDefined();
    expect(slotBottle[1].unique).toBe(true);
    // Partial on existence — an empty slots array indexes as a null key, and two
    // slot-less racks must not collide.
    expect(slotBottle[1].partialFilterExpression).toEqual({ 'slots.bottle': { $exists: true } });
  });

  test('cellar+name uniqueness is scoped to non-deleted racks', () => {
    const cellarName = indexes.find(([fields]) => fields.cellar === 1 && fields.name === 1);
    expect(cellarName).toBeDefined();
    expect(cellarName[1].unique).toBe(true);
    expect(cellarName[1].partialFilterExpression).toEqual({ deletedAt: null });
  });
});
