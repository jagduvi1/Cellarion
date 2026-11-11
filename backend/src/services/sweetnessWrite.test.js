/**
 * Label sweetness — the write rule (services/sweetnessWrite).
 *
 * WHY THIS TEST EXISTS:
 * The rule rewrites wine NAMES, and a wrong cut is a wrong wine for every
 * member who holds it. So the reading is pinned word by word against the real
 * seed table: the word leaves only as a word of its own (never out of
 * "Prosecco"), the English "dry" / "sweet" never leave (Dry Creek), a
 * still-wine word only from the end of the name ("Dolce Vita" stays), two
 * terms leave nothing, a curator's keep flag leaves everything, and casing, ß,
 * accents, hyphens and listed spellings fold the way the table folds them.
 * The write rule is pinned on its three outcomes — written, refused (strict),
 * dropped with a marker (lenient) — on the contradictions it must never write
 * through (the name says otherwise; a Prädikat that is sweet by law), and on
 * the switch: off, no name is ever read for a term or changed.
 */
const constants = require('../config/constants');
const ops = require('./sweetnessOps');
const { extractLoaded, extractFromName, assignSweetness } = require('./sweetnessWrite');
const seed = require('../data/sweetness-terms.json');

const hex = (n) => n.toString(16).padStart(24, '0');
const PT = 'c'.repeat(23) + '1';
const ROWS = [
  ...seed.map((r, i) => ({ _id: hex(i + 1), country: null, ...r })),
  // A national row beside the country-less one for the same word and scale.
  { _id: hex(900), name: 'seco', scale: 'still', band: 'dry', country: PT, synonyms: [] },
];
const row = (name, scale) => ROWS.find((r) => r.name === name && r.scale === scale && !r.country);

let terms;
beforeEach(async () => {
  ops.primeSweetnessCache(ROWS);
  terms = await ops.loadTerms();
});
afterEach(() => {
  ops.primeSweetnessCache(null);
  constants.SWEETNESS_EXTRACT_FROM_NAME = false;
});

const read = (name, opts) => extractLoaded(terms, name, opts);
const still = { scale: 'still' };
const sparkling = { scale: 'sparkling' };

