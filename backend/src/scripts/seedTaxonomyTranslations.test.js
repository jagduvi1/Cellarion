/**
 * The seeded display names, checked as data.
 *
 * A wrong entry here is invisible: it renders as a confident, plausible name in
 * a language most reviewers of this repo do not read. So the properties that
 * CAN be checked mechanically are checked — shape, no English, no self-
 * translations — and the rest is left to the admin endpoint, which lets a
 * native speaker fix any of it without a release.
 */
const { COUNTRIES, REGIONS } = require('./seed-taxonomy-translations');
const { sanitizeTranslations, localizedName } = require('../utils/localizedName');

const SHIPPED = ['fr', 'de', 'sv', 'et'];
const entries = [
  ...Object.entries(COUNTRIES).map(([name, t]) => ['country', name, t]),
  ...Object.entries(REGIONS).map(([name, t]) => ['region', name, t]),
];

describe('the seed tables', () => {
  test('every entry passes the same validation the admin endpoint applies', () => {
    for (const [kind, name, translations] of entries) {
      const parsed = sanitizeTranslations(translations);
      expect(parsed.ok ? null : `${kind} ${name}: ${parsed.error}`).toBeNull();
    }
  });

  test('no entry translates a name into itself', () => {
    // A translation equal to the canonical name is dead weight: the endpoint
    // filters it out, so it would ship in the table and never reach a reader.
    const selfies = entries.flatMap(([kind, name, t]) =>
      Object.entries(t).filter(([, value]) => value === name).map(([lang]) => `${kind} ${name} (${lang})`));
    expect(selfies).toEqual([]);
  });

  test('only languages the app actually ships are used', () => {
    const langs = new Set(entries.flatMap(([, , t]) => Object.keys(t)));
    expect([...langs].filter((l) => !SHIPPED.includes(l))).toEqual([]);
  });

  test('the record that prompted all of this is present and correct', () => {
    // Proposal 6a959b9d, "En Français svp".
    expect(REGIONS['Rhône Valley'].fr).toBe('Vallée du Rhône');
    // And the country his own import file wrote as "Allemagne".
    expect(COUNTRIES.Germany.fr).toBe('Allemagne');
  });

  test('the tables feed localizedName as-is', () => {
    // The seed and the reader agree on shape — a plain object, which is what
    // a .lean() document also gives.
    expect(localizedName({ name: 'Rhône Valley', translations: REGIONS['Rhône Valley'] }, 'fr'))
      .toBe('Vallée du Rhône');
    expect(localizedName({ name: 'Germany', translations: COUNTRIES.Germany }, 'sv'))
      .toBe('Tyskland');
  });

  test('an entry with nothing to say in any language is allowed but seeds nothing', () => {
    // Uruguay reads the same in all four; it is kept in the table as a marker
    // that it was considered rather than forgotten.
    expect(COUNTRIES.Uruguay).toEqual({});
    expect(sanitizeTranslations(COUNTRIES.Uruguay).translations).toEqual({});
  });

  test('no duplicate canonical names between the two tables', () => {
    // A name in both would be seeded twice against different models — harmless
    // today, confusing the moment one of them is edited.
    const overlap = Object.keys(COUNTRIES).filter((n) => n in REGIONS);
    expect(overlap).toEqual([]);
  });
});
