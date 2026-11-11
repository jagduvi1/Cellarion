// The Oeno by Vintec export: a two-section CSV (the cabinets' layers, then
// the bottles) read into bottles that know their cabinet, shelf, layer and
// slot. utils/importMappers.js re-exports the public names.

import { parseLocaleNumber, mapWineType, vintageOrNV, tryParseDate } from './importFields';
import { decodeCharRefs, splitLogicalLines, splitCSVLine } from './importCsv';

/**
 * The logical records of an Oeno export. A quoted Bottle Note may span lines,
 * but the bare dialect does not escape a quote at the start of a cell
 * ("Reserve" bottle for Dad), and the CSV rule would then keep that quote
 * open to the end of the file. So a record that spans lines is accepted only
 * when it splits into exactly as many cells as its section's header row and
 * none of its continuation lines is a whole row by itself (a quote closing at
 * a later row's note can make the count match). Any other one is a runaway
 * quote: its first line stands alone, as a line-by-line split reads it, and
 * the records are read again from the line after it.
 */
function splitOenoRecords(text) {
  const records = [];
  let headerCells = 0; // cells in the current section's header row
  let rest = text;
  const swallowsRows = (record) => record.split('\n').slice(1)
    .some((line) => splitCSVLine(line.replace(/\r$/, '')).length === headerCells);
  for (;;) {
    const lines = splitLogicalLines(rest, ',');
    let runaway = -1;
    for (let i = 0; i < lines.length; i++) {
      const cells = splitCSVLine(lines[i]);
      const first = (cells[0] || '').trim();
      if (first === 'Cabinet ID' || first === 'Bottle ID') headerCells = cells.length;
      if (lines[i].includes('\n') && (cells.length !== headerCells || swallowsRows(lines[i]))) { runaway = i; break; }
      records.push(lines[i]);
    }
    if (runaway === -1) return records;
    const record = lines[runaway];
    const cut = record.indexOf('\n');
    records.push(record.slice(0, cut).replace(/\r$/, ''));
    rest = [record.slice(cut + 1), ...lines.slice(runaway + 1)].join('\n');
  }
}

/**
 * Detect Oeno-by-Vintec's real two-section export by scanning for the
 * "User Bottles Details" marker separating the cabinet definitions from
 * the bottle records. Returns the row index of the bottle-section header
 * row, or -1 if the file isn't an Oeno export.
 */
export function detectOenoExportBoundary(rows) {
  for (let i = 0; i < rows.length; i++) {
    if (firstCell(rows[i]) === 'Bottle ID') return i;
  }
  return -1;
}

/**
 * First cell of a raw CSV line, quotes removed. Oeno wrote two dialects: the
 * earlier exports had bare cells; the last ones before the shutdown quote
 * EVERY cell. A raw split would see `"Bottle ID"`, never match `Bottle ID`,
 * return a boundary of -1 and let the whole file fall through to the generic
 * parser, which takes the leading `,,,,` row as its header and drops every
 * row as "no wine name".
 */
function firstCell(line) {
  return (splitCSVLine(line)[0] || '').trim();
}

