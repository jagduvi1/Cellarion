/**
 * The cut of a label sweetness term out of a name, over a generated grid of
 * the shapes around it.
 *
 * WHY THIS TEST EXISTS:
 * Hand-picked cases kept missing whole families of names: a comma on the word
 * before and a dash after ("Cuvée, Brut - Rosé" once became "Cuvée, - Rosé"),
 * a quote pair holding the term and a comma ('Cuvée "Brut," Rosé' once became
 * 'Cuvée," "Rosé'), a spaced bracket left against a neighbour. This builds
 * every name from a neighbour, the punctuation and space before the term, the
 * term, what follows, and another neighbour, and holds each cut against the
 * faults a tidy cut never adds: when the term is read, the name left must have
 * none the original did not have; otherwise nothing is removed. Names that
 * already hold an unmatched straight quote are left out — a cut cannot make
 * them tidy and the checks below cannot tell which side a quote is on.
 */
const ops = require('./sweetnessOps');
const { extractLoaded } = require('./sweetnessWrite');
const seed = require('../data/sweetness-terms.json');

const hex = (n) => n.toString(16).padStart(24, '0');
let terms;
beforeAll(async () => { ops.primeSweetnessCache(seed.map((r, i) => ({ _id: hex(i + 1), country: null, ...r }))); terms = await ops.loadTerms(); });
afterAll(() => ops.primeSweetnessCache(null));

const count = (s, rx) => (s.match(rx) || []).length;
const cnt = (s, ch) => s.split(ch).length - 1;
const SEP = '[-\u2010-\u2015\u2212/|·&+•*~]';
const FAULTS = {
  'separator beside a comma': new RegExp(`[,;:]\\s+${SEP}+(\\s|$)|(^|\\s)${SEP}+\\s+[,;:.]`, 'gu'),
  'two separator tokens': /(^|\s)[^\p{L}\p{M}\p{N}\s"“”„«»()[\]]+\s+[^\p{L}\p{M}\p{N}\s"“”„«»()[\]]+(?=\s|$)/gu,
  'empty pair': /\(\s*\)|\[\s*\]|"\s*"(?![\p{L}\p{N}])|«\s*»|„\s*“|“\s*”/gu,
  'opener then space': /[([«„]\s/gu,
  'space then closer': /\s[)\]»,;:.]/gu,
  'punctuation doubled': /[,;:]{2,}|[,;:]\.|\.[,;:]|\.\.(?!\.)/gu,
  'quote or bracket inside a word': /[\p{L}\p{N}]["“”„«»()[\]][\p{L}\p{N}]/gu,
  'closer then opener glued': /["”»)\]]["“„«([]/gu,
  'double space': /\s{2,}/g,
  'comma glued to the next word': /[\p{L}\p{N}][,;:][\p{L}]/gu,
};
/** The faults a cut added to a name (an empty list for a tidy cut). */
function faults(name, out) {
  const f = Object.entries(FAULTS).filter(([, rx]) => count(out, rx) > count(name, rx)).map(([k]) => k);
  for (const [o, c] of [['(', ')'], ['[', ']'], ['«', '»']]) if (cnt(name, o) - cnt(name, c) !== cnt(out, o) - cnt(out, c)) f.push(`unbalanced ${o}${c}`);
  const startsBad = /^[-\u2010-\u2015\u2212,;:/&+|·.)\]»”]/u; const endsBad = /[-\u2010-\u2015\u2212,;:/&+|·([«„]$/u;
  if (startsBad.test(out.trim()) && out.trim()[0] !== name.trim()[0]) f.push('starts with a separator');
  if (endsBad.test(out.trim()) && out.trim().slice(-1) !== name.trim().slice(-1)) f.push('ends with a separator');
  return f;
}

const LS = ['', 'Cuvée', 'R.D.', 'Sekt "Alte Reben"', 'Cuvée (Magnum)', '2012', 'Cuvée «Prestige»', 'Blanc, Blanc', 'Cuvée - X'];
const RS = ['', 'Rosé', '"Rosé"', '(Magnum)', 'N.V.', '«Réserve»', 'Rosé, 2012', 'X - Rosé'];
const BEFORE = [' ', '', '-', ' - ', ' \u2013 ', ', ', ',', '. ', ': ', ':', '; ', ' (', '(', ' "', '"', ' «', ' „', ' “', ' / ', ' & ', ' | ', ' -', '- ', '  ', ' [', ' ("', '\u00AD', '\u200B', ' ( ', ' « ', ' " ', ', - ', ' - , ', ') ', '" ', '), ', '", ', ') - '];
const AFTER = [' ', '', '-', ' - ', ' \u2013 ', ', ', ',', '. ', '.', ': ', '; ', ') ', ')', '" ', '"', '» ', '“ ', '” ', ' / ', ' & ', ' | ', '- ', ' -', '  ', '] ', '") ', '\u00AD', '\u200B', ' ) ', ' » ', ' " ', ' - , ', ', - ', ' (', ' "', ', (', ' - (', '.) ', '," ', '." '];
const TERMS = { sparkling: ['Brut', 'Extra Brut'], still: ['trocken'] };

test('every read cut adds no fault to the name; every other name keeps all of itself', () => {
  let read = 0; let untidy = 0;
  for (const scale of Object.keys(TERMS)) {
    for (const term of TERMS[scale]) for (const L of LS) for (const before of BEFORE) for (const after of AFTER) for (const R of (scale === 'still' ? [''] : RS)) {
      const name = `${L}${before}${term}${after}${R}`;
      if (cnt(name, '"') % 2 === 1 || name.includes('""')) continue;
      const out = extractLoaded(terms, name, { scale });
      if (out.ambiguous && out.ambiguous.kind === 'untidy_cut') { untidy += 1; expect(out.name).toBe(name); continue; }
      if (!out.term || out.name === name) continue;
      read += 1;
      const found = faults(name, out.name);
      if (found.length) expect({ name, out: out.name, found }).toEqual({ name, out: out.name, found: [] });
    }
  }
  expect(read).toBeGreaterThan(5000);
  expect(untidy).toBeGreaterThan(5000);
});
