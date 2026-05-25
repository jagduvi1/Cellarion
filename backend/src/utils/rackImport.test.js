const { computeRackPosition, planRackCreations, suggestRackDimensions } = require('./rackImport');

describe('computeRackPosition', () => {
  describe('explicit position', () => {
    test('returns the position unchanged with default top-left anchor', () => {
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

  describe('row + col with default top-left anchor', () => {
    test('maps (row=1, col=1) to position 1 in a 6-wide grid', () => {
      expect(computeRackPosition({ row: 1, col: 1, rackCols: 6 })).toEqual({ position: 1 });
    });

    test('maps (row=2, col=1) to position 7 in a 6-wide grid', () => {
      expect(computeRackPosition({ row: 2, col: 1, rackCols: 6 })).toEqual({ position: 7 });
    });

    test('rejects when rackCols is missing', () => {
      expect(computeRackPosition({ row: 1, col: 1 }).error).toBeDefined();
    });

    test('rejects when col exceeds rackCols', () => {
      expect(computeRackPosition({ row: 1, col: 7, rackCols: 6 }).error).toMatch(/exceeds/);
    });
  });

  describe('anchor=bottom-left (row+col)', () => {
    test('flips row only in an 18×6 rack', () => {
      // Bottom row 1 → effective row 18 → position (18-1)*6 + 1 = 103
      expect(computeRackPosition({ row: 1, col: 1, rackRows: 18, rackCols: 6, anchor: 'bottom-left' }))
        .toEqual({ position: 103 });
    });

    test('rejects when rackRows missing', () => {
      expect(computeRackPosition({ row: 1, col: 1, rackCols: 6, anchor: 'bottom-left' }).error)
        .toMatch(/rackRows/);
    });

    test('rejects when row exceeds rackRows', () => {
      expect(computeRackPosition({ row: 19, col: 1, rackRows: 18, rackCols: 6, anchor: 'bottom-left' }).error)
        .toMatch(/exceeds/);
    });
  });

  describe('anchor=top-right (row+col)', () => {
    test('flips col only', () => {
      // (row=1, col=1) anchored top-right in a 6-wide rack → col 6 → position 6
      expect(computeRackPosition({ row: 1, col: 1, rackCols: 6, anchor: 'top-right' }))
        .toEqual({ position: 6 });
    });
  });

  describe('anchor=bottom-right (row+col)', () => {
    test('flips both row and col', () => {
      // (row=1, col=1) bottom-right in 18×6 → effective (18, 6) → position (18-1)*6 + 6 = 108
      expect(computeRackPosition({ row: 1, col: 1, rackRows: 18, rackCols: 6, anchor: 'bottom-right' }))
        .toEqual({ position: 108 });
    });
  });

  describe('explicit position with non-default anchor', () => {
    test('flips row when anchor is bottom-left in a 4×6 grid', () => {
      // Oeno position 11 in a 4-row × 6-col rack:
      // srcRow = ceil(11/6) = 2, srcCol = ((11-1) % 6) + 1 = 5
      // bottom-left flips row: effectiveRow = 4 - 2 + 1 = 3
      // cellarion position = (3-1)*6 + 5 = 17
      expect(computeRackPosition({ position: 11, rackRows: 4, rackCols: 6, anchor: 'bottom-left' }))
        .toEqual({ position: 17 });
    });

    test('flips col when anchor is top-right in a 4×6 grid', () => {
      // srcRow=2, srcCol=5, top-right flips col: effectiveCol = 6 - 5 + 1 = 2
      // cellarion = (2-1)*6 + 2 = 8
      expect(computeRackPosition({ position: 11, rackRows: 4, rackCols: 6, anchor: 'top-right' }))
        .toEqual({ position: 8 });
    });

    test('flips both with bottom-right', () => {
      // srcRow=2, srcCol=5, bottom-right: effectiveRow=3, effectiveCol=2
      // cellarion = (3-1)*6 + 2 = 14
      expect(computeRackPosition({ position: 11, rackRows: 4, rackCols: 6, anchor: 'bottom-right' }))
        .toEqual({ position: 14 });
    });

    test('rejects non-default anchor without rackCols', () => {
      expect(computeRackPosition({ position: 11, anchor: 'bottom-left' }).error)
        .toMatch(/rackCols/);
    });
  });

  test('rejects invalid anchor', () => {
    expect(computeRackPosition({ row: 1, col: 1, rackCols: 6, anchor: 'sideways' }).error)
      .toMatch(/anchor/);
  });
});

describe('suggestRackDimensions', () => {
  test('single row for tiny racks (≤ 6)', () => {
    expect(suggestRackDimensions(5)).toEqual({ rows: 1, cols: 5 });
    expect(suggestRackDimensions(6)).toEqual({ rows: 1, cols: 6 });
  });

  test('2×6 for small wine racks (7–12)', () => {
    expect(suggestRackDimensions(11)).toEqual({ rows: 2, cols: 6 });
    expect(suggestRackDimensions(12)).toEqual({ rows: 2, cols: 6 });
  });

  test('4×6 for medium racks (13–24)', () => {
    expect(suggestRackDimensions(20)).toEqual({ rows: 4, cols: 6 });
    expect(suggestRackDimensions(24)).toEqual({ rows: 4, cols: 6 });
  });

  test('6×12 for larger racks (25–72)', () => {
    expect(suggestRackDimensions(48)).toEqual({ rows: 6, cols: 12 });
  });

  test('scales rows when max position exceeds 72, capped at 20', () => {
    expect(suggestRackDimensions(120)).toEqual({ rows: 10, cols: 12 });
    expect(suggestRackDimensions(500)).toEqual({ rows: 20, cols: 12 });
  });
});

describe('planRackCreations', () => {
  test('groups items by rackName', () => {
    const plan = planRackCreations([
      { rackName: 'A', row: 1, col: 1 },
      { rackName: 'A', row: 2, col: 3 },
      { rackName: 'B', row: 1, col: 1 },
    ]);
    expect(plan.size).toBe(2);
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

  test('uses suggestRackDimensions when only rackPosition is known', () => {
    // Mirrors Keith's M3 (positions 4, 10, 11): max 11 → suggestion is 2×6
    const plan = planRackCreations([
      { rackName: 'M3', rackPosition: 11 },
      { rackName: 'M3', rackPosition: 4 },
      { rackName: 'M3', rackPosition: 10 },
    ]);
    expect(plan.get('M3')).toMatchObject({ cols: 6, rows: 2, type: 'grid' });
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

  test('skips empty/whitespace rackName', () => {
    const plan = planRackCreations([
      { rackName: '   ', row: 1, col: 1 },
    ]);
    expect(plan.size).toBe(0);
  });
});
