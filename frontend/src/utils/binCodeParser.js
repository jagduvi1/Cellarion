/**
 * CellarTracker Location/Bin → rack auto-placement parser.
 *
 * CellarTracker stores physical placement as a freeform (Location, Bin) pair:
 * Location is the named storage area ("Cellar", "Wine Fridge", "Offsite
 * Storage") and Bin is a user-typed slot code within it. Bin formats are
 * completely unconstrained — the CT export spec documents `R3C2D1`, `A12`,
 * `12-3-4`, `147`, `Rack B - Top`, `BIN1`, `D-04-1`, and blank all appearing
 * in real exports.
 *
 * This module classifies each Location group's bins into one of five pattern
 * families and, when the group is CONSISTENT enough, derives rack geometry +
 * per-bottle placements that the existing import pipeline (summariseRacks /
 * planRackCreations / placeBottlesInRack) understands unchanged:
 *
 *   Family          Examples          Emitted placement
 *   ─────────────── ───────────────── ─────────────────────────────────────
 *   rowcol          R3C2, r4c1        { row, col }            (grid)
 *   rowcol-depth    R3C2D1, R5C1D2    { rackPosition: shelf, layer,
 *                                       slotInLayer }         (shelf rack;
 *                                       see depth handling below)
 *   letter-number   A12, B3           { row: letterIndex, col: number }
 *   segments        12-3-4, D-04-1,   2 segments → { row, col };
 *                   3.2               3 segments → first segment names a
 *                                       SUB-RACK ("Cellar D"), rest row/col
 *   sequential      147, BIN1, P6     { rackPosition: number } (constant
 *                                       alpha prefix stripped)
 *
 * Depth handling (rowcol-depth): decided from the data —
 *   - D absent everywhere, or constant across the group: D carries no
 *     information → plain grid { row, col } (pattern stays 'rowcol').
 *   - D ∈ {1, 2} with both present: D is a front/back layer, exactly like
 *     Cellarion's shelf racks (and the Oeno import path). Geometry is a
 *     shelf rack with rows = max R, cols = max C, backCols = max C, and each
 *     bottle emits { rackPosition: R (shelf number), layer: D,
 *     slotInLayer: C } — the trio computeRackPosition already resolves.
 *   - max D > 2: more depth levels than Cellarion's front/back model — fold
 *     depth into columns: col = (D-1) × maxC + C on a grid of
 *     cols = maxD × maxC. Deterministic, reversible, no new geometry.
 *
 * Disambiguation rules (documented because they bite):
 *   - `A12`-style codes match BOTH letter-number and prefixed-integer. If the
 *     letters VARY across the group (A1…A6, B1…B3) they are row labels →
 *     letter-number. If every code carries the SAME single letter (P1…P6)
 *     the letter carries no row information → sequential slots 1…6.
 *   - The sequential family only accepts a group whose alpha prefix is
 *     IDENTICAL on every code (BIN1, BIN2, … or bare 147, 148, …). Mixed
 *     prefixes mean the "prefix" was data, not decoration → not sequential.
 *   - Mixed pattern families in one group (real cellars do this) never
 *     auto-map: the best family must cover >= 60% of the group's bins.
 *
 * Confidence rule — a Location group auto-maps ONLY when:
 *   - its best pattern family parses >= 60% of ALL its bins (blanks count
 *     against — a mostly-unbinned location should not become a rack), AND
 *   - it yields >= 3 DISTINCT placements (a wine with 4 bottles all in "A12"
 *     says nothing about the rack's shape).
 * Anything below that threshold falls back to today's behaviour for the
 * WHOLE group: the joined "Location / Bin" text stays on the bottle and no
 * rack is created. We never guess.
 *
 * Dimension clamps mirror the backend's planRackCreations: rows/cols max 20
 * (the Rack schema bound). A parsed code whose row/col exceeds 20, or a
 * sequential position beyond 400 (a full 20×20 grid), is treated as unparsed
 * for that bottle rather than distorting the rack.
 */

