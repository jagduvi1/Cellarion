/**
 * The sweetness style as a correction proposal carries it
 * (services/proposalFields, services/proposalDirectApply).
 *
 * WHY THIS TEST EXISTS:
 * A style is filed as { term, source, url } and reaches the wine through the
 * write rule (services/sweetnessWrite assignSweetnessStyle). Filing asks that
 * rule first, without writing, so a member learns at once what approval
 * would refuse, and so a style applies on filing only when the rule would
 * write it exactly as filed. A reading here that differs from the rule would
 * file proposals that fail at approval — or apply a style the label's own
 * term contradicts. Pinned against the real seed table, on plain wine
 * objects, as the rule's own suite does.
 */
const ops = require('./sweetnessOps');
const {
  STYLE_FIELD, PROPOSABLE_FIELDS, readProposedFields, probeSweetnessStyle, settleSweetnessStyle,
} = require('./proposalFields');
const WineCorrectionProposal = require('../models/WineCorrectionProposal');
const { classifyProposal, memberAppliesOnFiling } = require('./proposalDirectApply');
const seed = require('../data/sweetness-terms.json');

const hex = (n) => n.toString(16).padStart(24, '0');
const ROWS = seed.map((r, i) => ({ _id: hex(i + 1), country: null, ...r }));
const id = (name, scale = 'still') => ROWS.find((r) => r.name === name && r.scale === scale)._id;
const TRADE_URL = 'https://merchant.example/riesling-kabinett';
const PRODUCER_URL = 'https://weingut-beispiel.example/weine/kabinett';

beforeEach(() => ops.primeSweetnessCache(ROWS));
afterEach(() => ops.primeSweetnessCache(null));

const read = (src, opts = {}) => readProposedFields(src, { grapesMax: 12, ...opts });
const wine = (over = {}) => ({
  _id: hex(900), name: 'Riesling Kabinett', producer: 'Weingut Beispiel', type: 'white',
  labelSweetness: null, sweetnessStyle: null, sweetnessReview: null, ...over,
});
const feinherb = (over = {}) => ({ [STYLE_FIELD]: { term: 'feinherb', source: 'trade', url: TRADE_URL, ...over } });

describe('reading a proposed style', () => {
  test('a term, a source and a link are read as one field, the link in the form the wine stores', async () => {
    const r = await read({ sweetnessStyle: { term: ' <b>feinherb</b> ', source: 'Trade', url: '  HTTPS://Merchant.Example/a  ' } });
    expect(r).toEqual({
      ok: true, classificationTier: null, newGrapeNames: [],
      proposedFields: { sweetnessStyle: { term: 'feinherb', source: 'trade', url: 'https://merchant.example/a' } },
    });
  });

  test('the filing\'s evidence link names the page when the style carries none', async () => {
    const r = await read({ sweetnessStyle: { term: 'feinherb', source: 'trade' } }, { styleUrl: TRADE_URL });
    expect(r.proposedFields.sweetnessStyle.url).toBe(TRADE_URL);
    expect(await read({ sweetnessStyle: { term: 'feinherb', source: 'trade' } })).toEqual({ ok: false, code: 'style_url_required' });
  });

  test('a style that is not an object, has no term or a term too long is refused for its shape', async () => {
    expect(await read({ sweetnessStyle: 'feinherb' })).toEqual({ ok: false, code: 'style_shape' });
    expect(await read({ sweetnessStyle: ['feinherb'] })).toEqual({ ok: false, code: 'style_shape' });
    expect(await read({ sweetnessStyle: { term: '  ', source: 'trade', url: TRADE_URL } })).toEqual({ ok: false, code: 'style_shape' });
    expect(await read({ sweetnessStyle: { term: 'x'.repeat(61), source: 'trade', url: TRADE_URL } })).toEqual({ ok: false, code: 'style_shape' });
  });

  test('the term is the word as printed: never a row id, never anything but a string', async () => {
    expect(await read({ sweetnessStyle: { term: id('feinherb'), source: 'trade', url: TRADE_URL } })).toEqual({ ok: false, code: 'style_shape' });
    expect(await read({ sweetnessStyle: { term: { toString: 1 }, source: 'trade', url: TRADE_URL } })).toEqual({ ok: false, code: 'style_shape' });
    expect(await read({ sweetnessStyle: { term: 42, source: 'trade', url: TRADE_URL } })).toEqual({ ok: false, code: 'style_shape' });
  });

  test('the fields a self-applying filing is held to are exactly the paths a proposal can store', () => {
    const paths = Object.keys(WineCorrectionProposal.schema.path('proposedFields').schema.paths);
    expect([...PROPOSABLE_FIELDS].sort()).toEqual(paths.sort());
  });

  test('only the producer or the trade names a style, and only a real link is accepted', async () => {
    expect(await read({ sweetnessStyle: { term: 'feinherb', source: 'critic', url: TRADE_URL } })).toEqual({ ok: false, code: 'style_source' });
    expect(await read({ sweetnessStyle: { term: 'feinherb', source: 'constructor', url: TRADE_URL } })).toEqual({ ok: false, code: 'style_source' });
    expect(await read({ sweetnessStyle: { term: 'feinherb', source: 'trade', url: 'merchant.example/a' } })).toEqual({ ok: false, code: 'style_url' });
    expect(await read({ sweetnessStyle: { term: 'feinherb', source: 'trade', url: 'https://user:pw@merchant.example/a' } })).toEqual({ ok: false, code: 'style_url' });
  });

  test('a style rides with other fields, and a null one is a field left alone', async () => {
    const r = await read({ appellation: 'Mosel', sweetnessStyle: { term: 'feinherb', source: 'trade', url: TRADE_URL } });
    expect(Object.keys(r.proposedFields)).toEqual(['appellation', 'sweetnessStyle']);
    expect(await read({ sweetnessStyle: null })).toEqual({ ok: false, code: 'no_fields' });
  });
});

