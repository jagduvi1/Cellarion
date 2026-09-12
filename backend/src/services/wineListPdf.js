const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { entryKey } = require('./wineListData');
const { localizedName } = require('../utils/localizedName');

// Page dimensions (points, 72pt = 1 inch)
const PAGE_SIZES = {
  A4: [595.28, 841.89],
  letter: [612, 792],
};

// Color schemes
const COLOR_SCHEMES = {
  classic:  { heading: '#2c1810', subheading: '#5c3a2e', text: '#333333', accent: '#8b0000', line: '#cccccc' },
  modern:   { heading: '#1a1a2e', subheading: '#16213e', text: '#2d2d2d', accent: '#0f3460', line: '#e0e0e0' },
  elegant:  { heading: '#2c2c2c', subheading: '#555555', text: '#444444', accent: '#8b6914', line: '#d4c5a9' },
  minimal:  { heading: '#000000', subheading: '#666666', text: '#333333', accent: '#999999', line: '#eeeeee' },
};

// Multi-language section titles for auto-grouped wine types
const TYPE_TITLES = {
  en: {
    red: 'Red Wines', white: 'White Wines', rosé: 'Rosé Wines',
    sparkling: 'Sparkling Wines', dessert: 'Dessert Wines', fortified: 'Fortified Wines',
  },
  sv: {
    red: 'Röda Viner', white: 'Vita Viner', rosé: 'Rosévin',
    sparkling: 'Mousserande Viner', dessert: 'Dessertviner', fortified: 'Starkvin',
  },
  fr: {
    red: 'Vins Rouges', white: 'Vins Blancs', rosé: 'Vins Rosés',
    sparkling: 'Vins Effervescents', dessert: 'Vins de Dessert', fortified: 'Vins Fortifiés',
  },
  de: {
    red: 'Rotweine', white: 'Weißweine', rosé: 'Roséweine',
    sparkling: 'Schaumweine', dessert: 'Dessertweine', fortified: 'Likörweine',
  },
  es: {
    red: 'Vinos Tintos', white: 'Vinos Blancos', rosé: 'Vinos Rosados',
    sparkling: 'Vinos Espumosos', dessert: 'Vinos de Postre', fortified: 'Vinos Fortificados',
  },
  it: {
    red: 'Vini Rossi', white: 'Vini Bianchi', rosé: 'Vini Rosati',
    sparkling: 'Spumanti', dessert: 'Vini da Dessert', fortified: 'Vini Liquorosi',
  },
};

// Glass label translations
const GLASS_LABEL = {
  en: 'glass', sv: 'glas', fr: 'verre', de: 'Glas', es: 'copa', it: 'bicchiere',
};

// "Wines by the Glass" lead-section titles
const GLASS_SECTION_TITLE = {
  en: 'Wines by the Glass', sv: 'Viner på glas', fr: 'Vins au Verre',
  de: 'Offene Weine', es: 'Vinos por Copa', it: 'Vini al Calice',
};

// The "last bottle" marker (layout.markLastBottle), in the list's language.
// The PDF prints an asterisk after the wine and this text as a legend; the
// web menu shows it as a small badge.
const LAST_BOTTLE_LABEL = {
  en: 'Last bottle', sv: 'Sista flaskan', fr: 'Dernière bouteille',
  de: 'Letzte Flasche', es: 'Última botella', it: 'Ultima bottiglia',
};

// Suffix on a heading repeated after a page break
const CONTINUED_LABEL = {
  en: 'continued', sv: 'forts.', fr: 'suite', de: 'Fortsetzung', es: 'continuación', it: 'continua',
};

// Auto-mode grouping: the fields a heading level may group on, outermost
// first in the classic menu order, and the depth cap (support ticket
// 2026-09-12 — a menu reads naturally at three).
const LEVEL_FIELDS = ['type', 'country', 'region', 'appellation'];
const MAX_LEVELS = 3;
const DEFAULT_TYPE_ORDER = ['sparkling', 'white', 'rosé', 'red', 'dessert', 'fortified'];

