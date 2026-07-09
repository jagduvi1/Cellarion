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

  // A Cellarion-native export carries the already-resolved internal slot index in
  // `position` for EVERY rack type, flagged with internalSlot. It must be treated
  // as identity — never re-interpreted as a shelf number — so placements survive
  // an export→import round-trip on shelf/x-rack/hex/… racks.
  describe('internalSlot (Cellarion-native export round-trip)', () => {
    test('shelf rack: internal slot is identity, NOT a shelf number', () => {
      // Without the flag a shelf treats position 11 as shelf 11 → slot 111…
      expect(computeRackPosition({
        position: 11, rackType: 'shelf', rackRows: 18, rackCols: 6, backCols: 5,
      })).toEqual({ position: 111 });
      // …with the flag it round-trips to the exact internal slot 11.
      expect(computeRackPosition({
        position: 11, internalSlot: true, rackType: 'shelf', rackRows: 18, rackCols: 6, backCols: 5,
      })).toEqual({ position: 11 });
    });

    test('grid rack: internal slot is identity too', () => {
      expect(computeRackPosition({ position: 7, internalSlot: true, rackType: 'grid', rackCols: 6 }))
        .toEqual({ position: 7 });
    });

    test('coerces a numeric string and rejects junk', () => {
      expect(computeRackPosition({ position: '11', internalSlot: true, rackType: 'shelf', rackCols: 6 }))
        .toEqual({ position: 11 });
      expect(computeRackPosition({ position: 0, internalSlot: true, rackType: 'shelf' }).error).toBeDefined();
    });

    test('ignored when no position is supplied (falls through to row/col)', () => {
      expect(computeRackPosition({ internalSlot: true, row: 2, col: 1, rackCols: 6 }))
        .toEqual({ position: 7 });
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
    // Realistic Oeno-style scenario: positions 4, 10, 11 → max 11 → 2×6
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
    // Realistic Oeno-style scenario: 9 bottles spread across positions 4-11
    // of rack M3, with several wines doubling up on the same position.
    // Required capacity = max(11, 9) = 11. Suggestion for 11 is 2×6 = 12 slots. ✓
    const plan = planRackCreations([
      { rackName: 'M3', rackPosition: 11 }, // wine A bottle 1
      { rackName: 'M3', rackPosition: 11 }, // wine A bottle 2
      { rackName: 'M3', rackPosition: 11 }, // wine A bottle 3
      { rackName: 'M3', rackPosition: 10 }, // wine B bottle 1
      { rackName: 'M3', rackPosition: 10 }, // wine B bottle 2
      { rackName: 'M3', rackPosition: 10 }, // wine B bottle 3
      { rackName: 'M3', rackPosition: 4 },  // wine C bottle 1
      { rackName: 'M3', rackPosition: 4 },  // wine C bottle 2
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

  test('treats disabled positions as occupied — exact request overflows past them', () => {
    const result = placeBottles([], [
      { requestedPosition: 3, bottleId: 'a' },
    ], 24, [3, 4]);
    expect(result.placements[0].position).toBe(5);
    expect(result.placements[0].overflowed).toBe(true);
  });

  test('overflow scan skips disabled positions', () => {
    const result = placeBottles([], [
      { requestedPosition: 1, bottleId: 'a' },
      { requestedPosition: 1, bottleId: 'b' },
    ], 24, [2]);
    const placementOf = (id) => result.placements.find(p => p.bottle === id).position;
    expect(placementOf('a')).toBe(1);
    expect(placementOf('b')).toBe(3); // 2 is disabled, not usable for overflow
  });

  test('disabled positions do not count as bottles placed', () => {
    const result = placeBottles([], [
      { requestedPosition: 1, bottleId: 'a' },
    ], 24, [10, 11, 12]);
    expect(result.placements).toHaveLength(1);
    expect(result.placements[0]).toEqual(expect.objectContaining({ position: 1, bottle: 'a' }));
  });

  test('reports unplaced when only disabled positions remain', () => {
    const existing = [{ position: 1, bottle: 'pre' }];
    const result = placeBottles(existing, [
      { requestedPosition: 2, bottleId: 'a' },
    ], 3, [2, 3]);
    expect(result.placements).toHaveLength(0);
    expect(result.unplaced).toHaveLength(1);
  });
});

describe('placeBottlesInRack (orchestration)', () => {
  const buildRack = (overrides = {}) => ({
    type: 'grid', rows: 4, cols: 6, typeConfig: undefined,
    slots: [], maxPosition: 24, ...overrides
  });

  test('end-to-end: Oeno-style M3 with Quantity=3 at slot 11 spreads into 11,12,13', () => {
    // Three bottles of one wine all targeting slot 11 of the same rack
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

  test('end-to-end: rack disabledPositions are never assigned', () => {
    const rack = buildRack({ disabledPositions: [11, 12] });
    const { placements, unplaced } = placeBottlesInRack(rack, [
      { item: { rackPosition: 11 }, bottleId: 'a', sourceIndex: 0 },
    ], 'top-left');
    expect(unplaced).toHaveLength(0);
    expect(placements[0].position).toBe(13);
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

  test('Oeno shelf rack: 3 bottles at M3-11 land on shelf 11 (front cells 1-3)', () => {
    // Transtherm Espace 1000: 18 shelves per module, 6 front + 5 back per shelf.
    // Oeno "M3-11" = shelf 11; the source app doesn't track which specific
    // cell within the shelf, so 3 bottles all land at the front of shelf 11.
    // Slots per shelf = 6 + 5 = 11. First slot of shelf 11 = (11-1)*11 + 1 = 111.
    const rack = {
      type: 'shelf', rows: 18, cols: 6, typeConfig: { bottlesPerCell: 1, backCols: 5 },
      slots: [], maxPosition: 198
    };
    const items = [
      { item: { rackPosition: 11 }, bottleId: 'chenin-1', sourceIndex: 0 },
      { item: { rackPosition: 11 }, bottleId: 'chenin-2', sourceIndex: 1 },
      { item: { rackPosition: 11 }, bottleId: 'chenin-3', sourceIndex: 2 },
    ];
    const { placements, unplaced } = placeBottlesInRack(rack, items, 'top-left');
    expect(unplaced).toHaveLength(0);
    const positions = placements.map(p => p.position).sort((a, b) => a - b);
    expect(positions).toEqual([111, 112, 113]);
  });

  test('Oeno shelf rack: bottom-left anchor flips shelf 11 to shelf 8', () => {
    // 18-shelf rack, bottom-left anchor. Oeno shelf 11 from bottom =
    // effective shelf 18 - 11 + 1 = 8 from top. First slot = (8-1)*11 + 1 = 78.
    const rack = {
      type: 'shelf', rows: 18, cols: 6, typeConfig: { bottlesPerCell: 1, backCols: 5 },
      slots: [], maxPosition: 198
    };
    const { placements } = placeBottlesInRack(rack, [
      { item: { rackPosition: 11 }, bottleId: 'a', sourceIndex: 0 },
    ], 'bottom-left');
    expect(placements[0].position).toBe(78);
  });

  test('Oeno shelf rack: 11 bottles on the same shelf fill front then back', () => {
    // A shelf full case: 11 bottles all at shelf 5. Slots 45-55 (front 6 + back 5).
    const rack = {
      type: 'shelf', rows: 18, cols: 6, typeConfig: { bottlesPerCell: 1, backCols: 5 },
      slots: [], maxPosition: 198
    };
    const items = Array.from({ length: 11 }, (_, i) => ({
      item: { rackPosition: 5 }, bottleId: `b${i}`, sourceIndex: i
    }));
    const { placements, unplaced } = placeBottlesInRack(rack, items, 'top-left');
    expect(unplaced).toHaveLength(0);
    const positions = placements.map(p => p.position).sort((a, b) => a - b);
    expect(positions).toEqual([45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55]);
  });

  test('Cellarion shelf rack: internalSlot items round-trip to their exact slots', () => {
    // The regression for the export→import bug: a Cellarion export stores the
    // internal slot index (e.g. 111, 112, 113) and flags it internalSlot. These
    // must land back on the SAME slots, not be re-read as shelf numbers.
    const rack = {
      type: 'shelf', rows: 18, cols: 6, typeConfig: { bottlesPerCell: 1, backCols: 5 },
      slots: [], maxPosition: 198
    };
    const items = [
      { item: { rackPosition: 111, internalSlot: true }, bottleId: 'a', sourceIndex: 0 },
      { item: { rackPosition: 112, internalSlot: true }, bottleId: 'b', sourceIndex: 1 },
      { item: { rackPosition: 113, internalSlot: true }, bottleId: 'c', sourceIndex: 2 },
    ];
    const { placements, unplaced } = placeBottlesInRack(rack, items, 'top-left');
    expect(unplaced).toHaveLength(0);
    const placementOf = (id) => placements.find(p => p.bottle === id).position;
    expect(placementOf('a')).toBe(111);
    expect(placementOf('b')).toBe(112);
    expect(placementOf('c')).toBe(113);
  });

  test('Oeno shelf rack: 12th bottle on a full shelf spills into the next shelf', () => {
    const rack = {
      type: 'shelf', rows: 18, cols: 6, typeConfig: { bottlesPerCell: 1, backCols: 5 },
      slots: [], maxPosition: 198
    };
    const items = Array.from({ length: 12 }, (_, i) => ({
      item: { rackPosition: 5 }, bottleId: `b${i}`, sourceIndex: i
    }));
    const { placements, unplaced } = placeBottlesInRack(rack, items, 'top-left');
    expect(unplaced).toHaveLength(0);
    const positions = placements.map(p => p.position).sort((a, b) => a - b);
    // Shelf 5 holds 11 (positions 45-55); 12th bottle overflows to shelf 6 slot 56
    expect(positions).toEqual([45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56]);
  });

  test('Oeno-export bottle with explicit layer + slotInLayer (front cell)', () => {
    // 18-shelf rack (6 front + 5 back). Bottle on shelf 18, front layer,
    // slot 5. With bottom-left anchor → effective shelf 1.
    // First slot of shelf 1 = 1; front layer slot 5 = position 5.
    const rack = {
      type: 'shelf', rows: 18, cols: 6, typeConfig: { bottlesPerCell: 1, backCols: 5 },
      slots: [], maxPosition: 198
    };
    const { placements } = placeBottlesInRack(rack, [
      { item: { rackPosition: 18, layer: 1, slotInLayer: 5 }, bottleId: 'syrah', sourceIndex: 0 },
    ], 'bottom-left');
    expect(placements[0].position).toBe(5);
  });

  test('Oeno-export bottle with layer=2 (back) maps to slot cols + slotInLayer', () => {
    // Shelf 18, layer 2 (back), slot 3 → back slots start at cols+1 (=7).
    // With bottom-left: effective shelf 1, base slot 0, back slot 3 = position 9.
    const rack = {
      type: 'shelf', rows: 18, cols: 6, typeConfig: { bottlesPerCell: 1, backCols: 5 },
      slots: [], maxPosition: 198
    };
    const { placements } = placeBottlesInRack(rack, [
      { item: { rackPosition: 18, layer: 2, slotInLayer: 3 }, bottleId: 'b', sourceIndex: 0 },
    ], 'bottom-left');
    expect(placements[0].position).toBe(9); // 0 + 6 + 3
  });

  test('Oeno-export bottle: top-left anchor maps shelf 1 layer 1 slot 1 → position 1', () => {
    const rack = {
      type: 'shelf', rows: 18, cols: 6, typeConfig: { bottlesPerCell: 1, backCols: 5 },
      slots: [], maxPosition: 198
    };
    const { placements } = placeBottlesInRack(rack, [
      { item: { rackPosition: 1, layer: 1, slotInLayer: 1 }, bottleId: 'a', sourceIndex: 0 },
    ], 'top-left');
    expect(placements[0].position).toBe(1);
  });

  test('Oeno shelf rack with bpc=2 (stacked): slot count = (cols+back)*bpc per shelf', () => {
    // Hypothetical cabinet: 18 shelves, 6 front + 5 back, but each cell
    // holds 2 bottles stacked. slotsPerShelf = (6+5)*2 = 22.
    // First slot of shelf 11 (top-left anchor) = (11-1)*22 + 1 = 221.
    const rack = {
      type: 'shelf', rows: 18, cols: 6, typeConfig: { bottlesPerCell: 2, backCols: 5 },
      slots: [], maxPosition: 396
    };
    const { placements, unplaced } = placeBottlesInRack(rack, [
      { item: { rackPosition: 11 }, bottleId: 'a', sourceIndex: 0 },
      { item: { rackPosition: 11 }, bottleId: 'b', sourceIndex: 1 },
      { item: { rackPosition: 11 }, bottleId: 'c', sourceIndex: 2 },
    ], 'top-left');
    expect(unplaced).toHaveLength(0);
    const positions = placements.map(p => p.position).sort((a, b) => a - b);
    expect(positions).toEqual([221, 222, 223]);
  });

  test('skip flag is honoured at the route level (helper level: pass an empty group)', () => {
    // placeBottlesInRack itself doesn't know about `skip` — that's the route's
    // responsibility. Verify the contract: when the route filters out skipped
    // racks, the helper sees an empty items array and returns empty arrays.
    const rack = buildRack();
    const { placements, unplaced } = placeBottlesInRack(rack, [], 'top-left');
    expect(placements).toEqual([]);
    expect(unplaced).toEqual([]);
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

// ── Shelf stride with bottlesPerCell > 1 / back columns (audit MED #16) ─────
// Canonical numbering (ShelfView): each shelf spans (cols + backCols) * bpc
// positions; the front layer covers the first cols*bpc, the back layer starts
// at cols*bpc. These pin the importer to that contract.
describe('shelf racks with bottlesPerCell > 1', () => {
  const shelf = { rackType: 'shelf', rackRows: 10, rackCols: 6, backCols: 5, bottlesPerCell: 2 };
  const stride = (6 + 5) * 2; // 22 positions per shelf

  test('front layer slot lands within the front span of its shelf', () => {
    // shelf 1 (top-anchored), front slot 8 → base 0 + 8
    expect(computeRackPosition({ ...shelf, position: 1, layer: 1, slotInLayer: 8 }))
      .toEqual({ position: 8 });
    // front capacity is cols*bpc = 12, not cols = 6
    expect(computeRackPosition({ ...shelf, position: 1, layer: 1, slotInLayer: 12 }))
      .toEqual({ position: 12 });
    expect(computeRackPosition({ ...shelf, position: 1, layer: 1, slotInLayer: 13 }).error).toBeDefined();
  });

  test('back layer starts after cols*bpc, not after cols', () => {
    // shelf 1, back slot 1 → 0 + 6*2 + 1 = 13 (the old math returned 7 — a FRONT cell)
    expect(computeRackPosition({ ...shelf, position: 1, layer: 2, slotInLayer: 1 }))
      .toEqual({ position: 13 });
    // back capacity is backCols*bpc = 10
    expect(computeRackPosition({ ...shelf, position: 1, layer: 2, slotInLayer: 10 }))
      .toEqual({ position: 22 });
    expect(computeRackPosition({ ...shelf, position: 1, layer: 2, slotInLayer: 11 }).error).toBeDefined();
  });

  test('shelf 2 uses the full (cols+backCols)*bpc stride', () => {
    expect(computeRackPosition({ ...shelf, position: 2, layer: 1, slotInLayer: 1 }))
      .toEqual({ position: stride + 1 });
    expect(computeRackPosition({ ...shelf, position: 2, layer: 2, slotInLayer: 1 }))
      .toEqual({ position: stride + 12 + 1 });
  });

  test('row/col input on a shelf rack uses the shelf stride, front-layer width', () => {
    // row 2, col 3 → (2-1)*22 + 3 = 25 (the old math returned (2-1)*6 + 3 = 9 — shelf 1's back layer)
    expect(computeRackPosition({ ...shelf, row: 2, col: 3 }))
      .toEqual({ position: 25 });
    // col bounded by front width (12)
    expect(computeRackPosition({ ...shelf, row: 1, col: 12 })).toEqual({ position: 12 });
    expect(computeRackPosition({ ...shelf, row: 1, col: 13 }).error).toBeDefined();
  });

  test('bpc=1 shelves keep the historical numbering (regression guard)', () => {
    const oeno = { rackType: 'shelf', rackRows: 18, rackCols: 6, backCols: 5 };
    // shelf 11 top-anchored: base (11-1)*11 = 110; front 3 → 113; back 2 → 110+6+2 = 118
    expect(computeRackPosition({ ...oeno, position: 11, layer: 1, slotInLayer: 3 }))
      .toEqual({ position: 113 });
    expect(computeRackPosition({ ...oeno, position: 11, layer: 2, slotInLayer: 2 }))
      .toEqual({ position: 118 });
  });

  test('plain grids are untouched by the stride change', () => {
    expect(computeRackPosition({ row: 2, col: 3, rackCols: 6 })).toEqual({ position: 9 });
    expect(computeRackPosition({ position: 9, rackCols: 6, rackRows: 4, anchor: 'bottom-left' }))
      .toEqual({ position: (4 - 2) * 6 + 3 });
  });
});
