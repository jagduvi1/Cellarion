/**
 * Client-side mirror of backend/src/services/wineListPdf.js section building,
 * used for the editor's live preview (which must reflect unsaved state).
 * The public menu page gets its sections pre-built from the server.
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

const keyOf = (e) =>
  `${e.wine?._id || e.wine}|${e.vintage || 'NV'}|${e.bottleSize || '750ml'}`;

function resolveEntry(entry, winesByKey, layout = {}) {
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
    country: wine.country?.name || '',
    region: wine.region?.name || '',
    grapes: (wine.grapes || []).map(g => g.name).filter(Boolean),
    type: wine.type || '',
    price: entry.listPrice != null ? entry.listPrice : item.avgPrice,
    glassPrice: entry.byGlass && entry.glassPrice != null ? entry.glassPrice : null,
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

function buildCustomSections(wineList, winesByKey) {
  const layout = wineList.layout || {};
  const sorted = [...(wineList.sections || [])].sort((a, b) => a.sortOrder - b.sortOrder);

  return sorted.map(section => ({
    title: section.title,
    wines: (section.entries || [])
      .map(e => resolveEntry(e, winesByKey, layout))
      .filter(Boolean)
      .sort((a, b) => a.sortOrder - b.sortOrder),
  })).filter(s => s.wines.length > 0);
}

function buildAutoSections(wineList, winesByKey) {
  const layout = wineList.layout || {};
  const grouping = wineList.autoGrouping || {};
  const groupBy = grouping.groupBy || 'type';
  const typeOrder = grouping.typeOrder || ['sparkling', 'white', 'rosé', 'red', 'dessert', 'fortified'];
  const withinGroup = grouping.withinGroup || 'country-region-name';
  const lang = wineList.language || 'en';

  const wines = (wineList.autoGroupEntries || [])
    .map(e => resolveEntry(e, winesByKey, layout))
    .filter(Boolean);

  const groups = new Map();
  for (const wine of wines) {
    let key;
    if (groupBy === 'type') key = wine.type || 'other';
    else if (groupBy === 'country') key = wine.country || 'Other';
    else key = wine.region || wine.country || 'Other';

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(wine);
  }

  let sortedKeys;
  if (groupBy === 'type') {
    sortedKeys = typeOrder.filter(t => groups.has(t));
    for (const key of groups.keys()) {
      if (!sortedKeys.includes(key)) sortedKeys.push(key);
    }
  } else {
    sortedKeys = [...groups.keys()].sort();
  }

  const sortFn = getSortFn(withinGroup);

  return sortedKeys.map(key => {
    const sectionWines = groups.get(key);
    sectionWines.sort(sortFn);
    const title = groupBy === 'type' ? formatTypeTitle(key, lang) : key;
    return { title, wines: sectionWines };
  }).filter(s => s.wines.length > 0);
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
        wines: glassWines,
        isGlassSection: true,
      });
    }
  }

  return sections;
}
