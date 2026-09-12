/**
 * Client-side mirror of backend/src/services/wineListPdf.js section building,
 * used for the editor's live preview (which must reflect unsaved state).
 * The public menu page gets its sections pre-built from the server.
 *
 * Output is a flat, pre-ordered list of `{ title, level, wines }`: `level`
 * is the heading depth (0 = section, 1 and 2 = nested headings) and wines
 * sit only under the deepest heading of their branch.
 */

export const TYPE_TITLES = {
  en: {
    red: 'Red Wines', white: 'White Wines', 'rosé': 'Rosé Wines',
    sparkling: 'Sparkling Wines', dessert: 'Dessert Wines', fortified: 'Fortified Wines',
  },
  sv: {
    red: 'Röda Viner', white: 'Vita Viner', 'rosé': 'Rosévin',
    sparkling: 'Mousserande Viner', dessert: 'Dessertviner', fortified: 'Starkvin',
  },
  fr: {
    red: 'Vins Rouges', white: 'Vins Blancs', 'rosé': 'Vins Rosés',
    sparkling: 'Vins Effervescents', dessert: 'Vins de Dessert', fortified: 'Vins Fortifiés',
  },
  de: {
    red: 'Rotweine', white: 'Weißweine', 'rosé': 'Roséweine',
    sparkling: 'Schaumweine', dessert: 'Dessertweine', fortified: 'Likörweine',
  },
  es: {
    red: 'Vinos Tintos', white: 'Vinos Blancos', 'rosé': 'Vinos Rosados',
    sparkling: 'Vinos Espumosos', dessert: 'Vinos de Postre', fortified: 'Vinos Fortificados',
  },
  it: {
    red: 'Vini Rossi', white: 'Vini Bianchi', 'rosé': 'Vini Rosati',
    sparkling: 'Spumanti', dessert: 'Vini da Dessert', fortified: 'Vini Liquorosi',
  },
};

export const GLASS_SECTION_TITLE = {
  en: 'Wines by the Glass', sv: 'Viner på glas', fr: 'Vins au Verre',
  de: 'Offene Weine', es: 'Vinos por Copa', it: 'Vini al Calice',
};

export const GLASS_LABEL = {
  en: 'glass', sv: 'glas', fr: 'verre', de: 'Glas', es: 'copa', it: 'bicchiere',
};

// The "last bottle" badge (layout.markLastBottle), in the list's language
export const LAST_BOTTLE_LABEL = {
  en: 'Last bottle', sv: 'Sista flaskan', fr: 'Dernière bouteille',
  de: 'Letzte Flasche', es: 'Última botella', it: 'Ultima bottiglia',
};

// Auto-mode grouping: the fields a heading level may group on, and the cap
export const LEVEL_FIELDS = ['type', 'country', 'region', 'appellation'];
export const MAX_LEVELS = 3;
const DEFAULT_TYPE_ORDER = ['sparkling', 'white', 'rosé', 'red', 'dessert', 'fortified'];

/**
 * The grouping levels in force: explicit `levels` (unknown fields and
 * repeats dropped, capped at three) or the legacy single `groupBy`.
 */
export function groupingLevels(grouping = {}) {
  const wanted = Array.isArray(grouping.levels) && grouping.levels.length
    ? grouping.levels
    : [grouping.groupBy || 'type'];
  const out = [];
  for (const level of wanted) {
    if (LEVEL_FIELDS.includes(level) && !out.includes(level)) out.push(level);
  }
  return out.length ? out.slice(0, MAX_LEVELS) : ['type'];
}

const keyOf = (e) =>
  `${e.wine?._id || e.wine}|${e.vintage || 'NV'}|${e.bottleSize || '750ml'}`;

// A taxonomy row's name in the LIST's language where it carries one, else
// the canonical name (mirror of backend utils/localizedName): Toskana on a
// German menu, but Bordeaux stays Bordeaux.
export function localName(doc, lang) {
  if (!doc) return '';
  const canonical = typeof doc.name === 'string' ? doc.name : '';
  const base = String(lang || 'en').toLowerCase().split(/[-_]/)[0];
  if (base === 'en' || !doc.translations) return canonical;
  const t = doc.translations[base];
  return typeof t === 'string' && t.trim() ? t.trim() : canonical;
}

function resolveEntry(entry, winesByKey, layout = {}, lang = 'en') {
  const item = winesByKey.get(keyOf(entry));
  if (!item) return null;
  if (layout.hideOutOfStock && item.stock === 0) return null;

  const wine = item.wine || {};
  return {
    key: keyOf(entry),
    name: wine.name || 'Unknown Wine',
    producer: wine.producer || '',
    vintage: entry.vintage || 'NV',
    bottleSize: entry.bottleSize || '750ml',
    country: localName(wine.country, lang),
    region: localName(wine.region, lang),
    appellation: wine.appellation || '',
    grapes: (wine.grapes || []).map(g => g.name).filter(Boolean),
    type: wine.type || '',
    price: entry.listPrice != null ? entry.listPrice : item.avgPrice,
    glassPrice: entry.byGlass && entry.glassPrice != null ? entry.glassPrice : null,
    byGlass: !!entry.byGlass,
    lastBottle: !!layout.markLastBottle && item.stock === 1,
    sortOrder: entry.sortOrder || 0,
  };
}