/**
 * The grouping levels in force for an auto-mode list: the explicit `levels`
 * (unknown fields and repeats dropped, capped at three) or, for lists saved
 * before nested grouping existed, the single legacy `groupBy`.
 */
function groupingLevels(grouping = {}) {
  const wanted = Array.isArray(grouping.levels) && grouping.levels.length
    ? grouping.levels
    : [grouping.groupBy || 'type'];
  const out = [];
  for (const level of wanted) {
    if (LEVEL_FIELDS.includes(level) && !out.includes(level)) out.push(level);
  }
  return out.length ? out.slice(0, MAX_LEVELS) : ['type'];
}

// A wine missing the field of a nested level falls back up the geography —
// but never to the heading it already sits under ("Italy › Italy"): that
// goes to "Other", which sorts last.
function groupKeyOf(wine, level, parentKey) {
  if (level === 'type') return wine.type || 'other';
  if (level === 'country') return wine.country || 'Other';
  const key = level === 'region'
    ? (wine.region || wine.country)
    : (wine.appellation || wine.region || wine.country);
  return key && key !== parentKey ? key : 'Other';
}

/** Split wines into ordered groups on one level: types in menu order, everything else A–Z, "Other" last. */
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

/**
 * Build structured sections from a WineList document and its wine map
 * (Map<entryKey, { wine, stock, avgPrice }> from wineListData.loadWineMap).
 *
 * Returns a flat, pre-ordered list of `{ title, level, wines }`: `level` is
 * the heading depth (0 = a section, 1 and 2 = nested headings under it) and
 * wines sit only under the deepest heading of their branch — a heading that
 * only introduces deeper headings has an empty `wines`. Custom-mode sections
 * and the by-the-glass lead section are always level 0.
 */
function buildSections(wineList, wineMap) {
  const sections = wineList.structureMode === 'custom'
    ? buildCustomSections(wineList, wineMap)
    : buildAutoSections(wineList, wineMap);

  // Optional lead section gathering everything served by the glass — the
  // standard format on restaurant lists. Wines stay in their regular
  // sections too.
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

// `lang` is the LIST's language: country and region print in it where the
// taxonomy row carries that name, else the canonical name (Toskana, but
// Bordeaux stays Bordeaux) — support ticket 2026-09-12.
function resolveEntry(entry, wineMap, layout = {}, lang = 'en') {
  const key = entryKey(entry);
  const info = wineMap.get(key);
  if (!info) return null; // wine no longer in the registry
  if (layout.hideOutOfStock && info.stock === 0) return null;

  const wine = info.wine;
  return {
    key,
    name: wine.name || 'Unknown Wine',
    producer: wine.producer || '',
    vintage: entry.vintage || 'NV',
    bottleSize: entry.bottleSize || '750ml',
    country: wine.country ? localizedName(wine.country, lang) : '',
    region: wine.region ? localizedName(wine.region, lang) : '',
    appellation: wine.appellation || '',
    grapes: (wine.grapes || []).map(g => g.name).filter(Boolean),
    type: wine.type || '',
    price: entry.listPrice != null ? entry.listPrice : info.avgPrice,
    glassPrice: entry.byGlass && entry.glassPrice != null ? entry.glassPrice : null,
    // Kept apart from glassPrice so a hidden-price menu can still say
    // "by the glass" and still build the by-the-glass lead section.
    byGlass: !!entry.byGlass,
    // Live cellar stock of exactly one — the marker is only ever shown for
    // the last bottle, never a count (support ticket 2026-09-12).
    lastBottle: !!layout.markLastBottle && info.stock === 1,
    sortOrder: entry.sortOrder || 0,
    stock: info.stock,
    wineDefinitionId: wine._id?.toString(),
  };
}

function buildCustomSections(wineList, wineMap) {
  const layout = wineList.layout || {};
  const sorted = [...(wineList.sections || [])].sort((a, b) => a.sortOrder - b.sortOrder);

  return sorted.map(section => {
    const wines = (section.entries || [])
      .map(e => resolveEntry(e, wineMap, layout, wineList.language || 'en'))
      .filter(Boolean)
      .sort((a, b) => a.sortOrder - b.sortOrder);

    return { title: section.title, level: 0, wines };
  }).filter(s => s.wines.length > 0);
}

/**
 * Auto mode: nested headings from the wine records — e.g. type › country ›
 * region — walked depth-first. A nested heading that would hold a single
 * group says nothing (one dessert wine → "Dessert" straight to the wine, not
 * Dessert › France › Sauternes), so it is skipped unless the list turns
 * `collapseSingle` off. The top level is never skipped: a list of only reds
 * still says "Red Wines".
 */
function buildAutoSections(wineList, wineMap) {
  const layout = wineList.layout || {};
  const grouping = wineList.autoGrouping || {};
  const levels = groupingLevels(grouping);
  const typeOrder = grouping.typeOrder || DEFAULT_TYPE_ORDER;
  const collapse = grouping.collapseSingle !== false;
  const sortFn = getSortFn(grouping.withinGroup || 'country-region-name');
  const lang = wineList.language || 'en';

  const wines = (wineList.autoGroupEntries || [])
    .map(e => resolveEntry(e, wineMap, layout, wineList.language || 'en'))
    .filter(Boolean);

  const out = [];
  // `depth` indexes `levels`; `level` is the rendered heading depth, which
  // falls behind `depth` once a singleton heading has been skipped.
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
      return (a, b) => {
        const cmp = (a.country || '').localeCompare(b.country || '');
        if (cmp !== 0) return cmp;
        const rcmp = (a.region || '').localeCompare(b.region || '');
        if (rcmp !== 0) return rcmp;
        return a.name.localeCompare(b.name);
      };
  }
}