describe('holding a proposed style against the wine at filing', () => {
  test('a term in another spelling takes the table\'s own, on the wine\'s scale', async () => {
    const pf = feinherb({ term: 'FEINHERB' });
    expect(await settleSweetnessStyle(pf, wine())).toEqual({ ok: true });
    expect(pf.sweetnessStyle.term).toBe('feinherb');
    const sekt = { sweetnessStyle: { term: 'trocken', source: 'producer', url: PRODUCER_URL } };
    expect(await settleSweetnessStyle(sekt, wine({ name: 'Riesling Sekt', type: 'sparkling' }))).toEqual({ ok: true });
    expect(sekt.sweetnessStyle.term).toBe('Trocken');
  });

  test('a term the table lacks, and a term of the other scale, are refused with the rule\'s own words', async () => {
    const unknown = await settleSweetnessStyle(feinherb({ term: 'lieblichst' }), wine());
    expect(unknown).toMatchObject({ ok: false, code: 'style_refused', reason: 'unknown_term' });
    expect(unknown.message).toMatch(/not a sweetness term for a still wine/);
    const other = await settleSweetnessStyle({ sweetnessStyle: { term: 'Extra Brut', source: 'producer', url: PRODUCER_URL } }, wine());
    expect(other).toMatchObject({ ok: false, code: 'style_refused', reason: 'type_mismatch' });
  });

  test('a term with a legal definition is refused from the trade', async () => {
    const r = await settleSweetnessStyle({ sweetnessStyle: { term: 'trocken', source: 'trade', url: TRADE_URL } }, wine());
    expect(r).toMatchObject({ ok: false, code: 'style_refused', reason: 'regulated_needs_producer' });
  });

  test('the type and name this same proposal sets are the ones the style is judged against', async () => {
    // Stored sparkling, corrected to white in the same filing: feinherb is a still term.
    const pf = { type: 'white', ...feinherb() };
    expect(await settleSweetnessStyle(pf, wine({ type: 'sparkling' }))).toEqual({ ok: true });
    // The corrected name states a dry wine: an off-dry style contradicts it.
    const named = { name: 'Riesling Kabinett trocken', ...feinherb() };
    expect(await settleSweetnessStyle(named, wine())).toMatchObject({ ok: false, code: 'style_refused', reason: 'term_contradiction' });
  });

  test('a style the label\'s own term already states, or contradicts, is not filed', async () => {
    const same = await settleSweetnessStyle(feinherb(), wine({ labelSweetness: id('halbtrocken') }));
    expect(same).toMatchObject({ ok: false, code: 'style_refused', reason: 'redundant' });
    const other = await settleSweetnessStyle(feinherb(), wine({ labelSweetness: id('trocken') }));
    expect(other).toMatchObject({ ok: false, code: 'style_refused', reason: 'term_contradiction' });
    expect(other.message).toMatch(/the label states "trocken"/);
  });

  test('the same style again is not filed; a different one from an equal source is, for a person to decide', async () => {
    const held = wine({ sweetnessStyle: { term: id('feinherb'), source: 'trade', url: TRADE_URL } });
    expect(await settleSweetnessStyle(feinherb(), held)).toMatchObject({ ok: false, code: 'style_refused', reason: 'unchanged' });
    const second = { sweetnessStyle: { term: 'fruchtsüß', source: 'trade', url: 'https://critic.example/note' } };
    expect(await settleSweetnessStyle(second, held)).toEqual({ ok: true });
    expect((await probeSweetnessStyle(held, second)).verdict).toBe('needs_review');
  });

  test('an amendment is judged with the type and the name its waiting row already holds', async () => {
    // The waiting row turns the wine into a sparkling one: feinherb is a still term.
    const typed = await settleSweetnessStyle(feinherb(), wine(), { type: 'sparkling' });
    expect(typed).toMatchObject({ ok: false, code: 'style_refused', reason: 'type_mismatch' });
    // The waiting row renames it with a dry word.
    const named = await settleSweetnessStyle(feinherb(), wine(), { name: 'Riesling Kabinett trocken' });
    expect(named).toMatchObject({ ok: false, code: 'style_refused', reason: 'term_contradiction' });
    // What this filing itself sets comes first.
    expect(await settleSweetnessStyle({ type: 'white', ...feinherb() }, wine(), { type: 'sparkling' })).toEqual({ ok: true });
  });

  test('the answer names the scale and the term, for the caller that decides what applies on filing', async () => {
    expect(await probeSweetnessStyle(wine(), feinherb())).toMatchObject({ verdict: 'applied', scale: 'still', term: { name: 'feinherb', regulated: false } });
    const dry = { sweetnessStyle: { term: 'trocken', source: 'producer', url: PRODUCER_URL } };
    expect(await probeSweetnessStyle(wine(), dry)).toMatchObject({ verdict: 'applied', term: { name: 'trocken', regulated: true } });
    expect(await probeSweetnessStyle(wine({ type: null }), feinherb())).toMatchObject({ verdict: 'applied', scale: null });
  });

  test('holding a style against a wine writes nothing to it', async () => {
    const w = wine();
    await settleSweetnessStyle(feinherb(), w);
    await probeSweetnessStyle(w, feinherb());
    expect(w.sweetnessStyle).toBeNull();
    expect(w.sweetnessReview).toBeNull();
  });

  test('a document loaded without its style is a programming error, not "no style"', async () => {
    const doc = { toObject: () => ({}), isSelected: (f) => f !== 'sweetnessStyle' };
    await expect(probeSweetnessStyle(doc, feinherb())).rejects.toThrow(/loaded without sweetnessStyle/);
  });
});