function getSortFn(withinGroup) {
  switch (withinGroup) {
    case 'price-asc':
      return (a, b) => (a.price || 0) - (b.price || 0);
    case 'price-desc':
      return (a, b) => (b.price || 0) - (a.price || 0);
    case 'vintage':
      return (a, b) => (a.vintage || '').localeCompare(b.vintage || '');
    case 'name':
      return (a, b) => a.name.localeCompare(b.name);
    case 'producer':
      return (a, b) =>
        (a.producer || '').localeCompare(b.producer || '') ||
        a.name.localeCompare(b.name) ||
        (a.vintage || '').localeCompare(b.vintage || '');
    case 'country-region-name':
    default:
      return (a, b) =>
        (a.country || '').localeCompare(b.country || '') ||
        (a.region || '').localeCompare(b.region || '') ||
        a.name.localeCompare(b.name);
  }
}

function formatTypeTitle(type, lang = 'en') {
  const titles = TYPE_TITLES[lang] || TYPE_TITLES.en;
  return titles[type] || type.charAt(0).toUpperCase() + type.slice(1);
}

// A wine missing the field of a nested level falls back up the geography —
// but never to the heading it already sits under: that goes to "Other", last.
function groupKeyOf(wine, level, parentKey) {
  if (level === 'type') return wine.type || 'other';
  if (level === 'country') return wine.country || 'Other';
  const key = level === 'region'
    ? (wine.region || wine.country)
    : (wine.appellation || wine.region || wine.country);
  return key && key !== parentKey ? key : 'Other';
}

function orderedGroups(wines, level, typeOrder, parentKey) {
  const groups = new Map();
  for (const wine of wines) {
    const key = groupKeyOf(wine, level, parentKey);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(wine);
  }
  let keys;
  if (level === 'type') {
    keys = typeOrder.filter(t => groups.has(t));
    for (const key of groups.keys()) {
      if (!keys.includes(key)) keys.push(key);
    }
  } else {
    keys = [...groups.keys()].sort((a, b) =>
      (a === 'Other') - (b === 'Other') || a.localeCompare(b));
  }
  return keys.map(key => ({ key, wines: groups.get(key) }));
}

function buildCustomSections(wineList, winesByKey) {
  const layout = wineList.layout || {};
  const sorted = [...(wineList.sections || [])].sort((a, b) => a.sortOrder - b.sortOrder);

  return sorted.map(section => ({
    title: section.title,
    level: 0,
    wines: (section.entries || [])
      .map(e => resolveEntry(e, winesByKey, layout, wineList.language || 'en'))
      .filter(Boolean)
      .sort((a, b) => a.sortOrder - b.sortOrder),
  })).filter(s => s.wines.length > 0);
}

// Nested headings walked depth-first; a nested heading that would hold a
// single group is skipped unless collapseSingle is off. The top level is
// never skipped.
function buildAutoSections(wineList, winesByKey) {
  const layout = wineList.layout || {};
  const grouping = wineList.autoGrouping || {};
  const levels = groupingLevels(grouping);
  const typeOrder = grouping.typeOrder || DEFAULT_TYPE_ORDER;
  const collapse = grouping.collapseSingle !== false;
  const sortFn = getSortFn(grouping.withinGroup || 'country-region-name');
  const lang = wineList.language || 'en';

  const wines = (wineList.autoGroupEntries || [])
    .map(e => resolveEntry(e, winesByKey, layout, wineList.language || 'en'))
    .filter(Boolean);

  const out = [];
  const walk = (subset, depth, level, parent, parentKey) => {
    if (depth >= levels.length) {
      parent.wines = [...subset].sort(sortFn);
      return;
    }
    const groups = orderedGroups(subset, levels[depth], typeOrder, parentKey);
    if (collapse && depth > 0 && groups.length === 1) {
      walk(subset, depth + 1, level, parent, parentKey);
      return;
    }
    for (const group of groups) {
      const section = {
        title: levels[depth] === 'type' ? formatTypeTitle(group.key, lang) : group.key,
        level,
        wines: [],
      };
      out.push(section);
      walk(group.wines, depth + 1, level + 1, section, group.key);
    }
  };
  walk(wines, 0, 0, null, null);
  return out;
}

/**
 * Build menu sections from a wine list and the editor's wine data.
 *
 * @param {Object} wineList - wine list state (entries in wine+vintage+size form)
 * @param {Map<string, Object>} winesByKey - Map of entry key → picker item
 *   ({ wine, vintage, bottleSize, stock, avgPrice })
 */
export function buildSections(wineList, winesByKey) {
  const sections = wineList.structureMode === 'custom'
    ? buildCustomSections(wineList, winesByKey)
    : buildAutoSections(wineList, winesByKey);

  if (wineList.layout?.glassSectionFirst) {
    const seen = new Set();
    const glassWines = [];
    for (const section of sections) {
      for (const wine of section.wines) {
        if (wine.glassPrice == null || seen.has(wine.key)) continue;
        seen.add(wine.key);
        glassWines.push(wine);
      }
    }
    if (glassWines.length > 0) {
      const lang = wineList.language || 'en';
      sections.unshift({
        title: GLASS_SECTION_TITLE[lang] || GLASS_SECTION_TITLE.en,
        level: 0,
        wines: glassWines,
        isGlassSection: true,
      });
    }
  }

  return sections;
}
