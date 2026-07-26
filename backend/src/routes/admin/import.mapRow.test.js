/**
 * mapRow — the LWIN CSV row mapper, and specifically its DISPLAY_NAME
 * fallback. The old fallback trusted a 2-part split ("Bordeaux, Château
 * Margaux") and wrote the REGION into the producer field ~45 times across
 * four prod import waves (registry audit 2026-07-26, RC-2); it also truncated
 * "…Côtes de Bordeaux" names mid-appellation. These tests pin the repaired
 * rules: 3+ parts = trust producer+name, 2 parts = name only, 1 part = name
 * only — a missing producer is skipped-and-reported downstream, never minted.
 */

jest.mock('../../services/search', () => ({ fullSync: jest.fn(), indexWine: jest.fn() }));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));

const { mapRow } = require('./import');

const lwinRow = (over = {}) => ({
  LWIN: '1234567',
  STATUS: 'Live',
  DISPLAY_NAME: 'NA',
  PRODUCER_TITLE: 'NA',
  PRODUCER_NAME: 'NA',
  WINE: 'NA',
  COUNTRY: 'France',
  REGION: 'Bordeaux',
  SUB_REGION: 'NA',
  COLOUR: 'Red',
  TYPE: 'Wine',
  SUB_TYPE: 'Still',
  CLASSIFICATION: 'NA',
  ...over,
});

describe('mapRow (lwin) — explicit PRODUCER_NAME/WINE columns win', () => {
  test('uses the explicit columns when present', () => {
    const m = mapRow(lwinRow({ PRODUCER_NAME: 'G.D. Vajra', WINE: 'Albe' }), 'lwin');
    expect(m.producer).toBe('G.D. Vajra');
    expect(m.name).toBe('Albe');
  });
});

describe('mapRow (lwin) — DISPLAY_NAME fallback', () => {
  test('3+ parts follow the documented format: producer, subregion, name', () => {
    const m = mapRow(lwinRow({ DISPLAY_NAME: 'G.D. Vajra, Barolo, Albe' }), 'lwin');
    expect(m.producer).toBe('G.D. Vajra');
    expect(m.name).toBe('Albe');
  });

  test('2 parts NEVER fill the producer — "Bordeaux, Château Margaux" was the RC-2 corruption', () => {
    const m = mapRow(lwinRow({ DISPLAY_NAME: 'Bordeaux, Château Margaux' }), 'lwin');
    expect(m.producer).toBeNull();          // skipped-and-reported downstream
    expect(m.name).toBe('Château Margaux'); // the name half is safe
  });

  test('1 part fills the name only, never the producer', () => {
    const m = mapRow(lwinRow({ DISPLAY_NAME: 'Château Margaux' }), 'lwin');
    expect(m.producer).toBeNull();
    expect(m.name).toBe('Château Margaux');
  });

  test('an explicit producer survives alongside a 2-part display (only the missing field falls back)', () => {
    const m = mapRow(lwinRow({ PRODUCER_NAME: 'Château Margaux', DISPLAY_NAME: 'Bordeaux, Pavillon Rouge' }), 'lwin');
    expect(m.producer).toBe('Château Margaux');
    expect(m.name).toBe('Pavillon Rouge');
  });
});

describe('mapRow (lwin) — appellation tier strip', () => {
  test('SUB_REGION is canonicalized like every other write path (audit RC-4)', () => {
    expect(mapRow(lwinRow({ SUB_REGION: 'Barolo DOCG' }), 'lwin').appellation).toBe('Barolo');
    expect(mapRow(lwinRow({ SUB_REGION: 'DO Alicante' }), 'lwin').appellation).toBe('Alicante');
    expect(mapRow(lwinRow({ SUB_REGION: 'NA' }), 'lwin').appellation).toBeNull();
  });
});
