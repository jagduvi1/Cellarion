const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

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

/**
 * Build structured sections from a populated WineList document.
 * Returns an array of { title, wines[] }.
 */
function buildSections(wineList, bottleMap) {
  if (wineList.structureMode === 'custom') {
    return buildCustomSections(wineList, bottleMap);
  }
  return buildAutoSections(wineList, bottleMap);
}

function resolveEntry(entry, bottleMap) {
  const bottle = bottleMap.get(entry.bottle.toString());
  if (!bottle || bottle.status !== 'active') return null;

  const wine = bottle.wineDefinition || {};
  return {
    name: wine.name || 'Unknown Wine',
    producer: wine.producer || '',
    vintage: bottle.vintage || 'NV',
    country: wine.country?.name || '',
    region: wine.region?.name || '',
    type: wine.type || '',
    price: entry.listPrice != null ? entry.listPrice : bottle.price,
    glassPrice: entry.glassPrice,
    sortOrder: entry.sortOrder || 0,
  };
}

function buildCustomSections(wineList, bottleMap) {
  const sorted = [...(wineList.sections || [])].sort((a, b) => a.sortOrder - b.sortOrder);

  return sorted.map(section => {
    const wines = (section.entries || [])
      .map(e => resolveEntry(e, bottleMap))
      .filter(Boolean)
      .sort((a, b) => a.sortOrder - b.sortOrder);

    return { title: section.title, wines };
  }).filter(s => s.wines.length > 0);
}

function buildAutoSections(wineList, bottleMap) {
  const grouping = wineList.autoGrouping || {};
  const groupBy = grouping.groupBy || 'type';
  const typeOrder = grouping.typeOrder || ['sparkling', 'white', 'rosé', 'red', 'dessert', 'fortified'];
  const withinGroup = grouping.withinGroup || 'country-region-name';

  const wines = (wineList.autoGroupEntries || [])
    .map(e => resolveEntry(e, bottleMap))
    .filter(Boolean);

  // Group wines
  const groups = new Map();
  for (const wine of wines) {
    let key;
    if (groupBy === 'type') key = wine.type || 'other';
    else if (groupBy === 'country') key = wine.country || 'Other';
    else key = wine.region || wine.country || 'Other';

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(wine);
  }

  // Sort group keys
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

    const title = groupBy === 'type' ? formatTypeTitle(key) : key;
    return { title, wines: sectionWines };
  }).filter(s => s.wines.length > 0);
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
      return (a, b) => {
        const cmp = (a.country || '').localeCompare(b.country || '');
        if (cmp !== 0) return cmp;
        const rcmp = (a.region || '').localeCompare(b.region || '');
        if (rcmp !== 0) return rcmp;
        return a.name.localeCompare(b.name);
      };
  }
}

function formatTypeTitle(type) {
  const titles = {
    red: 'Red Wines',
    white: 'White Wines',
    rosé: 'Rosé Wines',
    sparkling: 'Sparkling Wines',
    dessert: 'Dessert Wines',
    fortified: 'Fortified Wines',
  };
  return titles[type] || type.charAt(0).toUpperCase() + type.slice(1);
}

/**
 * Generate a wine list PDF and return a readable stream.
 *
 * @param {Object} wineList - Populated WineList document
 * @param {Map<string, Object>} bottleMap - Map of bottleId → populated bottle doc
 * @returns {PDFDocument} - A PDFKit document (readable stream)
 */
