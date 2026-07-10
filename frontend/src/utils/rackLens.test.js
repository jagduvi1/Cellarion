import { describe, it, expect } from 'vitest';
import { getLensStyle, getLensLegend, bottleMatchesSearch, LENSES } from './rackLens';

const CURRENT_YEAR = new Date().getFullYear();

// ─── getLensStyle — type (default) lens ──────────────────────────────────────

describe('getLensStyle — type lens', () => {
  it('returns null so renderers use their built-in wine-type colors', () => {
    expect(getLensStyle('type', { maturityStatus: 'peak' })).toBeNull();
  });

  it('returns null for missing bottle regardless of lens', () => {
    for (const lens of LENSES) {
      expect(getLensStyle(lens, null)).toBeNull();
      expect(getLensStyle(lens, undefined)).toBeNull();
    }
  });
});

// ─── getLensStyle — maturity lens ────────────────────────────────────────────

describe('getLensStyle — maturity lens', () => {
  it.each(['not-ready', 'early', 'peak', 'late', 'declining'])(
    'returns a distinct style for %s',
    (status) => {
      const style = getLensStyle('maturity', { maturityStatus: status });
      expect(style.fill).toMatch(/^#/);
      expect(style.stroke).toMatch(/^#/);
    }
  );

  it('gives every maturity status a unique fill', () => {
    const fills = ['not-ready', 'early', 'peak', 'late', 'declining', null]
      .map(s => getLensStyle('maturity', { maturityStatus: s }).fill);
    expect(new Set(fills).size).toBe(fills.length);
  });

  it('falls back to the neutral style for null/unknown status', () => {
    const neutral = getLensStyle('maturity', { maturityStatus: null });
    expect(getLensStyle('maturity', { maturityStatus: 'bogus' })).toEqual(neutral);
    expect(getLensStyle('maturity', {})).toEqual(neutral);
  });
});

// ─── getLensStyle — age lens ─────────────────────────────────────────────────

describe('getLensStyle — age lens', () => {
  const style = (vintage) => getLensStyle('age', { vintage }, CURRENT_YEAR);

  it('buckets by years since vintage', () => {
    const young = style(String(CURRENT_YEAR - 1));
    const mid = style(String(CURRENT_YEAR - 8));
    const old = style(String(CURRENT_YEAR - 30));
    expect(young.fill).not.toBe(mid.fill);
    expect(mid.fill).not.toBe(old.fill);
  });

  it('handles bucket boundaries (2/3 and 20/21 years)', () => {
    expect(style(String(CURRENT_YEAR - 2)).fill).not.toBe(style(String(CURRENT_YEAR - 3)).fill);
    expect(style(String(CURRENT_YEAR - 20)).fill).not.toBe(style(String(CURRENT_YEAR - 21)).fill);
  });

  it('returns the neutral style for NV and unparseable vintages', () => {
    const neutral = style('NV');
    expect(style(undefined)).toEqual(neutral);
    expect(style('n/a')).toEqual(neutral);
    expect(style('1750')).toEqual(neutral); // before plausible range
  });

  it('treats next-year (pre-release) vintages as youngest, not neutral', () => {
    expect(style(String(CURRENT_YEAR + 1))).toEqual(style(String(CURRENT_YEAR)));
  });
});

// ─── getLensStyle — rating lens ──────────────────────────────────────────────

describe('getLensStyle — rating lens', () => {
  it('maps a top rating and a bottom rating to different styles', () => {
    const top = getLensStyle('rating', { rating: 5, ratingScale: '5' });
    const bottom = getLensStyle('rating', { rating: 1, ratingScale: '5' });
    expect(top.fill).not.toBe(bottom.fill);
  });

  it('normalizes across scales — 100-point and 5-star tops land in the same bucket', () => {
    const hundred = getLensStyle('rating', { rating: 98, ratingScale: '100' });
    const fiveStar = getLensStyle('rating', { rating: 5, ratingScale: '5' });
    expect(hundred.fill).toBe(fiveStar.fill);
  });

  it('defaults missing scale to 5-star', () => {
    expect(getLensStyle('rating', { rating: 5 }))
      .toEqual(getLensStyle('rating', { rating: 5, ratingScale: '5' }));
  });

  it('returns the neutral style for unrated bottles', () => {
    const neutral = getLensStyle('rating', {});
    expect(getLensStyle('rating', { rating: null })).toEqual(neutral);
    expect(getLensStyle('maturity', { maturityStatus: null })).toEqual(neutral); // shared neutral
  });
});

// ─── getLensLegend ───────────────────────────────────────────────────────────

describe('getLensLegend', () => {
  it('returns entries with tKey + fill for every lens', () => {
    for (const lens of LENSES) {
      const legend = getLensLegend(lens);
      expect(legend.length).toBeGreaterThan(0);
      for (const e of legend) {
        expect(typeof e.tKey).toBe('string');
        expect(e.fill).toMatch(/^#/);
      }
    }
  });

  it('maturity legend covers all five statuses plus no-data', () => {
    expect(getLensLegend('maturity')).toHaveLength(6);
  });

  it('rating legend runs best-first', () => {
    const keys = getLensLegend('rating').map(e => e.tKey);
    expect(keys[0]).toBe('rackLens.ratingExcellent');
    expect(keys[keys.length - 1]).toBe('rackLens.ratingNone');
  });

  it('unknown lens yields an empty legend', () => {
    expect(getLensLegend('bogus')).toEqual([]);
  });
});

// ─── bottleMatchesSearch ─────────────────────────────────────────────────────

describe('bottleMatchesSearch', () => {
  const bottle = {
    vintage: '2015',
    wineDefinition: {
      name: 'Château Margaux',
      producer: 'Château Margaux',
      appellation: 'Margaux AOC',
      country: { name: 'France' },
      region: { name: 'Bordeaux' },
      grapes: [{ name: 'Cabernet Sauvignon' }, { name: 'Merlot' }],
    },
  };

  it('matches on name, producer, appellation, country, region, grape and vintage', () => {
    expect(bottleMatchesSearch(bottle, 'margaux')).toBe(true);
    expect(bottleMatchesSearch(bottle, 'france')).toBe(true);
    expect(bottleMatchesSearch(bottle, 'bordeaux')).toBe(true);
    expect(bottleMatchesSearch(bottle, 'merlot')).toBe(true);
    expect(bottleMatchesSearch(bottle, '2015')).toBe(true);
  });

  it('is case-insensitive and trims the term', () => {
    expect(bottleMatchesSearch(bottle, '  MARGAUX  ')).toBe(true);
  });

  it('rejects non-matching terms', () => {
    expect(bottleMatchesSearch(bottle, 'barolo')).toBe(false);
    expect(bottleMatchesSearch(bottle, '1999')).toBe(false);
  });

  it('empty or whitespace-only term matches everything', () => {
    expect(bottleMatchesSearch(bottle, '')).toBe(true);
    expect(bottleMatchesSearch(bottle, '   ')).toBe(true);
    expect(bottleMatchesSearch(bottle, null)).toBe(true);
  });

  it('survives bottles with missing wineDefinition or fields', () => {
    expect(bottleMatchesSearch({}, 'margaux')).toBe(false);
    expect(bottleMatchesSearch({ vintage: '2015' }, '2015')).toBe(true);
    expect(bottleMatchesSearch(null, 'margaux')).toBe(false);
  });
});
