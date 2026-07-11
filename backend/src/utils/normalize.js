// Normalization utilities for deduplication and fuzzy matching

/**
 * Wine-domain stop words that don't add meaningful distinction
 * These are removed during tokenization for better matching
 */
const WINE_STOP_WORDS = new Set([
  'wine', 'wines', 'winery', 'vineyard', 'vineyards', 'estate', 'estates',
  'cellars', 'cellar', 'reserve', 'selection', 'cuvee', 'cuvée',
  'château', 'chateau', 'domaine', 'domain', 'bodega', 'casa',
  'the', 'le', 'la', 'de', 'di', 'del', 'della', 'des', 'du',
  'and', 'et', 'y', 'e', 'und'
]);

/**
 * Normalize a string for comparison
 * - Convert to lowercase
 * - Remove accents/diacritics
 * - Remove punctuation
 * - Collapse whitespace
 */
const normalizeString = (str) => {
  if (!str) return '';

  return str
    .toLowerCase()
    .normalize('NFD') // Decompose accented characters
    .replace(/[\u0300-\u036f]/g, '') // Remove diacritics
    .replace(/[^\w\s]/g, '') // Remove punctuation
    .replace(/\s+/g, ' ') // Collapse whitespace
    .trim();
};

/**
 * Tokenize a string and remove wine-domain stop words
 * Used for more sophisticated matching
 */
const tokenize = (str) => {
  if (!str) return [];

  const normalized = normalizeString(str);
  const tokens = normalized.split(/\s+/).filter(token => {
    return token.length > 0 && !WINE_STOP_WORDS.has(token);
  });

  return tokens;
};

/**
 * Generate a normalized key for wine deduplication
 * Combines producer + wine name + appellation
 */
const generateWineKey = (name, producer, appellation = '') => {
  const normalizedName = normalizeString(name);
  const normalizedProducer = normalizeString(producer);
  const normalizedAppellation = normalizeString(appellation);

  // Combine in a consistent order
  return `${normalizedProducer}:${normalizedName}:${normalizedAppellation}`;
};

/**
 * Calculate Levenshtein distance between two strings
 * Used for fuzzy matching / similarity scoring.
 *
 * Uses two rolling rows (the shorter string as the inner dimension) so memory
 * is O(min(m, n)) rather than the O(m·n) full matrix — this keeps a pathological
 * input from allocating hundreds of MB even if length caps upstream were bypassed.
 */
const levenshteinDistance = (str1, str2) => {
  let m = str1.length;
  let n = str2.length;
  if (m === 0) return n;
  if (n === 0) return m;

  // Keep the shorter string as the column (inner) dimension.
  if (n > m) { [str1, str2] = [str2, str1]; [m, n] = [n, m]; }

  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        curr[j] = prev[j - 1];
      } else {
        curr[j] = Math.min(
          prev[j] + 1,       // deletion
          curr[j - 1] + 1,   // insertion
          prev[j - 1] + 1    // substitution
        );
      }
    }
    const tmp = prev; prev = curr; curr = tmp;
  }

  return prev[n];
};

// Strings longer than this are never a genuine fuzzy-duplicate of a wine
// name/producer; the route and schema already cap input length, so this is
// defense-in-depth bounding the O(m·n) edit-distance cost.
const MAX_COMPARE_LEN = 256;

/**
 * Calculate similarity score between two strings (0-1)
 * 1 = identical, 0 = completely different
 */
const calculateSimilarity = (str1, str2) => {
  if (!str1 || !str2) return 0;

  let normalized1 = normalizeString(str1);
  let normalized2 = normalizeString(str2);

  if (normalized1 === normalized2) return 1;

  if (normalized1.length > MAX_COMPARE_LEN) normalized1 = normalized1.slice(0, MAX_COMPARE_LEN);
  if (normalized2.length > MAX_COMPARE_LEN) normalized2 = normalized2.slice(0, MAX_COMPARE_LEN);

  const maxLength = Math.max(normalized1.length, normalized2.length);
  if (maxLength === 0) return 1;

  const distance = levenshteinDistance(normalized1, normalized2);
  return 1 - distance / maxLength;
};

/**
 * Generate trigrams from a string for fuzzy matching
 * e.g., "wine" -> ["  w", " wi", "win", "ine", "ne "]
 */
const generateTrigrams = (str) => {
  if (!str) return new Set();

  const normalized = normalizeString(str);
  const padded = `  ${normalized} `; // Pad for boundary trigrams
  const trigrams = new Set();

  for (let i = 0; i < padded.length - 2; i++) {
    trigrams.add(padded.substring(i, i + 3));
  }

  return trigrams;
};

