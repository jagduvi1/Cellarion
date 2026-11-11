/**
 * The wine record's sweetness style (WineDefinition.sweetnessStyle): the term
 * a wine is KNOWN by when its label prints none, named by the producer or the
 * trade. Exercised through validate(), the path every save takes.
 *
 * WHY THIS TEST EXISTS:
 * The style is descriptive and NEVER identity. A wine with one must key, slug,
 * display and compare exactly like the same wine without one — byte for byte —
 * or a merchant's word could split one wine into two or fold two into one. It
 * costs no database read, it is stored only with a known source and an
 * http(s) link, a write to it settles a pending sweetness question like a
 * write to the label term does, and it leaves the server in its outgoing
 * shape.
 */
const mongoose = require('mongoose');
const WineDefinition = require('./WineDefinition');
const SweetnessTerm = require('./SweetnessTerm');
const ops = require('../services/sweetnessOps');
const { conflictingStyleTerms, styleOf } = require('../utils/styleTerms');
const { generateWineSlug } = require('../utils/normalize');

const oid = () => new mongoose.Types.ObjectId();
const COUNTRY = oid();
const CREATOR = oid();
const TERM = oid();
const STYLE = { term: TERM, source: 'trade', url: 'https://merchant.example/riesling-kabinett' };

const fresh = (over = {}) => new WineDefinition({
  name: 'Riesling Kabinett', producer: 'Weingut Beispiel', appellation: 'Mosel',
  country: COUNTRY, createdBy: CREATOR, normalizedKey: 'weingut beispiel:riesling kabinett:mosel',
  ...over,
});
const loaded = (over = {}) => {
  const doc = fresh({ slug: 'weingut-beispiel-riesling-kabinett', ...over });
  doc.isNew = false;
  for (const p of ['name', 'producer', 'slug', 'labelSweetness', 'sweetnessReview', 'sweetnessStyle', 'type', 'sweetnessInName', 'normalizedKey']) doc.unmarkModified(p);
  return doc;
};

beforeEach(() => ops.primeSweetnessCache([{ _id: String(TERM), name: 'feinherb', scale: 'still', band: 'off-dry', regulated: false, country: null, synonyms: [] }]));
afterEach(() => { ops.primeSweetnessCache(null); jest.restoreAllMocks(); });

describe('never identity', () => {
  test('keys, slug base and display name are byte-identical with and without a style; no term read is spent', async () => {
    const read = jest.spyOn(SweetnessTerm, 'findById');
    const plain = fresh();
    const styled = fresh({ sweetnessStyle: STYLE });
    await plain.validate();
    await styled.validate();
    expect(read).not.toHaveBeenCalled();
    expect(styled.normalizedKey).toBe(plain.normalizedKey);
    expect(styled.canonicalKey).toBe(plain.canonicalKey);
    expect(styled.$locals.sweetnessName).toBe(plain.$locals.sweetnessName);
    expect(generateWineSlug(styled.name, styled.producer, styled.$locals.sweetnessName))
      .toBe(generateWineSlug(plain.name, plain.producer, plain.$locals.sweetnessName));
    expect(ops.wineDisplayName(styled)).toBe('Riesling Kabinett');
    expect(ops.wineDisplayName(styled)).toBe(ops.wineDisplayName(plain));
  });

  test('a style set or changed on a saved wine never moves its slug', async () => {
    const doc = loaded();
    doc.sweetnessStyle = STYLE;
    await doc.validate();
    expect(WineDefinition.shouldRegenerateSlug(doc)).toBe(false);
  });

  test('the style guard and the resolver\'s comparison do not read it', () => {
    const populated = { ...STYLE, term: { name: 'feinherb', band: 'off-dry', scale: 'still', regulated: false } };
    const a = { name: 'Riesling Kabinett', sweetnessStyle: populated };
    const b = { name: 'Riesling Kabinett', sweetnessStyle: null };
    expect(styleOf(a).sweetness.size).toBe(0);
    expect(styleOf(a).term).toBeNull();
    expect(conflictingStyleTerms(a, b)).toBeNull();
    // Two different styles do not split a wine either.
    const c = { name: 'Riesling Kabinett', sweetnessStyle: { ...populated, term: { name: 'fruchtsüß', band: 'medium-sweet', scale: 'still', regulated: false } } };
    expect(conflictingStyleTerms(a, c)).toBeNull();
  });
});

describe('what may be stored', () => {
  test('null by default', () => {
    expect(fresh().sweetnessStyle).toBeNull();
  });

  test('a known source and an http(s) link are required; the term is required', async () => {
    const bad = [
      { ...STYLE, source: 'critic' },
      { ...STYLE, url: 'javascript:alert(1)' },
      { ...STYLE, url: `https://merchant.example/${'x'.repeat(500)}` },
      { source: 'trade', url: STYLE.url },
      { term: TERM, source: 'trade' },
    ];
    for (const s of bad) {
      await expect(fresh({ sweetnessStyle: s }).validate()).rejects.toThrow(/sweetnessStyle/);
    }
    await expect(fresh({ sweetnessStyle: STYLE }).validate()).resolves.toBeUndefined();
  });
});

describe('the review marker', () => {
  test('a write to the style settles a pending sweetness question, as a write to the label term does', async () => {
    const doc = loaded({ sweetnessReview: { reason: 'term_contradiction', detail: 'x', since: new Date() } });
    doc.sweetnessStyle = STYLE;
    await doc.validate();
    expect(doc.sweetnessReview).toBeNull();
  });

  test('a marker set in the same write stays', async () => {
    const doc = loaded();
    doc.sweetnessStyle = STYLE;
    doc.sweetnessReview = { reason: 'term_contradiction', detail: 'y', since: new Date() };
    await doc.validate();
    expect(doc.sweetnessReview.reason).toBe('term_contradiction');
  });
});

describe('the outgoing shape', () => {
  test('a document sent as it is (toJSON) carries { name, band, scale, regulated, source, sourceUrl }; toObject keeps the stored shape', () => {
    const doc = fresh({ sweetnessStyle: STYLE });
    expect(doc.toJSON().sweetnessStyle).toEqual({ name: 'feinherb', band: 'off-dry', scale: 'still', regulated: false, source: 'trade', sourceUrl: STYLE.url });
    expect(JSON.parse(JSON.stringify(doc)).sweetnessStyle).toMatchObject({ name: 'feinherb', sourceUrl: STYLE.url });
    expect(doc.toObject().sweetnessStyle).toMatchObject({ source: 'trade', url: STYLE.url });
    expect(fresh().toJSON().sweetnessStyle).toBeNull();
  });
});