function formatTypeTitle(type, lang = 'en') {
  const titles = TYPE_TITLES[lang] || TYPE_TITLES.en;
  return titles[type] || type.charAt(0).toUpperCase() + type.slice(1);
}

/**
 * Generate a wine list PDF and return a readable stream.
 *
 * @param {Object} wineList - WineList document
 * @param {Map<string, Object>} wineMap - Map from wineListData.loadWineMap
 * @param {Object} [opts] - Optional: { publicUrl } for QR code
 * @returns {Promise<PDFDocument>} - A PDFKit document (readable stream)
 */
async function generateWineListPdf(wineList, wineMap, opts = {}) {
  const layout = wineList.layout || {};
  const branding = wineList.branding || {};
  const lang = wineList.language || 'en';
  const scheme = COLOR_SCHEMES[layout.colorScheme] || COLOR_SCHEMES.classic;
  const pageSize = PAGE_SIZES[layout.pageSize] || PAGE_SIZES.A4;
  const font = layout.fontFamily === 'sans-serif' ? 'Helvetica' : 'Times-Roman';
  const fontBold = layout.fontFamily === 'sans-serif' ? 'Helvetica-Bold' : 'Times-Bold';
  const fontItalic = layout.fontFamily === 'sans-serif' ? 'Helvetica-Oblique' : 'Times-Italic';
  const currencySymbol = layout.currencySymbol || '$';
  const glassLabel = GLASS_LABEL[lang] || GLASS_LABEL.en;

  const margin = 50;
  const contentWidth = pageSize[0] - margin * 2;

  // Generate QR code buffer if we have a public URL
  let qrBuffer = null;
  if (opts.publicUrl) {
    try {
      qrBuffer = await QRCode.toBuffer(opts.publicUrl, {
        width: 60, margin: 1, color: { dark: scheme.text, light: '#ffffff00' },
      });
    } catch (e) {
      // Skip QR if generation fails
    }
  }

  const doc = new PDFDocument({
    size: pageSize,
    margins: { top: margin, bottom: margin, left: margin, right: margin },
    info: {
      Title: wineList.name || 'Wine List',
      Author: branding.restaurantName || 'Cellarion',
      Creator: 'Cellarion Wine Cellar Manager',
    },
    bufferPages: true,
  });

  const sections = buildSections(wineList, wineMap);
  const hidePrices = !!layout.hidePrices;
  const newPageEachSection = !!layout.newPageEachSection;
  const continuedLabel = CONTINUED_LABEL[lang] || CONTINUED_LABEL.en;
  // The legacy single-level "type, then country — region" run-in sub-headers
  // only make sense when there is no nested heading doing that job.
  const levelsInForce = wineList.structureMode === 'auto' ? groupingLevels(wineList.autoGrouping || {}) : [];
  const legacySubHeaders = levelsInForce.length === 1 && levelsInForce[0] === 'type' &&
    wineList.autoGrouping?.withinGroup === 'country-region-name';
  let anyLastBottle = false;
  // Approximate heights of a heading per level, and of the first entry —
  // a heading stack (type › country › region) breaks the page as ONE unit
  // so no heading is ever orphaned at the foot of a page.
  const HEADING_HEIGHT = [42, 22, 15];
  const FIRST_ENTRY_HEIGHT = 26;
  // Content must stay above this line: everything written below the bottom
  // margin makes PDFKit open a new page by itself.
  const bottomLimit = pageSize[1] - margin;

  const renderHeading = (section, { first = false, continued = false } = {}) => {
    const level = section.level || 0;
    const title = continued ? `${section.title} (${continuedLabel})` : section.title;
    if (level === 0) {
      doc.moveDown(first ? 0.5 : 1.2);
      doc.font(fontBold).fontSize(13).fillColor(scheme.accent);
      doc.text(title.toUpperCase(), margin, doc.y, { width: contentWidth });
      doc.moveDown(0.2);
      doc.moveTo(margin, doc.y).lineTo(margin + contentWidth, doc.y)
        .strokeColor(scheme.line).lineWidth(0.5).stroke();
      doc.moveDown(0.4);
    } else if (level === 1) {
      doc.moveDown(0.6);
      doc.font(fontBold).fontSize(10.5).fillColor(scheme.subheading);
      doc.text(title, margin + 10, doc.y, { width: contentWidth - 10 });
      doc.moveDown(0.25);
    } else {
      doc.moveDown(0.3);
      doc.font(fontItalic).fontSize(9).fillColor(scheme.subheading);
      doc.text(title, margin + 20, doc.y, { width: contentWidth - 20 });
      doc.moveDown(0.15);
    }
  };

  // The headings the current wines sit under (one per level). A page break
  // in the middle of a group repeats them, marked as continued, so a reader
  // turning the page still knows where the wines are from.
  const stack = [];
  const breakPage = ({ repeatHeadings }) => {
    doc.addPage();
    if (!repeatHeadings) return;
    stack.forEach((s, idx) => renderHeading(s, { first: idx === 0, continued: true }));
  };

  // --- Header ---
  renderHeader(doc, branding, scheme, fontBold, fontItalic, contentWidth, margin, qrBuffer);

  // --- Sections ---
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    const level = section.level || 0;
    stack.length = level;
    stack[level] = section;

    if (level === 0 && i > 0 && newPageEachSection) {
      breakPage({ repeatHeadings: false });
    } else {
      // Room for this heading, the deeper headings that follow it before the
      // first wine, and that wine — else start a new page here.
      let need = HEADING_HEIGHT[Math.min(level, 2)] + FIRST_ENTRY_HEIGHT;
      for (let k = i + 1; k < sections.length && (sections[k].level || 0) > level && !section.wines.length; k++) {
        need += HEADING_HEIGHT[Math.min(sections[k].level || 0, 2)];
        if (sections[k].wines.length) break;
      }
      if (doc.y > bottomLimit - Math.max(need, level === 0 ? 80 : 0)) {
        breakPage({ repeatHeadings: false });
      }
    }

    renderHeading(section, { first: i === 0 || doc.y <= margin + 1 });

    let lastSubHeader = null;

    for (const wine of section.wines) {
      if (wine.lastBottle) anyLastBottle = true;

      let sub = null;
      if (!section.isGlassSection && legacySubHeaders) {
        sub = wine.region ? `${wine.country} — ${wine.region}` : wine.country;
        if (sub === lastSubHeader) sub = null;
      }

      // An entry is never split: name + price line, and the producer/grape
      // line under it, move to the next page together (with a pending
      // run-in sub-header, which would otherwise be orphaned).
      const need = entryHeight(wine) + (sub ? 20 : 0);
      if (doc.y + need > bottomLimit) {
        breakPage({ repeatHeadings: true });
        lastSubHeader = null;
        if (legacySubHeaders && !section.isGlassSection) {
          sub = wine.region ? `${wine.country} — ${wine.region}` : wine.country;
        }
      }

      if (sub) {
        lastSubHeader = sub;
        doc.moveDown(0.2);
        doc.font(fontItalic).fontSize(9).fillColor(scheme.subheading);
        doc.text(sub, margin + 10, doc.y, { width: contentWidth - 10, lineBreak: false });
        doc.moveDown(0.2);
      }

      renderWineEntry(doc, wine, {
        margin, contentWidth, font, fontBold, fontItalic,
        scheme, currencySymbol, glassLabel, hidePrices,
      });
    }
  }

  // Legend for the "last bottle" asterisk, once, under the last section
  if (anyLastBottle) {
    if (doc.y + 30 > bottomLimit) breakPage({ repeatHeadings: false });
    doc.moveDown(1);
    doc.font(fontItalic).fontSize(8).fillColor(scheme.subheading);
    doc.text(`* ${LAST_BOTTLE_LABEL[lang] || LAST_BOTTLE_LABEL.en}`, margin, doc.y, { width: contentWidth, lineBreak: false });
  }

  // Page numbers + footer on all pages. They sit INSIDE the bottom margin, so
  // the margin is lifted while they are stamped — otherwise PDFKit treats
  // each of them as overflow and appends a blank page per element per page
  // (support ticket 2026-09-12: a 4-page menu came out as 12).
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    if (branding.footerText) {
      doc.font(fontItalic).fontSize(7).fillColor(scheme.subheading);
      doc.text(branding.footerText, margin, pageSize[1] - margin + 5, {
        width: contentWidth, align: 'center', lineBreak: false,
      });
    }

    doc.font(font).fontSize(7).fillColor(scheme.subheading);
    doc.text(`${i + 1} / ${range.count}`, margin, pageSize[1] - margin + 16, {
      width: contentWidth, align: 'center', lineBreak: false,
    });

    doc.page.margins.bottom = savedBottom;
  }

  doc.end();
  return doc;
}

