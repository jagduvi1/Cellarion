import {
  computeLayout, computeModularLayout, getModularTotalSlots, getTotalSlots,
  SLOT_RADIUS, validDoubleHeightRows, DOUBLE_ROW_HEADROOM, cabinetShelfRows,
  cabinetRowWidth, cabinetBayCapacity, cabinetBays, cabinetBayUnits,
} from './rackLayouts';

describe('computeLayout', () => {
  describe('grid', () => {
    it('returns rows × cols slots', () => {
      const layout = computeLayout('grid', 4, 8);
      expect(layout.totalSlots).toBe(32);
      expect(layout.slots).toHaveLength(32);
    });

    it('1×1 grid has one slot', () => {
      const layout = computeLayout('grid', 1, 1);
      expect(layout.totalSlots).toBe(1);
    });

    it('positions are contiguous 1..N', () => {
      const layout = computeLayout('grid', 3, 4);
      const positions = layout.slots.map(s => s.position);
      expect(positions).toEqual([1,2,3,4,5,6,7,8,9,10,11,12]);
    });
  });

  describe('grid — double-height rows', () => {
    // POSITION NUMBERING CONTRACT: base grid keeps positions 1..rows*cols
    // row-major exactly as a plain grid; top-layer positions are APPENDED
    // after rows*cols in ascending row order, cols-1 per double row.
    const CELL = 48; // SLOT_R*2 + SLOT_GAP

    it('appends cols-1 top slots per double row (4x6, row 2 → 29)', () => {
      const layout = computeLayout('grid', 4, 6, { doubleHeightRows: [2] });
      expect(layout.totalSlots).toBe(29);
      expect(layout.slots.map(s => s.position))
        .toEqual(Array.from({ length: 29 }, (_, i) => i + 1));
    });

    it('base positions 1..rows*cols keep plain-grid order and x coordinates', () => {
      const plain = computeLayout('grid', 4, 6);
      const dbl = computeLayout('grid', 4, 6, { doubleHeightRows: [2] });
      for (let i = 0; i < 24; i++) {
        expect(dbl.slots[i].position).toBe(plain.slots[i].position);
        expect(dbl.slots[i].cx).toBe(plain.slots[i].cx);
      }
    });

    it('top-layer slots sit staggered between and above their base row', () => {
      const layout = computeLayout('grid', 4, 6, { doubleHeightRows: [2] });
      const baseRow2 = layout.slots.filter(s => s.position >= 7 && s.position <= 12);
      const tops = layout.slots.filter(s => s.isTop);
      expect(tops.map(s => s.position)).toEqual([25, 26, 27, 28, 29]);
      tops.forEach((s, i) => {
        expect(s.cx).toBeCloseTo((baseRow2[i].cx + baseRow2[i + 1].cx) / 2);
        expect(s.cy).toBeCloseTo(baseRow2[i].cy - CELL * DOUBLE_ROW_HEADROOM);
      });
    });

    it('grows taller per double row; rows below the double row shift down', () => {
      const plain = computeLayout('grid', 4, 6);
      const dbl = computeLayout('grid', 4, 6, { doubleHeightRows: [2] });
      const extra = CELL * DOUBLE_ROW_HEADROOM;
      expect(dbl.viewBox.height).toBeCloseTo(plain.viewBox.height + extra);
      expect(dbl.slots[0].cy).toBe(plain.slots[0].cy);            // row 1 unchanged
      expect(dbl.slots[6].cy).toBeCloseTo(plain.slots[6].cy + extra);   // row 2 shifted
      expect(dbl.slots[23].cy).toBeCloseTo(plain.slots[23].cy + extra); // row 4 shifted
    });

    it('emits explicit shelfYs so planks skip the top layers', () => {
      const layout = computeLayout('grid', 4, 6, { doubleHeightRows: [2] });
      expect(layout.shelfYs).toHaveLength(3); // rows-1 planks, top layer not counted
    });

    it('filters invalid rows; cols = 1 contributes nothing', () => {
      expect(computeLayout('grid', 4, 6, { doubleHeightRows: [0, 99] }).totalSlots).toBe(24);
      expect(computeLayout('grid', 4, 1, { doubleHeightRows: [2] }).totalSlots).toBe(4);
    });

    it('getTotalSlots matches computeLayout and the backend formula', () => {
      const tc = { doubleHeightRows: [1, 3] };
      expect(getTotalSlots('grid', 4, 6, tc)).toBe(4 * 6 + 2 * (6 - 1));
      expect(getTotalSlots('grid', 4, 6, tc)).toBe(computeLayout('grid', 4, 6, tc).totalSlots);
    });

    it('validDoubleHeightRows dedupes, sorts and filters', () => {
      expect(validDoubleHeightRows(4, 6, [3, 1, 3, 0, 99])).toEqual([1, 3]);
      expect(validDoubleHeightRows(4, 1, [2])).toEqual([]);
      expect(validDoubleHeightRows(4, 6, undefined)).toEqual([]);
    });
  });

  describe('x-rack', () => {
    it('default bottlesPerSection (10) → 40 slots', () => {
      expect(computeLayout('x-rack', 1, 1).totalSlots).toBe(40);
    });

    it('bottlesPerSection 6 → 24 slots', () => {
      expect(computeLayout('x-rack', 1, 1, { bottlesPerSection: 6 }).totalSlots).toBe(24);
    });

    it('bottlesPerSection 1 → 4 slots', () => {
      expect(computeLayout('x-rack', 1, 1, { bottlesPerSection: 1 }).totalSlots).toBe(4);
    });

    it('has contiguous positions', () => {
      const layout = computeLayout('x-rack', 1, 1, { bottlesPerSection: 6 });
      const positions = layout.slots.map(s => s.position).sort((a, b) => a - b);
      expect(positions).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    });
  });

  describe('hex', () => {
    it('3 rows, 4 cols → 11 slots', () => {
      expect(computeLayout('hex', 3, 4).totalSlots).toBe(11);
    });

    it('1 row, 5 cols → 5 slots', () => {
      expect(computeLayout('hex', 1, 5).totalSlots).toBe(5);
    });

    it('4 rows, 3 cols → 10 slots', () => {
      expect(computeLayout('hex', 4, 3).totalSlots).toBe(10);
    });

    describe('hexFlip', () => {
      it('is a no-op for an odd row count (the unflipped sequence is a palindrome)', () => {
        const unflipped = computeLayout('hex', 3, 4);
        const flipped = computeLayout('hex', 3, 4, { hexFlip: true });
        expect(flipped).toEqual(unflipped);
      });

      it('swaps which row is short for an even row count, without changing total slots', () => {
        const unflipped = computeLayout('hex', 4, 3);
        const flipped = computeLayout('hex', 4, 3, { hexFlip: true });
        expect(flipped.totalSlots).toBe(unflipped.totalSlots);

        const rowSize = (layout) => layout.slots.filter(s => s.cy === layout.slots[0].cy).length;
        // Unflipped row 0 is full width (3 cols); flipped row 0 mirrors the
        // old last row, which is short (2 cols).
        expect(rowSize(unflipped)).toBe(3);
        expect(rowSize(flipped)).toBe(2);
      });
    });

    // The equal-row staggered shelf (e.g. Liebherr GrandCru top/bottom
    // shelves: 4-4-4-4, offset — effectively 4.5 bottles wide).
    describe('hexEqualRows', () => {
      const rowsOf = (layout) => {
        const ys = [...new Set(layout.slots.map(s => s.cy))].sort((a, b) => a - b);
        return ys.map(y => layout.slots.filter(s => s.cy === y));
      };

      it('every row holds the full column count — total = rows × cols', () => {
        expect(computeLayout('hex', 4, 4, { hexEqualRows: true }).totalSlots).toBe(16);
        expect(computeLayout('hex', 4, 4).totalSlots).toBe(14); // classic, unchanged
      });

      it('offset rows keep the half-slot stagger at full width', () => {
        const [row0, row1] = rowsOf(computeLayout('hex', 2, 4, { hexEqualRows: true }));
        expect(row0).toHaveLength(4);
        expect(row1).toHaveLength(4);
        const cell = row0[1].cx - row0[0].cx;
        expect(row1[0].cx - row0[0].cx).toBeCloseTo(cell / 2);
      });

      it('the viewBox is wide enough for the staggered full-width rows', () => {
        for (const cols of [1, 4]) {
          const layout = computeLayout('hex', 2, cols, { hexEqualRows: true });
          const maxCx = Math.max(...layout.slots.map(s => s.cx));
          expect(layout.viewBox.width).toBeGreaterThanOrEqual(maxCx + SLOT_RADIUS);
        }
      });

      it('composes with hexFlip: the flip decides which rows are offset', () => {
        const plain = computeLayout('hex', 2, 4, { hexEqualRows: true });
        const flipped = computeLayout('hex', 2, 4, { hexEqualRows: true, hexFlip: true });
        expect(flipped.totalSlots).toBe(plain.totalSlots);
        // Unflipped: row 0 flush left, row 1 offset. Flipped: the reverse.
        expect(rowsOf(plain)[0][0].cx).toBeLessThan(rowsOf(flipped)[0][0].cx);
        expect(rowsOf(plain)[1][0].cx).toBeGreaterThan(rowsOf(flipped)[1][0].cx);
      });

      it('getTotalSlots mirrors the layout and the backend formula', () => {
        expect(getTotalSlots('hex', 4, 4, { hexEqualRows: true })).toBe(16);
        expect(getTotalSlots('hex', 4, 4, { hexEqualRows: true, hexFlip: true })).toBe(16);
        expect(getTotalSlots('hex', 4, 4)).toBe(14);
        expect(getTotalSlots('hex', 4, 4, { hexFlip: true })).toBe(14);
      });

      it('counts equal-row hex modules inside modular racks', () => {
        expect(getModularTotalSlots([
          { type: 'hex', rows: 4, cols: 4, typeConfig: { hexEqualRows: true } },
          { type: 'hex', rows: 4, cols: 4 },
        ])).toBe(16 + 14);
      });
    });
  });

  describe('triangle', () => {
    it('base 4 → 10 slots', () => {
      expect(computeLayout('triangle', 1, 4).totalSlots).toBe(10);
    });

    it('base 5 → 15 slots', () => {
      expect(computeLayout('triangle', 1, 5).totalSlots).toBe(15);
    });

    it('base 1 → 1 slot', () => {
      expect(computeLayout('triangle', 1, 1).totalSlots).toBe(1);
    });
  });

  describe('stack', () => {
    it('returns rows slots', () => {
      expect(computeLayout('stack', 6, 1).totalSlots).toBe(6);
    });

    it('1 high → 1 slot', () => {
      expect(computeLayout('stack', 1, 1).totalSlots).toBe(1);
    });
  });

  describe('cube', () => {
    it('2×2 outer, default 2×2 modules → 16', () => {
      expect(computeLayout('cube', 2, 2).totalSlots).toBe(16);
    });

    it('3×2 outer, 3×3 modules → 54', () => {
      expect(computeLayout('cube', 3, 2, { moduleRows: 3, moduleCols: 3 }).totalSlots).toBe(54);
    });
  });

  describe('shelf', () => {
    it('3 rows, 2 cols → 6 slots (bpc=1 default)', () => {
      expect(computeLayout('shelf', 3, 2).totalSlots).toBe(6);
    });

    it('2 rows, 3 cols with bpc=4 → 24 slots', () => {
      const layout = computeLayout('shelf', 2, 3, { bottlesPerCell: 4 });
      expect(layout.totalSlots).toBe(24);
      expect(layout.bottlesPerCell).toBe(4);
    });

    it('positions sharing same cell have identical coordinates', () => {
      const layout = computeLayout('shelf', 1, 1, { bottlesPerCell: 4 });
      expect(layout.totalSlots).toBe(4);
      const uniqueCoords = new Set(layout.slots.map(s => `${s.cx},${s.cy}`));
      expect(uniqueCoords.size).toBe(1);
    });
  });

  describe('unknown type falls back to grid', () => {
    it('returns rows × cols', () => {
      expect(computeLayout('nonexistent', 3, 5).totalSlots).toBe(15);
    });
  });

  // ── Cabinet (wine fridge) ─────────────────────────────────────────
  // POSITION NUMBERING CONTRACT: shelves top to bottom; inside a bay row 1
  // rests on the plank; position = cols × Σ shelfRows[k<i] + (row − 1) × cols
  // + slot. twoDeep pairs rows front/back per level without renumbering.
  describe('cabinet', () => {
    const tc = { shelfRows: [1, 3, 2], twoDeep: true }; // 6 + 18 + 12 = 36
    const layout = computeLayout('cabinet', 3, 6, tc);
    const at = (p) => layout.slots.find(s => s.position === p);

    it('numbers bays top to bottom and rows from the plank up', () => {
      expect(layout.totalSlots).toBe(36);
      // top bay (1 row): positions 1..6 on one y
      expect(new Set(layout.slots.slice(0, 6).map(s => s.cy)).size).toBe(1);
      // middle bay starts at 7 and sits BELOW the top bay
      expect(at(7).cy).toBeGreaterThan(at(1).cy);
      // inside the middle bay, row 3 (positions 19..24) is drawn ABOVE row 1 (7..12)
      expect(at(19).cy).toBeLessThan(at(7).cy);
      // bottom bay (25..36) is below the middle bay's lowest row
      expect(at(25).cy).toBeGreaterThan(at(7).cy);
    });

    it('twoDeep: even rows are the back row of their level — smaller, staggered, slightly higher', () => {
      expect(at(7).isBack).toBeUndefined();
      expect(at(13).isBack).toBe(true);             // row 2 of the middle bay
      expect(at(13).cy).toBeLessThan(at(7).cy);      // peeks above its front row
      expect(at(13).cy).toBeGreaterThan(at(19).cy);  // but stays below the level above
      expect(at(13).cx).toBeGreaterThan(at(7).cx);   // half-cell stagger
      expect(layout.backRadius).toBeDefined();
      // row 3 (level 2 front) rests on bottles, not wood → no scallop bumps
      expect(at(19).isTop).toBe(true);
      expect(at(7).isTop).toBeUndefined();
    });

    it('single-deep: every row is its own level, no back rows', () => {
      const single = computeLayout('cabinet', 2, 4, { shelfRows: [2, 1], twoDeep: false });
      expect(single.totalSlots).toBe(12);
      expect(single.slots.some(s => s.isBack)).toBe(false);
      expect(single.backRadius).toBeUndefined();
      const p = (n) => single.slots.find(s => s.position === n);
      expect(p(5).cy).toBeLessThan(p(1).cy); // row 2 above row 1 in the top bay
      expect(p(9).cy).toBeGreaterThan(p(1).cy); // bottom bay below
    });

    it('stagger (default): stacked levels nest — offset half a bottle, sitting closer together, same positions', () => {
      const square = computeLayout('cabinet', 3, 6, { ...tc, stagger: false });
      // Numbering is identical with and without stagger — it is drawing only.
      expect(layout.slots.map(s => s.position)).toEqual(square.slots.map(s => s.position));
      expect(layout.totalSlots).toBe(square.totalSlots);
      expect(layout.cabinet.stagger).toBe(true);
      expect(square.cabinet.stagger).toBe(false);

      const at = (l, p) => l.slots.find(s => s.position === p);
      // Middle bay rows: 1 = level 1 front (7..12), 2 = level 1 back (13..18),
      // 3 = level 2 front (19..24). Only EVEN levels are nudged, so level 1 —
      // front and back alike — keeps its x and level 2 moves half a cell.
      expect(at(layout, 7).cx).toBe(at(square, 7).cx);
      expect(at(layout, 13).cx).toBe(at(square, 13).cx);
      expect(at(layout, 19).cx).toBeGreaterThan(at(square, 19).cx);
      // Nested levels sit closer to the level below than squared ones do.
      const nestedGap = at(layout, 7).cy - at(layout, 19).cy;
      const squareGap = at(square, 7).cy - at(square, 19).cy;
      expect(nestedGap).toBeLessThan(squareGap);
      expect(nestedGap).toBeGreaterThan(0);
      // The staggered shelf is half a bottle wider, and nothing escapes it.
      expect(layout.viewBox.width).toBeGreaterThan(square.viewBox.width);
      layout.slots.forEach((slot) => {
        expect(slot.cx).toBeLessThanOrEqual(layout.viewBox.width);
      });
      // A bay of a single row has nothing to nest, so it is unaffected —
      // horizontally AND vertically (the first level rests on the plank).
      const oneRow = computeLayout('cabinet', 1, 4, { shelfRows: [1] });
      const oneRowSquare = computeLayout('cabinet', 1, 4, { shelfRows: [1], stagger: false });
      expect(oneRow.slots.map(s => s.cx)).toEqual(oneRowSquare.slots.map(s => s.cx));
      expect(oneRow.slots.map(s => s.cy)).toEqual(oneRowSquare.slots.map(s => s.cy));
      expect(oneRow.viewBox.height).toBe(oneRowSquare.viewBox.height);
      // Only the levels above the first close up: a 3-level bay nests twice.
      const three = computeLayout('cabinet', 1, 4, { shelfRows: [3], twoDeep: false });
      const threeSquare = computeLayout('cabinet', 1, 4, { shelfRows: [3], twoDeep: false, stagger: false });
      expect(three.viewBox.height).toBeLessThan(threeSquare.viewBox.height);
      // Exactly one nesting step per level ABOVE the first: a 3-level bay
      // closes up twice as much as a 2-level bay. (The bay is anchored at its
      // top, so a shorter bay legitimately lifts its own plank.)
      const twoLvl = computeLayout("cabinet", 1, 4, { shelfRows: [2], twoDeep: false });
      const twoLvlSquare = computeLayout("cabinet", 1, 4, { shelfRows: [2], twoDeep: false, stagger: false });
      const step = twoLvlSquare.viewBox.height - twoLvl.viewBox.height;
      expect(step).toBeGreaterThan(0);
      expect(threeSquare.viewBox.height - three.viewBox.height).toBeCloseTo(step * 2, 6);
    });

    it('draws one plank line between bays and exposes the bay list', () => {
      expect(layout.shelfYs).toHaveLength(2);
      expect(layout.cabinet.bays.map(b => b.rows)).toEqual([1, 3, 2]);
      expect(layout.cabinet.bays.map(b => b.levels)).toEqual([1, 2, 1]);
      expect(computeLayout('cabinet', 1, 3, { shelfRows: [2] }).shelfYs).toBeUndefined();
    });

    // Support ticket 2026-09-15: a Liebherr GrandCru 5001 stacks 6 in front
    // of 5, then 5 in front of 6 — rows alternate cols / cols−1, the narrow
    // ones lying in the grooves of the wide ones. Changes capacity and the
    // numbering, so unlike stagger it is pinned slot by slot.
    describe('alternate', () => {
      const alt = computeLayout('cabinet', 1, 6, { shelfRows: [4], twoDeep: true, alternate: true });
      const at = (p) => alt.slots.find(s => s.position === p);

      it('rows are 6, 5, 5, 6 wide and numbered straight on — 22 slots, not 24', () => {
        expect(alt.totalSlots).toBe(22);
        expect(alt.slots.map(s => s.position)).toEqual(Array.from({ length: 22 }, (_, i) => i + 1));
        expect(getTotalSlots('cabinet', 1, 6, { shelfRows: [4], twoDeep: true, alternate: true })).toBe(22);
        // row 1 (level 1 front) 1..6, row 2 (level 1 back) 7..11, row 3 (level 2 front) 12..16, row 4 (level 2 back) 17..22
        const rowOf = (from, to) => alt.slots.filter(s => s.position >= from && s.position <= to);
        expect(new Set(rowOf(1, 6).map(s => s.cy)).size).toBe(1);
        expect(rowOf(7, 11).every(s => s.isBack)).toBe(true);
        expect(rowOf(12, 16).every(s => !s.isBack && s.isTop)).toBe(true);
        expect(rowOf(17, 22).every(s => s.isBack)).toBe(true);
        expect(at(7).cy).toBeLessThan(at(1).cy);
        expect(at(12).cy).toBeLessThan(at(7).cy);
        expect(at(17).cy).toBeLessThan(at(12).cy);
      });

      it('the narrow rows sit half a bottle over, in the gaps of the wide rows; the wide rows line up', () => {
        const half = (at(2).cx - at(1).cx) / 2;
        expect(at(7).cx).toBeCloseTo(at(1).cx + half, 6);   // level 1 back (5) between the 6 in front
        expect(at(12).cx).toBeCloseTo(at(1).cx + half, 6);  // level 2 front (5) in the grooves of level 1
        expect(at(17).cx).toBeCloseTo(at(1).cx, 6);         // level 2 back (6) full width again
        expect(at(11).cx).toBeCloseTo(at(5).cx + half, 6);
        expect(at(22).cx).toBeCloseTo(at(6).cx, 6);
      });

      it('the shelf is exactly cols wide — no half-bottle overhang — and nothing escapes it', () => {
        const plain = computeLayout('cabinet', 1, 6, { shelfRows: [4], twoDeep: false, stagger: false });
        expect(alt.viewBox.width).toBe(plain.viewBox.width);
        alt.slots.forEach((slot) => {
          expect(slot.cx + SLOT_RADIUS).toBeLessThanOrEqual(alt.viewBox.width);
          expect(slot.cx - SLOT_RADIUS).toBeGreaterThanOrEqual(0);
        });
      });

      it('alternating rows always nest: stagger is implied, and the levels sit at the nested pitch', () => {
        const forced = computeLayout('cabinet', 1, 6, { shelfRows: [4], twoDeep: true, alternate: true, stagger: false });
        expect(forced.cabinet.stagger).toBe(true);
        expect(forced.cabinet.alternate).toBe(true);
        expect(forced.slots.map(s => [s.cx, s.cy])).toEqual(alt.slots.map(s => [s.cx, s.cy]));
        const nested = computeLayout('cabinet', 1, 6, { shelfRows: [4], twoDeep: true, stagger: true });
        expect(alt.viewBox.height).toBe(nested.viewBox.height);
      });

      it('single deep: levels alternate 4, 3, 4 with the 3 centred in the grooves', () => {
        const single = computeLayout('cabinet', 1, 4, { shelfRows: [3], twoDeep: false, alternate: true });
        expect(single.totalSlots).toBe(11);
        const p = (n) => single.slots.find(s => s.position === n);
        const half = (p(2).cx - p(1).cx) / 2;
        expect(p(5).cx).toBeCloseTo(p(1).cx + half, 6);
        expect(p(7).cx).toBeCloseTo(p(3).cx + half, 6);
        expect(p(8).cx).toBeCloseTo(p(1).cx, 6);
        expect(single.slots.some(s => s.isBack)).toBe(false);
      });

      it('per-shelf width and pattern: a narrower bay is centred, and the 5001 loading diagram is 196', () => {
        const tc = { shelfRows: [8, 8, 8, 8, 8], shelfCols: [4, 6, 6, 6, 4], shelfAlternate: [false, true, true, true, false], twoDeep: true };
        const l = computeLayout('cabinet', 5, 6, tc);
        expect(l.totalSlots).toBe(196);
        expect(getTotalSlots('cabinet', 5, 6, tc)).toBe(196);
        expect(l.cabinet.bays.map(b => [b.cols, b.alternate])).toEqual([[4, false], [6, true], [6, true], [6, true], [4, false]]);
        expect(l.cabinet.alternate).toBe(false); // not EVERY bay
        const p = (n) => l.slots.find(s => s.position === n);
        // Top bay: 8 rows of 4 (positions 1..32), staggered — the second
        // level nudged half a cell; the honeycomb bay below starts at 33.
        expect(l.slots.filter(s => s.position <= 32).map(s => s.isBack).filter(Boolean)).toHaveLength(16);
        expect(p(9).cx).toBeCloseTo(p(1).cx + (p(2).cx - p(1).cx) / 2, 6);
        expect(p(33).cy).toBeGreaterThan(p(1).cy);
        // The 4-wide bay (4.5 units with its stagger + back row: 4 + 0.5 + 0.5
        // = 5) sits centred inside the 6-wide cabinet (6.5 units: 6 + 0.5 for
        // the back row… an alternating bay is exactly 6), so its first bottle
        // starts to the right of the honeycomb bay's first bottle.
        expect(p(1).cx).toBeGreaterThan(p(33).cx);
        // A layout without per-shelf lists is unchanged by the new fields.
        const plain = computeLayout('cabinet', 2, 6, { shelfRows: [2, 3], twoDeep: true });
        const explicit = computeLayout('cabinet', 2, 6, { shelfRows: [2, 3], twoDeep: true, shelfCols: [6, 6], shelfAlternate: [false, false] });
        expect(explicit.slots).toEqual(plain.slots);
        expect(explicit.viewBox).toEqual(plain.viewBox);
        expect(cabinetBays(2, 6, { shelfRows: [1, 2], shelfCols: [3] })).toEqual([{ rows: 1, cols: 3, alternate: false }, { rows: 2, cols: 6, alternate: false }]);
        // Every slot stays inside the drawing.
        l.slots.forEach((slot) => {
          expect(slot.cx + SLOT_RADIUS).toBeLessThanOrEqual(l.viewBox.width);
          expect(slot.cx - SLOT_RADIUS).toBeGreaterThanOrEqual(0);
        });
      });

      it('the helpers mirror the backend: widths 6/5/5/6…, a bay of 8 holds 44, the 5001 preset 198', () => {
        const deep = { twoDeep: true, alternate: true };
        expect([1, 2, 3, 4, 5, 6, 7, 8].map((r) => cabinetRowWidth(r, 6, deep))).toEqual([6, 5, 5, 6, 6, 5, 5, 6]);
        expect([1, 2, 3].map((r) => cabinetRowWidth(r, 6, { twoDeep: false, alternate: true }))).toEqual([6, 5, 6]);
        expect([1, 2].map((r) => cabinetRowWidth(r, 1, deep))).toEqual([1, 1]);
        expect(cabinetBayCapacity(8, 6, deep)).toBe(44);
        expect(cabinetBayCapacity(8, 6, { twoDeep: true, alternate: false })).toBe(48);
        expect(getTotalSlots('cabinet', 5, 6, { shelfRows: [6, 8, 8, 8, 6], twoDeep: true, alternate: true })).toBe(198);
        // Off by default: an existing cabinet keeps cols × Σ shelfRows.
        expect(getTotalSlots('cabinet', 5, 6, { shelfRows: [6, 8, 8, 8, 6], twoDeep: true })).toBe(216);
      });
    });
  });

  describe('all types have valid coordinates', () => {
    const cases = [
      ['grid', 4, 8, undefined],
      ['grid', 4, 6, { doubleHeightRows: [1, 3] }],
      ['x-rack', 1, 1, { bottlesPerSection: 6 }],
      ['hex', 4, 5, undefined],
      ['triangle', 1, 5, undefined],
      ['stack', 8, 1, undefined],
      ['cube', 2, 3, { moduleRows: 2, moduleCols: 2 }],
      ['shelf', 3, 2, undefined],
      ['shelf', 2, 3, { bottlesPerCell: 4 }],
      ['cabinet', 3, 6, { shelfRows: [1, 3, 2], twoDeep: true }],
      ['cabinet', 2, 4, { shelfRows: [2, 5], twoDeep: false }],
      ['cabinet', 2, 4, undefined],
      ['cabinet', 2, 6, { shelfRows: [3, 4], twoDeep: true, alternate: true }],
      ['cabinet', 2, 5, { shelfRows: [3, 2], twoDeep: false, alternate: true }],
      ['cabinet', 3, 6, { shelfRows: [4, 4, 2], shelfCols: [4, 6, 3], shelfAlternate: [false, true, false] }],
    ];

    test.each(cases)('%s layout has positive coordinates within viewBox', (type, rows, cols, tc) => {
      const layout = computeLayout(type, rows, cols, tc);
      expect(layout.totalSlots).toBeGreaterThan(0);
      expect(layout.viewBox.width).toBeGreaterThan(0);
      expect(layout.viewBox.height).toBeGreaterThan(0);

      layout.slots.forEach(slot => {
        expect(slot.cx).toBeGreaterThanOrEqual(SLOT_RADIUS);
        expect(slot.cy).toBeGreaterThanOrEqual(SLOT_RADIUS);
        expect(slot.cx).toBeLessThanOrEqual(layout.viewBox.width);
        expect(slot.cy).toBeLessThanOrEqual(layout.viewBox.height);
      });
    });

    test.each(cases)('%s layout has contiguous positions 1..N', (type, rows, cols, tc) => {
      const layout = computeLayout(type, rows, cols, tc);
      const positions = layout.slots.map(s => s.position).sort((a, b) => a - b);
      const expected = Array.from({ length: layout.totalSlots }, (_, i) => i + 1);
      expect(positions).toEqual(expected);
    });
  });
});

