// From an uploaded file to rows: decoding the bytes, finding the delimiter,
// and reading CSV as spreadsheets really write it (quoted fields, line breaks
// inside a field, character references). Shared by every import format;
// utils/importMappers.js re-exports the public names.

const NAMED_CHAR_REFS = { amp: '&', quot: '"', apos: "'", nbsp: ' ' };

// Windows-1252 for 0x80–0x9F; \0 marks the five bytes it leaves undefined.
const CP1252_C1 = '€\0‚ƒ„…†‡ˆ‰Š‹Œ\0Ž\0'
  + '\0‘’“”•–—˜™š›œ\0žŸ';

/**
 * Turn HTML character references in one field back into the characters they
 * stand for. CellarTracker writes every letter outside Latin-1 that way
 * ("Fetească" arrives as "Feteasc&#259;"). Decimal and hex references plus
 * &amp; &quot; &apos; &nbsp; are decoded in a single pass, so "&amp;#259;"
 * becomes the literal "&#259;". References in 128–159 mean Windows-1252
 * characters, as browsers read them.
 *
 * Left as written: "<" and ">" (the server strips anything from a "<" to the
 * next ">" as a tag, so a decoded "score &lt; 95" note would be cut short),
 * control characters other than tab and line breaks, and invalid code points.
 */
export function decodeCharRefs(text) {
  if (!text || !text.includes('&')) return text;
  return text.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|quot|apos|nbsp));/g, (ref, dec, hex, named) => {
    if (named) return NAMED_CHAR_REFS[named];
    const cp = dec ? parseInt(dec, 10) : parseInt(hex, 16);
    if (cp >= 0x80 && cp <= 0x9F) return CP1252_C1[cp - 0x80] === '\0' ? ref : CP1252_C1[cp - 0x80];
    if (cp === 0x3C || cp === 0x3E || cp === 0x7F || (cp < 0x20 && cp !== 0x09 && cp !== 0x0A && cp !== 0x0D)) return ref;
    if (cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return ref;
    return String.fromCodePoint(cp);
  });
}

// A double-quote is only STRUCTURAL when it sits at a field boundary: an
// opening quote immediately follows a delimiter or line-start; a closing
// quote is immediately followed by a delimiter, line-end, or a doubled quote
// (the RFC 4180 escape). A quote anywhere else — e.g. an inch mark in a
// tasting note (Poured a 2" taste) — is a LITERAL character and must NOT
// toggle quote state. Toggling on every quote would leave a single stray
// quote "in quotes" across the row-terminating newline and swallow every
// following row into one merged line.

/**
 * Pass 1 of CSV parsing: split text into logical lines. Newlines inside a
 * properly-quoted field are kept as content; quote characters are preserved
 * for splitCsvFields to re-parse. Leading blank lines are dropped.
 */
export function splitLogicalLines(text, delimiter) {
  const isBoundary = (c) => c === undefined || c === delimiter || c === '\n' || c === '\r';

  const lines = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes) {
        if (text[i + 1] === '"') {
          current += '""';
          i++; // keep the escaped pair intact for splitCsvFields
        } else if (isBoundary(text[i + 1])) {
          inQuotes = false; // closing quote
          current += '"';
        } else {
          current += '"'; // stray quote inside the field — literal, stay open
        }
      } else if (current === '' || current[current.length - 1] === delimiter) {
        inQuotes = true; // opening quote at field start
        current += '"';
      } else {
        current += '"'; // stray quote mid-field — literal, stay unquoted
      }
    } else if (ch === '\n' && !inQuotes) {
      if (current.trim() || lines.length > 0) lines.push(current);
      current = '';
    } else if (ch === '\r' && !inQuotes) {
      // skip CR, handle in \n
    } else {
      current += ch;
    }
  }
  if (current.trim()) lines.push(current);
  return lines;
}

/**
 * Pass 2 of CSV parsing: split one logical line into fields, honoring quotes
 * with the same boundary rule so an unbalanced quote can't eat the delimiters
 * after it. Character references are decoded per field (decodeCharRefs),
 * after the split, so an encoded comma or quote can never change the row's
 * shape. `trim: false` keeps each field's surrounding whitespace.
 */
