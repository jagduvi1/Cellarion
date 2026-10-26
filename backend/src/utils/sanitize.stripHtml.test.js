/**
 * stripHtml keeps a plain '<' or '>' and strips only real markup.
 *
 * Members write comparisons in plain-text fields: "drink < 2030", "MongoDB > 4",
 * "<3", "a -> b". A '<' or '>' that opens no tag is text and must be stored as
 * typed. What a browser would read as markup — '<' followed by an ASCII letter,
 * '/', '!' or '?' — is still stripped through its closing '>', nested and
 * unclosed openers included.
 *
 * The basic tag, nesting, length-bound and non-string cases live in
 * sanitize.test.js.
 */
const { stripHtml } = require('./sanitize');

// What an HTML parser reads as the start of a tag, end tag, comment, doctype
// or processing instruction.
const OPENS_MARKUP = /<[A-Za-z/!?]/;

describe('stripHtml keeps a plain < and >', () => {
  test.each([
    ['MongoDB > 4'],
    ['drink < 2030, decant 1h'],
    ['<3'],
    ['a -> b'],
    ['x>y'],
    ['<= 5 g/l, >= 13.5%'],
    ['>_<'],
    ['a < b > c'],
    ['< b>'],
    ['<<3'],
    ['<>'],
    ['price <$50'],
    ['<Été'],
  ])('%j is stored as typed', (input) => {
    expect(stripHtml(input)).toBe(input);
  });

  test('a plain sign next to a real tag: the sign stays, the tag goes', () => {
    expect(stripHtml('Best < 2030 <i>really</i> > 4')).toBe('Best < 2030 really > 4');
    expect(stripHtml('1 < 2 and <b>bold</b>')).toBe('1 < 2 and bold');
  });
});

describe('stripHtml still strips real markup', () => {
  test.each([
    ['<img src=x onerror=alert(1)>', ''],
    ['<IMG SRC=x ONERROR=alert(1)>after', 'after'],
    ['<svg/onload=alert(1)>after', 'after'],
    ['<!-- hidden -->visible', 'visible'],
    ['<!DOCTYPE html>text', 'text'],
    ['<?xml version="1.0"?>text', 'text'],
    ['</p>text', 'text'],
    ['<scr<script>ipt>alert(1)</script>', 'alert(1)'],
  ])('%j → %j', (input, expected) => {
    expect(stripHtml(input)).toBe(expected);
  });

  test('an unclosed tag drops the rest of the input', () => {
    expect(stripHtml('note <script src=//evil.test/x.js')).toBe('note');
    expect(stripHtml('note <script')).toBe('note');
    expect(stripHtml('<scr<script>alert(1)')).toBe('');
  });

  test("a '<' inside a tag that opens nothing does not deepen it", () => {
    expect(stripHtml('<b title="1 < 2">bold</b>')).toBe('bold');
  });

  test("a '>' inside an attribute value ends the tag; the rest is inert text", () => {
    const out = stripHtml('<img alt="a>b" src=x onerror=alert(1)>tail');
    expect(out).toBe('b" src=x onerror=alert(1)>tail');
    expect(out).not.toMatch(OPENS_MARKUP);
  });

  test("a '<' glued to a letter opens a tag, as it does in a browser", () => {
    expect(stripHtml('a<b')).toBe('a');
    expect(stripHtml('x<y and y>z')).toBe('xz');
  });
});

describe('stripHtml never leaves markup behind', () => {
  test("stripping a tag never joins a kept '<' to what follows", () => {
    expect(stripHtml('<<b>x')).toBe('x');
    expect(stripHtml('<<<b>x')).toBe('x');
    expect(stripHtml('<<!-- -->script>alert(1)')).toBe('script>alert(1)');
    expect(stripHtml('< <b>x')).toBe('< x');
    expect(stripHtml('<<b>3')).toBe('<3');
  });

  test('every short string over the markup alphabet: nothing opens markup, and a second pass changes nothing', () => {
    const alphabet = ['<', '>', 'a', '/', '!', ' ', '3'];
    let words = [''];
    for (let len = 1; len <= 6; len++) {
      const next = [];
      for (const w of words) for (const c of alphabet) next.push(w + c);
      for (const w of next) {
        const out = stripHtml(w);
        if (OPENS_MARKUP.test(out) || stripHtml(out) !== out) {
          throw new Error(`stripHtml(${JSON.stringify(w)}) = ${JSON.stringify(out)}`);
        }
      }
      words = next;
    }
  });

  test('stays total and bounded', () => {
    expect(stripHtml({ length: 1e12 })).toBe('');
    expect(stripHtml(['<b>x</b>'])).toBe('');
    // An opener on the scan bound is still read as an opener.
    expect(stripHtml('x'.repeat(9_999) + '<b>tail')).toBe('x'.repeat(9_999));
    const big = stripHtml('< 3 '.repeat(5_000));
    expect(big.length).toBeLessThanOrEqual(10_000);
    expect(big.startsWith('< 3 < 3')).toBe(true);
  });
});
