/**
 * The classification migration's planning step: legacy strings map onto
 * taxonomy rows or are left alone and listed; ride-along words are dropped;
 * the wine's country picks between systems sharing a word; names fill rows
 * that have no classification, only where the word is a tier in that country.
 */
jest.mock('../models/WineDefinition', () => ({ find: jest.fn(), updateOne: jest.fn() }));
jest.mock('../models/Classification', () => ({ find: jest.fn() }));
jest.mock('../models/Country', () => ({ find: jest.fn() }));
jest.mock('../models/Region', () => ({}));
jest.mock('../services/enrichmentJob', () => ({ profileInputsSnapshot: jest.fn(() => 'snap') }));
jest.mock('./lib/backupLog', () => ({ createBackupLog: jest.fn() }));

const { planWine, buildIndex } = require('./migrate-classification-taxonomy');

const ROWS = [
  { _id: 'r1', name: 'Spätlese', kind: 'ripeness', country: null, synonyms: ['Spatlese'] },
  { _id: 'r2', name: 'VDP Grosse Lage', kind: 'vineyard_rank', country: 'Germany', synonyms: ['VDP.Grosse Lage', 'Grosse Lage'] },
  { _id: 'r3', name: 'Riserva', kind: 'ageing', country: 'Italy', synonyms: [] },
  { _id: 'r4', name: 'Gran Reserva', kind: 'ageing', country: 'Spain', synonyms: [] },
  { _id: 'r5', name: 'Kabinett', kind: 'ripeness', country: null, synonyms: [] },
  { _id: 'r6', name: 'Grosses Gewächs', kind: 'vineyard_rank', country: 'Germany', synonyms: ['GG'] },
  { _id: 'r7', name: 'VDP Erste Lage', kind: 'vineyard_rank', country: 'Germany', synonyms: ['VDP.Erste Lage', 'Erste Lage'] },
  { _id: 'r8', name: 'ÖTW Erste Lage', kind: 'vineyard_rank', country: 'Austria', synonyms: ['1ÖTW', 'Erste Lage'] },
  { _id: 'r9', name: '20 Years Old', kind: 'ageing', country: 'Portugal', synonyms: ['20 Year Old'] },
  { _id: 'r10', name: 'Tawny Port', kind: 'ageing', country: 'Portugal', synonyms: ['Tawny'] },
];
const lookup = buildIndex(ROWS);

test('a legacy string with two tiers maps to two rows; the canonical spelling replaces the import one', () => {
  const plan = planWine({ name: 'Zeltinger Sonnenuhr', classification: 'Spatlese, VDP.Grosse Lage', country: { name: 'Germany' } }, lookup);
  expect(plan).toMatchObject({ source: 'legacy', names: ['Spätlese', 'VDP Grosse Lage'], unresolved: [] });
  expect(plan.rows.map((r) => r._id)).toEqual(['r1', 'r2']);
});

test('a legacy value no row answers is left alone and reported, even beside a resolvable one', () => {
  const plan = planWine({ name: 'X', classification: 'Riserva, Brut', country: { name: 'Italy' } }, lookup);
  expect(plan).toEqual({ names: [], unresolved: ['Brut'], source: 'legacy' });
});

test('ride-along words are dropped beside a tier, parentheses split, and a value of nothing else is listed', () => {
  expect(planWine({ name: 'A', classification: 'Kabinett trocken', country: { name: 'Germany' } }, lookup)).toMatchObject({ names: ['Kabinett'], unresolved: [] });
  expect(planWine({ name: 'B', classification: 'Prädikatswein - Spätlese', country: { name: 'Germany' } }, lookup)).toMatchObject({ names: ['Spätlese'] });
  expect(planWine({ name: 'C', classification: 'VDP.Grosse Lage (Grosses Gewächs)', country: { name: 'Germany' } }, lookup)).toMatchObject({ names: ['VDP Grosse Lage', 'Grosses Gewächs'] });
  expect(planWine({ name: 'D', classification: 'trocken', country: { name: 'Germany' } }, lookup)).toEqual({ names: [], unresolved: ['trocken'], source: 'legacy' });
  expect(planWine({ name: 'E', classification: 'Deutscher Qualitätswein', country: { name: 'Germany' } }, lookup)).toEqual({ names: [], unresolved: ['Deutscher Qualitätswein'], source: 'legacy' });
});

test('a word that is a tier in two systems resolves to the row of the wine\'s country', () => {
  expect(planWine({ name: 'A', classification: 'Erste Lage', country: { name: 'Austria' } }, lookup)).toMatchObject({ names: ['ÖTW Erste Lage'] });
  expect(planWine({ name: 'B', classification: 'Erste Lage', country: { name: 'Germany' } }, lookup)).toMatchObject({ names: ['VDP Erste Lage'] });
  expect(planWine({ name: 'C', classification: 'Erste Lage (1ÖTW)', country: { name: 'Austria' } }, lookup)).toMatchObject({ names: ['ÖTW Erste Lage'] });
});

test('a wine without a classification is filled from its name only where the word is a tier there', () => {
  expect(planWine({ name: 'Barolo Riserva', classification: null, country: { name: 'Italy' } }, lookup)).toMatchObject({ source: 'name', names: ['Riserva'] });
  expect(planWine({ name: 'Rioja Gran Reserva', classification: '', country: { name: 'Spain' } }, lookup)).toMatchObject({ source: 'name', names: ['Gran Reserva'] });
  expect(planWine({ name: '20 Year Old Tawny', classification: '', country: { name: 'Portugal' }, type: 'fortified' }, lookup)).toMatchObject({ source: 'name', names: ['20 Years Old', 'Tawny Port'] });
  // Chile's "Reserva" is marketing, and Burgundy's Premier Cru belongs to the appellation.
  expect(planWine({ name: 'Reserva Carmenère', classification: null, country: { name: 'Chile' } }, lookup)).toBeNull();
  expect(planWine({ name: 'Meursault Premier Cru Charmes', classification: null, country: { name: 'France' }, region: { name: 'Burgundy' } }, lookup)).toBeNull();
});

test('a wine that already carries taxonomy rows is not touched', () => {
  expect(planWine({ name: 'Barolo Riserva', classification: '', classifications: ['r3'], country: { name: 'Italy' } }, lookup)).toBeNull();
});