/** Height renderWineEntry will use for a wine (see its final `doc.y` line). */
function entryHeight(wine) {
  const grapes = (wine.grapes || []).slice(0, 3).join(', ');
  const producerRegion = [wine.producer, wine.region].filter(Boolean).join(' — ');
  return [producerRegion, grapes].filter(Boolean).length ? 26 : 15;
}

/** "CHF 16" but "$16": a space after a symbol made of letters, none after a sign. */
function priceWithSymbol(symbol, amount) {
  const sep = /[A-Za-z]$/.test(symbol) ? ' ' : '';
  return `${symbol}${sep}${amount}`;
}

// Server-generated logo URLs are always `wine-list-logos/<uuid>.<ext>` — anything
// else (in particular anything with path separators or dots beyond the extension)
// is rejected before it reaches path.join, as defense in depth against traversal.
const LOGO_URL_PATTERN = /^wine-list-logos\/[a-f0-9-]+\.(jpg|png|webp)$/;

function renderHeader(doc, branding, scheme, fontBold, fontItalic, contentWidth, margin, qrBuffer) {
  // Logo
  if (branding.logoUrl && LOGO_URL_PATTERN.test(branding.logoUrl)) {
    try {
      const logoPath = path.join('/app/uploads', branding.logoUrl);
      if (fs.existsSync(logoPath)) {
        doc.image(logoPath, (doc.page.width - 80) / 2, margin, { fit: [80, 80] });
        doc.y = margin + 85;
      }
    } catch (e) {
      // Skip logo if invalid
    }
  }

  // Restaurant name
  if (branding.restaurantName) {
    doc.font(fontBold).fontSize(22).fillColor(scheme.heading);
    doc.text(branding.restaurantName, margin, doc.y, { width: contentWidth, align: 'center' });
  }

  // Tagline
  if (branding.tagline) {
    doc.moveDown(0.1);
    doc.font(fontItalic).fontSize(10).fillColor(scheme.subheading);
    doc.text(branding.tagline, { width: contentWidth, align: 'center' });
  }

  // QR code — top-right corner
  const qrSize = 50;
  if (qrBuffer) {
    const qrX = margin + contentWidth - qrSize;
    const qrY = margin;
    doc.image(qrBuffer, qrX, qrY, { width: qrSize, height: qrSize });
  }

  // Decorative line — below the QR code, never through it
  doc.moveDown(0.5);
  if (qrBuffer) doc.y = Math.max(doc.y, margin + qrSize + 8);
  doc.moveTo(margin, doc.y).lineTo(margin + contentWidth, doc.y)
    .strokeColor(scheme.accent).lineWidth(1).stroke();
  doc.moveDown(0.3);
}

