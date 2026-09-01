/**
 * Every `white-space: pre-wrap` must be able to break a long word.
 *
 * pre-wrap preserves the author's newlines and wraps at spaces — but it cannot
 * break a single unbreakable token. One support reply contained a
 * 234-character URL, which widened its block past the card; because the card
 * clips its overflow, every OTHER line in that block was cut off too, and the
 * ticket read as truncated nonsense on both mobile and desktop.
 *
 * The bug is invisible until someone pastes a long URL, so it cannot be caught
 * by looking at a screen — which is why it is pinned as a rule about the
 * stylesheets instead. Four files had pre-wrap without a break rule when this
 * was written; five already had one, so the codebase knew the pattern and
 * these had simply drifted from it.
 *
 * Anywhere user-supplied or model-generated text is rendered, assume a long
 * token will eventually arrive in it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL.pathname — on Windows the latter yields "/C:/..."
// which fs cannot open.
const SRC = dirname(dirname(fileURLToPath(import.meta.url)));

function cssFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) cssFiles(full, out);
    else if (entry.endsWith('.css')) out.push(full);
  }
  return out;
}

/** Split a stylesheet into `{ …declarations }` bodies, comments stripped. */
function declarationBlocks(css) {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutComments.match(/\{[^{}]*\}/g) || [];
}

const BREAKS_WORDS = /(overflow-wrap|word-wrap)\s*:\s*(anywhere|break-word)|word-break\s*:\s*(break-word|break-all)/;

describe('pre-wrap always pairs with a word-breaking rule', () => {
  const files = cssFiles(SRC);

  it('finds stylesheets to check (guards against the glob silently matching nothing)', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('has no declaration block with pre-wrap and no way to break a long token', () => {
    const offenders = [];
    for (const file of files) {
      for (const block of declarationBlocks(readFileSync(file, 'utf8'))) {
        if (!/white-space\s*:\s*pre-wrap/.test(block)) continue;
        if (BREAKS_WORDS.test(block)) continue;
        offenders.push(`${relative(SRC, file)} — ${block.replace(/\s+/g, ' ').slice(0, 80)}`);
      }
    }
    // Named rather than counted, so a failure says which rule to fix.
    expect(offenders).toEqual([]);
  });
});

describe('the rule itself', () => {
  const check = (block) => /white-space\s*:\s*pre-wrap/.test(block) && !BREAKS_WORDS.test(block);

  it('accepts each spelling already used in this codebase', () => {
    expect(check('{ white-space: pre-wrap; overflow-wrap: anywhere; }')).toBe(false);
    expect(check('{ white-space: pre-wrap; overflow-wrap: break-word; }')).toBe(false);
    expect(check('{ white-space: pre-wrap; word-break: break-word; }')).toBe(false);
    expect(check('{ white-space: pre-wrap; word-wrap: break-word; }')).toBe(false);
    expect(check('{ white-space: pre-wrap; word-break: break-all; }')).toBe(false);
  });

  it('flags pre-wrap left on its own', () => {
    expect(check('{ white-space: pre-wrap; }')).toBe(true);
    expect(check('{ margin: 0; white-space: pre-wrap; line-height: 1.6; }')).toBe(true);
  });

  it('does not flag other white-space values, which are not affected', () => {
    expect(check('{ white-space: nowrap; }')).toBe(false);
    expect(check('{ white-space: normal; }')).toBe(false);
  });

  it('is not satisfied by a break rule that only appears in a comment', () => {
    // declarationBlocks strips comments before this runs; assert the stripping,
    // since a commented-out fix passing the check would be worse than no check.
    const css = '.x { white-space: pre-wrap; /* overflow-wrap: anywhere; */ }';
    const [block] = declarationBlocks(css);
    expect(check(block)).toBe(true);
  });
});
