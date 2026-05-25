const { computeRackPosition, planRackCreations } = require('./rackImport');

describe('computeRackPosition', () => {
  describe('explicit position', () => {
    test('returns the position when given a valid number', () => {
      expect(computeRackPosition({ position: 7 })).toEqual({ position: 7 });
    });

    test('parses a numeric string', () => {
      expect(computeRackPosition({ position: '12' })).toEqual({ position: 12 });
    });

    test('rejects zero or negative', () => {
      expect(computeRackPosition({ position: 0 }).error).toBeDefined();
      expect(computeRackPosition({ position: -3 }).error).toBeDefined();
    });

    test('rejects non-numeric strings', () => {
      expect(computeRackPosition({ position: 'abc' }).error).toBeDefined();
    });
  });

  describe('row + col with rowOrigin=top (default)', () => {
    test('maps (row=1, col=1) to position 1 in a 6-wide grid', () => {
      expect(computeRackPosition({ row: 1, col: 1, rackCols: 6 })).toEqual({ position: 1 });
    });

    test('maps (row=1, col=6) to position 6', () => {
      expect(computeRackPosition({ row: 1, col: 6, rackCols: 6 })).toEqual({ position: 6 });
    });

    test('maps (row=2, col=1) to position 7 in a 6-wide grid', () => {
      expect(computeRackPosition({ row: 2, col: 1, rackCols: 6 })).toEqual({ position: 7 });
    });

    test('maps (row=3, col=4) to position 16 in a 6-wide grid', () => {
      expect(computeRackPosition({ row: 3, col: 4, rackCols: 6 })).toEqual({ position: 16 });
    });

    test('rejects when rackCols is missing', () => {
      expect(computeRackPosition({ row: 1, col: 1 }).error).toBeDefined();
    });

    test('rejects when col exceeds rackCols', () => {
      expect(computeRackPosition({ row: 1, col: 7, rackCols: 6 }).error).toMatch(/exceeds/);
    });
  });

  describe('row + col with rowOrigin=bottom (Oeno-style)', () => {
    test('maps (row=1, col=1) at bottom to last row first slot in an 18×6 rack', () => {
      // Bottom row 1 -> effectiveRow 18 -> position (18-1)*6 + 1 = 103
      expect(computeRackPosition({ row: 1, col: 1, rackRows: 18, rackCols: 6, rowOrigin: 'bottom' }))
        .toEqual({ position: 103 });
    });

    test('maps (row=18, col=6) at bottom to position 6 (top-right)', () => {
      // Top row 18 -> effectiveRow 1 -> position (1-1)*6 + 6 = 6
      expect(computeRackPosition({ row: 18, col: 6, rackRows: 18, rackCols: 6, rowOrigin: 'bottom' }))
        .toEqual({ position: 6 });
    });

    test('maps (row=9, col=3) at bottom in 18×6 to position 64', () => {
      // effectiveRow = 18 - 9 + 1 = 10 -> position (10-1)*6 + 3 = 57 + 3 = 57? recompute: (10-1)*6=54; 54+3=57
      // Wait: 18-9+1 = 10. (10-1)*6 = 54. 54+3 = 57. Adjust expectation.
      expect(computeRackPosition({ row: 9, col: 3, rackRows: 18, rackCols: 6, rowOrigin: 'bottom' }))
        .toEqual({ position: 57 });
    });

    test('rejects when rackRows missing and rowOrigin=bottom', () => {
      expect(computeRackPosition({ row: 1, col: 1, rackCols: 6, rowOrigin: 'bottom' }).error)
        .toMatch(/rackRows/);
    });

    test('rejects when row exceeds rackRows', () => {
      expect(computeRackPosition({ row: 19, col: 1, rackRows: 18, rackCols: 6, rowOrigin: 'bottom' }).error)
        .toMatch(/exceeds/);
    });
  });

  test('rejects invalid rowOrigin', () => {
    expect(computeRackPosition({ row: 1, col: 1, rackCols: 6, rowOrigin: 'left' }).error)
      .toMatch(/rowOrigin/);
  });
});

