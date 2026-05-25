const { computeRackPosition, planRackCreations, suggestRackDimensions, findNextFreeSlot, placeBottles, placeBottlesInRack } = require('./rackImport');

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

  test('sizes rack by total bottle count when many bottles share a slot', () => {
    // Mirrors Keith's data: 3 Riesling + 3 Chenin Blanc + 2 Pinot + 1 Ata Rangi
    // all claim positions in M3 (total 9 bottles), with max position 11.
    // Required capacity = max(11, 9) = 11. Suggestion for 11 is 2×6 = 12 slots. ✓
    const plan = planRackCreations([
      { rackName: 'M3', rackPosition: 11 }, // Chenin 1
      { rackName: 'M3', rackPosition: 11 }, // Chenin 2
      { rackName: 'M3', rackPosition: 11 }, // Chenin 3
      { rackName: 'M3', rackPosition: 10 }, // Riesling 1
      { rackName: 'M3', rackPosition: 10 }, // Riesling 2
      { rackName: 'M3', rackPosition: 10 }, // Riesling 3
      { rackName: 'M3', rackPosition: 4 },  // Ata Rangi 1
      { rackName: 'M3', rackPosition: 4 },  // Ata Rangi 2
    ]);
    const m3 = plan.get('M3');
    // 2×6 = 12 slots, ≥ max(11, 8) = 11. ✓
    expect(m3.rows * m3.cols).toBeGreaterThanOrEqual(11);
    expect(m3.rows * m3.cols).toBeGreaterThanOrEqual(8); // bottle count
  });

  test('grows capacity when total bottle count exceeds max position', () => {
    // Edge case: many bottles all claim slot 3 → capacity needs >= count
    const items = Array.from({ length: 15 }, () => ({ rackName: 'Big', rackPosition: 3 }));
    const plan = planRackCreations(items);
    const big = plan.get('Big');
    expect(big.rows * big.cols).toBeGreaterThanOrEqual(15);
  });
});

describe('findNextFreeSlot', () => {
  test('returns next forward slot when forward slot is free', () => {
    const occupied = new Set([5]);
    expect(findNextFreeSlot(occupied, 5, 24)).toBe(6);
  });

  test('skips occupied slots forward', () => {
    const occupied = new Set([5, 6, 7]);
    expect(findNextFreeSlot(occupied, 5, 24)).toBe(8);
  });

  test('falls back to backward search when forward is exhausted', () => {
    const occupied = new Set([5, 6, 7, 8, 9, 10, 11, 12]);
    expect(findNextFreeSlot(occupied, 7, 12)).toBe(4);
  });

  test('returns null when the rack is full', () => {
    const occupied = new Set([1, 2, 3, 4, 5]);
    expect(findNextFreeSlot(occupied, 3, 5)).toBeNull();
  });
});