describe('computeModularLayout', () => {
  it('returns empty layout for no modules', () => {
    const layout = computeModularLayout([]);
    expect(layout.totalSlots).toBe(0);
    expect(layout.slots).toHaveLength(0);
    expect(layout.moduleLayouts).toHaveLength(0);
  });

  it('returns empty layout for null', () => {
    const layout = computeModularLayout(null);
    expect(layout.totalSlots).toBe(0);
  });

  it('single grid module matches computeLayout', () => {
    const single = computeLayout('grid', 3, 4);
    const modular = computeModularLayout([{ type: 'grid', rows: 3, cols: 4 }]);
    expect(modular.totalSlots).toBe(single.totalSlots);
    expect(modular.slots).toHaveLength(single.slots.length);
    // Positions should match
    expect(modular.slots.map(s => s.position)).toEqual(single.slots.map(s => s.position));
    // Coordinates should match (no offset)
    modular.slots.forEach((s, i) => {
      expect(s.cx).toBe(single.slots[i].cx);
      expect(s.cy).toBe(single.slots[i].cy);
    });
  });

  it('two modules have contiguous global positions', () => {
    const layout = computeModularLayout([
      { type: 'grid', rows: 2, cols: 3 },    // 6 slots
      { type: 'stack', rows: 4, cols: 1, x: 5 },  // 4 slots
    ]);
    expect(layout.totalSlots).toBe(10);
    const positions = layout.slots.map(s => s.position);
    expect(positions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('offset modules have shifted coordinates', () => {
    const CELL = 48; // SLOT_R*2 + SLOT_GAP = 20*2+8
    const layout = computeModularLayout([
      { type: 'grid', rows: 1, cols: 1, x: 0, y: 0 },
      { type: 'grid', rows: 1, cols: 1, x: 3, y: 2 },
    ]);
    // Second module's slot should be offset by 3*CELL, 2*CELL
    const slot2 = layout.slots[1];
    const slot1 = layout.slots[0];
    expect(slot2.cx - slot1.cx).toBe(3 * CELL);
    expect(slot2.cy - slot1.cy).toBe(2 * CELL);
  });

  it('moduleLayouts has correct metadata', () => {
    const layout = computeModularLayout([
      { type: 'grid', rows: 2, cols: 3, x: 0, y: 0 },
      { type: 'hex', rows: 2, cols: 3, x: 5, y: 0 },
    ]);
    expect(layout.moduleLayouts).toHaveLength(2);
    expect(layout.moduleLayouts[0].moduleIndex).toBe(0);
    expect(layout.moduleLayouts[0].slotCount).toBe(6);
    expect(layout.moduleLayouts[1].moduleIndex).toBe(1);
    expect(layout.moduleLayouts[1].slotCount).toBe(5); // hex 2×3 = 2+2=5 (alternating)
  });

  it('slots include moduleIndex', () => {
    const layout = computeModularLayout([
      { type: 'grid', rows: 1, cols: 2 },
      { type: 'stack', rows: 3, cols: 1, x: 3 },
    ]);
    expect(layout.slots[0].moduleIndex).toBe(0);
    expect(layout.slots[1].moduleIndex).toBe(0);
    expect(layout.slots[2].moduleIndex).toBe(1);
    expect(layout.slots[3].moduleIndex).toBe(1);
    expect(layout.slots[4].moduleIndex).toBe(1);
  });

  it('mixed module types sum correctly', () => {
    const layout = computeModularLayout([
      { type: 'grid', rows: 3, cols: 4 },       // 12
      { type: 'hex', rows: 3, cols: 4 },         // 11
      { type: 'stack', rows: 6, cols: 1 },        // 6
    ]);
    expect(layout.totalSlots).toBe(29);
  });
});

describe('getModularTotalSlots', () => {
  it('returns 0 for empty/null', () => {
    expect(getModularTotalSlots([])).toBe(0);
    expect(getModularTotalSlots(null)).toBe(0);
  });

  it('matches computeModularLayout totalSlots', () => {
    const modules = [
      { type: 'grid', rows: 3, cols: 4 },
      { type: 'hex', rows: 3, cols: 4 },
      { type: 'stack', rows: 5, cols: 1 },
    ];
    const layout = computeModularLayout(modules);
    expect(getModularTotalSlots(modules)).toBe(layout.totalSlots);
  });

  it('sums mixed types correctly', () => {
    // grid 3×4 = 12, hex 3×4 = 11, stack 6 = 6 → 29
    expect(getModularTotalSlots([
      { type: 'grid', rows: 3, cols: 4 },
      { type: 'hex', rows: 3, cols: 4 },
      { type: 'stack', rows: 6, cols: 1 },
    ])).toBe(29);
  });
});

describe('getTotalSlots', () => {
  it('shelf with bpc=1', () => {
    expect(getTotalSlots('shelf', 3, 2)).toBe(6);
  });

  it('shelf with bpc=4', () => {
    expect(getTotalSlots('shelf', 2, 3, { bottlesPerCell: 4 })).toBe(24);
  });

  it('x-rack with bottlesPerSection=6', () => {
    expect(getTotalSlots('x-rack', 1, 1, { bottlesPerSection: 6 })).toBe(24);
  });

  it('matches computeLayout for all types', () => {
    const cases = [
      ['grid', 4, 8, undefined],
      ['grid', 4, 6, { doubleHeightRows: [2, 4] }],
      ['x-rack', 1, 1, { bottlesPerSection: 6 }],
      ['hex', 4, 5, undefined],
      ['triangle', 1, 5, undefined],
      ['stack', 8, 1, undefined],
      ['cube', 2, 3, { moduleRows: 2, moduleCols: 2 }],
      ['shelf', 3, 2, undefined],
      ['cabinet', 3, 6, { shelfRows: [1, 3, 2], twoDeep: true }],
      ['cabinet', 2, 4, { shelfRows: [2, 5], twoDeep: false }],
      ['cabinet', 2, 6, { shelfRows: [3, 4], twoDeep: true, alternate: true }],
    ];
    cases.forEach(([type, rows, cols, tc]) => {
      expect(getTotalSlots(type, rows, cols, tc)).toBe(computeLayout(type, rows, cols, tc).totalSlots);
    });
  });

  it('cabinet capacity is cols × Σ shelfRows, missing entries count as 1', () => {
    expect(getTotalSlots('cabinet', 5, 7, { shelfRows: [4, 4, 4, 4, 4] })).toBe(140);
    expect(getTotalSlots('cabinet', 3, 6, { shelfRows: [1, 3, 2] })).toBe(36);
    expect(getTotalSlots('cabinet', 2, 5)).toBe(10);
    expect(cabinetShelfRows(4, { shelfRows: [2, 30] })).toEqual([2, 12, 1, 1]);
  });
});

describe('cabinetBayUnits', () => {
  it("counts the two-deep back row's half bottle only where the back row is drawn offset (audit 2026-09-16)", () => {
    const bay = { rows: 2, cols: 6, alternate: false };
    // The 2D map draws the back row at c + 0.5, so it needs the half.
    expect(cabinetBayUnits(bay, { twoDeep: true, stagger: false })).toBe(6.5);
    // The shelf view and the 3D room stack the back row straight behind the
    // front: without backOffset the default cabinet gained a blank strip.
    expect(cabinetBayUnits(bay, { twoDeep: true, stagger: false, backOffset: false })).toBe(6);
    expect(cabinetBayUnits(bay, { twoDeep: true, stagger: true, backOffset: false })).toBe(6.5);
    expect(cabinetBayUnits({ ...bay, cols: 1 }, { twoDeep: false, stagger: true })).toBe(1);
    // An alternating bay never pokes out: its offset rows are the narrow ones.
    expect(cabinetBayUnits({ ...bay, alternate: true }, { twoDeep: true, stagger: true })).toBe(6);
  });
});