function splitCsvFields(line, delimiter, { trim = true } = {}) {
  const fields = [];
  let field = '';
  let inQ = false;
  const finish = (value) => (trim ? decodeCharRefs(value).trim() : decodeCharRefs(value));
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ) {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else if (line[i + 1] === undefined || line[i + 1] === delimiter) {
          inQ = false; // closing quote
        } else {
          field += '"'; // stray quote inside the field — literal
        }
      } else if (field === '') {
        inQ = true; // opening quote at field start
      } else {
        field += '"'; // stray quote mid-field — literal
      }
    } else if (c === delimiter && !inQ) {
      fields.push(finish(field));
      field = '';
    } else {
      field += c;
    }
  }
  fields.push(finish(field));
  return fields;
}

/**
 * Parse CSV text into an array of row objects.
 * Handles quoted fields, embedded commas, and newlines within quotes.
 * Character references are decoded per field (decodeCharRefs), after the
 * split, so an encoded comma or quote can never change the row's shape.
 * Production callers should pre-detect the delimiter via detectDelimiter()
 * before calling this (see parseAndMap below).
 */
export function parseCSV(text, delimiter = ',') {
  const lines = splitLogicalLines(text, delimiter);
  if (lines.length < 2) return [];

  const splitLine = (line) => splitCsvFields(line, delimiter);

  const headers = splitLine(lines[0]);
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const values = splitLine(lines[i]);
    if (values.every(v => !v)) continue; // skip empty rows
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] || '';
    });
    rows.push(row);
  }

  return rows;
}

/**
 * Decode a raw import file (ArrayBuffer/Uint8Array) into text with encoding
 * detection. CellarTracker's browser-UI export is Windows-1252 — reading it
 * as UTF-8 silently corrupts every accented producer (Pétrus → P�trus).
 *
 * Order: BOM sniff (UTF-8 / UTF-16LE / UTF-16BE) → strict UTF-8 validation
 * (fatal decoder) → Windows-1252 fallback. cp1252 is used rather than plain
 * latin-1 because it maps the 0x80–0x9F range (curly quotes, €) correctly,
 * and a cp1252 decode never throws — every byte sequence is valid.
 * Valid UTF-8 input always decodes as UTF-8, so this changes nothing for
 * well-formed files.
 *
 * @returns {{ text: string, encoding: 'utf-8'|'utf-16le'|'utf-16be'|'windows-1252' }}
 */
export function decodeImportBuffer(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8' };
  }
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) {
    return { text: new TextDecoder('utf-16le').decode(bytes), encoding: 'utf-16le' };
  }
  if (bytes[0] === 0xFE && bytes[1] === 0xFF) {
    return { text: new TextDecoder('utf-16be').decode(bytes), encoding: 'utf-16be' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' };
  }
}

/**
 * CellarTracker's WebQuery endpoint returns an HTML page ("You are currently
 * not logged into CellarTracker.") instead of data when the session is
 * invalid. Fail fast with a recognisable error code instead of parsing HTML
 * as a wine list.
 */
export function throwIfHtmlErrorPage(text) {
  const head = text.slice(0, 512).trimStart().toLowerCase();
  const isHtml = head.startsWith('<html') || head.startsWith('<!doctype');
  if (isHtml || text.includes('You are currently not logged into CellarTracker')) {
    const err = new Error('This file is an HTML error page, not a wine export');
    err.code = 'ct-error-page';
    throw err;
  }
}

/**
 * Auto-detect delimiter from first line of CSV.
 */
export function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/)[0];
  if (firstLine.includes('\t')) return '\t';
  if (firstLine.includes(';')) return ';';
  return ',';
}

/**
 * Split one CSV line respecting double-quoted fields (which may contain
 * commas). parseCSV's field splitter without the trim, for the Oeno-export
 * parser, which trims each cell itself.
 */
export function splitCSVLine(line, delimiter = ',') {
  if (!line) return [];
  return splitCsvFields(line, delimiter, { trim: false });
}
