// Racks in an import file: reading a combined "rack and slot" cell, sizing
// a rack from the slots a file uses, and the rack summary and defaults the
// import review starts from. utils/importMappers.js re-exports them.

/**
 * Parse a combined rack-location string like "M2-11" or "Cabinet 1-15" into
 * a rack name + 1-indexed position. Splits on the LAST hyphen so rack names
 * containing hyphens still work. Returns null when the right side isn't a
 * positive integer.
 */
export function parseCombinedRackLocation(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  const lastDash = trimmed.lastIndexOf('-');
  if (lastDash < 1 || lastDash === trimmed.length - 1) return null;
  const left = trimmed.slice(0, lastDash).trim();
  const right = trimmed.slice(lastDash + 1).trim();
  if (!left) return null;
  // Right side must be a pure positive integer (allow leading zeros: "04")
  if (!/^\d+$/.test(right)) return null;
  const pos = parseInt(right, 10);
  if (pos < 1) return null;
  return { rackName: left, rackPosition: pos };
}

/**
 * Suggest reasonable rack dimensions given a max position observed in import
 * data. Mirrors the backend helper of the same name. Biases toward common
 * physical wine-rack widths (6 or 12 columns).
 */
export function suggestRackDimensions(maxPosition) {
  const p = Math.max(1, parseInt(maxPosition, 10) || 1);
  if (p <= 6)  return { rows: 1, cols: p };
  if (p <= 12) return { rows: 2, cols: 6 };
  if (p <= 24) return { rows: 4, cols: 6 };
  if (p <= 72) return { rows: 6, cols: 12 };
  const cols = 12;
  const rows = Math.min(20, Math.ceil(p / cols));
  return { rows, cols };
}

/**
 * Summarise rack usage in a parsed-items batch:
 *   { [rackName]: { count, maxPosition, maxPerCell, observedPositions: number[] } }
 *
 * `maxPerCell` tracks the highest number of items sharing the same
 * rackPosition within a single rack — for Oeno-format imports this is the
 * "max bottles on the busiest shelf" stat shown in the picker's meta line.
 * Always returned for diagnostics; the rack-default chooser
 * (`getDefaultRackConfig`) decides what to do with it per format.
 */
export function summariseRacks(items) {
  const summary = {};
  const positionCounts = {}; // { [rackName]: { [position]: count } }
  for (const item of items) {
    if (!item?.rackName) continue;
    const name = String(item.rackName).trim();
    if (!name) continue;
    if (!summary[name]) summary[name] = { count: 0, maxPosition: 0, maxPerCell: 1, observedPositions: [] };
    summary[name].count += 1;
    const pos = parseInt(item.rackPosition, 10);
    if (!isNaN(pos)) {
      summary[name].observedPositions.push(pos);
      if (pos > summary[name].maxPosition) summary[name].maxPosition = pos;
      if (!positionCounts[name]) positionCounts[name] = {};
      positionCounts[name][pos] = (positionCounts[name][pos] || 0) + 1;
      if (positionCounts[name][pos] > summary[name].maxPerCell) {
        summary[name].maxPerCell = positionCounts[name][pos];
      }
    }
  }
  return summary;
}

/**
 * Pick a sensible default rack configuration for the picker based on the
 * detected source format and per-rack stats. Format-specific knowledge
 * lives here so the page component doesn't have to know about it.
 *
 * Currently:
 *   - oeno-export: rack defaults come from the cabinet metadata inside the
 *     CSV itself (cabinet brand/model → shelf layout). Per-rack overrides
 *     are written directly during parsing, so this function returns a
 *     conservative shelf fallback for any rack that slips through.
 *   - cellartracker: racks derived from Location/Bin auto-mapping carry the
 *     pattern-detected geometry in info.ctRackSpec (set from
 *     ctRackAutoMap.racks[name].spec); sequential-bin racks have no spec and
 *     fall through to the maxPosition-based grid sizing below.
 *   - everything else: Grid with rows/cols sized to fit the data. No
 *     auto-inferred multi-bottle stacking; users opt in via the picker.
 */
export function getDefaultRackConfig(format, info) {
  if (info.rackSpec) {
    // Geometry the source file stated outright (Ploc gives every unit's real
    // row/column extent), rather than one inferred from the bottles.
    return info.rackSpec;
  }
  if (info.ctRackSpec) {
    // Geometry detected from the CellarTracker bin-code pattern.
    return info.ctRackSpec;
  }
  if (format === 'oeno-export' && info.oenoRackSpec) {
    // Cabinet/column-specific spec set during oeno-export parsing.
    return info.oenoRackSpec;
  }
  const required = Math.max(info.maxPosition || 0, info.count || 0);
  return { type: 'grid', ...suggestRackDimensions(required), typeConfig: {} };
}

/**
 * Format-specific default for the slot-1 anchor.
 *   - oeno-export: shelf 1 is at the bottom of the cabinet (Oeno convention)
 *   - everything else: top-left (most apps)
 */
export function getDefaultAnchor(format) {
  return format === 'oeno-export' ? 'bottom-left' : 'top-left';
}