describe('which styles apply on filing', () => {
  test('a curator\'s style on a wine that has none applies; with a blank appellation beside it too', async () => {
    expect(await classifyProposal(wine(), 'field_correction', feinherb())).toMatchObject({ direct: true });
    const both = { region: 'Mosel', ...feinherb() };
    expect(await classifyProposal(wine({ region: null }), 'field_correction', both)).toMatchObject({ direct: true });
  });

  test('a style replacing a recorded one is reviewed, whatever its source', async () => {
    const held = wine({ sweetnessStyle: { term: id('feinherb'), source: 'trade', url: TRADE_URL } });
    const stronger = { sweetnessStyle: { term: 'fruchtsüß', source: 'producer', url: PRODUCER_URL } };
    const verdict = await classifyProposal(held, 'field_correction', stronger);
    expect(verdict.direct).toBe(false);
    expect(verdict.reason).toMatch(/sweetnessStyle already has a value/);
  });

  test('a style beside a gated field waits with it', async () => {
    const verdict = await classifyProposal(wine(), 'field_correction', { producer: 'Weingut Anders', ...feinherb() });
    expect(verdict.direct).toBe(false);
    expect(verdict.reason).toMatch(/producer is admin-reviewed/);
  });

  test('a member\'s style applies on its own, on a wine that has none — and in no other case', async () => {
    expect(await memberAppliesOnFiling(wine(), feinherb())).toMatchObject({ direct: true });
    expect(await memberAppliesOnFiling(wine(), { appellation: 'Mosel', ...feinherb() })).toMatchObject({ direct: false });
    expect(await memberAppliesOnFiling(wine(), { appellation: 'Mosel' })).toMatchObject({ direct: false });
    const held = wine({ sweetnessStyle: { term: id('fruchtsüß'), source: 'trade', url: TRADE_URL } });
    expect(await memberAppliesOnFiling(held, feinherb())).toMatchObject({ direct: false });
    expect(await memberAppliesOnFiling(wine(), {})).toMatchObject({ direct: false });
  });

  test('a term with a legal definition waits for a curator when a member files it, and applies when the curator does', async () => {
    const dry = { sweetnessStyle: { term: 'trocken', source: 'producer', url: PRODUCER_URL } };
    const member = await memberAppliesOnFiling(wine(), dry);
    expect(member.direct).toBe(false);
    expect(member.reason).toMatch(/legal definition/);
    expect(await classifyProposal(wine(), 'field_correction', dry)).toMatchObject({ direct: true });
  });

  test('on a wine with no type nothing applies on filing: the style cannot be held against the name', async () => {
    const untyped = wine({ type: null, name: 'Riesling trocken' });
    const member = await memberAppliesOnFiling(untyped, feinherb());
    expect(member.direct).toBe(false);
    expect(member.reason).toMatch(/has no type yet/);
    expect(await classifyProposal(untyped, 'field_correction', feinherb())).toMatchObject({ direct: false });
  });

  test('a member\'s style the rule would hold does not apply: a tier that is sweet by law against a dry-side term', async () => {
    const tba = wine({ name: 'Riesling Trockenbeerenauslese', classification: 'Trockenbeerenauslese' });
    const dry = { sweetnessStyle: { term: 'trocken', source: 'producer', url: PRODUCER_URL } };
    const verdict = await memberAppliesOnFiling(tba, dry);
    expect(verdict.direct).toBe(false);
  });
});