/**
 * Parse Oeno's real two-section CSV export.
 *
 * The file is structured as:
 *   1. Cabinet/layer definitions \u2014 one row per (cabinet, column, shelf,
 *      layer-front-back). Includes "Disabled Slots" so we know which
 *      positions are unusable. Total/Empty Slots are cabinet-level stats.
 *   2. A blank-row separator + literal "User Bottles Details" marker.
 *   3. Bottle records \u2014 one row per individual bottle, joining to a
 *      specific layer via Layer ID and indicating its slot within that
 *      layer. Cabinet fields can all be "null" for unshelved bottles.
 *
 * The parser maps each (cabinet, column) pair into a Cellarion shelf rack
 * sized for that column's shelves. Oeno's "layer" means two different things
 * depending on the cabinet, and the file does not say which, so the shape is
 * read off the data (see geometryForColumn):
 *   - layers 1–2 only: sliding shelves with a front and a back row
 *     (Transtherm/Eurocave). cols=6, backCols=5, bpc=1, the
 *     Vintec/Transtherm standard, widened if the file addresses a higher slot.
 *   - layers 3+: stacked storage shelves (Vintec VWM: up to 10
 *     layers × 7 slots, 44 bottles on one shelf). Mapped to the `cabinet`
 *     rack type: one bay per shelf with the file's own layer count as the
 *     bay's rows, two deep, so every bottle lands in its exact cell and the
 *     3D view draws a wine fridge.
 * Users can override either shape in the picker. Each bottle carries an
 * explicit shelf number, layer and slotInLayer; the backend's
 * computeRackPosition turns those into the exact Cellarion slot under the
 * same two models.
 *
 * Consumed bottles (Consumed On set) come in via the existing
 * addToHistory path. Unshelved bottles (Cabinet ID = null) skip rack
 * placement.
 *
 * @param {string} text - Raw CSV text
 * @returns {{ items: object[], format: 'oeno-export', headers: string[], oenoRackSpecs: object }}
 *   `oenoRackSpecs` is keyed by rack name and used by the picker's
 *   default-rack-config helper to pre-fill cabinet shapes.
 */
