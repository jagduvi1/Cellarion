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
      // The link checks the write rule makes (utils/sweetnessStyle), here too.
      { ...STYLE, url: 'https:merchant.example' },
      { ...STYLE, url: 'https://login:secret@merchant.example/x' },
      { ...STYLE, url: 'https://merchant.example' }, // not the normalised form the rule stores
      { ...STYLE, source: 'constructor' },
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
  test('a write to the style settles a question about the style, and no other', async () => {
    const styleQuestion = loaded({ sweetnessReview: { reason: 'style_contradiction', detail: 'x', since: new Date() } });
    styleQuestion.sweetnessStyle = STYLE;
    await styleQuestion.validate();
    expect(styleQuestion.sweetnessReview).toBeNull();
    // A pending question about the NAME stays: the style does not settle it.
    const nameQuestion = loaded({ name: 'Dolce Vita Bianco', sweetnessReview: { reason: 'name_ambiguous', detail: 'y', since: new Date() } });
    nameQuestion.sweetnessStyle = STYLE;
    await nameQuestion.validate();
    expect(nameQuestion.sweetnessReview.reason).toBe('name_ambiguous');
  });

  test('a marker set in the same write stays', async () => {
    const doc = loaded();
    doc.sweetnessStyle = STYLE;
    doc.sweetnessReview = { reason: 'style_contradiction', detail: 'y', since: new Date() };
    await doc.validate();
    expect(doc.sweetnessReview.reason).toBe('style_contradiction');
  });
});

describe('the outgoing shape, and deny by default', () => {
  const POPULATED_TERM = { _id: TERM, name: 'feinherb', band: 'off-dry', scale: 'still', regulated: false };

  test('the path is select: false: a read that does not ask for it never sees it', () => {
    expect(WineDefinition.schema.path('sweetnessStyle').options.select).toBe(false);
  });

  test('a document sent as it is (toJSON) carries { name, band, scale, regulated, source, sourceUrl } once its term is populated', () => {
    const doc = fresh({ sweetnessStyle: STYLE });
    doc.sweetnessStyle.term = new SweetnessTerm(POPULATED_TERM);
    expect(doc.toJSON().sweetnessStyle).toEqual({ name: 'feinherb', band: 'off-dry', scale: 'still', regulated: false, source: 'trade', sourceUrl: STYLE.url });
    expect(doc.toObject().sweetnessStyle).toMatchObject({ source: 'trade', url: STYLE.url });
    expect(fresh().toJSON().sweetnessStyle).toBeNull();
  });

  test('its term not populated, with the term copy warm or cold: no throw, and no key — never null, never an id', () => {
    for (const warm of [true, false]) {
      if (!warm) ops.primeSweetnessCache(null);
      const doc = fresh({ sweetnessStyle: STYLE });
      let json;
      expect(() => { json = JSON.parse(JSON.stringify(doc)); }).not.toThrow();
      expect(json).not.toHaveProperty('sweetnessStyle');
    }
  });

  test('a stored source or link the rules refuse is never sent', () => {
    const doc = fresh({ sweetnessStyle: STYLE });
    doc.sweetnessStyle.term = new SweetnessTerm(POPULATED_TERM);
    doc.sweetnessStyle.url = 'javascript:alert(1)';
    expect(doc.toJSON()).not.toHaveProperty('sweetnessStyle');
  });
});