const MAX_DIM = 20;
const MAX_SEQ_POSITION = MAX_DIM * MAX_DIM;
const MIN_PARSE_RATIO = 0.6;
const MIN_DISTINCT = 3;

const RCD_RE = /^R\s*(\d{1,2})\s*C\s*(\d{1,2})(?:\s*D\s*(\d{1,2}))?$/i;
const LETTER_RE = /^([A-Za-z])\s*(\d{1,3})$/;
const PREFIXED_INT_RE = /^([A-Za-z]{0,6})(\d{1,4})$/;
const SEGMENT_SPLIT_RE = /[-.]/;
const NUMERIC_SEGMENT_RE = /^\d{1,3}$/;
const SUBRACK_SEGMENT_RE = /^[A-Za-z0-9]{1,6}$/;

/** Split a bin code on dashes/dots into 2 or 3 usable segments, or null. */
function matchSegments(bin) {
  const parts = bin.split(SEGMENT_SPLIT_RE).map((s) => s.trim());
  if (parts.length < 2 || parts.length > 3) return null;
  if (parts.some((p) => !p)) return null;
  const [rowStr, colStr] = parts.slice(-2);
  if (!NUMERIC_SEGMENT_RE.test(rowStr) || !NUMERIC_SEGMENT_RE.test(colStr)) return null;
  const row = parseInt(rowStr, 10);
  const col = parseInt(colStr, 10);
  if (row < 1 || col < 1) return null;
  if (parts.length === 2) return { segs: 2, row, col };
  if (!SUBRACK_SEGMENT_RE.test(parts[0])) return null;
  return { segs: 3, subRack: parts[0].toUpperCase(), row, col };
}

/** Signature string used to count DISTINCT placements. */
function placementKey(p) {
  if (p.rackPosition != null && p.layer != null) return `s${p.rackPosition}|${p.layer}|${p.slotInLayer}`;
  if (p.rackPosition != null) return `p${p.rackPosition}`;
  return `${p.subRack || ''}|${p.row}|${p.col}`;
}

/** Empty (non-qualifying) result for a group of `n` bins. */
function noMatch(n, allIndexes) {
  return {
    pattern: null,
    confidence: 0,
    qualifies: false,
    inferredRows: undefined,
    inferredCols: undefined,
    inferredBackCols: undefined,
    placements: [],
    unparsed: allIndexes,
    subRacks: undefined,
    binCount: n,
    distinctCount: 0,
  };
}

/**
 * Analyse ONE Location group's bin codes.
 *
 * @param {string[]} bins  Raw Bin values (blank / whitespace = no bin),
 *                         one per bottle, order preserved.
 * @returns {{
 *   pattern: 'rowcol'|'rowcol-depth'|'letter-number'|'segments'|'sequential'|null,
 *   confidence: number,           // parsed / total bins in the group
 *   qualifies: boolean,           // >= 60% parsed AND >= 3 distinct placements
 *   inferredRows?: number, inferredCols?: number, inferredBackCols?: number,
 *   placements: Array<{ index, row?, col?, rackPosition?, layer?, slotInLayer?, subRack? }>,
 *   unparsed: number[],           // indexes (into bins) with no placement
 *   subRacks?: { [key: string]: { rows: number, cols: number } },
 *   binCount: number, distinctCount: number
 * }}
 * `index` refers to the position in the input `bins` array. When
 * `qualifies` is false the caller must fall back to freeform text for the
 * whole group — `placements` is still returned for diagnostics only.
 */
