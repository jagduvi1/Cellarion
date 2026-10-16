import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import en from '../locales/en/translation.json';
import Help, { SECTION_KEYS, sectionKeyFor } from './Help';

// What Help says is the point of these tests, so t() reads the real English
// strings instead of echoing keys or inline defaults.
vi.mock('react-i18next', async () => {
  const strings = (await import('../locales/en/translation.json')).default;
  const t = (key, opts) => {
    const vars = (opts && typeof opts === 'object') ? opts : {};
    const v = key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), strings);
    if (typeof v === 'string') return v.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? String(vars[k]) : ''));
    return 'defaultValue' in vars ? vars.defaultValue : key;
  };
  return { useTranslation: () => ({ t }) };
});

vi.mock('../components/SEOHead', () => ({ default: () => null }));

let pickListsOn = false;
vi.mock('../utils/featureFlags', () => ({ useFeature: (key) => key === 'pickLists' && pickListsOn }));

const getHelpContent = vi.fn();
vi.mock('../api/help', () => ({ getHelpContent: (...a) => getHelpContent(...a) }));

const sections = en.help.sections;
// A section's open/close button, found by its exact title.
const header = (key) => screen.getByRole('heading', { level: 2, name: sections[key].title }).closest('button');
const at = (path) => render(<MemoryRouter initialEntries={[path]}><Help /></MemoryRouter>);
const nextFrame = () => act(async () => { await new Promise((r) => requestAnimationFrame(r)); });

beforeEach(() => {
  pickListsOn = false;
  getHelpContent.mockResolvedValue({ sections: [] });
  Element.prototype.scrollIntoView = vi.fn();
});

describe('the help text', () => {
  test('every section the page lists has a title, a summary and up to ten bullets with no gap', () => {
    for (const key of SECTION_KEYS) {
      const s = sections[key];
      expect(s, key).toBeDefined();
      expect(typeof s.title).toBe('string');
      expect(typeof s.summary).toBe('string');
      // The page reads d1, d2, … and stops at the first one missing, up to d10.
      const bullets = Object.keys(s).filter((k) => /^d\d+$/.test(k)).map((k) => Number(k.slice(1))).sort((a, b) => a - b);
      expect(bullets.length, key).toBeGreaterThan(0);
      expect(bullets, key).toEqual(bullets.map((_, i) => i + 1));
      expect(bullets.length, key).toBeLessThanOrEqual(10);
    }
  });

  test('every English section is shown on the page (none written and forgotten)', () => {
    expect(Object.keys(sections).sort()).toEqual([...SECTION_KEYS].sort());
  });

  // Help follows the app's words (2026-10-15): "Drink" / "Take out of the
  // cellar" / "Taken out", "Recently deleted", every feature free.
  test('uses the current words: nothing paid, nothing "consumed", no old menu paths', () => {
    const all = JSON.stringify(sections);
    expect(all).not.toMatch(/premium/i);
    expect(all).not.toMatch(/\bconsum/i);
    expect(all).not.toMatch(/Remove Bottle/);
    expect(all).not.toMatch(/"\.\.\." menu/);
    expect(all).not.toMatch(/10-point/);
  });

  test('says that pick lists are an early-access preview, and where to turn it on', () => {
    expect(sections.pickLists.title).toMatch(/early access/i);
    expect(sections.pickLists.d1).toMatch(/early-access preview/);
    expect(sections.pickLists.d1).toMatch(/Settings → Early access/);
  });

  test('names the Room view shortcuts the page really has', () => {
    const room = Object.values(sections.roomView).join(' ');
    for (const keys of ['Ctrl+Z', 'Ctrl+Y', 'Ctrl+Shift+Z', 'Shift+click', 'arrow keys', 'Esc']) {
      expect(room).toContain(keys);
    }
  });
});

describe('the page', () => {
  test('shows the newer sections', () => {
    at('/help');
    for (const key of ['vintagePage', 'openBottle', 'barcode', 'onOrder', 'selectMode', 'recentlyDeleted',
      'pickLists', 'wineLists', 'dashboard', 'offline', 'earlyAccess']) {
      expect(header(key)).toBeInTheDocument();
    }
  });

  test('/help#onOrder opens that section, closed ones stay closed, and it is scrolled into view', async () => {
    const { container } = at('/help#onOrder');
    expect(header('onOrder')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(sections.onOrder.d5)).toBeInTheDocument();
    expect(header('cellars')).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelector('#onOrder')).toContainElement(header('onOrder'));
    await nextFrame();
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  test('the address is forgiving about how the section is spelled', () => {
    expect(sectionKeyFor('onOrder')).toBe('onOrder');
    expect(sectionKeyFor('on-order')).toBe('onOrder');
    expect(sectionKeyFor('ONORDER')).toBe('onOrder');
    expect(sectionKeyFor('cellar-chat')).toBe('cellarChat');
    expect(sectionKeyFor('nothing-like-it')).toBeNull();
    expect(sectionKeyFor('')).toBeNull();
    at('/help#recently-deleted');
    expect(header('recentlyDeleted')).toHaveAttribute('aria-expanded', 'true');
  });

  test('an unknown or broken address opens nothing', () => {
    at('/help#%E0%A4%A');
    for (const key of SECTION_KEYS) expect(header(key)).toHaveAttribute('aria-expanded', 'false');
  });

  // The server spells its ids in kebab case ("cellar-chat"); matched on the
  // literal key, those sections never got their "Go to" link.
  test('a page the server names under a kebab-case id gets its "Go to" link', async () => {
    getHelpContent.mockResolvedValue({ sections: [{ id: 'cellar-chat', route: '/cellar-chat' }] });
    at('/help#cellarChat');
    expect(await screen.findByRole('link', { name: /Go to Cellar Chat/ })).toHaveAttribute('href', '/cellar-chat');
  });

  test('the Dashboard section links to the Dashboard', () => {
    at('/help#dashboard');
    expect(screen.getByRole('link', { name: /Go to Dashboard/ })).toHaveAttribute('href', '/dashboard');
  });

  test('pick lists link to their page only for members who have them', () => {
    const { unmount } = at('/help#pickLists');
    expect(screen.queryByRole('link', { name: /Go to Pick lists/ })).not.toBeInTheDocument();
    unmount();
    pickListsOn = true;
    at('/help#pickLists');
    expect(screen.getByRole('link', { name: /Go to Pick lists/ })).toHaveAttribute('href', '/pick-lists');
  });
});
