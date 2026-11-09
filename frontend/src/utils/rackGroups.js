/**
 * Racks sectioned by their optional group label (discussion #1228: a
 * basement is usually several racks, not one). Groups
 * keep first-seen order — the order the racks were created in — and the
 * ungrouped racks come last under a null key, so a cellar with no groups at
 * all renders as one section, no heading.
 */
export function groupRacks(racks) {
  const sections = [];
  const byKey = new Map();
  for (const r of racks || []) {
    const key = (r.group && String(r.group).trim()) || null;
    if (!byKey.has(key)) {
      const section = { group: key, racks: [] };
      byKey.set(key, section);
      sections.push(section);
    }
    byKey.get(key).racks.push(r);
  }
  return [...sections.filter((s) => s.group !== null), ...sections.filter((s) => s.group === null)];
}

/** Distinct group names in creation order — the suggestions for a group input. */
export function groupNames(racks) {
  return groupRacks(racks).map((s) => s.group).filter(Boolean);
}
