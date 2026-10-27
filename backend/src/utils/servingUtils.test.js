const {
  NEEDS_AIR, DEFAULT_TEMPS, DEFAULT_AIR, AIR_BY_PHASE, defaultServingTemp, servingAdvice, servingSentence, isTemp,
} = require('./servingUtils');

const PHASES = ['not-ready', 'early', 'peak', 'late', 'declining'];
const TYPES = ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'];

describe('the tables cover every type, body and phase', () => {
  test('every wine type has a temperature for every body, min ≤ max', () => {
    for (const type of TYPES) {
      for (const body of ['light', 'medium', 'full', 'unknown']) {
        const [min, max] = DEFAULT_TEMPS[type][body];
        expect(isTemp(min) && isTemp(max) && min <= max).toBe(true);
      }
      expect(NEEDS_AIR).toContain(DEFAULT_AIR[type]);
    }
  });

  test('every air trait has a code for every phase', () => {
    for (const trait of NEEDS_AIR) for (const phase of PHASES) expect(typeof AIR_BY_PHASE[trait][phase]).toBe('string');
  });
});

describe('defaults when the sommelier set nothing', () => {
  test('a full red is served warmer than a light one, a crisp white colder than an oaked one', () => {
    expect(defaultServingTemp('red', 'full')).toEqual([16, 18]);
    expect(defaultServingTemp('red', 'light')).toEqual([13, 15]);
    expect(defaultServingTemp('white', 'light')).toEqual([8, 10]);
    expect(defaultServingTemp('white', 'full')).toEqual([10, 12]);
    expect(defaultServingTemp('sparkling', null)).toEqual([6, 8]);
  });

  test('a drink that is not wine gets no advice; an unknown type gets none either', () => {
    expect(servingAdvice({ type: null, nonWine: true, aiProfile: {} }, 'peak')).toBeNull();
    expect(servingAdvice({ type: 'beer', aiProfile: {} }, 'peak')).toBeNull();
  });

  test('a red at its peak: style temperature, open and pour; the same red young: open ahead', () => {
    const red = { type: 'red', aiProfile: { body: 'medium' } };
    expect(servingAdvice(red, 'peak')).toEqual({
      temperature: { min: 15, max: 17, source: 'style' },
      air: { trait: 'short', code: 'pour', source: 'style' },
    });
    expect(servingAdvice(red, 'early').air.code).toBe('open_ahead');
  });

  test('without a phase the temperature stands alone: no guess about the wine\'s age', () => {
    expect(servingAdvice({ type: 'red', aiProfile: {} }, null)).toEqual({
      temperature: { min: 15, max: 18, source: 'style' },
      air: null,
    });
  });
});

describe('the sommelier\'s trait, read against the phase today', () => {
  const barolo = { type: 'red', aiProfile: { body: 'full', needsAir: 'long', servingTempMin: 17, servingTempMax: 18 } };

  test('a wine that needs air when young: decant long early, briefly at peak, pour carefully when old', () => {
    expect(servingAdvice(barolo, 'early')).toEqual({
      temperature: { min: 17, max: 18, source: 'sommelier' },
      air: { trait: 'long', code: 'decant_long', source: 'sommelier' },
    });
    expect(servingAdvice(barolo, 'peak').air.code).toBe('decant_short');
    expect(servingAdvice(barolo, 'late').air.code).toBe('pour_careful');
    expect(servingAdvice(barolo, 'declining').air.code).toBe('pour_careful');
  });

  test('the same record gives different advice as the years pass, nothing stored changes', () => {
    const young = servingAdvice(barolo, 'early');
    const old = servingAdvice(barolo, 'late');
    expect(young.temperature).toEqual(old.temperature);
    expect(young.air.code).not.toBe(old.air.code);
  });

  test('a half-set or inverted temperature falls back to the style', () => {
    expect(servingAdvice({ type: 'white', aiProfile: { servingTempMin: 9 } }, null).temperature.source).toBe('style');
    expect(servingAdvice({ type: 'white', aiProfile: { servingTempMin: 12, servingTempMax: 9 } }, null).temperature.source).toBe('style');
    expect(servingAdvice({ type: 'white', aiProfile: { servingTempMin: 9.5, servingTempMax: 11 } }, null).temperature.source).toBe('style');
  });

  test('"none" on a fragile old wine never decants it', () => {
    const old = { type: 'red', aiProfile: { needsAir: 'none' } };
    for (const phase of PHASES) expect(servingAdvice(old, phase).air.code).toMatch(/^pour/);
  });
});

describe('the English sentence for assistants', () => {
  test('temperature and air, or temperature alone', () => {
    expect(servingSentence(servingAdvice({ type: 'red', aiProfile: { body: 'full', needsAir: 'long' } }, 'early')))
      .toBe('Serve at 16–18 °C; decant one to two hours before serving.');
    expect(servingSentence(servingAdvice({ type: 'sparkling', aiProfile: {} }, null))).toBe('Serve at 6–8 °C.');
    expect(servingSentence(null)).toBeNull();
  });
});