describe('placeBottles', () => {
  test('places single bottles at their exact requested positions', () => {
    const result = placeBottles([], [
      { requestedPosition: 4, bottleId: 'a' },
      { requestedPosition: 10, bottleId: 'b' },
      { requestedPosition: 11, bottleId: 'c' },
    ], 24);
    expect(result.placements).toEqual([
      expect.objectContaining({ position: 4, bottle: 'a' }),
      expect.objectContaining({ position: 10, bottle: 'b' }),
      expect.objectContaining({ position: 11, bottle: 'c' }),
    ]);
    expect(result.unplaced).toHaveLength(0);
  });

  test('overflows multiple bottles claiming the same slot into adjacent slots', () => {
    // 3 bottles all want slot 11 in a 24-slot rack
    const result = placeBottles([], [
      { requestedPosition: 11, bottleId: 'a' },
      { requestedPosition: 11, bottleId: 'b' },
      { requestedPosition: 11, bottleId: 'c' },
    ], 24);
    const positions = result.placements.map(p => p.position).sort((a, b) => a - b);
    expect(positions).toEqual([11, 12, 13]);
    const overflowedFlags = result.placements.map(p => p.overflowed);
    expect(overflowedFlags.filter(Boolean)).toHaveLength(2);
    expect(result.unplaced).toHaveLength(0);
  });

  test('keeps exact slot for the first arrival even when others request the same', () => {
    // Bottle wanting slot 12 (which is free) should NOT be displaced
    // by overflow from slot-11 requests in pass 1.
    const result = placeBottles([], [
      { requestedPosition: 11, bottleId: 'a' },
      { requestedPosition: 11, bottleId: 'b' },
      { requestedPosition: 12, bottleId: 'c' },
    ], 24);
    const placementOf = (id) => result.placements.find(p => p.bottle === id).position;
    expect(placementOf('a')).toBe(11);   // exact
    expect(placementOf('c')).toBe(12);   // exact (not stolen by overflow)
    expect(placementOf('b')).toBe(13);   // overflowed past taken 12
  });

  test('respects existing occupied slots', () => {
    const existing = [{ position: 11, bottle: 'pre' }];
    const result = placeBottles(existing, [
      { requestedPosition: 11, bottleId: 'a' },
    ], 24);
    expect(result.placements[0].position).toBe(12);
    expect(result.placements[0].overflowed).toBe(true);
  });

  test('reports unplaced bottles when the rack is full', () => {
    // 5-slot rack, all pre-occupied
    const existing = [1, 2, 3, 4, 5].map(p => ({ position: p, bottle: `pre-${p}` }));
    const result = placeBottles(existing, [
      { requestedPosition: 3, bottleId: 'overflow' },
    ], 5);
    expect(result.placements).toHaveLength(0);
    expect(result.unplaced).toHaveLength(1);
    expect(result.unplaced[0].bottleId).toBe('overflow');
  });

  test('falls back to backward search when forward space is exhausted', () => {
    // 5-slot rack, slot 5 taken, requests at slot 5
    const existing = [{ position: 5, bottle: 'pre' }];
    const result = placeBottles(existing, [
      { requestedPosition: 5, bottleId: 'a' },
    ], 5);
    expect(result.placements[0].position).toBe(4);
  });
});

