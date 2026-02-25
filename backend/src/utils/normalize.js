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
 * Used for fuzzy matching / similarity scoring
 */
const levenshteinDistance = (str1, str2) => {
  const m = str1.length;
  const n = str2.length;

  // Create distance matrix
  const dp = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));

  // Initialize base cases
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  // Fill matrix
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,     // deletion
          dp[i][j - 1] + 1,     // insertion
          dp[i - 1][j - 1] + 1  // substitution
        );
      }
    }
  }

  return dp[m][n];
};

/**
 * Calculate similarity score between two strings (0-1)
 * 1 = identical, 0 = completely different
 */
const calculateSimilarity = (str1, str2) => {
  if (!str1 || !str2) return 0;

  const normalized1 = normalizeString(str1);
  const normalized2 = normalizeString(str2);

  if (normalized1 === normalized2) return 1;

  const maxLength = Math.max(normalized1.length, normalized2.length);
  if (maxLength === 0) return 1;

  const distance = levenshteinDistance(normalized1, normalized2);
  return 1 - distance / maxLength;
};

/**
 * Check if two strings are similar enough to be considered duplicates
 * threshold: 0.0 to 1.0 (default 0.85 = 85% similar)
 */
const isSimilar = (str1, str2, threshold = 0.85) => {
  return calculateSimilarity(str1, str2) >= threshold;
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

module.exports = {
  normalizeString,
  tokenize,
  generateWineKey,
  levenshteinDistance,
  calculateSimilarity,
  isSimilar,
  generateTrigrams,
  trigramSimilarity,
  tokenSimilarity,
  combinedSimilarity
};