/**
 * Calculate trigram similarity between two strings (Jaccard index)
 * Returns 0-1, where 1 = identical, 0 = no common trigrams
 */
const trigramSimilarity = (str1, str2) => {
  if (!str1 || !str2) return 0;

  const trigrams1 = generateTrigrams(str1);
  const trigrams2 = generateTrigrams(str2);

  if (trigrams1.size === 0 && trigrams2.size === 0) return 1;
  if (trigrams1.size === 0 || trigrams2.size === 0) return 0;

  // Calculate intersection
  const intersection = new Set([...trigrams1].filter(t => trigrams2.has(t)));

  // Jaccard index: intersection / union
  const union = trigrams1.size + trigrams2.size - intersection.size;
  return intersection.size / union;
};

/**
 * Token-based similarity (Jaccard index on tokens)
 * Good for matching phrases with different word order
 */
const tokenSimilarity = (str1, str2) => {
  if (!str1 || !str2) return 0;

  const tokens1 = new Set(tokenize(str1));
  const tokens2 = new Set(tokenize(str2));

  if (tokens1.size === 0 && tokens2.size === 0) return 1;
  if (tokens1.size === 0 || tokens2.size === 0) return 0;

  const intersection = new Set([...tokens1].filter(t => tokens2.has(t)));
  const union = tokens1.size + tokens2.size - intersection.size;

  return intersection.size / union;
};

/**
 * Combined similarity score using multiple algorithms
 * Weights: Levenshtein (40%), Trigram (30%), Token (30%)
 */
const combinedSimilarity = (str1, str2) => {
  if (!str1 || !str2) return 0;

  const levSim = calculateSimilarity(str1, str2);
  const triSim = trigramSimilarity(str1, str2);
  const tokSim = tokenSimilarity(str1, str2);

  // Weighted combination
  return levSim * 0.4 + triSim * 0.3 + tokSim * 0.3;
};

/**
 * Map of alternate/regional grape names → canonical English name.
 * Keys are the output of normalizeString() applied to the alternate name.
 * Values are the canonical display name to store in the database.
 *
 * This prevents the same physical grape from being stored as multiple Grape
 * records when different labels (or the AI) use regional synonyms.
 */
const GRAPE_SYNONYMS = {
  // Syrah / Shiraz
  'shiraz':               'Syrah',

  // Grenache family
  'garnacha':             'Grenache',
  'garnacha tinta':       'Grenache',
  'grenache noir':        'Grenache',
  'grenache blanc':       'Grenache Blanc',
  'garnacha blanca':      'Grenache Blanc',
  'grenache gris':        'Grenache Gris',

  // Malbec / Côt
  // NOTE: 'auxerrois' is deliberately NOT mapped. It is a Malbec synonym only
  // in Cahors; in Alsace/Lorraine (where the name is far more common on
  // labels) Auxerrois is a distinct white grape — the mapping silently
  // corrupted every Alsace Auxerrois auto-created via label scan / AI import.
  'cot':                  'Malbec',
  'cote':                 'Malbec',
  'malbeck':              'Malbec',

  // Tempranillo synonyms
  'tinto fino':           'Tempranillo',
  'tinta del pais':       'Tempranillo',
  'tinta de toro':        'Tempranillo',
  'aragonez':             'Tempranillo',
  'ull de llebre':        'Tempranillo',
  'cencibel':             'Tempranillo',

  // Pinot Gris / Pinot Grigio
  'pinot grigio':         'Pinot Gris',
  'grauburgunder':        'Pinot Gris',
  'rulander':             'Pinot Gris',

  // Pinot Noir synonyms
  'spatburgunder':        'Pinot Noir',
  'blauburgunder':        'Pinot Noir',
  'clevner':              'Pinot Noir',

  // Pinot Blanc synonyms
  'pinot bianco':         'Pinot Blanc',
  'weissburgunder':       'Pinot Blanc',

  // Sangiovese synonyms
  'brunello':             'Sangiovese',
  'prugnolo gentile':     'Sangiovese',
  'morellino':            'Sangiovese',

  // Zinfandel / Primitivo — same DNA, often listed interchangeably
  'primitivo':            'Zinfandel',

  // Carignan
  'carignane':            'Carignan',
  'carinan':              'Carignan',
  'mazuelo':              'Carignan',
  'samso':                'Carignan',

  // Mourvèdre
  'monastrell':           'Mourvèdre',
  'mataro':               'Mourvèdre',
  'mourvedre':            'Mourvèdre',

  // Albariño
  'alvarinho':            'Albariño',
  'albarino':             'Albariño',

  // Sauvignon Blanc — AI occasionally truncates
  'sauvignon':            'Sauvignon Blanc',

  // Chardonnay has no real synonyms but handle Morillon (Austria)
  'morillon':             'Chardonnay',

  // Muscadet (the wine name used as grape name by mistake)
  'muscadet':             'Melon de Bourgogne',
};