export function analyzeBinGroup(bins) {
  const trimmed = (bins || []).map((b) => (b == null ? '' : String(b).trim()));
  const n = trimmed.length;
  const allIndexes = trimmed.map((_, i) => i);
  if (n === 0) return noMatch(0, []);

  // ── Per-bin candidate matches, per family ────────────────────────────────
  const rcd = [];
  const letter = [];
  const seg2 = [];
  const seg3 = [];
  const seq = [];
  trimmed.forEach((bin, i) => {
    if (!bin) return;
    let m;
    if ((m = bin.match(RCD_RE))) {
      const row = parseInt(m[1], 10);
      const col = parseInt(m[2], 10);
      const depth = m[3] !== undefined ? parseInt(m[3], 10) : null;
      if (row >= 1 && col >= 1 && (depth === null || depth >= 1)) rcd.push({ i, row, col, depth });
    }
    if ((m = bin.match(LETTER_RE))) {
      const col = parseInt(m[2], 10);
      if (col >= 1) letter.push({ i, letter: m[1].toUpperCase(), col });
    }
    const seg = matchSegments(bin);
    if (seg?.segs === 2) seg2.push({ i, row: seg.row, col: seg.col });
    if (seg?.segs === 3) seg3.push({ i, subRack: seg.subRack, row: seg.row, col: seg.col });
    if ((m = bin.match(PREFIXED_INT_RE))) {
      const num = parseInt(m[2], 10);
      if (num >= 1) seq.push({ i, prefix: m[1].toUpperCase(), num });
    }
  });

  // ── Family validity (see disambiguation rules in the header) ─────────────
  // sequential: alpha prefix must be constant across the whole group.
  const seqPrefixes = new Set(seq.map((c) => c.prefix));
  const seqValid = seq.length > 0 && seqPrefixes.size === 1;
  // letter-number: letters must VARY (constant letter = sequential, and the
  // sequential family already covers those codes with prefix = the letter).
  const letters = new Set(letter.map((c) => c.letter));
  const letterValid = letter.length > 0 && letters.size > 1;

  const families = [
    { name: 'rcd', matches: rcd, valid: rcd.length > 0 },
    { name: 'seg3', matches: seg3, valid: seg3.length > 0 },
    { name: 'seg2', matches: seg2, valid: seg2.length > 0 },
    { name: 'letter', matches: letter, valid: letterValid },
    { name: 'seq', matches: seq, valid: seqValid },
  ].filter((f) => f.valid);

  if (families.length === 0) return noMatch(n, allIndexes);

  // Best family = widest coverage; ties break by the order above (most
  // structured pattern wins — an RCD code is never "really" an integer).
  const best = families.reduce((a, b) => (b.matches.length > a.matches.length ? b : a));

  // ── Build placements for the chosen family ───────────────────────────────
  let pattern;
  let placements = [];
  let inferredRows;
  let inferredCols;
  let inferredBackCols;
  let subRacks;

  if (best.name === 'rcd') {
    const depths = best.matches.filter((c) => c.depth !== null).map((c) => c.depth);
    const distinctDepths = new Set(depths);
    const maxDepth = depths.length > 0 ? Math.max(...depths) : 0;
    const usable = best.matches.filter((c) => c.row <= MAX_DIM && c.col <= MAX_DIM);

    if (distinctDepths.size <= 1) {
      // No depth, or depth never varies → it carries no information: plain grid.
      pattern = 'rowcol';
      placements = usable.map((c) => ({ index: c.i, row: c.row, col: c.col }));
      inferredRows = Math.max(0, ...usable.map((c) => c.row)) || undefined;
      inferredCols = Math.max(0, ...usable.map((c) => c.col)) || undefined;
    } else if (maxDepth <= 2) {
      // Front/back — Cellarion shelf-rack geometry (same trio as the Oeno path).
      pattern = 'rowcol-depth';
      const withLayer = usable.filter((c) => (c.depth || 1) <= 2);
      placements = withLayer.map((c) => ({
        index: c.i,
        rackPosition: c.row, // shelf number
        layer: c.depth || 1,
        slotInLayer: c.col,
      }));
      inferredRows = Math.max(0, ...withLayer.map((c) => c.row)) || undefined;
      inferredCols = Math.max(0, ...withLayer.map((c) => c.col)) || undefined;
      inferredBackCols = inferredCols;
    } else {
      // Deeper than front/back → fold depth into extra columns on a grid.
      pattern = 'rowcol-depth';
      const maxCol = Math.max(...best.matches.map((c) => c.col));
      const folded = best.matches
        .map((c) => ({ index: c.i, row: c.row, col: ((c.depth || 1) - 1) * maxCol + c.col }))
        .filter((c) => c.row <= MAX_DIM && c.col <= MAX_DIM);
      placements = folded;
      inferredRows = Math.max(0, ...folded.map((c) => c.row)) || undefined;
      inferredCols = Math.max(0, ...folded.map((c) => c.col)) || undefined;
    }
  } else if (best.name === 'letter') {
    pattern = 'letter-number';
    const usable = best.matches
      .map((c) => ({ index: c.i, row: c.letter.charCodeAt(0) - 64, col: c.col }))
      .filter((c) => c.row <= MAX_DIM && c.col <= MAX_DIM);
    placements = usable;
    inferredRows = Math.max(0, ...usable.map((c) => c.row)) || undefined;
    inferredCols = Math.max(0, ...usable.map((c) => c.col)) || undefined;
  } else if (best.name === 'seg2') {
    pattern = 'segments';
    const usable = best.matches.filter((c) => c.row <= MAX_DIM && c.col <= MAX_DIM);
    placements = usable.map((c) => ({ index: c.i, row: c.row, col: c.col }));
    inferredRows = Math.max(0, ...usable.map((c) => c.row)) || undefined;
    inferredCols = Math.max(0, ...usable.map((c) => c.col)) || undefined;
  } else if (best.name === 'seg3') {
    pattern = 'segments';
    const usable = best.matches.filter((c) => c.row <= MAX_DIM && c.col <= MAX_DIM);
    placements = usable.map((c) => ({ index: c.i, subRack: c.subRack, row: c.row, col: c.col }));
    subRacks = {};
    for (const c of usable) {
      const sr = subRacks[c.subRack] || (subRacks[c.subRack] = { rows: 0, cols: 0 });
      if (c.row > sr.rows) sr.rows = c.row;
      if (c.col > sr.cols) sr.cols = c.col;
    }
  } else {
    pattern = 'sequential';
    const usable = best.matches.filter((c) => c.num <= MAX_SEQ_POSITION);
    placements = usable.map((c) => ({ index: c.i, rackPosition: c.num }));
    // Dimensions are left to the downstream sizing (suggestRackDimensions
    // from the max observed position) — same as any rackPosition import.
  }

  // ── Confidence rule ──────────────────────────────────────────────────────
  const distinctCount = new Set(placements.map(placementKey)).size;
  const confidence = n > 0 ? placements.length / n : 0;
  const qualifies = confidence >= MIN_PARSE_RATIO && distinctCount >= MIN_DISTINCT;

  const placed = new Set(placements.map((p) => p.index));
  const unparsed = allIndexes.filter((i) => !placed.has(i));

  return {
    pattern,
    confidence,
    qualifies,
    inferredRows,
    inferredCols,
    inferredBackCols,
    placements,
    unparsed,
    subRacks,
    binCount: n,
    distinctCount,
  };
}