describe('planRackCreations', () => {
  test('returns empty map when no items have rackName', () => {
    const plan = planRackCreations([
      { wineName: 'Wine A' },
      { wineName: 'Wine B', rackName: '' },
    ]);
    expect(plan.size).toBe(0);
  });

  test('groups items by rackName', () => {
    const plan = planRackCreations([
      { rackName: 'Rack A', row: 1, col: 1 },
      { rackName: 'Rack A', row: 2, col: 3 },
      { rackName: 'Rack B', row: 1, col: 1 },
    ]);
    expect(plan.size).toBe(2);
    expect(plan.has('Rack A')).toBe(true);
    expect(plan.has('Rack B')).toBe(true);
  });

  test('infers rows/cols from max observed row/col', () => {
    const plan = planRackCreations([
      { rackName: 'A', row: 1, col: 2 },
      { rackName: 'A', row: 5, col: 1 },
      { rackName: 'A', row: 3, col: 8 },
    ]);
    expect(plan.get('A')).toMatchObject({ type: 'grid', rows: 5, cols: 8 });
  });

  test('honours explicit rackRows/rackCols when larger than observed', () => {
    const plan = planRackCreations([
      { rackName: 'A', row: 1, col: 1, rackRows: 18, rackCols: 6 },
      { rackName: 'A', row: 2, col: 2 },
    ]);
    expect(plan.get('A')).toMatchObject({ rows: 18, cols: 6 });
  });

  test('grows rows to fit a rackPosition that exceeds rows*cols capacity', () => {
    const plan = planRackCreations([
      { rackName: 'A', rackPosition: 95, rackCols: 6 },
    ]);
    // cols=6, position=95, need rows >= ceil(95/6) = 16
    expect(plan.get('A')).toMatchObject({ cols: 6, rows: 16 });
  });

  test('Oeno-style: uses 6-col default and 4-row minimum when only rackPosition is known', () => {
    // Matches Keith's CSV: M3-11 → rackName=M3, rackPosition=11, no row/col,
    // no rackRows/rackCols. We want a sensible default rack shape, not a 1-wide column.
    const plan = planRackCreations([
      { rackName: 'M3', rackPosition: 11 },
      { rackName: 'M3', rackPosition: 4 },
      { rackName: 'M3', rackPosition: 10 },
    ]);
    expect(plan.get('M3')).toMatchObject({ cols: 6, rows: 4, type: 'grid' });
  });

  test('Oeno-style: grows rows when max position exceeds 4 rows at 6 cols', () => {
    const plan = planRackCreations([
      { rackName: 'BigRack', rackPosition: 50 },
    ]);
    // 6 cols × 4 rows = 24 < 50 → rows = ceil(50/6) = 9
    expect(plan.get('BigRack')).toMatchObject({ cols: 6, rows: 9 });
  });

  test('respects rackType override', () => {
    const plan = planRackCreations([
      { rackName: 'Honeycomb', row: 1, col: 1, rackType: 'hex' },
    ]);
    expect(plan.get('Honeycomb').type).toBe('hex');
  });

  test('clamps rows/cols to schema max of 20', () => {
    const plan = planRackCreations([
      { rackName: 'Huge', row: 25, col: 30 },
    ]);
    expect(plan.get('Huge').rows).toBe(20);
    expect(plan.get('Huge').cols).toBe(20);
  });

  test('defaults to rows=1, cols=1 when no positional info present', () => {
    const plan = planRackCreations([
      { rackName: 'Bare' },
    ]);
    expect(plan.get('Bare')).toMatchObject({ rows: 1, cols: 1, type: 'grid' });
  });

  test('skips empty/whitespace rackName', () => {
    const plan = planRackCreations([
      { rackName: '   ', row: 1, col: 1 },
    ]);
    expect(plan.size).toBe(0);
  });
});
