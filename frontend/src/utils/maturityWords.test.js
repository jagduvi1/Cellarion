import en from '../locales/en/translation.json';
import sv from '../locales/sv/translation.json';
import de from '../locales/de/translation.json';
import fr from '../locales/fr/translation.json';
import { getMaturityStatus, maturityBadgeText } from './drinkStatus';

// One set of maturity names everywhere (usability pass, Step 3): the filter
// chips said "Declining", the statistics "Past Prime", the bottle page
// "Late maturity" — a chart click landed on a chip with another name.

test('the filter chips, the statistics and the bottle page use the same names', () => {
  const chips = en.maturity;
  const stats = en.statistics.maturityPhases;
  expect(stats.notReady).toBe(chips.notReady);
  expect(stats.early).toBe(chips.early);
  expect(stats.peak).toBe(chips.peak);
  expect(stats.late).toBe(chips.late);
  expect(stats.declining).toBe(chips.declining);
  expect(stats.noProfile).toBe(chips.noData);
  // The bottle page's phase table: the same words (the peak keeps its star).
  expect(en.bottleDetail.maturityPhaseEarly).toBe(chips.early);
  expect(en.bottleDetail.maturityPhasePeak).toBe(`${chips.peak} ⭐`);
  expect(en.bottleDetail.maturityPhaseLate).toBe(chips.late);
  // The personal-window labels start with the same name.
  expect(en.bottleDetail.personalNotReady.startsWith(chips.notReady)).toBe(true);
  expect(en.bottleDetail.personalEarly.startsWith(chips.early)).toBe(true);
  expect(en.bottleDetail.personalLate.startsWith(chips.late)).toBe(true);
  // Inside an own window with no peak years set it is simply "Drink now" —
  // no claim of a peak the user never gave.
  expect(en.bottleDetail.personalDrinkNow).toBe('Drink now');
  expect(en.bottleDetail.personalPast.startsWith(chips.declining)).toBe(true);
});

test('the maturity badge is the chip name, translated, with the next change\'s year', () => {
  const t = (k, o) => {
    const v = k.split('.').reduce((acc, p) => acc && acc[p], en);
    return String(v).replace('{{year}}', o?.year);
  };
  const profile = (w) => ({ status: 'reviewed', ...w });
  const year = 2026;
  expect(maturityBadgeText(getMaturityStatus(profile({ earlyFrom: 2030, peakFrom: 2032, peakUntil: 2040 }), null, year), t)).toBe('Not ready — from 2030');
  expect(maturityBadgeText(getMaturityStatus(profile({ earlyFrom: 2020, peakFrom: 2028, peakUntil: 2040 }), null, year), t)).toBe('Early — peak from 2028');
  expect(maturityBadgeText(getMaturityStatus(profile({ peakFrom: 2020, peakUntil: 2030 }), null, year), t)).toBe('Peak ⭐');
  expect(maturityBadgeText(getMaturityStatus(profile({ peakFrom: 2010, peakUntil: 2015, lateFrom: 2016, lateUntil: 2030 }), null, year), t)).toBe('Late');
  expect(maturityBadgeText(getMaturityStatus(profile({ peakFrom: 2000, peakUntil: 2010 }), null, year), t)).toBe('Declining');
});

test('every language with maturity names has the year hints of the badge too (never a half-English badge)', () => {
  for (const [lng, bundle] of Object.entries({ sv, de, fr })) {
    if (!bundle.maturity) continue;
    expect([lng, Object.keys(bundle.maturity.hints || {}).sort()]).toEqual([lng, ['from', 'lateFrom', 'peakFrom']]);
  }
});
