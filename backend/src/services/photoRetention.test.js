/**
 * services/photoRetention — the ONE definition of which photos the registry
 * keeps when their bottle or their uploader's account goes (policy 2026-09-27:
 * any photo approved as public outlives both; before, only the wine's chosen
 * picture did). The two query fragments must be exact complements of the
 * predicate, because the cascades delete with one and detach with the other.
 */
const { REGISTRY_PHOTO, OWN_PHOTO, isRegistryPhoto } = require('./photoRetention');

// A tiny in-memory evaluator for the subset of query syntax the fragments use,
// so the fragments are checked against the same rows as the predicate.
function matches(doc, q) {
  return Object.entries(q).every(([k, v]) => {
    if (k === '$or') return v.some((sub) => matches(doc, sub));
    if (k === '$nor') return !v.some((sub) => matches(doc, sub));
    if (v && typeof v === 'object' && '$ne' in v) return doc[k] !== v.$ne;
    return doc[k] === v;
  });
}

const rows = [
  { name: 'the wine\'s picture', kind: 'bottle', status: 'approved', visibility: 'public', assignedToWine: true, keep: true },
  { name: 'approved public, not the picture', kind: 'bottle', status: 'approved', visibility: 'public', assignedToWine: false, keep: true },
  { name: 'approved public, kind unset (old row)', status: 'approved', visibility: 'public', keep: true },
  { name: 'approved PRIVATE', kind: 'bottle', status: 'approved', visibility: 'private', assignedToWine: false, keep: false },
  { name: 'pending review', kind: 'bottle', status: 'processed', visibility: 'public', assignedToWine: false, keep: false },
  { name: 'still uploading', kind: 'bottle', status: 'uploaded', visibility: 'public', keep: false },
  { name: 'rejected tombstone', kind: 'bottle', status: 'rejected', visibility: 'public', assignedToWine: false, keep: false },
  { name: 'a label scan, whatever its flags say', kind: 'label-scan', status: 'approved', visibility: 'public', assignedToWine: true, keep: false },
  { name: 'a label scan, pending', kind: 'label-scan', status: 'uploaded', keep: false },
];

describe('isRegistryPhoto', () => {
  test.each(rows.map((r) => [r.name, r]))('%s', (_name, row) => {
    expect(isRegistryPhoto(row)).toBe(row.keep);
  });

  test('nothing is not a registry photo', () => {
    expect(isRegistryPhoto(null)).toBe(false);
    expect(isRegistryPhoto(undefined)).toBe(false);
  });
});

describe('the query fragments', () => {
  test('REGISTRY_PHOTO selects exactly the rows the predicate keeps', () => {
    for (const row of rows) expect([row.name, matches(row, REGISTRY_PHOTO)]).toEqual([row.name, row.keep]);
  });

  test('OWN_PHOTO is its exact complement — every row is in one and only one', () => {
    for (const row of rows) {
      expect([row.name, matches(row, OWN_PHOTO)]).toEqual([row.name, !row.keep]);
      expect(matches(row, REGISTRY_PHOTO) !== matches(row, OWN_PHOTO)).toBe(true);
    }
  });

  test('the fragments carry no field a caller would also set (they merge by spread)', () => {
    for (const frag of [REGISTRY_PHOTO, OWN_PHOTO]) {
      expect(Object.keys(frag)).not.toEqual(expect.arrayContaining(['bottle', 'uploadedBy', 'wineDefinition', 'createdAt']));
    }
  });
});
