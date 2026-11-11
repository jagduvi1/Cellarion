// The import page's fixed tables: its steps, the row limit, and the labels
// and colours it shows for a format, a match status, an encoding, a
// CellarTracker table, a bin pattern and a wine type.

export const STEPS = ['upload', 'review', 'importing', 'done'];

// Mirrors backend config/constants MAX_IMPORT_SIZE: /confirm hard-rejects
// bigger batches in one request, while /validate runs in 25-row slices and
// happily validates any size — so without an upfront warning a larger file
// only fails at the very last click, after all the review work.
export const MAX_IMPORT_ROWS = 2000;

export const FORMAT_LABEL_KEYS = {
  cellarion: 'importBottles.formats.cellarion',
  vivino: 'importBottles.formats.vivino',
  cellartracker: 'importBottles.formats.cellartracker',
  'oeno-export': 'importBottles.formats.oenoExport',
  generic: 'importBottles.formats.generic',
  receipt: 'importBottles.formats.receipt'
};

export const STATUS_LABEL_KEYS = {
  exact: 'importBottles.status.exact',
  fuzzy: 'importBottles.status.fuzzy',
  ai_match: 'importBottles.status.aiMatch',
  ai_new: 'importBottles.status.aiNew',
  no_match: 'importBottles.status.noMatch',
  error: 'importBottles.status.error',
  skipped: 'importBottles.status.skipped'
};

export const STATUS_CLASSES = {
  exact: 'status-exact',
  fuzzy: 'status-fuzzy',
  ai_match: 'status-ai',
  ai_new: 'status-ai',
  no_match: 'status-nomatch',
  error: 'status-error',
  skipped: 'status-skipped'
};

// Human-readable labels for the encodings decodeImportBuffer can detect
export const ENCODING_LABELS = {
  'utf-8': 'UTF-8',
  'utf-16le': 'UTF-16 LE',
  'utf-16be': 'UTF-16 BE',
  'windows-1252': 'Windows-1252'
};

// CellarTracker table names shown next to the detected format
export const CT_TABLE_LABEL_KEYS = {
  list: 'importBottles.ctTables.list',
  inventory: 'importBottles.ctTables.inventory',
  bottles: 'importBottles.ctTables.bottles',
  consumed: 'importBottles.ctTables.consumed',
  purchase: 'importBottles.ctTables.purchase',
  pending: 'importBottles.ctTables.pending'
};

// Pattern labels for CellarTracker Location/Bin auto-mapped racks
export const CT_PATTERN_LABEL_KEYS = {
  'rowcol': 'importBottles.rackAutoMap.patternRowCol',
  'rowcol-depth': 'importBottles.rackAutoMap.patternRowColDepth',
  'letter-number': 'importBottles.rackAutoMap.patternLetterNumber',
  'segments': 'importBottles.rackAutoMap.patternSegments',
  'sequential': 'importBottles.rackAutoMap.patternSequential'
};

export const TYPE_DOTS = {
  red: '#8B2252',
  white: '#F5E6C8',
  'rosé': '#FFB6C1',
  sparkling: '#FFD700',
  dessert: '#DAA520',
  fortified: '#8B4513'
};