describe('extractFromName — the word a name states as a word of its own', () => {
  test('the tail of a still wine', () => {
    const r = read('Riesling Kabinett trocken', still);
    expect(r).toMatchObject({ name: 'Riesling Kabinett', ambiguous: null });
    expect(r.term).toMatchObject({ name: 'trocken', band: 'dry' });
  });

  test('the comma and bracket forms leave no dangling separator', () => {
    expect(read('Riesling, trocken', still).name).toBe('Riesling');
    expect(read('Riesling - trocken', still).name).toBe('Riesling');
    expect(read('Riesling (trocken)', still).name).toBe('Riesling');
    expect(read('Riesling (Alte Reben, trocken)', still).name).toBe('Riesling (Alte Reben)');
  });

  test('a sparkling dosage word leaves from anywhere in the name', () => {
    expect(read('Brut Rosé', sparkling)).toMatchObject({ name: 'Rosé', term: { name: 'Brut' } });
    expect(read('Cuvée Brut Rosé', sparkling)).toMatchObject({ name: 'Cuvée Rosé', term: { name: 'Brut' } });
    expect(read('Cuvée, Brut, Rosé', sparkling).name).toBe('Cuvée, Rosé');
    expect(read('Champagne Extra-Brut', sparkling)).toMatchObject({ name: 'Champagne', term: { name: 'Extra Brut' } });
  });

  test('the longest spelling wins: Brut Nature is not Brut', () => {
    expect(read('Champagne Brut Nature', sparkling)).toMatchObject({ name: 'Champagne', term: { name: 'Brut Nature' } });
  });

  test('the same word on two scales: trocken is dry on a still wine and sec on a Sekt', () => {
    expect(read('Riesling Sekt Trocken', sparkling).term).toMatchObject({ name: 'Trocken', scale: 'sparkling', band: 'sec' });
    expect(read('Riesling trocken', still).term).toMatchObject({ name: 'trocken', scale: 'still', band: 'dry' });
  });

  test('a still-wine word that is not the last word is not read ("Dolce Vita")', () => {
    const r = read('Dolce Vita', still);
    expect(r).toMatchObject({ name: 'Dolce Vita', term: null, ambiguous: { reason: 'name_ambiguous', kind: 'not_at_end' } });
    expect(read('Riesling trocken Alte Reben', still).ambiguous.kind).toBe('not_at_end');
  });

  test('a term inside a longer word is never read (Prosecco) — reported, not removed', () => {
    const r = read('Prosecco Superiore', sparkling);
    expect(r).toMatchObject({ name: 'Prosecco Superiore', term: null, ambiguous: { kind: 'inside_word' } });
    expect(r.ambiguous.detail).toMatch(/"Secco" sits inside the word "Prosecco"/);
    expect(read('Prosecco Extra Dry', sparkling)).toMatchObject({ name: 'Prosecco', term: { name: 'Extra Dry' }, ambiguous: null });
  });

  test('a Prädikat is a word of its own: Trockenbeerenauslese is no glued "trocken"', () => {
    expect(read('Riesling Trockenbeerenauslese', still)).toEqual({ name: 'Riesling Trockenbeerenauslese', term: null, ambiguous: null });
  });

  test('the English dry / sweet never leave a name (Dry Creek); beside a real term they are name words', () => {
    expect(read('Dry Creek Valley Zinfandel', still)).toMatchObject({ name: 'Dry Creek Valley Zinfandel', term: null, ambiguous: { kind: 'english_word' } });
    expect(read('Sweet Cheeks Pinot Noir', still).ambiguous.kind).toBe('english_word');
    expect(read('Dry Creek Riesling trocken', still)).toMatchObject({ name: 'Dry Creek Riesling', term: { name: 'trocken' } });
  });

  test('Brut Premier: read and cut without the keep flag; untouched and unread with it', () => {
    expect(read('Brut Premier', sparkling)).toMatchObject({ name: 'Premier', term: { name: 'Brut' } });
    expect(read('Brut Premier', { ...sparkling, keep: true })).toEqual({ name: 'Brut Premier', term: null, ambiguous: null });
  });

  test('casing, ß and the capital ẞ fold the way the table folds them', () => {
    expect(read('RIESLING SÜẞ', still)).toMatchObject({ name: 'RIESLING', term: { name: 'süß' } });
    expect(read('Riesling Süss', still).term).toMatchObject({ name: 'süß' });
    expect(read('Riesling TROCKEN', still)).toMatchObject({ name: 'Riesling', term: { name: 'trocken' } });
  });

  test('pas dosé and the listed spellings resolve to their rows', () => {
    expect(read('Blanc de Blancs pas dosé', sparkling)).toMatchObject({ name: 'Blanc de Blancs', term: { name: 'Pas Dosé', band: 'brut-nature' } });
    expect(read('Franciacorta Dosaggio Zero', sparkling)).toMatchObject({ name: 'Franciacorta', term: { name: 'Dosage Zéro' } });
    expect(read('Cava Brut Natur', sparkling)).toMatchObject({ name: 'Cava', term: { name: 'Brut Nature' } });
  });

  test('two different terms: nothing is read, nothing removed', () => {
    const r = read('Champagne Brut Demi-Sec', sparkling);
    expect(r).toMatchObject({ name: 'Champagne Brut Demi-Sec', term: null, ambiguous: { kind: 'two_terms' } });
  });

  test('a name that is only the word stays the name; the term is still read', () => {
    expect(read('Brut', sparkling)).toMatchObject({ name: 'Brut', term: { name: 'Brut' } });
  });

  test('fortified (no scale), an empty name and an empty table read nothing; no type is ambiguous', () => {
    expect(read('Fino Seco', { scale: false })).toEqual({ name: 'Fino Seco', term: null, ambiguous: null });
    expect(read('', still)).toEqual({ name: '', term: null, ambiguous: null });
    expect(read('Riesling trocken', { scale: null })).toMatchObject({ term: null, ambiguous: { kind: 'no_scale' } });
    ops.primeSweetnessCache(null);
    return extractFromName('Riesling trocken', still).then((r) => expect(r).toEqual({ name: 'Riesling trocken', term: null, ambiguous: null }));
  });

  test('a word of the wine\'s country wins over the country-less row', () => {
    expect(read('Douro seco', { ...still, countryId: PT }).term._id).toBe(hex(900));
    expect(read('Douro seco', still).term._id).toBe(row('seco', 'still')._id);
  });
});

