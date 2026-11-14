// The DB loop is exercised on a real MongoDB (align-cru-appellations.mongo.test.js);
// here: the vineyard table and the decisions, without one.
jest.mock('./lib/backupLog', () => ({ createBackupLog: jest.fn() }));
jest.mock('../services/search', () => ({ indexWine: jest.fn() }));
jest.mock('./lib/scriptSearch', () => ({ initSearch: jest.fn() }));
// The REAL snapshot: pure, and a hand mirror would rot the day the field list changes.
jest.mock('../services/enrichmentJob', () => ({
  profileInputsSnapshot: jest.requireActual('../services/enrichmentJob').profileInputsSnapshot,
}));

const {
  VINEYARDS, canonicalName, synonymsFor, withAppellationSegment, planWineMove, planList, resolveAmongVineyards, looksLikeChampagneCru,
} = require('./align-cru-appellations');
const { generateWineKey, pendingWineKey, sweetnessKeySegment, normalizeAppellationKey } = require('../utils/normalize');
const { computeCanonicalKey } = require('../utils/wineIdentity');
const { profileInputsSnapshot } = require('../services/enrichmentJob');

const FRANCE = 'c-france';
const BURGUNDY = 'r-burgundy';
let nextId = 0;
const entry = (name, over = {}) => {
  nextId += 1;
  const synonyms = over.synonyms || [];
  return { _id: `a${nextId}`, name, country: FRANCE, region: BURGUNDY, synonyms, key: normalizeAppellationKey(name), synonymKeys: synonyms.map(normalizeAppellationKey), ...over };
};

