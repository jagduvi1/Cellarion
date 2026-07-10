/**
 * Cellar Book data builder — assembles the printable book model from the
 * racks (with populated slot bottles) and the cellar's active bottle list.
 *
 * Pure functions so the page component stays thin and this stays testable.
 */
import { getTotalSlots, getModularTotalSlots } from './rackLayouts';

/**
 * Build the book model:
 *   rackSections: one per rack — entries sorted by slot position
 *   unplaced:     active bottles that sit in no rack slot, sorted by wine name
 *
 * `bottles` is the cellar's active bottle list; bottles placed in racks are
 * detected by id against the rack slots, so the two sources may overlap.
 */
export function buildCellarBook(racks, bottles) {
  const placedIds = new Set();
  const rackSections = (racks || []).map(rack => {
    const entries = (rack.slots || [])
      .filter(s => s.bottle)
      .map(s => ({ position: s.position, bottle: s.bottle }))
      .sort((a, b) => a.position - b.position);
    for (const e of entries) placedIds.add(idOf(e.bottle));
    const totalSlots = rack.isModular && rack.modules?.length > 0
      ? getModularTotalSlots(rack.modules)
      : getTotalSlots(rack.type || 'grid', rack.rows, rack.cols, rack.typeConfig);
    return {
      rack,
      entries,
      filledCount: entries.length,
      totalSlots: totalSlots - (rack.disabledPositions?.length || 0),
    };
  });

  const unplaced = (bottles || [])
    .filter(b => !placedIds.has(idOf(b)))
    .sort((a, b) => {
      const av = (a.wineDefinition?.name || '').toLowerCase();
      const bv = (b.wineDefinition?.name || '').toLowerCase();
      return av < bv ? -1 : av > bv ? 1 : 0;
    });

  const placedCount = placedIds.size;
  return { rackSections, unplaced, placedCount, totalActive: (bottles || []).length };
}

function idOf(bottle) {
  return (bottle?._id || bottle || '').toString();
}

/**
 * Human-readable drink window for a bottle row on paper.
 * Personal drinkFrom/drinkTo years win when set (matches classifyMaturity's
 * precedence); otherwise falls back to the backend-attached maturityStatus
 * translation key when present. Returns { text } | { tKey } | null.
 */
export function formatDrinkWindow(bottle) {
  const from = Number.isFinite(bottle?.drinkFrom) ? bottle.drinkFrom : null;
  const to = Number.isFinite(bottle?.drinkTo) ? bottle.drinkTo : null;
  if (from !== null && to !== null) return { text: `${from}–${to}` };
  if (from !== null) return { text: `${from}–` };
  if (to !== null) return { text: `–${to}` };
  const MATURITY_KEYS = {
    'not-ready': 'maturity.notReady',
    early: 'maturity.early',
    peak: 'maturity.peak',
    late: 'maturity.late',
    declining: 'maturity.declining',
  };
  const key = MATURITY_KEYS[bottle?.maturityStatus];
  return key ? { tKey: key } : null;
}
