/**
 * The sweetness style write rule (services/sweetnessWrite assignSweetnessStyle).
 *
 * WHY THIS TEST EXISTS:
 * sweetnessStyle is the term a wine is KNOWN by when its label prints none,
 * named by the producer or the trade. It is never stored without the page
 * that names it; a term with a legal definition never comes from a merchant;
 * the label's own term always wins — on the label field or, until the
 * migration, as a word of the name — and on the same band it makes the style
 * redundant; two contributors who disagree cannot flip a wine back and forth
 * (an overwrite by an equal or weaker source comes back as "needs review").
 * The rule and the model must accept exactly the same sources and links, or a
 * value the rule accepts fails the save; "constructor" is no source and
 * "https:merchant.example" no link. Pinned against the real seed table.
 */
const mongoose = require('mongoose');
const ops = require('./sweetnessOps');
const { assignSweetnessStyle, STYLE_SOURCE_RANK } = require('./sweetnessWrite');
const WineDefinition = require('../models/WineDefinition');
const { SWEETNESS_STYLE_SOURCES, STYLE_URL_MAX } = require('../utils/sweetnessStyle');
const { URL_MAX } = require('./proposalFields');
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

  test('the link is stored in its normalised form', async () => {
    const w = wine();
    await assignSweetnessStyle(w, { term: 'feinherb', source: 'trade', url: '  HTTPS://Merchant.Example/a?q="<x>"  ' });
    expect(w.sweetnessStyle.url).toBe('https://merchant.example/a?q=%22%3Cx%3E%22');
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

  test.each([
    [{ url: '' }, 'url_required'],
    [{ url: undefined }, 'url_required'],
    [{ url: ['https://merchant.example/x'] }, 'url_required'],
    [{ url: 'javascript:alert(1)' }, 'bad_url'],
    [{ url: 'ftp://merchant.example/x' }, 'bad_url'],
    [{ url: 'https:merchant.example' }, 'bad_url'],
    [{ url: 'https:/merchant.example' }, 'bad_url'],
    [{ url: 'http:\\\\merchant.example' }, 'bad_url'],
    [{ url: 'ht\ttps://merchant.example/x' }, 'bad_url'],
    [{ url: 'https://merchant.example/x\ny' }, 'bad_url'],
    [{ url: 'https://' }, 'bad_url'],
    [{ url: 'https://login:secret@merchant.example/x' }, 'bad_url'],
    [{ url: 'https://cellarion.app:login@evil.example/x' }, 'bad_url'],
    [{ url: `https://merchant.example/${'x'.repeat(500)}` }, 'bad_url'],
    [{ source: 'critic' }, 'bad_source'],
    [{ source: 'constructor' }, 'bad_source'],
    [{ source: '__proto__' }, 'bad_source'],
    [{ source: undefined }, 'bad_source'],
  ])('%j → %s, strict and lenient alike', async (over, reason) => {
    const w = wine();
    const input = { term: 'feinherb', source: 'trade', url: TRADE_URL, ...over };
    expect(await assignSweetnessStyle(w, { ...input, strict: true })).toMatchObject({ ok: false, reason });
    expect(await assignSweetnessStyle(w, input)).toMatchObject({ ok: true, verdict: 'dropped', reason });
    expect(w.sweetnessStyle).toBeNull();
  });

  test('only a string or an ObjectId is a word', async () => {
    for (const term of [['feinherb'], 5, { toString: null }, { name: 'feinherb' }]) {
      const w = wine();
      expect(await assignSweetnessStyle(w, { term, source: 'trade', url: TRADE_URL, strict: true })).toMatchObject({ ok: false, reason: 'unknown_term' });
      expect(w.sweetnessStyle).toBeNull();
    }
    const byOid = wine();
    await assignSweetnessStyle(byOid, { term: new mongoose.Types.ObjectId(id('feinherb')), source: 'trade', url: TRADE_URL });
    expect(byOid.sweetnessStyle.term).toBe(id('feinherb'));
  });

  test('an unknown word: refused with the known terms of the wine\'s scale, echoed short; a term of the other scale: type_mismatch', async () => {
    const r = await assignSweetnessStyle(wine(), { term: 'restsüß', source: 'trade', url: TRADE_URL, strict: true });
    expect(r).toMatchObject({ ok: false, reason: 'unknown_term' });
    expect(r.message).toMatch(/feinherb/);
    expect(r.message).not.toMatch(/Brut/);
    const long = await assignSweetnessStyle(wine(), { term: 'x'.repeat(5000), source: 'trade', url: TRADE_URL, strict: true });
    expect(long.message.length).toBeLessThan(1500);
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

describe('the rule and the model accept exactly the same values', () => {
  const doc = () => new WineDefinition({ name: 'Riesling Kabinett', producer: 'Weingut Beispiel', type: 'white', country: new mongoose.Types.ObjectId(), createdBy: new mongoose.Types.ObjectId(), normalizedKey: 'weingut beispiel:riesling kabinett:' });
  test.each([
    ['https://merchant.example/x', 'trade'],
    ['https://merchant.example', 'producer'],
    ['https:merchant.example', 'trade'],
    ['http:\\\\merchant.example', 'trade'],
    ['https://login:secret@merchant.example/x', 'trade'],
    ['https://merchant.example/x', 'constructor'],
    ['https://', 'trade'],
  ])('%s from %s: applied and saved, or refused by both', async (url, source) => {
    const target = doc();
    const r = await assignSweetnessStyle(target, { term: 'feinherb', source, url, strict: true });
    if (r.ok) {
      expect(r.verdict).toBe('applied');
      await expect(target.validate()).resolves.toBeUndefined();
    } else {
      // The same value written straight onto the model is refused there too.
      target.sweetnessStyle = { term: id('feinherb'), source, url };
      await expect(target.validate()).rejects.toThrow(/sweetnessStyle/);
    }
  });

  test('the ranked sources are the model\'s; the link limit is the evidence-link limit', () => {
    expect(Object.keys(STYLE_SOURCE_RANK).sort()).toEqual([...SWEETNESS_STYLE_SOURCES].sort());
    expect(WineDefinition.SWEETNESS_STYLE_SOURCES).toEqual(SWEETNESS_STYLE_SOURCES);
    expect(STYLE_URL_MAX).toBe(URL_MAX);
    expect(WineDefinition.schema.path('sweetnessStyle').schema.path('url').options.maxlength).toBe(URL_MAX);
  });
});

describe('the label wins', () => {
  test('the label\'s own term — or another on its band — makes the style redundant: it is cleared', async () => {
    const same = wine({ labelSweetness: id('feinherb'), sweetnessStyle: style('feinherb', 'trade', TRADE_URL) });
    expect(await assignSweetnessStyle(same, { term: 'feinherb', source: 'producer', url: PRODUCER_URL })).toMatchObject({ ok: true, changed: true, verdict: 'redundant', style: null });
    const band = wine({ labelSweetness: id('halbtrocken') });
    expect(await assignSweetnessStyle(band, { term: 'feinherb', source: 'trade', url: TRADE_URL })).toMatchObject({ verdict: 'redundant', review: null });
    expect(band.sweetnessStyle).toBeNull();
    // A populated label row read without its id (the API shape) counts too.
    const populated = wine({ labelSweetness: { name: 'feinherb', band: 'off-dry', scale: 'still', regulated: false } });
    expect((await assignSweetnessStyle(populated, { term: 'feinherb', source: 'trade', url: TRADE_URL })).verdict).toBe('redundant');
  });

  test('another band: lenient holds it with a style_contradiction marker; strict refuses with term_contradiction', async () => {
    const w = wine({ labelSweetness: id('trocken') });
    const r = await assignSweetnessStyle(w, { term: 'feinherb', source: 'trade', url: TRADE_URL });
    expect(r).toMatchObject({ ok: true, changed: false, verdict: 'held', reason: 'style_contradiction', review: { reason: 'style_contradiction' } });
    expect(r.review.detail).toMatch(/the label states "trocken", the style named is "feinherb"/);
    expect(w.sweetnessStyle).toBeNull();
    const s = wine({ labelSweetness: id('trocken') });
    expect(await assignSweetnessStyle(s, { term: 'feinherb', source: 'trade', url: TRADE_URL, strict: true })).toMatchObject({ ok: false, reason: 'term_contradiction' });
    expect(s.sweetnessReview).toBeUndefined();
  });

  test('the word of the label still in the name counts like the label field', async () => {
    const trocken = wine({ name: 'Riesling Kabinett trocken' });
    expect(await assignSweetnessStyle(trocken, { term: 'feinherb', source: 'trade', url: TRADE_URL })).toMatchObject({ verdict: 'held', review: { reason: 'style_contradiction' } });
    expect(trocken.sweetnessStyle).toBeNull();
    const feinherb = wine({ name: 'Riesling Kabinett feinherb', sweetnessStyle: style('feinherb', 'trade', TRADE_URL) });
    expect(await assignSweetnessStyle(feinherb, { term: 'feinherb', source: 'producer', url: PRODUCER_URL })).toMatchObject({ verdict: 'redundant', changed: true });
    expect(feinherb.sweetnessStyle).toBeNull();
    // ...unless the word IS the name (sweetnessInName).
    const kept = wine({ name: 'Riesling Kabinett trocken', sweetnessInName: true });
    expect((await assignSweetnessStyle(kept, { term: 'feinherb', source: 'trade', url: TRADE_URL })).verdict).toBe('applied');
  });

  test('a label term this server cannot name holds the style back', async () => {
    const w = wine({ labelSweetness: 'f'.repeat(24) });
    expect((await assignSweetnessStyle(w, { term: 'feinherb', source: 'trade', url: TRADE_URL })).verdict).toBe('held');
    expect(w.sweetnessStyle).toBeNull();
  });

  test('a dry-side style on a Prädikat that is sweet by law is held; a sweet one is written', async () => {
    const tba = wine({ name: 'Riesling Trockenbeerenauslese' });
    const r = await assignSweetnessStyle(tba, { term: 'feinherb', source: 'trade', url: TRADE_URL });
    expect(r).toMatchObject({ verdict: 'held', review: { reason: 'style_contradiction' } });
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

  test('a style a lean read left in its outgoing shape still ranks: a trade term does not replace a producer\'s', async () => {
    const shaped = { name: 'feinherb', band: 'off-dry', scale: 'still', regulated: false, source: 'producer', sourceUrl: PRODUCER_URL };
    const w = wine({ sweetnessStyle: shaped });
    expect(await assignSweetnessStyle(w, { term: 'fruchtsüß', source: 'trade', url: TRADE_URL })).toMatchObject({ verdict: 'needs_review', reason: 'weaker_source' });
    expect(w.sweetnessStyle).toBe(shaped);
  });

  test('the same term from an equal or weaker source changes nothing, not even the link', async () => {
    const w = wine({ sweetnessStyle: style('feinherb', 'producer', PRODUCER_URL) });
    expect(await assignSweetnessStyle(w, { term: 'Feinherb', source: 'trade', url: TRADE_URL })).toMatchObject({ verdict: 'unchanged', changed: false });
    expect(await assignSweetnessStyle(w, { term: 'feinherb', source: 'producer', url: 'https://weingut-beispiel.example/new' })).toMatchObject({ verdict: 'unchanged' });
    expect(w.sweetnessStyle).toEqual(style('feinherb', 'producer', PRODUCER_URL));
  });
});

describe('clearing, leaving alone, and a partial load', () => {
  test('null or an empty term clears; undefined leaves the style as it is', async () => {
    const w = wine({ sweetnessStyle: style('feinherb', 'trade', TRADE_URL) });
    expect(await assignSweetnessStyle(w, {})).toMatchObject({ verdict: 'unchanged', changed: false });
    expect(w.sweetnessStyle).toEqual(style('feinherb', 'trade', TRADE_URL));
    expect(await assignSweetnessStyle(w, { term: null })).toMatchObject({ verdict: 'cleared', changed: true, style: null });
    expect(await assignSweetnessStyle(w, { term: '' })).toMatchObject({ verdict: 'cleared', changed: false });
  });

  test('a document loaded without the label term or the style is refused, either path', async () => {
    const withoutStyle = WineDefinition.hydrate({ _id: hex(70), name: 'Riesling', producer: 'Weingut Beispiel', type: 'white', labelSweetness: id('trocken') }, { name: 1, producer: 1, type: 1, labelSweetness: 1 });
    expect(await assignSweetnessStyle(withoutStyle, { term: 'feinherb', source: 'trade', url: TRADE_URL })).toMatchObject({ ok: false, reason: 'not_loaded' });
    const withoutLabel = WineDefinition.hydrate({ _id: hex(71), name: 'Riesling', producer: 'Weingut Beispiel', type: 'white', sweetnessStyle: null }, { name: 1, producer: 1, type: 1, sweetnessStyle: 1 });
    expect(await assignSweetnessStyle(withoutLabel, { term: 'feinherb', source: 'trade', url: TRADE_URL })).toMatchObject({ ok: false, reason: 'not_loaded' });
    expect(withoutLabel.isModified('sweetnessStyle')).toBe(false);
  });
});
