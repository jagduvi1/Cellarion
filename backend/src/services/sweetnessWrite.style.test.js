/**
 * The sweetness style write rule (services/sweetnessWrite assignSweetnessStyle).
 *
 * WHY THIS TEST EXISTS:
 * sweetnessStyle is the term a wine is KNOWN by when its label prints none,
 * named by the producer or the trade. It is never stored without the page
 * that names it; a term with a legal definition never comes from a merchant;
 * the label's own term always wins; and two contributors who disagree cannot
 * flip a wine back and forth: an overwrite by an equal or weaker source is not
 * applied, it comes back as "needs review". A dry-side style on a Prädikat
 * that is sweet by law is held, as a label term is. Pinned against the real
 * seed table, without a database.
 */
const ops = require('./sweetnessOps');
const { assignSweetnessStyle, STYLE_SOURCE_RANK } = require('./sweetnessWrite');
const WineDefinition = require('../models/WineDefinition');
const seed = require('../data/sweetness-terms.json');

const hex = (n) => n.toString(16).padStart(24, '0');
const ROWS = seed.map((r, i) => ({ _id: hex(i + 1), country: null, ...r }));
const id = (name, scale = 'still') => ROWS.find((r) => r.name === name && r.scale === scale)._id;
const TRADE_URL = 'https://merchant.example/riesling-kabinett';
const PRODUCER_URL = 'https://weingut-beispiel.example/weine/kabinett';

beforeEach(() => ops.primeSweetnessCache(ROWS));
afterEach(() => ops.primeSweetnessCache(null));

const wine = (over = {}) => ({ name: 'Riesling Kabinett', producer: 'Weingut Beispiel', type: 'white', labelSweetness: null, sweetnessStyle: null, ...over });
const style = (name, source, url, scale = 'still') => ({ term: id(name, scale), source, url });

describe('filling a blank style', () => {
  test('a customary term from the trade, with its page, applies at once', async () => {
    const w = wine();
    const r = await assignSweetnessStyle(w, { term: 'feinherb', source: 'trade', url: TRADE_URL });
    expect(r).toMatchObject({ ok: true, changed: true, verdict: 'applied', reason: null, review: null });
    expect(w.sweetnessStyle).toEqual(style('feinherb', 'trade', TRADE_URL));
    expect(r.style).toBe(w.sweetnessStyle);
  });

  test('a regulated term from the producer applies; resolved on the wine\'s scale', async () => {
    const sekt = wine({ name: 'Riesling Sekt', type: 'sparkling' });
    expect((await assignSweetnessStyle(sekt, { term: 'trocken', source: 'Producer', url: PRODUCER_URL })).verdict).toBe('applied');
    expect(sekt.sweetnessStyle).toEqual(style('Trocken', 'producer', PRODUCER_URL, 'sparkling'));
  });
});

