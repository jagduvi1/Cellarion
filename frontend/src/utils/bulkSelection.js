// The size every bottle has unless told otherwise — not worth repeating on
// every line of a list.
export const DEFAULT_BOTTLE_SIZE = '750ml';

// "Producer Wine 2016" plus the size when it isn't the standard bottle.
export function bottleLine({ producer, name, vintage, bottleSize }) {
  return [producer, name, vintage || 'NV', bottleSize && bottleSize !== DEFAULT_BOTTLE_SIZE ? bottleSize : '']
    .filter(Boolean)
    .join(' ');
}

/**
 * What a bulk delete's confirm screen lists: the selected bottles grouped by
 * wine, vintage and size, biggest group first — [{ key, label, count }].
 * Built from the cellar list's loaded items, which are groups
 * ({ bottles: [...] }) or single bottles.
 */
export function summarizeSelection(items, selectedIds, unknownWine) {
  const groups = new Map();
  for (const item of items || []) {
    for (const b of (Array.isArray(item?.bottles) ? item.bottles : [item])) {
      if (!b || !selectedIds.has(b._id)) continue;
      const wine = b.wineDefinition;
      const name = wine?.name || b.pendingWineRequest?.wineName || unknownWine;
      const producer = wine?.producer || b.pendingWineRequest?.producer || '';
      const key = `${wine?._id || name}|${b.vintage || 'NV'}|${b.bottleSize || ''}`;
      const group = groups.get(key) || { key, label: bottleLine({ producer, name, vintage: b.vintage, bottleSize: b.bottleSize }), count: 0 };
      group.count += 1;
      groups.set(key, group);
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}
