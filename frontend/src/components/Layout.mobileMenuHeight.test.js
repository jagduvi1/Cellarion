/**
 * The phone menu is never taller than the visible screen.
 *
 * The menu scrolls inside itself, so a menu that is taller than the screen
 * keeps its last rows below it: the account row and Logout cannot be reached.
 * In a phone browser `100vh` is the height with the address bar hidden, which
 * is more than the screen while the bar shows. It cannot be seen in a desktop
 * browser or in an installed app (neither has an address bar that comes and
 * goes), so it is pinned as a rule about the stylesheet.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL.pathname: on Windows the latter yields "/C:/...".
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Layout.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of the first rule whose selector is exactly `selector`. */
function declarationsOf(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^{}]*)\\}`));
  return match ? match[1].split(';').map((d) => d.trim()).filter(Boolean) : [];
}

describe('phone menu height', () => {
  const maxHeights = declarationsOf('.mobile-menu').filter((d) => d.startsWith('max-height'));

  it('is measured against the visible height, so Logout stays reachable under an address bar', () => {
    expect(maxHeights.some((d) => d.includes('100dvh'))).toBe(true);
  });

  it('lets the visible-height rule win over the fallback for older browsers', () => {
    expect(maxHeights.length).toBeGreaterThan(0);
    expect(maxHeights[maxHeights.length - 1]).toContain('100dvh');
  });

  it('subtracts the navbar and the status-bar inset in every form of the rule', () => {
    for (const d of maxHeights) {
      expect(d).toContain('60px');
      expect(d).toContain('env(safe-area-inset-top)');
    }
  });
});
