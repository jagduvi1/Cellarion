/**
 * The Help page's sections, in page order. Each key is also the section's
 * address: /help#onOrder opens that section (pages/Help).
 */
export const SECTION_KEYS = [
  'cellars', 'bottles', 'vintagePage', 'openBottle', 'labelScan', 'barcode',
  'onOrder', 'selectMode', 'recentlyDeleted', 'sharing', 'racks', 'roomView',
  'pickLists', 'wineLists', 'wishlist', 'restock', 'journal', 'recommendations',
  'cellarChat', 'analytics', 'dashboard', 'community', 'wineRequests', 'import',
  'settings', 'offline', 'earlyAccess', 'history', 'other',
];

// "onOrder", "on-order" and "onorder" all name the same section: these links
// are typed by people (support answers, forum posts), and the server's help
// content spells its ids in kebab case ("cellar-chat" for cellarChat).
const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** The section key an address or a server id names, or null. */
export function sectionKeyFor(id) {
  const wanted = squash(id);
  return wanted ? SECTION_KEYS.find(k => squash(k) === wanted) || null : null;
}
