/**
 * The order in which an arrangement fills a wall rack.
 *
 * WHY THIS TEST EXISTS:
 * "Organize this rack" puts the bottle to drink first into the first place of
 * a fill order. On a plain rack that order is the slot numbers. In a wall the
 * numbers of a pile count from the lowest bottle up, so filling by number
 * puts the bottle to drink first at the bottom of the pile, under all the
 * others; and filling by height across the wall leaves bottles hanging at
 * the top of piles with nothing under them. wallFillOrder fills box after
 * box, gives a pile its lowest places and lays the first bottle on top. Both
 * surfaces (the Arrange preview and MCP auto_arrange) take their order from it.
 */
const { wallFillOrder, wallTotalSlots } = require('./wallGeometry');
const { buildArrangePlan } = require('./rackArrange');

// A1: an X of three a pile (1–12). B1: two shelves of three (13–18).
// A2, two cells wide: an open bin of five (19–23).
const ROWS = 2;
const COLS = 2;
const TC = {
  boxes: [
    { x: 0, y: 0, w: 1, h: 1, kind: 'x', perSection: 3 },
    { x: 1, y: 0, w: 1, h: 1, kind: 'shelves', rows: 2, cols: 3 },
    { x: 0, y: 1, w: 2, h: 1, kind: 'bin', perSection: 5 },
  ],
};
const order = (opts) => wallFillOrder(ROWS, COLS, TC, opts);

describe('the fill order of a wall', () => {
  test('a pile gets its lowest places, and the first bottle lies on top', () => {
    // Five bottles: three fill the top pile of A1, two start the left pile.
    expect(order({ count: 5 }).slice(0, 5)).toEqual([3, 2, 1, 5, 4]);
    // One bottle: it lies alone at the bottom of the first pile.
    expect(order({ count: 1 })[0]).toBe(1);
  });

  test('boxes are filled one after another, each before the next', () => {
    // 14 bottles: the X (12), then the first two places of the top shelf.
    expect(order({ count: 14 }).slice(0, 14)).toEqual([3, 2, 1, 6, 5, 4, 9, 8, 7, 12, 11, 10, 13, 14]);
  });

  test('every usable position is listed once, the ones that stay empty last', () => {
    const all = order({ count: 5 });
    expect(all).toHaveLength(wallTotalSlots(ROWS, COLS, TC));
    expect(new Set(all).size).toBe(all.length);
    expect(order({ count: 0 })).toHaveLength(23);
  });

  test('a switched-off position is skipped, and the pile closes up under it', () => {
    const got = order({ count: 3, disabled: [1, 14] });
    expect(got).not.toContain(1);
    expect(got).not.toContain(14);
    // The top pile has two usable places left; the third bottle starts the next pile.
    expect(got.slice(0, 3)).toEqual([3, 2, 4]);
  });

  test('from the bottom right the last box comes first, and a rack box is read from that corner', () => {
    const got = order({ count: 7, corner: 'bottom-right' });
    // The bin (five), first bottle on top; then the lower shelf from the right.
    expect(got.slice(0, 7)).toEqual([23, 22, 21, 20, 19, 18, 17]);
  });

  test('a closed box and a wall without boxes give no places', () => {
    expect(wallFillOrder(1, 1, { boxes: [{ x: 0, y: 0, w: 1, h: 1, kind: 'closed' }] }, { count: 3 })).toEqual([]);
    expect(wallFillOrder(1, 1, undefined, { count: 3 })).toEqual([]);
  });

  test('the plan built from it puts the bottle to drink first on top of the first pile', () => {
    const bottle = (id, maturityStatus) => ({ _id: id, maturityStatus, vintage: '2015', wineDefinition: { name: id, type: 'red' } });
    // Stored the wrong way round: the one to keep longest lies on top.
    const entries = [
      { position: 1, bottle: bottle('late', 'late') },
      { position: 2, bottle: bottle('peak', 'peak') },
      { position: 3, bottle: bottle('young', 'not-ready') },
    ];
    const { target } = buildArrangePlan(entries, 23, [], 'maturity', order({ count: entries.length }));
    const at = Object.fromEntries(target.map((t) => [t.bottleId, t.position]));
    expect(at).toEqual({ late: 3, peak: 2, young: 1 });
  });
});