describe('assignSweetness — an explicit term', () => {
  test('resolved on the wine\'s scale and written; the same term again changes nothing', async () => {
    const wine = { name: 'Riesling Sekt', type: 'sparkling' };
    const r = await assignSweetness(wine, { labelSweetness: 'trocken' });
    expect(r).toMatchObject({ ok: true, changed: true, name: null, dropped: [], review: null });
    expect(wine.labelSweetness).toBe(row('Trocken', 'sparkling')._id);
    expect((await assignSweetness(wine, { labelSweetness: 'Trocken' })).changed).toBe(false);
  });

  test('the wine\'s country picks its own row', async () => {
    const pt = { name: 'Douro Branco', type: 'white', country: PT };
    await assignSweetness(pt, { labelSweetness: 'seco' });
    expect(pt.labelSweetness).toBe(hex(900));
    const other = { name: 'Rioja Blanco', type: 'white' };
    await assignSweetness(other, { labelSweetness: 'seco' });
    expect(other.labelSweetness).toBe(row('seco', 'still')._id);
  });

  test('strict: an unknown word is refused with the known terms of the wine\'s scale; nothing is written', async () => {
    const wine = { name: 'Riesling', type: 'white', labelSweetness: null };
    const r = await assignSweetness(wine, { labelSweetness: 'knochentrocken', strict: true });
    expect(r).toMatchObject({ ok: false, code: 'invalid_input', reason: 'unknown_term', unresolved: ['knochentrocken'] });
    expect(r.message).toMatch(/"knochentrocken" is not a label sweetness term for a still wine/);
    expect(r.message).toMatch(/halbtrocken/);
    expect(r.message).not.toMatch(/Brut/);
    expect(wine).toEqual({ name: 'Riesling', type: 'white', labelSweetness: null });
  });

  test('lenient: an unknown word is dropped and the wine marked unknown_term; the stored term stays', async () => {
    const wine = { name: 'Riesling', type: 'white', labelSweetness: row('trocken', 'still')._id };
    const r = await assignSweetness(wine, { labelSweetness: 'knochentrocken' });
    expect(r).toMatchObject({ ok: true, changed: false, dropped: ['knochentrocken'], review: { reason: 'unknown_term' } });
    expect(wine.labelSweetness).toBe(row('trocken', 'still')._id);
    expect(wine.sweetnessReview.since).toBeInstanceOf(Date);
  });

  test('a term of the other scale: strict refuses type_mismatch, lenient drops and marks it', async () => {
    const strict = await assignSweetness({ name: 'Chardonnay', type: 'white' }, { labelSweetness: 'Brut Nature', strict: true });
    expect(strict).toMatchObject({ ok: false, reason: 'type_mismatch' });
    expect(strict.message).toMatch(/a term for a sparkling wine, and this is a still wine/);
    const wine = { name: 'Chardonnay', type: 'white' };
    expect(await assignSweetness(wine, { labelSweetness: 'Brut Nature' })).toMatchObject({ ok: true, review: { reason: 'type_mismatch' } });
    expect(wine.labelSweetness).toBeUndefined();
  });

  test('fortified: refused on strict, dropped (no marker) on lenient', async () => {
    const strict = await assignSweetness({ name: 'Fino', type: 'fortified' }, { labelSweetness: 'seco', strict: true });
    expect(strict).toMatchObject({ ok: false, reason: 'no_scale' });
    expect(strict.message).toMatch(/Fortified wines have no label sweetness yet/);
    const wine = { name: 'Fino', type: 'fortified' };
    expect(await assignSweetness(wine, { labelSweetness: 'seco' })).toMatchObject({ ok: true, changed: false, dropped: ['seco'], review: null });
    expect(wine).toEqual({ name: 'Fino', type: 'fortified' });
  });

  test('a term that disagrees with the word in the name: name untouched, term not written, marked term_contradiction', async () => {
    const wine = { name: 'Riesling Kabinett trocken', type: 'white', labelSweetness: null };
    const r = await assignSweetness(wine, { labelSweetness: 'halbtrocken', strict: true });
    expect(r).toMatchObject({ ok: true, changed: false, term: null, review: { reason: 'term_contradiction' } });
    expect(r.review.detail).toMatch(/the name states "trocken", the term given is "halbtrocken"/);
    expect(wine).toMatchObject({ name: 'Riesling Kabinett trocken', labelSweetness: null });
  });

  test('the keep flag: the word in the name IS the name, so it does not contradict a term', async () => {
    const wine = { name: 'Brut Premier', type: 'sparkling', sweetnessInName: true };
    expect(await assignSweetness(wine, { labelSweetness: 'Extra Brut' })).toMatchObject({ changed: true, review: null });
    expect(wine.name).toBe('Brut Premier');
  });

  test('a dry-side term on a Prädikat that is sweet by law is held: TBA + trocken', async () => {
    const tba = { name: 'Riesling Trockenbeerenauslese', type: 'white' };
    const r = await assignSweetness(tba, { labelSweetness: 'trocken' });
    expect(r).toMatchObject({ ok: true, changed: false, review: { reason: 'term_contradiction' } });
    expect(r.review.detail).toMatch(/trockenbeerenauslese is sweet by law, but the term "trocken" is dry/);
    expect(tba.labelSweetness).toBeUndefined();
    // The tier on a classification row, or in the classification string, counts too.
    const byRow = { name: 'Riesling', type: 'white', classifications: [{ name: 'Beerenauslese', kind: 'ripeness' }] };
    expect((await assignSweetness(byRow, { labelSweetness: 'feinherb' })).review.reason).toBe('term_contradiction');
    const byString = { name: 'Riesling', type: 'white', classification: 'Eiswein' };
    expect((await assignSweetness(byString, { labelSweetness: 'halbtrocken' })).review.reason).toBe('term_contradiction');
    // A sweet term on a sweet tier is what the label says, and an Auslese may be trocken.
    expect((await assignSweetness({ name: 'Riesling Trockenbeerenauslese', type: 'dessert' }, { labelSweetness: 'edelsüß' })).changed).toBe(true);
    expect((await assignSweetness({ name: 'Riesling Auslese', type: 'white' }, { labelSweetness: 'trocken' })).changed).toBe(true);
  });

  test('null or an empty word clears; undefined leaves the field alone', async () => {
    const wine = { name: 'Riesling', type: 'white', labelSweetness: row('trocken', 'still')._id };
    expect((await assignSweetness(wine, {})).changed).toBe(false);
    expect(wine.labelSweetness).toBe(row('trocken', 'still')._id);
    expect((await assignSweetness(wine, { labelSweetness: null })).changed).toBe(true);
    expect(wine.labelSweetness).toBeNull();
    expect((await assignSweetness(wine, { labelSweetness: '' })).changed).toBe(false);
  });

  test('a term row id is accepted, on its own scale only', async () => {
    const wine = { name: 'Riesling', type: 'white' };
    await assignSweetness(wine, { labelSweetness: row('feinherb', 'still')._id });
    expect(wine.labelSweetness).toBe(row('feinherb', 'still')._id);
    expect(await assignSweetness({ name: 'Riesling', type: 'white' }, { labelSweetness: row('Brut', 'sparkling')._id, strict: true }))
      .toMatchObject({ ok: false, reason: 'type_mismatch' });
  });

  test('without a term table (no connection, no seed) nothing resolves and nothing is marked', async () => {
    ops.primeSweetnessCache(null);
    const wine = { name: 'Riesling', type: 'white' };
    expect(await assignSweetness(wine, { labelSweetness: 'trocken', strict: true })).toMatchObject({ ok: true, changed: false, dropped: ['trocken'], review: null });
    expect(wine).toEqual({ name: 'Riesling', type: 'white' });
  });

  test('a marker for the same reason keeps its first `since`', async () => {
    const since = new Date('2020-01-01T00:00:00Z');
    const wine = { name: 'Riesling', type: 'white', sweetnessReview: { reason: 'unknown_term', detail: 'x', since } };
    await assignSweetness(wine, { labelSweetness: 'knochentrocken' });
    expect(wine.sweetnessReview.since).toBe(since);
  });
});

