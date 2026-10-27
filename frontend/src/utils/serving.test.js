import { describe, test, expect } from 'vitest';
import { DEFAULT_TEMPS, DEFAULT_AIR, AIR_BY_PHASE, NEEDS_AIR, servingAdvice, servingText } from './serving';

const t = (key, fallback, opts) => {
  if (key === 'serving.temperature') return `Serve at ${opts.range}`;
  return key;
};

describe('serving advice on the bottle page', () => {
  test('the tables cover every type, body and phase (mirrors the backend)', () => {
    for (const type of ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified']) {
      for (const body of ['light', 'medium', 'full', 'unknown']) {
        const [min, max] = DEFAULT_TEMPS[type][body];
        expect(min <= max).toBe(true);
      }
      expect(NEEDS_AIR).toContain(DEFAULT_AIR[type]);
    }
    for (const trait of NEEDS_AIR) for (const phase of ['not-ready', 'early', 'peak', 'late', 'declining']) expect(AIR_BY_PHASE[trait][phase]).toBeTruthy();
  });

  test('a red with no trait: style temperature, phase-dependent air', () => {
    const red = { type: 'red', aiProfile: { body: 'full' } };
    expect(servingAdvice(red, 'peak')).toEqual({ temperature: { min: 16, max: 18, source: 'style' }, air: { trait: 'short', code: 'pour', source: 'style' } });
    expect(servingAdvice(red, 'early').air.code).toBe('open_ahead');
    expect(servingAdvice(red, null).air).toBeNull();
  });

  test('the sommelier\'s trait changes the advice with the years, not the record', () => {
    const barolo = { type: 'red', aiProfile: { needsAir: 'long', servingTempMin: 17, servingTempMax: 18 } };
    expect(servingAdvice(barolo, 'early').air.code).toBe('decant_long');
    expect(servingAdvice(barolo, 'peak').air.code).toBe('decant_short');
    expect(servingAdvice(barolo, 'late').air.code).toBe('pour_careful');
    expect(servingAdvice(barolo, 'late').temperature).toEqual({ min: 17, max: 18, source: 'sommelier' });
  });

  test('a drink that is not wine has no line', () => {
    expect(servingAdvice({ type: null, nonWine: true, aiProfile: {} }, 'peak')).toBeNull();
  });

  test('the line reads as one sentence, in the user\'s unit', () => {
    expect(servingText(servingAdvice({ type: 'red', aiProfile: { needsAir: 'long' } }, 'early'), t)).toBe('Serve at 15–18 °C; serving.air.decant_long.');
    expect(servingText(servingAdvice({ type: 'sparkling', aiProfile: {} }, null), t)).toBe('Serve at 6–8 °C.');
    expect(servingText(servingAdvice({ type: 'sparkling', aiProfile: {} }, null), t, 'F')).toBe('Serve at 43–46 °F.');
    expect(servingText(null, t)).toBe('');
  });
});