/**
 * Analyse a whole file's (Location, Bin) pairs, grouped by Location.
 *
 * @param {Array<{location: string, bin: string}>} pairs
 * @returns {{ [location: string]: ReturnType<typeof analyzeBinGroup> }}
 *   Each group's `placements[].index` / `unparsed[]` refer to indexes in the
 *   ORIGINAL `pairs` array (not group-local). Pairs with a blank Location are
 *   skipped entirely — no location means nothing to place (e.g. CT List rows
 *   for wines spanning multiple locations export Location blank).
 */
export function analyzeBinGroups(pairs) {
  const groups = new Map(); // location -> [globalIndex]
  (pairs || []).forEach((p, i) => {
    const loc = (p?.location || '').trim();
    if (!loc) return;
    if (!groups.has(loc)) groups.set(loc, []);
    groups.get(loc).push(i);
  });

  const out = {};
  for (const [loc, idxs] of groups) {
    const analysis = analyzeBinGroup(idxs.map((i) => pairs[i]?.bin ?? ''));
    // Re-map group-local indexes back to the caller's pair indexes.
    analysis.placements = analysis.placements.map((pl) => ({ ...pl, index: idxs[pl.index] }));
    analysis.unparsed = analysis.unparsed.map((i) => idxs[i]);
    out[loc] = analysis;
  }
  return out;
}
