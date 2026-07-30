/**
 * The coverage maths, and the build-time plugin that ships it to the app.
 *
 * Both matter to translators: this number decides whether their language is
 * offered as finished or as beta, so a bug here either ships a half-English UI
 * as if it were done, or keeps a complete translation permanently labelled
 * unfinished.
 */

import { LOCALES, SHIPPED_CODES, BETA_BELOW as VIRTUAL_BETA_BELOW } from 'virtual:locale-coverage';

import en from './en/translation.json';
import { BETA_BELOW, coverageFor, isMachineDrafted, isStaffKey, localeStatus, flatten } from './coverage.js';

describe('coverageFor', () => {
  const source = {
    cellars: { title: 'Cellars', empty: 'Nothing here' },
    bottles: { count_one: '{{count}} bottle', count_other: '{{count}} bottles' },
    admin: { title: 'Admin', users: 'Users' },
    adminStats: { title: 'Stats' },
    moderationReports: { title: 'Reports' },
  };

  test('excludes staff strings from the denominator', () => {
    // 2 user-facing singles + 1 plural family = 3 units; the 4 admin strings
    // must not appear in the total at all.
    expect(coverageFor(source, source).total).toBe(3);
  });

  test('a translation with zero admin strings still reaches 100%', () => {
    const fr = {
      cellars: { title: 'Caves', empty: 'Rien ici' },
      bottles: { count_one: '{{count}} bouteille', count_other: '{{count}} bouteilles' },
    };
    expect(coverageFor(source, fr).ratio).toBe(1);
  });

  test('counts a plural family as one unit regardless of the locale plural count', () => {
    // Polish needs four forms for what English says in two — that must not
    // inflate the denominator or the numerator.
    const pl = {
      cellars: { title: 'Piwnice', empty: 'Pusto' },
      bottles: {
        count_one: '{{count}} butelka',
        count_few: '{{count}} butelki',
        count_many: '{{count}} butelek',
        count_other: '{{count}} butelki',
      },
    };
    const { translated, total } = coverageFor(source, pl);
    expect([translated, total]).toEqual([3, 3]);
  });

  test('empty and whitespace-only strings do not count as translated', () => {
    const half = { cellars: { title: 'Caves', empty: '   ' } };
    expect(coverageFor(source, half).translated).toBe(1);
  });

  test('orphan and staff keys in a locale cannot push coverage above its work', () => {
    const noisy = {
      cellars: { title: 'Caves' },
      admin: { title: 'Admin', users: 'Utilisateurs' },
      ghost: { removed: 'Stale key from a deleted feature' },
    };
    const { translated, total, ratio } = coverageFor(source, noisy);
    expect([translated, total]).toEqual([1, 3]);
    expect(ratio).toBeCloseTo(1 / 3);
  });

  test('localeStatus flags beta strictly below the threshold', () => {
    const at = { code: 'x', ratio: BETA_BELOW };
    expect(at.ratio < BETA_BELOW).toBe(false);
    const nearly = {
      cellars: { title: 'Caves', empty: 'Rien' },
      bottles: { count_one: '', count_other: '' },
    };
    expect(localeStatus('fr', source, nearly).beta).toBe(true);
  });
});

describe('machine-drafted languages', () => {
  const source = {
    cellars: { title: 'Cellars' },
    bottles: { count_one: '{{count}} bottle', count_other: '{{count}} bottles' },
  };
  const complete = {
    cellars: { title: 'Caves' },
    bottles: { count_one: '{{count}} bouteille', count_other: '{{count}} bouteilles' },
  };

  test('a fully-filled drafted locale is still beta — filled is not reviewed', () => {
    const fr = localeStatus('fr', source, complete);
    expect(fr.ratio).toBe(1);
    expect(fr.beta).toBe(true);
  });

  test('an equally complete locale that was never drafted is not beta', () => {
    expect(localeStatus('sv', source, complete)).toMatchObject({ ratio: 1, beta: false });
  });

  test('a regional variant inherits its base language draft status', () => {
    expect(isMachineDrafted('fr-CA')).toBe(true);
    expect(isMachineDrafted('fr_CA')).toBe(true);
    expect(isMachineDrafted('sv')).toBe(false);
    expect(isMachineDrafted(undefined)).toBe(false);
  });

  test('the flag only ever adds beta, never clears it', () => {
    // A drafted locale that is also genuinely incomplete stays beta for both
    // reasons — removing it from the set must not ship a half-empty language.
    const half = { cellars: { title: 'Caves' } };
    expect(localeStatus('fr', source, half).beta).toBe(true);
    expect(localeStatus('de', source, half).ratio).toBeCloseTo(0.5);
  });
});

describe('isStaffKey', () => {
  test.each([
    ['admin.users.title', true],
    ['adminStats.countIn90Days', true],
    ['adminMcp.title', true],
    ['adminAiBudget.spent', true],
    ['adminModerators.currentMods', true],
    ['moderationReports.title', true],
    // Named like staff surfaces, actually user-facing: the rack audit modal and
    // the cellar activity view.
    ['audit.title', false],
    ['cellarAudit.title', false],
    ['somm.maturity.title', false],
    ['bottleDetail.title', false],
  ])('%s → staff: %s', (key, expected) => {
    expect(isStaffKey(key)).toBe(expected);
  });
});

describe('virtual:locale-coverage (build-time plugin output)', () => {
  test('exposes every locale directory, English first-class and complete', () => {
    const codes = LOCALES.map((l) => l.code);
    expect(codes).toContain('en');
    expect(codes).toContain('sv');
    const english = LOCALES.find((l) => l.code === 'en');
    expect(english).toMatchObject({ ratio: 1, beta: false });
  });

  test('agrees with the maths in this repo, not a stale checked-in count', () => {
    const sv = LOCALES.find((l) => l.code === 'sv');
    const recomputed = coverageFor(en, svBundle());
    expect(sv.translated).toBe(recomputed.translated);
    expect(sv.total).toBe(recomputed.total);
  });

  test('the denominator is smaller than the raw key count (staff excluded)', () => {
    const english = LOCALES.find((l) => l.code === 'en');
    expect(english.total).toBeLessThan(flatten(en).length);
    expect(flatten(en).some(isStaffKey)).toBe(true); // the exclusion is not a no-op
  });

  test('SHIPPED_CODES omits beta languages and the threshold matches source', () => {
    expect(VIRTUAL_BETA_BELOW).toBe(BETA_BELOW);
    for (const code of SHIPPED_CODES) {
      expect(LOCALES.find((l) => l.code === code).beta).toBe(false);
    }
    expect(SHIPPED_CODES).toContain('en');
  });

  test('Swedish is complete enough to ship (guards against a locale regression)', () => {
    expect(LOCALES.find((l) => l.code === 'sv').beta).toBe(false);
  });

  test('the machine-drafted languages ship as beta however full they are', () => {
    // The whole point of the flag: fr/de are ~100% filled, so without it they
    // would be auto-selected from the browser and declared via hreflang before
    // a single string had been read by a French or German speaker.
    for (const code of ['fr', 'de']) {
      const locale = LOCALES.find((l) => l.code === code);
      expect(locale).toBeDefined();
      expect(locale.beta).toBe(true);
      expect(SHIPPED_CODES).not.toContain(code);
    }
  });
});

// Imported lazily so the assertions above read in order; the bundle is only
// needed for the cross-check against the plugin's own count.
function svBundle() {
  const mods = import.meta.glob('./sv/translation.json', { eager: true });
  return mods['./sv/translation.json'].default;
}