function generateWineListPdf(wineList, bottleMap) {
  const layout = wineList.layout || {};
  const branding = wineList.branding || {};
  const scheme = COLOR_SCHEMES[layout.colorScheme] || COLOR_SCHEMES.classic;
  const pageSize = PAGE_SIZES[layout.pageSize] || PAGE_SIZES.A4;
  const font = layout.fontFamily === 'sans-serif' ? 'Helvetica' : 'Times-Roman';
  const fontBold = layout.fontFamily === 'sans-serif' ? 'Helvetica-Bold' : 'Times-Bold';
  const fontItalic = layout.fontFamily === 'sans-serif' ? 'Helvetica-Oblique' : 'Times-Italic';
  const currencySymbol = layout.currencySymbol || '$';
  const showGlassPrice = layout.showGlassPrice || false;

  const margin = 50;
  const contentWidth = pageSize[0] - margin * 2;

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

  const sections = buildSections(wineList, bottleMap);

  // --- Header ---
  renderHeader(doc, branding, scheme, fontBold, fontItalic, contentWidth, margin);

  // --- Sections ---
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];

    // Page break if near bottom
    if (doc.y > pageSize[1] - margin - 80) {
      doc.addPage();
    }

    // Section title
    doc.moveDown(i === 0 ? 0.5 : 1.2);
    doc.font(fontBold).fontSize(13).fillColor(scheme.accent);
    doc.text(section.title.toUpperCase(), margin, doc.y, { width: contentWidth });

    // Line under section title
    doc.moveDown(0.2);
    doc.moveTo(margin, doc.y).lineTo(margin + contentWidth, doc.y)
      .strokeColor(scheme.line).lineWidth(0.5).stroke();
    doc.moveDown(0.4);

    // Sub-group headers for auto mode (country/region within type)
    let lastSubHeader = null;

    for (const wine of section.wines) {
      // Page break check
      if (doc.y > pageSize[1] - margin - 35) {
        doc.addPage();
      }

      // Country/region sub-headers in auto type-grouping
      if (wineList.structureMode === 'auto' &&
          wineList.autoGrouping?.groupBy === 'type' &&
          wineList.autoGrouping?.withinGroup === 'country-region-name') {
        const sub = wine.region ? `${wine.country} — ${wine.region}` : wine.country;
        if (sub && sub !== lastSubHeader) {
          lastSubHeader = sub;
          doc.moveDown(0.2);
          doc.font(fontItalic).fontSize(9).fillColor(scheme.subheading);
          doc.text(sub, margin + 10, doc.y, { width: contentWidth - 10 });
          doc.moveDown(0.2);
        }
      }

      // Wine entry: Name Vintage .............. Price
      renderWineEntry(doc, wine, {
        margin, contentWidth, font, fontBold, fontItalic,
        scheme, currencySymbol, showGlassPrice,
      });
    }
  }

  // Page numbers on all pages
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);

    // Footer text
    if (branding.footerText) {
      doc.font(fontItalic).fontSize(7).fillColor(scheme.subheading);
      doc.text(branding.footerText, margin, pageSize[1] - margin + 5, {
        width: contentWidth, align: 'center',
      });
    }

    // Page number
    doc.font(font).fontSize(7).fillColor(scheme.subheading);
    doc.text(`${i + 1} / ${range.count}`, margin, pageSize[1] - margin + 16, {
      width: contentWidth, align: 'center',
    });
  }

  doc.end();
  return doc;
}

function renderHeader(doc, branding, scheme, fontBold, fontItalic, contentWidth, margin) {
  // Logo
  if (branding.logoUrl) {
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

  // Decorative line
  doc.moveDown(0.5);
  doc.moveTo(margin, doc.y).lineTo(margin + contentWidth, doc.y)
    .strokeColor(scheme.accent).lineWidth(1).stroke();
  doc.moveDown(0.3);
}

function renderWineEntry(doc, wine, opts) {
  const { margin, contentWidth, font, fontBold, fontItalic, scheme, currencySymbol, showGlassPrice } = opts;
  const indent = margin + 20;
  const priceColWidth = 100;
  const nameColWidth = contentWidth - 20 - priceColWidth;

  // Build display: "Wine Name, Vintage"
  const vintage = wine.vintage && wine.vintage !== 'NV' ? wine.vintage : 'NV';
  const displayName = `${wine.name}, ${vintage}`;

  const y = doc.y;

  // Wine name + vintage
  doc.font(fontBold).fontSize(9.5).fillColor(scheme.text);
  doc.text(displayName, indent, y, { width: nameColWidth, lineBreak: false });

  // Price column (right-aligned)
  let priceText = '';
  if (wine.price != null) {
    priceText = `${currencySymbol}${wine.price.toFixed(0)}`;
    if (showGlassPrice && wine.glassPrice != null) {
      priceText += ` / ${currencySymbol}${wine.glassPrice.toFixed(0)} glass`;
    }
  }
  if (priceText) {
    doc.font(font).fontSize(9.5).fillColor(scheme.text);
    doc.text(priceText, margin + contentWidth - priceColWidth, y, {
      width: priceColWidth, align: 'right', lineBreak: false,
    });

    // Dot leader
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

  // Second line: producer, region
  const details = [wine.producer, wine.region].filter(Boolean).join(' — ');
  if (details) {
    doc.font(fontItalic).fontSize(8).fillColor(scheme.subheading);
    doc.text(details, indent, y + 13, { width: nameColWidth + priceColWidth, lineBreak: false });
  }

  // Move Y past this entry
  doc.y = y + (details ? 26 : 15);
}

module.exports = { generateWineListPdf };
