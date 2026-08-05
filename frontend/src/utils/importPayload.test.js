/**
 * The review→confirm payload boundary. A field the parsers emit but this
 * mapping drops silently disappears between the review screen and the created
 * bottle — that is exactly how the CellarTracker rack auto-map's row/col
 * placements were lost (racks were created but arrived empty, while
 * rackPosition-based racks placed fine).
 *
 * The full-pipeline test parses a real CT fixture end-to-end (decode →
 * parseAndMap → buildImportItem) so every future parser field must survive
 * the payload mapping or fail here.
 */
import { readFileSync } from 'fs';
import { describe, test, expect } from 'vitest';
import { buildImportItem } from './importPayload';
import { decodeImportBuffer, parseAndMap } from './importMappers';

const FIXTURE = 'src/utils/__fixtures__/cellartracker/bundle/CellarTracker_Inventory.tsv';

function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

describe('buildImportItem', () => {
  test('forwards grid row/col placements (CT auto-map regression)', () => {
    const r = {
      item: {
        wineName: 'La Tâche', producer: 'Domaine de la Romanée-Conti',
        vintage: '2017', rackName: 'Wine Fridge', row: 2, col: 5,
        rackRows: 2, rackCols: 6,
      },
    };
    const out = buildImportItem(r, 'wine123');
    expect(out.wineDefinition).toBe('wine123');
    expect(out.rackName).toBe('Wine Fridge');
    expect(out.row).toBe(2);
    expect(out.col).toBe(5);
    expect(out.rackRows).toBe(2);
    expect(out.rackCols).toBe(6);
  });

  test('forwards shelf layer/slotInLayer and rackType', () => {
    const r = {
      item: {
        wineName: 'Barbaresco', producer: 'Gaja', vintage: '2018',
        rackName: 'Double Deep', rackPosition: 3, layer: 2, slotInLayer: 3,
        rackType: 'shelf', rackRows: 2, rackCols: 4,
      },
    };
    const out = buildImportItem(r, 'wine456');
    expect(out.rackPosition).toBe(3);
    expect(out.layer).toBe(2);
    expect(out.slotInLayer).toBe(3);
    expect(out.rackType).toBe('shelf');
  });

  test('request selection sets requestWine and clears wineDefinition', () => {
    const out = buildImportItem({ item: { wineName: 'X', producer: 'Y' } }, 'request');
    expect(out.requestWine).toBe(true);
    expect(out.wineDefinition).toBeUndefined();
  });

  test("create selection forwards aiProposed as aiWine — the sentinel must never leak into wineDefinition", () => {
    const aiProposed = { name: 'Clos du Test', producer: 'Domaine Fictif', country: 'France', type: 'red' };
    const out = buildImportItem({ item: { wineName: 'X', producer: 'Y' }, aiProposed }, 'create');
    expect(out.aiWine).toEqual(aiProposed);
    expect(out.wineDefinition).toBeUndefined();
    expect(out.requestWine).toBeUndefined();
  });

  test('non-create selections never carry aiWine, even when the row has a proposal', () => {
    const r = { item: { wineName: 'X', producer: 'Y' }, aiProposed: { name: 'N', producer: 'P' } };
    expect(buildImportItem(r, 'wine123').aiWine).toBeUndefined();
    expect(buildImportItem(r, 'request').aiWine).toBeUndefined();
  });

  test('forwards addToWishlist (Vivino scan-history wishlist mode)', () => {
    const out = buildImportItem(
      { item: { wineName: 'X', producer: 'Y', vintage: '2018', addToWishlist: true } },
      'w1'
    );
    expect(out.addToWishlist).toBe(true);
  });

  test('forwards internalSlot for cellarion round-trips', () => {
    const out = buildImportItem(
      { item: { wineName: 'X', producer: 'Y', rackName: 'Hex', rackPosition: 11, internalSlot: true } },
      'w1'
    );
    expect(out.internalSlot).toBe(true);
    expect(out.rackPosition).toBe(11);
  });

  test('full pipeline: real CT Inventory fixture placements survive to the payload', () => {
    const { text } = decodeImportBuffer(toArrayBuffer(readFileSync(FIXTURE)));
    const parsed = parseAndMap(text);

    const placed = parsed.items.filter((i) => i.rackName);
    expect(placed.length).toBeGreaterThan(0);

    for (const item of placed) {
      const payload = buildImportItem({ item }, 'someWineId');
      // The backend's placement gate: rackPosition OR row+col (import.js).
      const hasPlacement =
        payload.rackPosition !== undefined ||
        (payload.row !== undefined && payload.col !== undefined);
      expect(hasPlacement).toBe(true);
      expect(payload.rackName).toBe(item.rackName);
    }

    // The Wine Fridge group is letter+number bins → row/col placements; they
    // must reach the payload as numbers, not vanish.
    const fridge = parsed.items.find((i) => i.rackName === 'Wine Fridge' && i.row !== undefined);
    expect(fridge).toBeDefined();
    const fridgePayload = buildImportItem({ item: fridge }, 'w');
    expect(typeof fridgePayload.row).toBe('number');
    expect(typeof fridgePayload.col).toBe('number');
  });
});