function renderWineEntry(doc, wine, opts) {
  const { margin, contentWidth, font, fontBold, fontItalic, scheme, currencySymbol, glassLabel, hidePrices } = opts;
  const indent = margin + 20;
  const priceColWidth = 100;
  const nameColWidth = contentWidth - 20 - priceColWidth;

  const vintage = wine.vintage && wine.vintage !== 'NV' ? wine.vintage : 'NV';
  // Non-standard formats (magnums, halves) are listed explicitly
  const sizeSuffix = wine.bottleSize && wine.bottleSize !== '750ml' ? ` (${wine.bottleSize})` : '';
  // The last-bottle asterisk is explained by a legend under the last section
  const displayName = `${wine.name}, ${vintage}${sizeSuffix}${wine.lastBottle ? ' *' : ''}`;

  const y = doc.y;

  doc.font(fontBold).fontSize(9.5).fillColor(scheme.text);
  doc.text(displayName, indent, y, { width: nameColWidth, lineBreak: false });

  // A wine can be glass-only (no bottle price known) — render whichever
  // prices exist rather than gating the glass price on the bottle price.
  // With prices hidden, a by-the-glass wine still says so, without a figure.
  const priceParts = [];
  if (hidePrices) {
    if (wine.byGlass) priceParts.push(glassLabel);
  } else {
    if (wine.price != null) priceParts.push(priceWithSymbol(currencySymbol, wine.price.toFixed(0)));
    if (wine.glassPrice != null) priceParts.push(`${priceWithSymbol(currencySymbol, wine.glassPrice.toFixed(0))} ${glassLabel}`);
  }
  const priceText = priceParts.join(' / ');
  if (priceText) {
    doc.font(font).fontSize(9.5).fillColor(scheme.text);
    doc.text(priceText, margin + contentWidth - priceColWidth, y, {
      width: priceColWidth, align: 'right', lineBreak: false,
    });

    const nameW = Math.min(doc.widthOfString(displayName, { font: fontBold, fontSize: 9.5 }), nameColWidth);
    const dotsStart = indent + nameW + 4;
    const dotsEnd = margin + contentWidth - priceColWidth - 4;
    if (dotsEnd > dotsStart + 8) {
      doc.font(font).fontSize(7).fillColor(scheme.line);
      let dx = dotsStart;
      const dotY = y + 2;
      while (dx < dotsEnd) {
        doc.text('.', dx, dotY, { lineBreak: false });
        dx += 3.5;
      }
    }
  }

  const grapes = (wine.grapes || []).slice(0, 3).join(', ');
  const producerRegion = [wine.producer, wine.region].filter(Boolean).join(' — ');
  const details = [producerRegion, grapes].filter(Boolean).join(' · ');
  if (details) {
    doc.font(fontItalic).fontSize(8).fillColor(scheme.subheading);
    doc.text(details, indent, y + 13, { width: nameColWidth + priceColWidth, lineBreak: false });
  }

  doc.y = y + (details ? 26 : 15);
}

module.exports = {
  generateWineListPdf, buildSections, resolveEntry, groupingLevels, priceWithSymbol,
  LEVEL_FIELDS, MAX_LEVELS, LAST_BOTTLE_LABEL, CONTINUED_LABEL,
};
