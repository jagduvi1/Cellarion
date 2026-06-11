const { migrateEntries } = require('./migrate-wine-list-entries');

const bottleById = new Map([
  ['b1', { _id: 'b1', wineDefinition: 'w1', vintage: '2018', bottleSize: '750ml', status: 'active' }],
  ['b2', { _id: 'b2', wineDefinition: 'w1', vintage: '2018', bottleSize: '750ml', status: 'active' }], // duplicate of b1's wine
  ['b3', { _id: 'b3', wineDefinition: 'w1', vintage: '2018', bottleSize: '1.5L', status: 'active' }],  // same wine, magnum
  ['b4', { _id: 'b4', wineDefinition: 'w2', vintage: null, bottleSize: null, status: 'active' }],
  ['b5', { _id: 'b5', wineDefinition: null, status: 'active' }], // pending wine request — no definition
  ['b6', { _id: 'b6', wineDefinition: 'w3', vintage: '2019', bottleSize: '750ml', status: 'drank' }], // consumed
]);

describe('migrateEntries', () => {
  test('re-keys bottle entries to wine + vintage + size', () => {
    const out = migrateEntries([{ bottle: 'b1', listPrice: 80, glassPrice: null, sortOrder: 0 }], bottleById, {});
    expect(out).toEqual([{
      wine: 'w1', vintage: '2018', bottleSize: '750ml',
      listPrice: 80, byGlass: false, glassPrice: null, glassPriceManual: false, sortOrder: 0,
    }]);
  });

  test('collapses duplicate bottles of the same wine, keeps distinct sizes', () => {
    const out = migrateEntries([
      { bottle: 'b1', listPrice: 80 },
      { bottle: 'b2', listPrice: 90 }, // duplicate — first wins
      { bottle: 'b3', listPrice: 170 }, // magnum — distinct entry
    ], bottleById, {});
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ wine: 'w1', bottleSize: '750ml', listPrice: 80 });
    expect(out[1]).toMatchObject({ wine: 'w1', bottleSize: '1.5L', listPrice: 170 });
  });

  test('defaults missing vintage and size, drops unresolvable bottles with reasons', () => {
    const dropped = [];
    const out = migrateEntries([
      { bottle: 'b4', listPrice: 30 },
      { bottle: 'b5', listPrice: 40 },     // no wine definition
      { bottle: 'b-gone', listPrice: 50 }, // bottle deleted
    ], bottleById, { onDrop: (e, reason) => dropped.push(reason) });
    expect(out).toEqual([expect.objectContaining({ wine: 'w2', vintage: 'NV', bottleSize: '750ml' })]);
    expect(dropped).toEqual(['pending-wine-request', 'bottle-missing']);
  });

  test('keeps consumed-bottle entries while the wine has active stock, drops sold-out ones', () => {
    const entries = [{ bottle: 'b6', listPrice: 60 }];

    const inStock = migrateEntries(entries, bottleById, {
      activeStockKeys: new Set(['w3|2019|750ml']),
    });
    expect(inStock).toEqual([expect.objectContaining({ wine: 'w3', vintage: '2019' })]);

    const dropped = [];
    const soldOut = migrateEntries(entries, bottleById, {
      activeStockKeys: new Set(),
      onDrop: (e, reason) => dropped.push(reason),
    });
    expect(soldOut).toEqual([]);
    expect(dropped).toEqual(['sold-out']);
  });

  test('hand-entered glass prices are always manual; byGlass follows the old display flag', () => {
    const entries = [{ bottle: 'b1', listPrice: 80, glassPrice: 15 }];

    const shown = migrateEntries(entries, bottleById, { showGlassPrice: true });
    expect(shown[0]).toMatchObject({ byGlass: true, glassPrice: 15, glassPriceManual: true });

    // Display was off: price stays hidden (byGlass false) but remains
    // protected as manual so the new pricing rule can never overwrite it
    const hidden = migrateEntries(entries, bottleById, { showGlassPrice: false });
    expect(hidden[0]).toMatchObject({ byGlass: false, glassPrice: 15, glassPriceManual: true });
  });

  test('is idempotent: already-migrated entries pass through unchanged', () => {
    const migrated = { wine: 'w1', vintage: '2018', bottleSize: '750ml', listPrice: 99, byGlass: true, glassPrice: 18, glassPriceManual: true, sortOrder: 0 };
    const out = migrateEntries([migrated, { bottle: 'b1', listPrice: 80 }], bottleById, {});
    // The bottle entry resolves to the same wine key and is deduped away
    expect(out).toEqual([migrated]);
  });
});