describe('placeBottlesInRack (orchestration)', () => {
  const buildRack = (overrides = {}) => ({
    type: 'grid', rows: 4, cols: 6, typeConfig: undefined,
    slots: [], maxPosition: 24, ...overrides
  });

  test('end-to-end: Oeno-style M3 with Quantity=3 at slot 11 spreads into 11,12,13', () => {
    // Recreates Keith's scenario for a single rack
    const rack = buildRack({ rows: 4, cols: 6, maxPosition: 24 });
    const items = [
      { item: { rackPosition: 11 }, bottleId: 'chenin-1', sourceIndex: 0 },
      { item: { rackPosition: 11 }, bottleId: 'chenin-2', sourceIndex: 1 },
      { item: { rackPosition: 11 }, bottleId: 'chenin-3', sourceIndex: 2 },
    ];
    const { placements, unplaced } = placeBottlesInRack(rack, items, 'top-left');
    expect(unplaced).toHaveLength(0);
    const placementOf = (id) => placements.find(p => p.bottle === id).position;
    expect(placementOf('chenin-1')).toBe(11);
    expect(placementOf('chenin-2')).toBe(12);
    expect(placementOf('chenin-3')).toBe(13);
  });

  test('end-to-end: anchor=bottom-left flips row before placement', () => {
    // Slot 11 in a 4×6 anchored bottom-left → Cellarion position 17
    const rack = buildRack();
    const { placements } = placeBottlesInRack(rack, [
      { item: { rackPosition: 11 }, bottleId: 'a', sourceIndex: 0 },
    ], 'bottom-left');
    expect(placements[0].position).toBe(17);
  });

  test('end-to-end: existing slots block placement, force overflow', () => {
    const rack = buildRack({
      slots: [{ position: 11, bottle: 'pre' }]
    });
    const { placements } = placeBottlesInRack(rack, [
      { item: { rackPosition: 11 }, bottleId: 'a', sourceIndex: 0 },
    ], 'top-left');
    expect(placements[0].position).toBe(12);
    expect(placements[0].overflowed).toBe(true);
  });

  test('end-to-end: reports unplaced when slot exceeds capacity', () => {
    const rack = buildRack({ rows: 2, cols: 6, maxPosition: 12 });
    const { placements, unplaced } = placeBottlesInRack(rack, [
      { item: { rackPosition: 25 }, bottleId: 'a', sourceIndex: 4 },
    ], 'top-left');
    expect(placements).toHaveLength(0);
    expect(unplaced).toHaveLength(1);
    expect(unplaced[0]).toMatchObject({ sourceIndex: 4, requestedPosition: 25 });
    expect(unplaced[0].reason).toMatch(/capacity/);
  });

  test('shelf rack: 3 bottles claiming Oeno cell 11 land in slots 31, 32, 33 (bpc=3)', () => {
    // Vintec/Oeno cabinet: shelf with 2 rows × 6 cols × 3 bottles/cell = 36 slots.
    // Oeno "cell 11" = top row, col 5 → Cellarion's first slot of cell 11 = 31.
    // 3 bottles all claiming cell 11 should naturally pack into slots 31, 32, 33.
    const rack = {
      type: 'shelf', rows: 2, cols: 6, typeConfig: { bottlesPerCell: 3 },
      slots: [], maxPosition: 36
    };
    const items = [
      { item: { rackPosition: 11 }, bottleId: 'chenin-1', sourceIndex: 0 },
      { item: { rackPosition: 11 }, bottleId: 'chenin-2', sourceIndex: 1 },
      { item: { rackPosition: 11 }, bottleId: 'chenin-3', sourceIndex: 2 },
    ];
    const { placements, unplaced } = placeBottlesInRack(rack, items, 'top-left');
    expect(unplaced).toHaveLength(0);
    const positions = placements.map(p => p.position).sort((a, b) => a - b);
    expect(positions).toEqual([31, 32, 33]);
  });

  test('shelf rack: cell 12 (next cell) gets positions 34-36; cell 1 gets 1-3', () => {
    const rack = {
      type: 'shelf', rows: 2, cols: 6, typeConfig: { bottlesPerCell: 3 },
      slots: [], maxPosition: 36
    };
    const items = [
      { item: { rackPosition: 1 }, bottleId: 'a', sourceIndex: 0 },
      { item: { rackPosition: 12 }, bottleId: 'b', sourceIndex: 1 },
    ];
    const { placements } = placeBottlesInRack(rack, items, 'top-left');
    const posOf = (id) => placements.find(p => p.bottle === id).position;
    expect(posOf('a')).toBe(1);
    expect(posOf('b')).toBe(34);
  });

  test('shelf rack with bottom-left anchor: cell 11 flips through cell-grid math', () => {
    // 2×6 shelf, bpc=3, anchor=bottom-left.
    // Oeno cell 11 → cell-grid (row 2, col 5). bottom-left flips row → (row 1, col 5).
    // Cellarion cell index = (1-1)*6 + 5 = 5. First slot of cell 5 = (5-1)*3 + 1 = 13.
    const rack = {
      type: 'shelf', rows: 2, cols: 6, typeConfig: { bottlesPerCell: 3 },
      slots: [], maxPosition: 36
    };
    const items = [
      { item: { rackPosition: 11 }, bottleId: 'a', sourceIndex: 0 },
    ];
    const { placements } = placeBottlesInRack(rack, items, 'bottom-left');
    expect(placements[0].position).toBe(13);
  });

  test('shelf rack: overflow when cell is full spills into the next cell', () => {
    // 4 bottles trying to fit into a cell with bpc=3 — the 4th overflows.
    const rack = {
      type: 'shelf', rows: 2, cols: 6, typeConfig: { bottlesPerCell: 3 },
      slots: [], maxPosition: 36
    };
    const items = Array.from({ length: 4 }, (_, i) => ({
      item: { rackPosition: 11 }, bottleId: `b${i}`, sourceIndex: i
    }));
    const { placements, unplaced } = placeBottlesInRack(rack, items, 'top-left');
    expect(unplaced).toHaveLength(0);
    const positions = placements.map(p => p.position).sort((a, b) => a - b);
    expect(positions).toEqual([31, 32, 33, 34]); // 34 is cell 12's first slot
  });

  test('end-to-end: row+col coordinates flatten using rack geometry', () => {
    const rack = buildRack();
    const { placements } = placeBottlesInRack(rack, [
      { item: { row: 2, col: 3 }, bottleId: 'a', sourceIndex: 0 },
    ], 'top-left');
    // row 2 col 3 in a 6-col grid → position (2-1)*6 + 3 = 9
    expect(placements[0].position).toBe(9);
  });
});