export function parseOenoExport(text) {
  const cleaned = text.replace(/^\uFEFF/, '');
  // Logical records, not raw lines: a quoted Bottle Note may span lines.
  const lines = splitOenoRecords(cleaned);
  const boundary = detectOenoExportBoundary(lines);
  if (boundary === -1) {
    return null;
  }

  // \u2500\u2500 Section 1: cabinet/layer definitions \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  // Lookup map: Layer ID (string) \u2192 { cabinetId, cabinetLabel, cabinetBrand,
  //   cabinetModel, columnIndex, shelfIndex, layerIndex, disabledSlots:Set }
  const layerById = new Map();
  // Per-cabinet metadata for the rack-spec output
  const cabinetById = new Map();

  // Section 1's header row is usually line 0, but the last Oeno exports open
  // with a title block ("User Cabinets Details With Unshelved Bottle Count")
  // above it. Everything above the header is skipped.
  let cabinetHeader = -1;
  for (let i = 0; i < boundary; i++) {
    if (firstCell(lines[i]) === 'Cabinet ID') { cabinetHeader = i; break; }
  }
  const cabinetCells = cabinetHeader === -1 ? 0 : splitCSVLine(lines[cabinetHeader]).length;
  for (let i = cabinetHeader + 1; i < boundary; i++) {
    const cells = oenoCells(lines[i], cabinetCells);
    if (!cells[0] || !cells[0].trim()) continue;
    const cabinetId = cells[0].trim();
    if (!cabinetId) continue;

    const cabinetLabel = (cells[1] || '').trim();
    const cabinetBrand = (cells[2] || '').trim();
    const cabinetModel = (cells[3] || '').trim();
    const columnIndex = parseInt(cells[4], 10);
    const shelfIndex = parseInt(cells[5], 10);
    const layerIndex = parseInt(cells[6], 10);
    const layerId = (cells[7] || '').trim();

    if (!layerId || isNaN(columnIndex) || isNaN(shelfIndex) || isNaN(layerIndex)) continue;

    // "Disabled Slots" is a comma-separated list inside the field (which is
    // itself comma-separated). The CSV parser already handles the quoting,
    // so cells[8] is a raw string like "6, 5" or "0" (meaning none disabled)
    // or "1, 2, 3" etc.
    const disabledRaw = (cells[8] || '').trim();
    const disabledSlots = new Set();
    if (disabledRaw && disabledRaw !== '0') {
      for (const part of disabledRaw.split(',')) {
        const n = parseInt(part.trim(), 10);
        if (!isNaN(n) && n > 0) disabledSlots.add(n);
      }
    }

    layerById.set(layerId, {
      cabinetId, cabinetLabel, cabinetBrand, cabinetModel,
      columnIndex, shelfIndex, layerIndex, disabledSlots
    });

    if (!cabinetById.has(cabinetId)) {
      cabinetById.set(cabinetId, {
        label: cabinetLabel,
        brand: cabinetBrand,
        model: cabinetModel,
        columns: new Map(), // columnIndex \u2192 { maxShelf }
      });
    }
    const cab = cabinetById.get(cabinetId);
    if (!cab.columns.has(columnIndex)) {
      cab.columns.set(columnIndex, { maxShelf: 0, maxLayer: 0, slotWidth: new Map(), layersByShelf: new Map() });
    }
    const col = cab.columns.get(columnIndex);
    if (shelfIndex > col.maxShelf) col.maxShelf = shelfIndex;
    noteLayerExtent(col, layerIndex, ...disabledSlots);
    noteShelfLayer(col, shelfIndex, layerIndex);
  }

  // \u2500\u2500 Section 2: bottle records \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  const bottleHeaders = splitCSVLine(lines[boundary]);
  const headerIndex = (name) => bottleHeaders.findIndex(h => h.trim() === name);
  const idx = {
    bottleId: headerIndex('Bottle ID'),
    cabinetId: headerIndex('Cabinet ID'),
    layerId: headerIndex('Layer ID'),
    slot: headerIndex('Slot'),
    size: headerIndex('Bottle Size Liters'),
    year: headerIndex('Wine Year'),
    type: headerIndex('Wine Type'),
    note: headerIndex('Bottle Note'),
    title: headerIndex('Wine Title'),
    country: headerIndex('Wine Country'),
    region: headerIndex('Wine Region'),
    winery: headerIndex('Wine Winery'),
    cost: headerIndex('Purchase Cost'),
    currency: headerIndex('Purchase Currency'),
    purchase: headerIndex('Purchase Date'),
    consumed: headerIndex('Consumed On'),
  };

  const items = [];
  const rackNameFor = (cabinetLabel, columnIndex, totalColumns) =>
    totalColumns > 1 ? `${cabinetLabel} \u2013 Module ${columnIndex}` : cabinetLabel;
  // Cells that hold a bottle, per rack, as "shelf/layer/slot". Oeno sometimes
  // carries two definitions of the same shelf+layer (a re-created layer keeps
  // its old row) whose disabled lists disagree; a bottle sitting in a cell is
  // the stronger evidence that the cell is usable, so it wins below.
  const occupiedByRack = new Map();

  for (let i = boundary + 1; i < lines.length; i++) {
    const cells = oenoCells(lines[i], bottleHeaders.length);
    if (!cells[idx.bottleId] || !cells[idx.bottleId].trim()) continue;

    const cabinetIdRaw = (cells[idx.cabinetId] || '').trim();
    const layerIdRaw = (cells[idx.layerId] || '').trim();
    const slotRaw = (cells[idx.slot] || '').trim();
    const isUnshelved = !cabinetIdRaw || cabinetIdRaw === 'null';

    const sizeLitres = parseLocaleNumber(cells[idx.size]);
    const bottleSize = isNaN(sizeLitres) ? '750ml' : `${Math.round(sizeLitres * 1000)}ml`;
    const cost = parseLocaleNumber(cells[idx.cost]);
    const consumedAt = (cells[idx.consumed] || '').trim();

    const baseItem = {
      wineName: (cells[idx.title] || '').trim(),
      producer: (cells[idx.winery] || '').trim(),
      ...vintageOrNV(cells[idx.year]),
      country: (cells[idx.country] || '').trim(),
      region: (cells[idx.region] || '').trim(),
      type: mapWineType((cells[idx.type] || '').trim()),
      bottleSize,
      notes: (cells[idx.note] || '').trim(),
      price: isNaN(cost) ? undefined : cost,
      currency: (cells[idx.currency] || '').trim() || undefined,
      purchaseDate: tryParseDate((cells[idx.purchase] || '').trim()),
    };

    if (consumedAt) {
      baseItem.addToHistory = true;
      // Normalise like the CSV/JSON paths do — parseOenoExport returns
      // directly from parseAndMap, so its dates skip the shared fix-up loop.
      baseItem.consumedAt = tryParseDate(consumedAt);
      baseItem.consumedReason = 'drank';
    }

    if (isUnshelved) {
      items.push(baseItem);
      continue;
    }

    const layer = layerById.get(layerIdRaw);
    if (!layer) {
      // Layer ID references a layer we don't know \u2014 still import as unshelved
      items.push(baseItem);
      continue;
    }

    const cab = cabinetById.get(layer.cabinetId);
    const totalColumns = cab?.columns.size || 1;
    const slotInLayer = parseInt(slotRaw, 10) || undefined;
    if (cab && slotInLayer) noteLayerExtent(cab.columns.get(layer.columnIndex), layer.layerIndex, slotInLayer);
    if (cab) noteShelfLayer(cab.columns.get(layer.columnIndex), layer.shelfIndex, layer.layerIndex);
    const rackName = rackNameFor(layer.cabinetLabel, layer.columnIndex, totalColumns);
    if (slotInLayer) {
      if (!occupiedByRack.has(rackName)) occupiedByRack.set(rackName, new Set());
      occupiedByRack.get(rackName).add(`${layer.shelfIndex}/${layer.layerIndex}/${slotInLayer}`);
    }
    items.push({
      ...baseItem,
      rackName,
      // For shelf racks the backend interprets rackPosition as the shelf
      // number (row). layer + slotInLayer pin down the exact cell.
      rackPosition: layer.shelfIndex,
      layer: layer.layerIndex,
      slotInLayer,
    });
  }

  // Build per-rack default configs so the picker can pre-fill cabinet shapes
  const oenoRackSpecs = {};
  for (const [cabinetId, cab] of cabinetById) {
    const totalColumns = cab.columns.size;
    for (const [columnIndex, col] of cab.columns) {
      const rackName = rackNameFor(cab.label, columnIndex, totalColumns);
      const rows = Math.min(20, col.maxShelf);
      const geo = geometryForColumn(col, rows);
      const { cols, backCols, bpc, stacked } = geo;

      // Convert each layer's disabled slot-in-layer indices to GLOBAL Cellarion
      // positions, mirroring the backend's placement math with the Oeno
      // bottom-left anchor (shelf 1 = bottom):
      //   Open Shelf (front/back model, computeRackPosition):
      //     effectiveShelf = rows - shelfIndex + 1
      //     shelfBase = (effectiveShelf - 1) × (cols + backCols) × bottlesPerCell
      //     front (layer 1): shelfBase + slotInLayer          (slotInLayer ≤ cols)
      //     back  (layer 2): shelfBase + cols + slotInLayer   (slotInLayer ≤ backCols)
      //   Wine cabinet (rackGeometry.cabinetPosition): bay i = rows - shelfIndex
      //     position = cols × Σ shelfRows[k<i] + (layer - 1) × cols + slotInLayer
      //     (every row `cols` wide: an Oeno cabinet is never created with the
      //     alternating-rows option, whose rows are cols / cols−1 in turn)
      const disabled = new Set();
      const occupied = occupiedByRack.get(rackName) || new Set();
      for (const layer of layerById.values()) {
        if (layer.cabinetId !== cabinetId || layer.columnIndex !== columnIndex) continue;
        if (layer.disabledSlots.size === 0) continue;
        // Shelves clamped away by the 20-row cap have no cells to disable
        if (layer.shelfIndex > rows) continue;
        for (const n of layer.disabledSlots) {
          // A bottle in the cell beats a stale disabled flag (see occupiedByRack)
          if (occupied.has(`${layer.shelfIndex}/${layer.layerIndex}/${n}`)) continue;
          if (stacked) {
            const bay = rows - layer.shelfIndex;
            if (layer.layerIndex > geo.shelfRows[bay] || n > cols) continue;
            let base = 0;
            for (let k = 0; k < bay; k++) base += cols * geo.shelfRows[k];
            disabled.add(base + (layer.layerIndex - 1) * cols + n);
            continue;
          }
          const shelfBase = (rows - layer.shelfIndex) * (cols + backCols) * bpc;
          if (layer.layerIndex === 1 && n <= cols) {
            disabled.add(shelfBase + n);
          } else if (layer.layerIndex === 2 && n <= backCols) {
            disabled.add(shelfBase + cols + n);
          }
        }
      }

      const shape = stacked
        ? { type: 'cabinet', rows, cols, typeConfig: { shelfRows: geo.shelfRows, twoDeep: true, stagger: true } }
        : { type: 'shelf', rows, cols, typeConfig: { bottlesPerCell: bpc, backCols } };
      oenoRackSpecs[rackName] = {
        ...shape,
        ...(disabled.size > 0
          ? { disabledPositions: [...disabled].sort((a, b) => a - b) }
          : {}),
      };
    }
  }

  return {
    items,
    format: 'oeno-export',
    headers: bottleHeaders,
    oenoRackSpecs,
  };
}

