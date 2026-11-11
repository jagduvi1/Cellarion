import { defaultTypeConfig, createRackTypeConfig } from './rackTypeConfig';
import { CABINET_DEFAULT } from './cabinetPresets';

describe('defaultTypeConfig', () => {
  test.each([
    ['cube', { moduleRows: 2, moduleCols: 2 }],
    ['x-rack', { bottlesPerSection: 10 }],
    ['shelf', { bottlesPerCell: 1, backCols: 0 }],
    ['grid', {}],
    ['hex', {}],
    ['triangle', {}],
    ['stack', {}],
    ['no such type', {}],
  ])('%s', (type, expected) => {
    expect(defaultTypeConfig(type)).toEqual(expected);
  });

  test('a cabinet starts from the default cabinet, with a list of its own', () => {
    const config = defaultTypeConfig('cabinet');

    expect(config).toEqual({
      shelfRows: CABINET_DEFAULT.shelfRows,
      twoDeep: CABINET_DEFAULT.twoDeep,
      stagger: CABINET_DEFAULT.stagger,
      alternate: CABINET_DEFAULT.alternate,
    });
    expect(config.shelfRows).not.toBe(CABINET_DEFAULT.shelfRows);
  });
});

describe('createRackTypeConfig', () => {
  const form = (overrides) => ({ type: 'grid', rows: 4, cols: 8, typeConfig: {}, ...overrides });

  test('a form with no option sends no typeConfig', () => {
    expect(createRackTypeConfig(form())).toBeUndefined();
    expect(createRackTypeConfig(form({ typeConfig: undefined }))).toBeUndefined();
    expect(createRackTypeConfig(form({ typeConfig: null }))).toBeUndefined();
  });

  test('the form state is not changed', () => {
    const typeConfig = { doubleHeightRows: [1, 9], shelfRows: [2] };
    createRackTypeConfig(form({ typeConfig }));

    expect(typeConfig).toEqual({ doubleHeightRows: [1, 9], shelfRows: [2] });
  });

  test('options of another type pass through as they are', () => {
    expect(createRackTypeConfig(form({ type: 'cube', typeConfig: { moduleRows: 2, moduleCols: 3 } })))
      .toEqual({ moduleRows: 2, moduleCols: 3 });
  });

  describe('double-height rows', () => {
    test('rows outside the final row count are dropped', () => {
      expect(createRackTypeConfig(form({ rows: 3, typeConfig: { doubleHeightRows: [0, 1, 3, 4] } })))
        .toEqual({ doubleHeightRows: [1, 3] });
    });

    test('a list left empty is not sent, and the typeConfig is then an empty object', () => {
      expect(createRackTypeConfig(form({ rows: 2, typeConfig: { doubleHeightRows: [5] } }))).toEqual({});
    });
  });

  describe('a rack that is not a cabinet', () => {
    test('loses every cabinet option the form still holds from an earlier type', () => {
      const typeConfig = {
        bottlesPerSection: 10,
        shelfRows: [2, 2], twoDeep: true, stagger: true, headToTail: true, alternate: false,
        shelfCols: [3, 3], shelfAlternate: [true, false], shelfSideways: ['front', ''],
      };
      expect(createRackTypeConfig(form({ type: 'x-rack', typeConfig }))).toEqual({ bottlesPerSection: 10 });
    });
  });

  describe('a cabinet', () => {
    const cabinet = (overrides, typeConfig) => form({ type: 'cabinet', rows: 3, cols: 6, typeConfig, ...overrides });

    test('the per-shelf list is fitted to the final shelf count: padded with 1, trimmed', () => {
      expect(createRackTypeConfig(cabinet({ rows: 4 }, { shelfRows: [2, 3] })).shelfRows).toEqual([2, 3, 1, 1]);
      expect(createRackTypeConfig(cabinet({ rows: 2 }, { shelfRows: [2, 3, 4] })).shelfRows).toEqual([2, 3]);
    });

    test('two deep and stagger are on unless switched off; alternate is off unless switched on', () => {
      expect(createRackTypeConfig(cabinet({}, { shelfRows: [1, 1, 1] })))
        .toEqual({ shelfRows: [1, 1, 1], twoDeep: true, stagger: true, alternate: false });
      expect(createRackTypeConfig(cabinet({}, { shelfRows: [1, 1, 1], twoDeep: false, stagger: false, alternate: true })))
        .toEqual({ shelfRows: [1, 1, 1], twoDeep: false, stagger: false, alternate: true });
    });

    test('head to tail is kept for a one-deep cabinet only, and only when on', () => {
      const base = { shelfRows: [1, 1, 1] };
      expect(createRackTypeConfig(cabinet({}, { ...base, twoDeep: false, headToTail: true })).headToTail).toBe(true);
      expect(createRackTypeConfig(cabinet({}, { ...base, twoDeep: true, headToTail: true }))).not.toHaveProperty('headToTail');
      expect(createRackTypeConfig(cabinet({}, { ...base, twoDeep: false, headToTail: false }))).not.toHaveProperty('headToTail');
    });

    test('per-shelf widths are fitted and sent only when a shelf is narrower than the cabinet', () => {
      const narrower = createRackTypeConfig(cabinet({}, { shelfRows: [1, 1, 1], shelfCols: [6, 4] }));
      expect(narrower.shelfCols).toEqual([6, 4, 6]);

      const same = createRackTypeConfig(cabinet({}, { shelfRows: [1, 1, 1], shelfCols: [6, 6, 9] }));
      expect(same).not.toHaveProperty('shelfCols');
    });

    test('per-shelf patterns are fitted and sent only when a shelf differs from the cabinet', () => {
      const differs = createRackTypeConfig(cabinet({}, { shelfRows: [1, 1, 1], alternate: false, shelfAlternate: [true] }));
      expect(differs.shelfAlternate).toEqual([true, false, false]);

      const same = createRackTypeConfig(cabinet({}, { shelfRows: [1, 1, 1], alternate: true, shelfAlternate: [true, true, true] }));
      expect(same).not.toHaveProperty('shelfAlternate');
    });

    test('how the shelves lie is fitted and sent only when some shelf lies sideways', () => {
      const sideways = createRackTypeConfig(cabinet({}, { shelfRows: [1, 1, 1], shelfSideways: ['', 'front', 'nonsense', 'all'] }));
      expect(sideways.shelfSideways).toEqual(['', 'front', '']);

      const none = createRackTypeConfig(cabinet({}, { shelfRows: [1, 1, 1], shelfSideways: ['', ''] }));
      expect(none).not.toHaveProperty('shelfSideways');
    });
  });
});
