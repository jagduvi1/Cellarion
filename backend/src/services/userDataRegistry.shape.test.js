/**
 * The order and the shape of the user-data registry.
 *
 * The registry is one ordered list. The order is part of what it does: an
 * account is erased entry by entry, and the export is built by merging each
 * entry's fragment into the one before, so two entries that write under the
 * same key (`reports`, `priceTracking`) depend on who comes first. This suite
 * keeps a snapshot of every entry in order: its model, its category, the user
 * fields it declares and which of the hooks it has. Moving entries between
 * files must leave the snapshot as it is; adding a model adds one line to it.
 */

// services/search.js eagerly requires the ESM-only `meilisearch` package,
// which Jest can't parse — mock it (same pattern as userDataRegistry.test.js).
jest.mock('./search', () => ({
  indexDiscussion: jest.fn(),
}));

const { REGISTRY, EXCLUDED } = require('./userDataRegistry');

const CATEGORIES = ['personal-data', 'shared-content', 'creator-ref', 'via-cellar'];
const KNOWN_KEYS = ['model', 'category', 'userFields', 'purge', 'postPurge', 'note', 'exportFragment'];

// One line per entry: "Model [category] fields… | hooks".
const lineOf = (entry) => {
  const hooks = [
    typeof entry.purge === 'function' ? 'purge' : 'no purge',
    typeof entry.postPurge === 'function' ? 'postPurge' : null,
    typeof entry.exportFragment === 'function' ? 'export' : 'no export',
    entry.note ? 'note' : null,
  ].filter(Boolean).join(', ');
  return `${entry.model.modelName} [${entry.category}] ${(entry.userFields || []).join(', ')} | ${hooks}`;
};

describe('the user-data registry', () => {
  test('lists its entries in this order, with these fields and hooks', () => {
    expect(REGISTRY.map(lineOf)).toMatchSnapshot();
  });

  test('every entry has a known category and declares the user fields it handles', () => {
    for (const entry of REGISTRY) {
      expect(CATEGORIES).toContain(entry.category);
      expect(Array.isArray(entry.userFields)).toBe(true);
      expect(entry.userFields.length).toBeGreaterThan(0);
    }
  });

  test('an entry carries no key the executors do not read', () => {
    const strays = REGISTRY.flatMap((entry) => Object.keys(entry)
      .filter((key) => !KNOWN_KEYS.includes(key))
      .map((key) => `${entry.model.modelName}.${key}`));
    expect(strays).toEqual([]);
  });

  test('the models left out on purpose are these', () => {
    expect(Object.keys(EXCLUDED).sort()).toMatchSnapshot();
  });
});