/**
 * Record what a column's layers address: the highest layer index seen and the
 * widest slot per layer. Fed from BOTH the layer definitions (disabled-slot
 * indices reveal a layer's width even when no bottle sits there) and the
 * bottle records (their Slot column). geometryForColumn reads it.
 */
function noteLayerExtent(col, layerIndex, ...slots) {
  if (!col || isNaN(layerIndex)) return;
  if (layerIndex > col.maxLayer) col.maxLayer = layerIndex;
  const cur = col.slotWidth.get(layerIndex) || 0;
  const widest = Math.max(cur, ...slots.filter((n) => Number.isFinite(n) && n > 0));
  if (widest > cur) col.slotWidth.set(layerIndex, widest);
}

/** Highest layer index seen on one Oeno shelf of a column (definitions + bottles). */
function noteShelfLayer(col, shelfIndex, layerIndex) {
  if (!col || isNaN(shelfIndex) || isNaN(layerIndex)) return;
  const cur = col.layersByShelf.get(shelfIndex) || 0;
  if (layerIndex > cur) col.layersByShelf.set(shelfIndex, layerIndex);
}

/**
 * Pick the Cellarion rack shape for one Oeno cabinet column. The file never
 * states whether "layer" means front/back or a stacked row, so the layer
 * count decides:
 *   - up to 2 layers → Open Shelf with a front + back row, 6 + 5 (Vintec/
 *     Transtherm sliding shelves), widened when the file addresses a higher
 *     slot;
 *   - 3 or more     → Wine cabinet (`cabinet` type): cols = widest layer,
 *     shelfRows[i] = the layers that shelf holds, TOP shelf first (Oeno
 *     numbers shelves from the bottom, Cellarion bays from the top), two deep.
 * `rows` is the (capped) shelf count the rack will have.
 */