describe('assignSweetness — the extract switch', () => {
  test('the switch is off by default', () => {
    expect(constants.SWEETNESS_EXTRACT_FROM_NAME).toBe(false);
  });

  test('off: an explicit term is written and the name keeps its word; no term is ever read off a name', async () => {
    const wine = { name: 'Riesling Kabinett trocken', type: 'white' };
    const r = await assignSweetness(wine, { labelSweetness: 'trocken' });
    expect(r).toMatchObject({ changed: true, name: null });
    expect(wine.name).toBe('Riesling Kabinett trocken');
    expect(ops.wineDisplayName({ name: wine.name, labelSweetness: row('trocken', 'still') })).toBe('Riesling Kabinett trocken');

    const named = { name: 'Riesling Kabinett trocken', type: 'white' };
    expect(await assignSweetness(named, { name: 'Riesling Kabinett trocken', type: 'white' }))
      .toMatchObject({ changed: false, term: null, review: null, ambiguous: null });
    expect(named).toEqual({ name: 'Riesling Kabinett trocken', type: 'white' });
  });

  test('on: an explicit term that the name carries leaves the name', async () => {
    constants.SWEETNESS_EXTRACT_FROM_NAME = true;
    const wine = { name: 'Riesling Kabinett trocken', type: 'white' };
    const r = await assignSweetness(wine, { labelSweetness: 'trocken' });
    expect(r).toMatchObject({ changed: true, name: 'Riesling Kabinett' });
    expect(wine).toMatchObject({ name: 'Riesling Kabinett', labelSweetness: row('trocken', 'still')._id });
  });

  test('on: a name being written gives up its word to the field', async () => {
    constants.SWEETNESS_EXTRACT_FROM_NAME = true;
    const wine = {};
    const r = await assignSweetness(wine, { name: 'Cuvée Brut Rosé', type: 'sparkling' });
    expect(r).toMatchObject({ changed: true, name: 'Cuvée Rosé', term: { name: 'Brut' } });
    expect(wine).toEqual({ name: 'Cuvée Rosé', labelSweetness: row('Brut', 'sparkling')._id });
  });

  test('on: a write that sets neither the name nor the type reads nothing', async () => {
    constants.SWEETNESS_EXTRACT_FROM_NAME = true;
    const wine = { name: 'Riesling Kabinett trocken', type: 'white' };
    expect((await assignSweetness(wine, {})).changed).toBe(false);
    expect(wine).toEqual({ name: 'Riesling Kabinett trocken', type: 'white' });
  });

  test('on: the keep flag keeps the word and reads no term', async () => {
    constants.SWEETNESS_EXTRACT_FROM_NAME = true;
    const wine = { name: 'Brut Premier', type: 'sparkling', sweetnessInName: true };
    expect(await assignSweetness(wine, { name: 'Brut Premier' })).toMatchObject({ changed: false, term: null, review: null });
    expect(wine.name).toBe('Brut Premier');
  });

  test('on: an ambiguous name is marked name_ambiguous; a term inside a word is only reported', async () => {
    constants.SWEETNESS_EXTRACT_FROM_NAME = true;
    const creek = { name: 'Dry Creek Valley Zinfandel', type: 'red' };
    const r = await assignSweetness(creek, { name: creek.name });
    expect(r).toMatchObject({ changed: false, review: { reason: 'name_ambiguous' }, ambiguous: { kind: 'english_word' } });
    expect(creek.name).toBe('Dry Creek Valley Zinfandel');

    const prosecco = { name: 'Prosecco Superiore', type: 'sparkling' };
    const p = await assignSweetness(prosecco, { name: prosecco.name });
    expect(p).toMatchObject({ changed: false, review: null, ambiguous: { kind: 'inside_word' } });
    expect(prosecco.sweetnessReview).toBeUndefined();
  });

  test('on: a name word that differs from the stored term, or contradicts the Prädikat, moves nothing', async () => {
    constants.SWEETNESS_EXTRACT_FROM_NAME = true;
    const wine = { name: 'Riesling halbtrocken', type: 'white', labelSweetness: row('trocken', 'still')._id };
    const r = await assignSweetness(wine, { name: wine.name });
    expect(r).toMatchObject({ changed: false, review: { reason: 'term_contradiction' } });
    expect(r.review.detail).toMatch(/the name states "halbtrocken", the record states "trocken"/);
    expect(wine.name).toBe('Riesling halbtrocken');

    const tba = { name: 'Riesling Trockenbeerenauslese trocken', type: 'white' };
    expect((await assignSweetness(tba, { name: tba.name })).review.reason).toBe('term_contradiction');
    expect(tba.name).toBe('Riesling Trockenbeerenauslese trocken');
  });

  test('on: a fortified wine is never read', async () => {
    constants.SWEETNESS_EXTRACT_FROM_NAME = true;
    const wine = { name: 'Fino Seco', type: 'fortified' };
    expect(await assignSweetness(wine, { name: wine.name })).toMatchObject({ changed: false, review: null });
    expect(wine).toEqual({ name: 'Fino Seco', type: 'fortified' });
  });
});
