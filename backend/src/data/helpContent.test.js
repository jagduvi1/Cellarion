/**
 * The server's copy of the Help text (data/helpContent.js).
 *
 * It is printed on the crawler page /og/help and gives the Help page its
 * "Go to …" links, so it drifts silently when screens change: it once still
 * said "Remove Bottle", "consumed" and Premium limits long after the app had
 * moved on. These tests pin the shape the consumers read, the words the app
 * no longer uses, and that every section the Help page shows exists here.
 */

const { sections } = require('./helpContent');

// SECTION_KEYS in frontend/src/pages/Help.js. Add a key here when the Help
// page gets a new section, and give it a section in helpContent.js.
const FRONTEND_SECTION_KEYS = [
  'cellars', 'bottles', 'vintagePage', 'openBottle', 'labelScan', 'barcode',
  'onOrder', 'selectMode', 'recentlyDeleted', 'sharing', 'racks', 'roomView',
  'pickLists', 'wineLists', 'wishlist', 'restock', 'journal', 'recommendations',
  'cellarChat', 'analytics', 'dashboard', 'community', 'wineRequests', 'import',
  'settings', 'offline', 'earlyAccess', 'history', 'other',
];

// The Help page's own matching rule (sectionKeyFor in Help.js).
const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const userText = (s) => [s.title, s.summary, ...s.details];

describe('helpContent', () => {
  test('every section has the shape its consumers read', () => {
    expect(Array.isArray(sections)).toBe(true);
    for (const s of sections) {
      expect(s.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(typeof s.title).toBe('string');
      expect(s.title.trim()).not.toBe('');
      expect(typeof s.summary).toBe('string');
      expect(s.summary.trim()).not.toBe('');
      expect(Array.isArray(s.details)).toBe(true);
      expect(s.details.length).toBeGreaterThan(0);
      for (const d of s.details) {
        expect(typeof d).toBe('string');
        expect(d.trim()).not.toBe('');
      }
      expect(s.route === null || (typeof s.route === 'string' && s.route.startsWith('/'))).toBe(true);
      expect(s).toHaveProperty('tourId');
    }
  });

  test('section ids are unique, also after squashing', () => {
    const squashed = sections.map(s => squash(s.id));
    expect(new Set(squashed).size).toBe(sections.length);
  });

  test.each(FRONTEND_SECTION_KEYS)('the Help page section "%s" has a server section', (key) => {
    const matches = sections.filter(s => squash(s.id) === squash(key));
    expect(matches).toHaveLength(1);
  });

  test('every server section belongs to a Help page section', () => {
    const keys = new Set(FRONTEND_SECTION_KEYS.map(squash));
    const orphans = sections.filter(s => !keys.has(squash(s.id))).map(s => s.id);
    expect(orphans).toEqual([]);
  });

  test('no section uses words the app no longer uses', () => {
    const banned = [
      // the old button; it is "Drink" → "Take out of the cellar" now
      // ("add and remove bottles", an editor's rights, is fine)
      /\bremove bottle\b/i,
      /consumed/i, // a bottle that left is "Taken out"
      /premium/i, // every feature is free; there is no paid tier with more
      /"\.\.\."/, // the old "..." menu is the ⋮ menu
    ];
    const hits = [];
    for (const s of sections) {
      for (const text of userText(s)) {
        for (const re of banned) {
          if (re.test(text)) hits.push(`${s.id}: ${re} in "${text}"`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  test('pick lists say where early access is, whatever state their flag is in, and offer no page link', () => {
    const pick = sections.find(s => s.id === 'pick-lists');
    expect(pick).toBeDefined();
    expect(userText(pick).join(' ')).toMatch(/early access/i);
    // The Help page links to /pick-lists only for members who have it; a
    // route here would override that.
    expect(pick.route).toBeNull();
  });
});

describe('the supporter tiers', () => {
  test('come from the plans, so a price change reaches the help text', () => {
    const { PLANS } = require('../config/plans');
    const other = sections.find(s => s.id === 'other').details.join(' ');
    for (const k of ['supporter', 'patron', 'benefactor']) {
      expect(other).toContain(`${PLANS[k].label} ($${PLANS[k].price}/mo)`);
    }
  });
});