function geometryForColumn(col, rows) {
  const widest = (layers) => Math.max(0, ...layers.map((l) => col.slotWidth.get(l) || 0));
  if (col.maxLayer <= 2) {
    return {
      cols: Math.min(20, Math.max(6, widest([1]))),
      backCols: Math.min(20, Math.max(5, widest([2]))),
      bpc: 1,
      stacked: false,
    };
  }
  const shelfRows = [];
  for (let i = 0; i < rows; i++) {
    const oenoShelf = rows - i; // bay 0 = the top shelf = the highest Oeno shelf number
    shelfRows.push(Math.min(12, Math.max(1, col.layersByShelf.get(oenoShelf) || 1)));
  }
  return {
    cols: Math.min(20, Math.max(1, widest([...col.slotWidth.keys()]))),
    backCols: 0,
    bpc: 1,
    shelfRows,
    stacked: true,
  };
}

/**
 * The cells of one Oeno row. The boundary-aware split keeps a stray inch mark
 * literal, but in the bare dialect it also keeps a quote at the start of a
 * cell open when its closing quote is not at a boundary ("Reserve" bottle),
 * and the row then comes out short. When the row does not split into the
 * header's number of cells, a split that toggles on every quote is tried, the
 * way the bare dialect was always read, and kept when it does.
 */
function oenoCells(line, expected) {
  const cells = splitCSVLine(line);
  if (!expected || cells.length === expected) return cells;
  const fields = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { field += '"'; i++; } else inQ = !inQ;
    } else if (c === ',' && !inQ) {
      fields.push(decodeCharRefs(field));
      field = '';
    } else {
      field += c;
    }
  }
  fields.push(decodeCharRefs(field));
  return fields.length === expected ? fields : cells;
}