describe('what is never stored', () => {
  test('a regulated term from the trade: refused when strict, dropped when lenient — nothing written, nothing marked', async () => {
    const w = wine();
    const strict = await assignSweetnessStyle(w, { term: 'halbtrocken', source: 'trade', url: TRADE_URL, strict: true });
    expect(strict).toMatchObject({ ok: false, code: 'invalid_input', reason: 'regulated_needs_producer' });
    expect(strict.message).toMatch(/only the producer names it/);
    const lenient = await assignSweetnessStyle(w, { term: 'halbtrocken', source: 'trade', url: TRADE_URL });
    expect(lenient).toMatchObject({ ok: true, changed: false, verdict: 'dropped', reason: 'regulated_needs_producer', review: null });
    expect(w).toEqual(wine());
  });

  test('no link, a link that is not http(s), a link over the limit, an unknown source', async () => {
    const cases = [
      [{ url: '' }, 'url_required'],
      [{ url: undefined }, 'url_required'],
      [{ url: 'javascript:alert(1)' }, 'bad_url'],
      [{ url: 'ftp://merchant.example/x' }, 'bad_url'],
      [{ url: `https://merchant.example/${'x'.repeat(500)}` }, 'bad_url'],
      [{ source: 'critic' }, 'bad_source'],
      [{ source: undefined }, 'bad_source'],
    ];
    for (const [over, reason] of cases) {
      const w = wine();
      const input = { term: 'feinherb', source: 'trade', url: TRADE_URL, ...over };
      expect(await assignSweetnessStyle(w, { ...input, strict: true })).toMatchObject({ ok: false, reason });
      expect(await assignSweetnessStyle(w, input)).toMatchObject({ ok: true, verdict: 'dropped', reason });
      expect(w.sweetnessStyle).toBeNull();
    }
  });

  test('an unknown word: refused with the known terms of the wine\'s scale; a term of the other scale: type_mismatch', async () => {
    const r = await assignSweetnessStyle(wine(), { term: 'restsüß', source: 'trade', url: TRADE_URL, strict: true });
    expect(r).toMatchObject({ ok: false, reason: 'unknown_term' });
    expect(r.message).toMatch(/feinherb/);
    expect(r.message).not.toMatch(/Brut/);
    expect(await assignSweetnessStyle(wine(), { term: 'Brut', source: 'producer', url: PRODUCER_URL, strict: true }))
      .toMatchObject({ ok: false, reason: 'type_mismatch' });
    const lenient = wine();
    expect(await assignSweetnessStyle(lenient, { term: 'restsüß', source: 'trade', url: TRADE_URL })).toMatchObject({ verdict: 'dropped', reason: 'unknown_term', review: null });
    expect(lenient.sweetnessReview).toBeUndefined();
  });

  test('a fortified wine has no style yet', async () => {
    expect(await assignSweetnessStyle(wine({ type: 'fortified' }), { term: 'dulce', source: 'producer', url: PRODUCER_URL, strict: true }))
      .toMatchObject({ ok: false, reason: 'no_scale' });
    expect(await assignSweetnessStyle(wine({ type: 'fortified' }), { term: 'dulce', source: 'producer', url: PRODUCER_URL }))
      .toMatchObject({ verdict: 'dropped', reason: 'no_scale' });
  });

  test('without a term table nothing resolves', async () => {
    ops.primeSweetnessCache(null);
    const w = wine();
    expect(await assignSweetnessStyle(w, { term: 'feinherb', source: 'trade', url: TRADE_URL, strict: true })).toMatchObject({ ok: true, verdict: 'dropped', reason: 'no_table' });
    expect(w.sweetnessStyle).toBeNull();
  });
});

describe('the label wins', () => {
  test('the label\'s own term makes the style redundant: it is cleared', async () => {
    const w = wine({ labelSweetness: id('feinherb'), sweetnessStyle: style('feinherb', 'trade', TRADE_URL) });
    const r = await assignSweetnessStyle(w, { term: 'feinherb', source: 'producer', url: PRODUCER_URL });
    expect(r).toMatchObject({ ok: true, changed: true, verdict: 'redundant', style: null });
    expect(w.sweetnessStyle).toBeNull();
    // A populated label row read without its id (the API shape) is the same term too.
    const populated = wine({ labelSweetness: { name: 'feinherb', band: 'off-dry', scale: 'still', regulated: false } });
    expect((await assignSweetnessStyle(populated, { term: 'feinherb', source: 'trade', url: TRADE_URL })).verdict).toBe('redundant');
  });

  test('a different term: nothing overwritten, marked term_contradiction', async () => {
    const w = wine({ labelSweetness: id('halbtrocken') });
    const r = await assignSweetnessStyle(w, { term: 'feinherb', source: 'trade', url: TRADE_URL, strict: true });
    expect(r).toMatchObject({ ok: true, changed: false, verdict: 'held', reason: 'term_contradiction', review: { reason: 'term_contradiction' } });
    expect(r.review.detail).toMatch(/the label states "halbtrocken", the style named is "feinherb"/);
    expect(w.sweetnessStyle).toBeNull();
    expect(w.labelSweetness).toBe(id('halbtrocken'));
  });

  test('a label term this server cannot name holds the style back', async () => {
    const w = wine({ labelSweetness: 'f'.repeat(24) });
    expect((await assignSweetnessStyle(w, { term: 'feinherb', source: 'trade', url: TRADE_URL })).verdict).toBe('held');
    expect(w.sweetnessStyle).toBeNull();
  });

  test('a dry-side style on a Prädikat that is sweet by law is held; a sweet one is written', async () => {
    const tba = wine({ name: 'Riesling Trockenbeerenauslese' });
    const r = await assignSweetnessStyle(tba, { term: 'feinherb', source: 'trade', url: TRADE_URL });
    expect(r).toMatchObject({ verdict: 'held', review: { reason: 'term_contradiction' } });
    expect(r.review.detail).toMatch(/trockenbeerenauslese is sweet by law/);
    expect(tba.sweetnessStyle).toBeNull();
    const sweet = wine({ name: 'Riesling Trockenbeerenauslese', type: 'dessert' });
    expect((await assignSweetnessStyle(sweet, { term: 'edelsüß', source: 'trade', url: TRADE_URL })).verdict).toBe('applied');
  });
});

