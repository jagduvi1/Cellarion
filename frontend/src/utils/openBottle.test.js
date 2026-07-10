import { describe, it, expect } from 'vitest';
import {
  bottleSizeMl, pouredMl, remainingMl, glassesLeft,
  drinkByDate, daysLeft, freshnessStatus, PRESERVATION_METHODS,
} from './openBottle';

const DAY = 86400000;

describe('bottleSizeMl', () => {
  it('parses canonical size codes', () => {
    expect(bottleSizeMl({ bottleSize: '750ml' })).toBe(750);
    expect(bottleSizeMl({ bottleSize: '1500ml' })).toBe(1500);
    expect(bottleSizeMl({ bottleSize: '375ml' })).toBe(375);
  });

  it('falls back to 750 for missing or non-canonical sizes', () => {
    expect(bottleSizeMl({})).toBe(750);
    expect(bottleSizeMl({ bottleSize: 'Magnum' })).toBe(750);
    expect(bottleSizeMl(null)).toBe(750);
  });
});

describe('pour math', () => {
  const bottle = { bottleSize: '750ml', pours: [{ ml: 125 }, { ml: 125 }, { ml: 100 }] };

  it('sums pours and derives remaining volume', () => {
    expect(pouredMl(bottle)).toBe(350);
    expect(remainingMl(bottle)).toBe(400);
  });

  it('never goes below zero remaining', () => {
    expect(remainingMl({ bottleSize: '375ml', pours: [{ ml: 500 }] })).toBe(0);
  });

  it('converts remaining to glasses at half-glass precision', () => {
    expect(glassesLeft(bottle)).toBe(3); // 400 / 125 = 3.2 → 3
    expect(glassesLeft({ bottleSize: '750ml', pours: [] })).toBe(6);
    expect(glassesLeft({ bottleSize: '750ml', pours: [{ ml: 190 }] })).toBe(4.5); // 560/125 = 4.48 → 4.5
  });

  it('treats missing pours as an untouched bottle', () => {
    expect(remainingMl({ bottleSize: '750ml' })).toBe(750);
  });
});

describe('freshness window', () => {
  const openedAt = new Date('2026-07-01T12:00:00Z');

  it('coravin gets months, vacuum days', () => {
    const coravin = { openedAt, preservationMethod: 'coravin' };
    const vacuum = { openedAt, preservationMethod: 'vacuum' };
    expect(drinkByDate(coravin).getTime() - openedAt.getTime()).toBe(90 * DAY);
    expect(drinkByDate(vacuum).getTime() - openedAt.getTime()).toBe(4 * DAY);
  });

  it('unknown/missing method falls back to the shortest window', () => {
    const b = { openedAt, preservationMethod: null };
    expect(drinkByDate(b).getTime() - openedAt.getTime()).toBe(2 * DAY);
  });

  it('unopened bottles have no window', () => {
    expect(drinkByDate({})).toBeNull();
    expect(daysLeft({})).toBeNull();
    expect(freshnessStatus({})).toBeNull();
  });

  it('daysLeft counts down and goes negative past the deadline', () => {
    const b = { openedAt, preservationMethod: 'vacuum' }; // deadline 2026-07-05
    expect(daysLeft(b, new Date('2026-07-02T12:00:00Z'))).toBe(3);
    expect(daysLeft(b, new Date('2026-07-06T12:00:00Z'))).toBe(-1);
  });

  it('freshnessStatus maps to ok / soon / past', () => {
    const b = { openedAt, preservationMethod: 'coravin' };
    expect(freshnessStatus(b, new Date('2026-07-02T12:00:00Z'))).toBe('ok');
    expect(freshnessStatus(b, new Date('2026-09-27T12:00:00Z'))).toBe('soon');
    expect(freshnessStatus(b, new Date('2026-10-05T12:00:00Z'))).toBe('past');
  });

  it('every method has a positive freshness window', () => {
    for (const m of PRESERVATION_METHODS) {
      expect(m.freshnessDays).toBeGreaterThan(0);
    }
  });
});