describe('the vineyard table', () => {
  test('names the 32 grand-cru appellations of the Côte d\'Or, 24 in the Côte de Nuits and 8 in the Côte de Beaune', () => {
    expect(VINEYARDS).toHaveLength(32);
    expect(VINEYARDS.filter((v) => v.area === 'nuits')).toHaveLength(24);
    expect(VINEYARDS.filter((v) => v.area === 'beaune')).toHaveLength(8);
    expect(canonicalName(VINEYARDS.find((v) => v.name === 'Corton'))).toBe('Corton Grand Cru');
  });

  test('no spelling of one vineyard is a spelling of another', () => {
    const owner = new Map();
    for (const v of VINEYARDS) {
      for (const s of [canonicalName(v), ...synonymsFor(v)]) {
        const key = normalizeAppellationKey(s);
        expect([s, owner.get(key) || v.name]).toEqual([s, v.name]);
        owner.set(key, v.name);
      }
    }
    // The pairs that look alike are different keys.
    for (const [a, b] of [['Montrachet', 'Puligny-Montrachet'], ['Charlemagne', 'Corton-Charlemagne'], ['Chambertin', 'Gevrey-Chambertin'], ['Échezeaux', 'Grands-Échezeaux'], ['La Romanée', 'Romanée-Conti'], ['Musigny', 'Chambolle-Musigny']]) {
      expect(normalizeAppellationKey(a)).not.toBe(normalizeAppellationKey(b));
    }
  });

  test('the bare name is a synonym; a spelling the key\'s fold already covers is not listed twice', () => {
    const of = (name) => synonymsFor(VINEYARDS.find((v) => v.name === name));
    expect(of('Corton')).toEqual(['Corton']);
    expect(of('Bonnes-Mares')).toEqual(['Bonnes-Mares']);
    expect(of('Échezeaux')).toEqual(['Échezeaux']);
    expect(of('Clos de Vougeot')).toEqual(['Clos de Vougeot', 'Clos Vougeot', 'Clos Vougeot Grand Cru']);
    for (const v of VINEYARDS) {
      const keys = [canonicalName(v), ...synonymsFor(v)].map(normalizeAppellationKey);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

describe('planList', () => {
  test('creates the missing entries, respells the ones under another spelling and leaves every other entry alone', () => {
    const list = [
      entry('Corton Grand Cru'), entry('Bonnes Mares Grand Cru'), entry('Batard-Montrachet'),
      entry('Corton-Le Rognet Grand Cru'), entry('Chablis Grand Cru'), entry('Gevrey-Chambertin'),
    ];
    const { plans, accepted, needsAPerson } = planList(list, FRANCE, BURGUNDY);
    expect(plans).toHaveLength(32);
    expect(plans.filter((p) => p.create)).toHaveLength(29);
    expect(plans.filter((p) => p.rename).map((p) => [p.keep.name, p.name])).toEqual([
      ['Bonnes Mares Grand Cru', 'Bonnes-Mares Grand Cru'], ['Batard-Montrachet', 'Bâtard-Montrachet Grand Cru'],
    ]);
    const corton = plans.find((p) => p.name === 'Corton Grand Cru');
    expect(corton).toMatchObject({ create: false, rename: false, synonymsChange: true, synonyms: ['Corton'] });
    expect(plans.find((p) => p.create).region).toBe(BURGUNDY);
    expect(needsAPerson).toEqual([]);
    expect(accepted.get('corton')).toBe('Corton Grand Cru');
    expect(accepted.get('clos vougeot')).toBe('Clos de Vougeot Grand Cru');
    expect(accepted.has('corton le rognet grand cru')).toBe(false);
    expect(accepted.has('chablis grand cru')).toBe(false);
  });

  test('a second entry for one vineyard is folded into the first, its spellings kept', () => {
    const list = [entry('Corton Grand Cru'), entry('Corton', { synonyms: ['Corton AOC Grand Cru'] })];
    const corton = planList(list, FRANCE, BURGUNDY).plans.find((p) => p.name === 'Corton Grand Cru');
    expect(corton.keep.name).toBe('Corton Grand Cru');
    expect(corton.fold.map((d) => d.name)).toEqual(['Corton']);
    expect(corton.synonyms).toEqual(['Corton', 'Corton AOC Grand Cru']);
  });

  test('a synonym another entry answers to is not added, and is named for a person', () => {
    const list = [entry('Vallée du Musigny', { synonyms: ['Musigny'] })];
    const { plans, accepted, needsAPerson } = planList(list, FRANCE, BURGUNDY);
    const musigny = plans.find((p) => p.name === 'Musigny Grand Cru');
    expect(musigny.synonyms).toEqual(['Le Musigny', 'Le Musigny Grand Cru']);
    expect(accepted.has('musigny')).toBe(false);
    expect(needsAPerson.map((n) => n.text).join('\n')).toMatch(/"Musigny" is not added as a spelling of "Musigny Grand Cru": the list entry "Vallée du Musigny" already answers to it/);
  });

  test('planned twice, the second plan has nothing to write', () => {
    const first = planList([entry('Corton Grand Cru'), entry('Batard-Montrachet')], FRANCE, BURGUNDY);
    const after = first.plans.map((p) => entry(p.name, { synonyms: p.synonyms }));
    const second = planList(after, FRANCE, BURGUNDY);
    expect(second.plans.filter((p) => p.create || p.rename || p.synonymsChange || p.fold.length)).toEqual([]);
  });
});

describe('resolveAmongVineyards', () => {
  const list = [entry('Corton-Le Rognet Grand Cru'), entry('Chablis Grand Cru'), entry('Gevrey-Chambertin Premier Cru'), entry('Gevrey-Chambertin')];
  const { accepted } = planList(list, FRANCE, BURGUNDY);
  const others = new Set(list.map((d) => d.key));

  test('the bare name, any case, a variant and a spelling the fold covers resolve to "<Vineyard> Grand Cru"', () => {
    for (const [typed, canonical] of [
      ['Corton', 'Corton Grand Cru'], ['corton grand cru', 'Corton Grand Cru'], ['Clos Vougeot', 'Clos de Vougeot Grand Cru'],
      ['Clos Vougeot Grand Cru', 'Clos de Vougeot Grand Cru'], ['Echezeaux', 'Échezeaux Grand Cru'], ['Echézeaux Grand Cru', 'Échezeaux Grand Cru'],
      ['Bonnes Mares Grand Cru', 'Bonnes-Mares Grand Cru'], ['Griotte-Chambertin', 'Griotte-Chambertin Grand Cru'], ['La Tâche', 'La Tâche Grand Cru'],
      ['Corton Grand Cru AOC', 'Corton Grand Cru'], ['Appellation Corton Contrôlée', 'Corton Grand Cru'],
    ]) {
      expect([typed, resolveAmongVineyards(typed, accepted, others)]).toEqual([typed, canonical]);
    }
  });

  test('another entry of the list, a premier cru and a village are not one of the 32', () => {
    for (const typed of ['Corton-Le Rognet Grand Cru', 'Chablis Grand Cru', 'Gevrey-Chambertin Premier Cru', 'Gevrey-Chambertin', 'Puligny-Montrachet', 'Aloxe-Corton', 'Champagne Grand Cru', 'Corton Bressandes', '']) {
      expect([typed, resolveAmongVineyards(typed, accepted, others)]).toEqual([typed, null]);
    }
  });
});

describe('withAppellationSegment', () => {
  test('replaces only the last segment and keeps the label sweetness suffix', () => {
    expect(withAppellationSegment('p:n:corton', 'corton', 'corton grand cru')).toBe('p:n:corton grand cru');
    expect(withAppellationSegment('p:n:champagne grand cru#sw=brut', 'champagne grand cru', 'champagne')).toBe('p:n:champagne#sw=brut');
    expect(withAppellationSegment('pending~u1:n:musigny', 'musigny', 'musigny grand cru')).toBe('pending~u1:n:musigny grand cru');
  });

  test('a key already on the new segment is unchanged; one on neither is left alone', () => {
    expect(withAppellationSegment('p:n:champagne', 'champagne grand cru', 'champagne')).toBe('p:n:champagne');
    expect(withAppellationSegment('p:n:barolo', 'corton', 'corton grand cru')).toBeNull();
    expect(withAppellationSegment('', 'corton', 'corton grand cru')).toBeNull();
    expect(withAppellationSegment(null, 'corton', 'corton grand cru')).toBeNull();
  });
});

describe('planWineMove', () => {
  const row = (appellation, over = {}) => ({
    _id: 'w1', name: 'Cuvée Aurore', producer: 'Domaine Exemple', country: 'c1', region: 'r1', type: 'red', grapes: ['g1'],
    appellation, classification: null, classifications: [],
    // The keys as they were written when the typed appellation was the last segment.
    normalizedKey: `domaine exemple:cuvee aurore:${appellation.toLowerCase()}`,
    canonicalKey: `exemple:cuvee aurore:${appellation.toLowerCase()}`,
    ...over,
  });

  test('a Burgundy respelling moves the appellation and both keys, and nothing else', () => {
    const { $set, keysLeft } = planWineMove(row('Corton', { classification: 'Grand Cru', classifications: ['gc'] }), { appellation: 'Corton Grand Cru' });
    expect(keysLeft).toEqual([]);
    expect($set).toMatchObject({
      appellation: 'Corton Grand Cru',
      normalizedKey: generateWineKey('Cuvée Aurore', 'Domaine Exemple', 'Corton Grand Cru'),
      canonicalKey: computeCanonicalKey('Cuvée Aurore', 'Domaine Exemple', 'Corton Grand Cru'),
    });
    expect($set).not.toHaveProperty('classification');
    expect($set).not.toHaveProperty('classifications');
    expect($set.updatedAt).toBeInstanceOf(Date);
  });

  test('a Champagne move lands on the keys the rule writes for Champagne, with the tiers', () => {
    const { $set } = planWineMove(row('Champagne Grand Cru'), { appellation: 'Champagne', classification: { classification: 'Grand Cru', classifications: ['gc'] } });
    expect($set).toMatchObject({
      appellation: 'Champagne', classification: 'Grand Cru', classifications: ['gc'],
      normalizedKey: generateWineKey('Cuvée Aurore', 'Domaine Exemple', 'Champagne Grand Cru'),
      canonicalKey: computeCanonicalKey('Cuvée Aurore', 'Domaine Exemple', 'Champagne Premier Cru'),
    });
    expect($set.normalizedKey).toBe('domaine exemple:cuvee aurore:champagne');
  });

  test('a spelling the fold already keyed as the canonical one changes no key', () => {
    const { $set, keysLeft } = planWineMove(row('Echézeaux Grand Cru', { normalizedKey: 'domaine exemple:cuvee aurore:echezeaux grand cru', canonicalKey: 'exemple:cuvee aurore:echezeaux grand cru' }), { appellation: 'Échezeaux Grand Cru' });
    expect(keysLeft).toEqual([]);
    expect($set.appellation).toBe('Échezeaux Grand Cru');
    expect($set).not.toHaveProperty('normalizedKey');
    expect($set).not.toHaveProperty('canonicalKey');
  });

  test('a pending row stays in its namespace and keeps its sweetness suffix', () => {
    const key = `${pendingWineKey('Cuvée Aurore', 'u1', '')}champagne 1er cru${sweetnessKeySegment('Brut')}`;
    const { $set } = planWineMove(row('Champagne 1er Cru', { normalizedKey: key }), { appellation: 'Champagne' });
    expect($set.normalizedKey).toBe(pendingWineKey('Cuvée Aurore', 'u1', 'Champagne', { sweetness: 'Brut' }));
  });

  test('a key an older rule wrote is left as written, and named', () => {
    const { $set, keysLeft } = planWineMove(row('Corton', { normalizedKey: 'domaine exemple:cuvee aurore:' }), { appellation: 'Corton Grand Cru' });
    expect(keysLeft).toEqual(['normalizedKey']);
    expect($set).not.toHaveProperty('normalizedKey');
    expect($set.appellation).toBe('Corton Grand Cru');
  });

  test('an in-sync profile snapshot moves along; a stale one is left alone', () => {
    const r = row('Champagne Grand Cru');
    r.aiProfile = { inputsSnapshot: profileInputsSnapshot(r) };
    const tiers = { classification: 'Grand Cru', classifications: ['gc'] };
    expect(planWineMove(r, { appellation: 'Champagne', classification: tiers }).$set['aiProfile.inputsSnapshot'])
      .toBe(profileInputsSnapshot({ ...r, appellation: 'Champagne', classification: 'Grand Cru' }));
    const stale = row('Champagne Grand Cru');
    stale.aiProfile = { inputsSnapshot: profileInputsSnapshot({ ...stale, name: 'Other' }) };
    expect(planWineMove(stale, { appellation: 'Champagne', classification: tiers }).$set).not.toHaveProperty('aiProfile.inputsSnapshot');
  });
});

describe('looksLikeChampagneCru', () => {
  test('a Champagne value that states a cru and something more is for a person', () => {
    for (const v of ['Champagne Grand Cru (Bouzy)', 'Champagne Grand Cru (Cramant)', 'Champagne Premier Cru Brut', 'Grand Cru Champagne', 'Champagne 1er Cru - Cuis']) {
      expect([v, looksLikeChampagneCru(v)]).toEqual([v, true]);
    }
  });

  test('the plain appellation, Cognac and the other appellations are not', () => {
    for (const v of ['Champagne', 'Grande Champagne', 'Petite Champagne', 'Fine Champagne', 'Grande Champagne Premier Cru', 'Ratafia de Champagne', 'Coteaux Champenois', 'Chablis Grand Cru']) {
      expect([v, looksLikeChampagneCru(v)]).toEqual([v, false]);
    }
  });
});