describe('a stored style yields only to a stronger source', () => {
  test('producer beats trade: a different term from the producer replaces the trade\'s', async () => {
    const w = wine({ sweetnessStyle: style('feinherb', 'trade', TRADE_URL) });
    expect(await assignSweetnessStyle(w, { term: 'fruchtsüß', source: 'producer', url: PRODUCER_URL })).toMatchObject({ verdict: 'applied', changed: true });
    expect(w.sweetnessStyle).toEqual(style('fruchtsüß', 'producer', PRODUCER_URL));
  });

  test('the same term from the producer upgrades the source and its link', async () => {
    const w = wine({ sweetnessStyle: style('feinherb', 'trade', TRADE_URL) });
    expect((await assignSweetnessStyle(w, { term: 'feinherb', source: 'producer', url: PRODUCER_URL })).verdict).toBe('applied');
    expect(w.sweetnessStyle).toEqual(style('feinherb', 'producer', PRODUCER_URL));
  });

  test('an equal or weaker source with a different term is NOT written: needs review', async () => {
    const trade = wine({ sweetnessStyle: style('feinherb', 'trade', TRADE_URL) });
    expect(await assignSweetnessStyle(trade, { term: 'fruchtsüß', source: 'trade', url: 'https://other-merchant.example/x' }))
      .toMatchObject({ ok: true, changed: false, verdict: 'needs_review', reason: 'equal_source', review: null });
    expect(trade.sweetnessStyle).toEqual(style('feinherb', 'trade', TRADE_URL));
    const producer = wine({ sweetnessStyle: style('feinherb', 'producer', PRODUCER_URL) });
    expect(await assignSweetnessStyle(producer, { term: 'fruchtsüß', source: 'trade', url: TRADE_URL }))
      .toMatchObject({ changed: false, verdict: 'needs_review', reason: 'weaker_source' });
    expect(producer.sweetnessStyle).toEqual(style('feinherb', 'producer', PRODUCER_URL));
  });

  test('the same term from an equal or weaker source changes nothing, not even the link', async () => {
    const w = wine({ sweetnessStyle: style('feinherb', 'producer', PRODUCER_URL) });
    expect(await assignSweetnessStyle(w, { term: 'Feinherb', source: 'trade', url: TRADE_URL })).toMatchObject({ verdict: 'unchanged', changed: false });
    expect(await assignSweetnessStyle(w, { term: 'feinherb', source: 'producer', url: 'https://weingut-beispiel.example/new' })).toMatchObject({ verdict: 'unchanged' });
    expect(w.sweetnessStyle).toEqual(style('feinherb', 'producer', PRODUCER_URL));
  });
});

describe('clearing and leaving alone', () => {
  test('null or an empty term clears; undefined leaves the style as it is', async () => {
    const w = wine({ sweetnessStyle: style('feinherb', 'trade', TRADE_URL) });
    expect(await assignSweetnessStyle(w, {})).toMatchObject({ verdict: 'unchanged', changed: false });
    expect(w.sweetnessStyle).toEqual(style('feinherb', 'trade', TRADE_URL));
    expect(await assignSweetnessStyle(w, { term: null })).toMatchObject({ verdict: 'cleared', changed: true, style: null });
    expect(await assignSweetnessStyle(w, { term: '' })).toMatchObject({ verdict: 'cleared', changed: false });
  });
});

test('the ranked sources are the model\'s', () => {
  expect(Object.keys(STYLE_SOURCE_RANK).sort()).toEqual([...WineDefinition.SWEETNESS_STYLE_SOURCES].sort());
});
