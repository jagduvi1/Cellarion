const { migrateEntries } = require('./migrate-wine-list-entries');

const bottleById = new Map([
  ['b1', { _id: 'b1', wineDefinition: 'w1', vintage: '2018', bottleSize: '750ml' }],
  ['b2', { _id: 'b2', wineDefinition: 'w1', vintage: '2018', bottleSize: '750ml' }], // duplicate of b1's wine
  ['b3', { _id: 'b3', wineDefinition: 'w1', vintage: '2018', bottleSize: '1.5L' }],  // same wine, magnum
  ['b4', { _id: 'b4', wineDefinition: 'w2', vintage: null, bottleSize: null }],
  ['b5', { _id: 'b5', wineDefinition: null }], // pending wine request — no definition
]);

describe('migrateEntries', () => {
  test('re-keys bottle entries to wine + vintage + size', () => {
    const out = migrateEntries([{ bottle: 'b1', listPrice: 80, glassPrice: null, sortOrder: 0 }], bottleById, false);
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
    ], bottleById, false);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ wine: 'w1', bottleSize: '750ml', listPrice: 80 });
    expect(out[1]).toMatchObject({ wine: 'w1', bottleSize: '1.5L', listPrice: 170 });
  });

  test('defaults missing vintage and size, drops unresolvable bottles', () => {
    const out = migrateEntries([
      { bottle: 'b4', listPrice: 30 },
      { bottle: 'b5', listPrice: 40 },     // no wine definition
      { bottle: 'b-gone', listPrice: 50 }, // bottle deleted
    ], bottleById, false);
    expect(out).toEqual([expect.objectContaining({ wine: 'w2', vintage: 'NV', bottleSize: '750ml' })]);
  });

  test('preserves displayed glass prices: byGlass only when the list showed them', () => {
    const entries = [{ bottle: 'b1', listPrice: 80, glassPrice: 15 }];
    const shown = migrateEntries(entries, bottleById, true);
    expect(shown[0]).toMatchObject({ byGlass: true, glassPrice: 15, glassPriceManual: true });

    const hidden = migrateEntries(entries, bottleById, false);
    expect(hidden[0]).toMatchObject({ byGlass: false, glassPrice: 15, glassPriceManual: false });
  });

  test('is idempotent: already-migrated entries pass through unchanged', () => {
    const migrated = { wine: 'w1', vintage: '2018', bottleSize: '750ml', listPrice: 99, byGlass: true, glassPrice: 18, glassPriceManual: true, sortOrder: 0 };
    const out = migrateEntries([migrated, { bottle: 'b1', listPrice: 80 }], bottleById, false);
    // The bottle entry resolves to the same wine key and is deduped away
    expect(out).toEqual([migrated]);
  });
});