/**
 * Resolve a grape name to its canonical English form.
 * If the name (after normalization) matches a known synonym, the canonical
 * name is returned. Otherwise the original trimmed name is returned unchanged.
 *
 * @param {string} name  Raw grape name from label scan or user input
 * @returns {string}     Canonical grape name for storage
 */
const resolveGrapeName = (name) => {
  if (!name || !name.trim()) return name;
  const key = normalizeString(name);
  return GRAPE_SYNONYMS[key] || name.trim();
};

/**
 * Map of alternate country names → canonical English name.
 * Keys are the output of normalizeString() applied to the alternate name.
 * Values are the canonical Country.name used by the seeded taxonomy.
 *
 * Same idea as GRAPE_SYNONYMS: the AI importer and label scan receive labels
 * in the user's language ("Tyskland", "Italie") or informal abbreviations
 * ("USA"), and findOrCreateCountry would otherwise mint a duplicate Country
 * document for each spelling — this happened on prod (USA / United States Of
 * America / Tyskland / Italie / New Zeeland were all created as countries).
 * Covers Swedish, German, French, Spanish, Italian and Dutch names for the
 * wine countries plus common English variants; anything unmapped passes
 * through unchanged and still dedupes by normalizedName.
 */
const COUNTRY_ALIASES = {
  // United States
  'usa':                      'United States',
  'us':                       'United States',
  'united states of america': 'United States',
  'america':                  'United States',
  'estados unidos':           'United States',
  'etatsunis':                'United States', // États-Unis (hyphen deleted by normalizeString)
  'vereinigte staaten':       'United States',

  // England — canonical wine country (English PDO sparkling/still wines;
  // wine-world convention over ISO). Welsh wines are rare enough that a
  // separate "Wales" country may still be created deliberately.
  'united kingdom':           'England',
  'uk':                       'England',
  'great britain':            'England',
  'storbritannien':           'England',
  'grobritannien':            'England', // Großbritannien (ß is stripped by normalizeString)

  // Germany
  'tyskland':                 'Germany',   // sv/da/no
  'deutschland':              'Germany',
  'allemagne':                'Germany',
  'alemania':                 'Germany',
  'germania':                 'Germany',
  'duitsland':                'Germany',

  // Italy
  'italie':                   'Italy',     // fr
  'italia':                   'Italy',
  'italien':                  'Italy',     // sv + de

  // France
  'frankrike':                'France',    // sv
  'frankreich':               'France',
  'francia':                  'France',
  'frankrijk':                'France',

  // Spain
  'spanien':                  'Spain',     // sv + de
  'espagne':                  'Spain',
  'espana':                   'Spain',
  'espanha':                  'Spain',
  'spagna':                   'Spain',
  'spanje':                   'Spain',

  // Portugal — same spelling in most languages; no aliases needed

  // New Zealand
  'new zeeland':              'New Zealand', // common typo (created a prod country)
  'nya zeeland':              'New Zealand', // sv
  'neuseeland':               'New Zealand',
  'nouvellezelande':          'New Zealand', // Nouvelle-Zélande (hyphen deleted)
  'nueva zelanda':            'New Zealand',
  'nuova zelanda':            'New Zealand',

  // Austria
  'osterrike':                'Austria',   // sv (Österrike)
  'osterreich':               'Austria',   // de (Österreich)
  'autriche':                 'Austria',

  // South Africa
  'sydafrika':                'South Africa', // sv
  'sudafrika':                'South Africa', // de (Südafrika)
  'afrique du sud':           'South Africa',
  'sudafrica':                'South Africa',

  // Australia
  'australien':               'Australia', // sv + de
  'australie':                'Australia',

  // Greece
  'grekland':                 'Greece',    // sv
  'griechenland':             'Greece',
  'grece':                    'Greece',
  'grecia':                   'Greece',

  // Hungary
  'ungern':                   'Hungary',   // sv
  'ungarn':                   'Hungary',
  'hongrie':                  'Hungary',
  'ungheria':                 'Hungary',

  // Switzerland
  'schweiz':                  'Switzerland', // sv + de
  'suisse':                   'Switzerland',
  'svizzera':                 'Switzerland',

  // Croatia
  'kroatien':                 'Croatia',   // sv + de
  'croatie':                  'Croatia',
  'croazia':                  'Croatia',
  'hrvatska':                 'Croatia',

  // Czech Republic
  'czechia':                  'Czech Republic',
  'tjeckien':                 'Czech Republic', // sv
  'tschechien':               'Czech Republic',

  // Netherlands
  'holland':                  'Netherlands',
  'nederlanderna':            'Netherlands', // sv
  'niederlande':              'Netherlands',
  'paysbas':                  'Netherlands', // Pays-Bas (hyphen deleted)

  // Georgia
  'georgien':                 'Georgia',   // sv + de
  'georgie':                  'Georgia',

  // Lebanon
  'libanon':                  'Lebanon',   // sv + de
  'liban':                    'Lebanon',

  // Turkey
  'turkiye':                  'Turkey',
  'turkiet':                  'Turkey',    // sv
  'turkei':                   'Turkey',    // de (Türkei)
  'turquie':                  'Turkey',

  // Belgium
  'belgien':                  'Belgium',   // sv + de
  'belgique':                 'Belgium',
  'belgie':                   'Belgium',

  // Scandinavia
  'sverige':                  'Sweden',
  'schweden':                 'Sweden',
  'suede':                    'Sweden',
  'norge':                    'Norway',
  'norwegen':                 'Norway',
  'norvege':                  'Norway',
  'danmark':                  'Denmark',
  'danemark':                 'Denmark',

  // Canada / Mexico / Brazil / Japan / Morocco
  'kanada':                   'Canada',    // sv + de
  'mexiko':                   'Mexico',    // sv + de
  'mexique':                  'Mexico',
  'brasilien':                'Brazil',    // sv + de
  'bresil':                   'Brazil',
  'brasil':                   'Brazil',
  'japon':                    'Japan',
  'marocko':                  'Morocco',   // sv
  'marokko':                  'Morocco',   // de
  'maroc':                    'Morocco',

  // Eastern Europe
  'slovenien':                'Slovenia',  // sv
  'slowenien':                'Slovenia',  // de
  'rumanien':                 'Romania',   // sv/de (Rumänien)
  'roumanie':                 'Romania',
  'bulgarien':                'Bulgaria',  // sv + de
  'bulgarie':                 'Bulgaria',
  'moldavien':                'Moldova',   // sv
  'moldawien':                'Moldova',   // de
  'russia':                   'Russian Federation',
  'ryssland':                 'Russian Federation', // sv

  // South America
  'argentine':                'Argentina', // fr
  'argentinien':              'Argentina', // de
  'chili':                    'Chile',     // fr + nl
};

/**
 * Resolve a country name to its canonical English form.
 * If the name (after normalization) matches a known alias, the canonical
 * name is returned. Otherwise the original trimmed name is returned unchanged.
 *
 * @param {string} name  Raw country name from label scan, AI lookup or import
 * @returns {string}     Canonical country name for storage
 */
const resolveCountryName = (name) => {
  if (!name || !name.trim()) return name;
  const key = normalizeString(name);
  return COUNTRY_ALIASES[key] || name.trim();
};

/**
 * Convert any string to a URL-safe slug (lowercase, hyphenated, ASCII-only).
 * Builds on normalizeString (which already strips diacritics and punctuation).
 */
const slugify = (str) => {
  if (!str) return '';
  return normalizeString(str)
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 80);
};

/**
 * Build a vintage-neutral slug for a WineDefinition. If the wine name already
 * starts with the producer name, we don't duplicate the producer ("Cloudy Bay
 * Sauvignon Blanc" produced by "Cloudy Bay" → "cloudy-bay-sauvignon-blanc",
 * not "cloudy-bay-cloudy-bay-sauvignon-blanc").
 */
const generateWineSlug = (name, producer) => {
  const nName = normalizeString(name);
  const nProducer = normalizeString(producer);
  if (!nName) return slugify(producer);
  if (!nProducer || nName === nProducer || nName.startsWith(nProducer + ' ')) {
    return slugify(name);
  }
  return slugify(`${producer} ${name}`);
};


module.exports = {
  normalizeString,
  slugify,
  tokenize,
  generateWineKey,
  generateWineSlug,
  resolveGrapeName,
  resolveCountryName,
  levenshteinDistance,
  calculateSimilarity,
  generateTrigrams,
  trigramSimilarity,
  tokenSimilarity,
  combinedSimilarity
};
