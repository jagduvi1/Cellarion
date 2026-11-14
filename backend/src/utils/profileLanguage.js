/**
 * The optional language for the AI-written wine texts (SuperAdmin → AI,
 * aiConfig.aiTextLanguage). Off — no key stored — is the default.
 *
 * The tasting profile is always written in English, in the fields it has
 * always used: aiProfile.description, flavors, foodPairings and the
 * structured descriptors. Those are what the registry's machinery reads —
 * the embedding text (services/embedding.buildEmbeddingText), search,
 * duplicate matching, the curation tools, MCP, the token API and the
 * Registry Bridge. With a language set, the same model call also returns the
 * three prose fields translated, stored apart as
 *
 *   aiProfile.localized = { lang, description, flavors, foodPairings, generatedAt }
 *
 * (services/enrichmentJob writes it). Only the member screens that show the
 * prose read it — the wine page, the bottle page and the vintage page, through
 * displayProfile() — and only while it is fresh: written in the language set
 * now, from the English text stored now (its generatedAt equals
 * aiProfile.generatedAt). Any rewrite of the English therefore retires the
 * copy by itself, and English shows again. Every other reader gets the
 * profile without it (withoutLocalized).
 */

/**
 * The languages the app's interface ships (frontend/src/locales), English
 * aside, each with the English name the prompt asks for. The prompt only ever
 * receives a name from this table, never text from the setting. A new
 * interface language becomes selectable here by one line.
 */
const AI_TEXT_LANGUAGES = Object.freeze({
  de: 'German',
  et: 'Estonian',
  fr: 'French',
  nb: 'Norwegian Bokmål',
  nl: 'Dutch',
  sv: 'Swedish',
});

/** The prose fields the copy translates; the rest of the profile is never translated. */
const LOCALIZED_FIELDS = Object.freeze(['description', 'flavors', 'foodPairings']);

/**
 * Output tokens added to a profile call while a language is set: the
 * translated description and lists ride in the same answer. Only then — the
 * call with the setting off keeps its old budget.
 */
const LOCALIZED_EXTRA_TOKENS = 600;

/**
 * A stored or requested language → its code, or '' for off. English, an
 * unknown code and anything that is not a string are off.
 */
function normalizeAiTextLanguage(raw) {
  if (typeof raw !== 'string') return '';
  const code = raw.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(AI_TEXT_LANGUAGES, code) ? code : '';
}

/** The language a settings object asks for ('' = off). */
function aiTextLanguageOf(cfg) {
  return normalizeAiTextLanguage(cfg && cfg.aiTextLanguage);
}

/** The language set now ('' = off). Read lazily: config/aiConfig requires this file. */
function activeAiTextLanguage() {
  return aiTextLanguageOf(require('../config/aiConfig').get());
}

/**
 * The paragraph services/labelScan.suggestProfile appends to the profile
 * prompt while a language is set; '' otherwise (off, English, unknown).
 */
function languageDirective(code) {
  const lang = normalizeAiTextLanguage(code);
  if (!lang) return '';
  const name = AI_TEXT_LANGUAGES[lang];
  return `\n\nAlso add one more key to the JSON object, "localized", holding the description, flavors and foodPairings you wrote above translated into ${name}: ` +
    `{"localized":{"description":"the description in ${name}","flavors":["each flavour in ${name}"],"foodPairings":["each pairing in ${name}"]}}. ` +
    'Translate faithfully, item for item: the same meaning, nothing added or left out, plain text like the description. ' +
    'Every other key — description, flavors and foodPairings included — stays exactly as specified above, in English.';
}

const timeOf = (v) => {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string' || typeof v === 'number') {
    const t = new Date(v).getTime();
    return Number.isNaN(t) ? null : t;
  }
  return null;
};

/**
 * The stored copy when it may be shown, else null: written in the language
 * set now (`lang`, read from the settings when not given) from the English
 * text stored now — same generatedAt — and that text is published.
 */
function freshLocalized(ap, lang) {
  const copy = ap && typeof ap === 'object' ? ap.localized : null;
  if (!copy || typeof copy !== 'object') return null;
  if (typeof copy.description !== 'string' || !copy.description) return null;
  if (typeof ap.description !== 'string' || !ap.description || ap.heldAt) return null;
  const want = lang === undefined ? activeAiTextLanguage() : normalizeAiTextLanguage(lang);
  if (!want || copy.lang !== want) return null;
  const at = timeOf(ap.generatedAt);
  return at !== null && at === timeOf(copy.generatedAt) ? copy : null;
}

/** The profile without the copy; the same object when it carries none. */
function withoutLocalized(ap) {
  if (!ap || typeof ap !== 'object' || !Object.prototype.hasOwnProperty.call(ap, 'localized')) return ap;
  const out = { ...ap };
  delete out.localized;
  return out;
}

/**
 * The profile a member's screen receives: the wine page (REST
 * GET /api/wines/:idOrSlug/public), the bottle page (GET /api/bottles/:id)
 * and the vintage page (GET /api/cellars/:id/vintages/:wineId/:vintage). The
 * copy stays only while it is fresh, and never for an API token. Returns
 * `shown` itself when nothing changes — always so with no copy stored.
 *
 * @param {object|null} shown  the profile the route is about to send
 * @param {object} [opts]
 * @param {object} [opts.stored=shown]  the stored profile it was built from
 *   (the anonymous tier sends a summary that carries no copy of its own)
 * @param {boolean} [opts.token=false]  the reader is an API token
 * @param {boolean} [opts.proseOnly=false]  the anonymous tier: the description only
 * @returns {object|null}
 */
function displayProfile(shown, { stored = shown, token = false, proseOnly = false } = {}) {
  if (!shown || typeof shown !== 'object') return shown;
  const copy = token ? null : freshLocalized(stored);
  if (!copy) return withoutLocalized(shown);
  const localized = proseOnly
    ? { lang: copy.lang, description: copy.description }
    : {
        lang: copy.lang,
        description: copy.description,
        flavors: Array.isArray(copy.flavors) ? [...copy.flavors] : [],
        foodPairings: Array.isArray(copy.foodPairings) ? [...copy.foodPairings] : [],
        generatedAt: copy.generatedAt,
      };
  return { ...withoutLocalized(shown), localized };
}

/**
 * For a wine sent as it is (the WineDefinition toJSON transform): a stored
 * copy leaves the server only while it is fresh. Mutates the plain `ap`.
 */
function dropStaleLocalized(ap) {
  if (ap && typeof ap === 'object' && ap.localized != null && !freshLocalized(ap)) delete ap.localized;
}

/** The English prose as one comparable string (see dropLocalizedIfProseChanged). */
function proseSignature(ap) {
  return JSON.stringify(LOCALIZED_FIELDS.map((f) => {
    const v = ap ? ap[f] : null;
    return Array.isArray(v) ? [...v] : (v ?? null);
  }));
}

/**
 * A curator write or an undo (services/wineProfileOps) changes the English
 * prose without a new generatedAt, so the copy would still look fresh: drop
 * it when the prose differs from `before` (a proseSignature taken before the
 * change). A write that leaves the prose as it was keeps the copy.
 * Returns true when it dropped one.
 */
function dropLocalizedIfProseChanged(ap, before) {
  if (!ap || ap.localized == null) return false;
  if (proseSignature(ap) === before) return false;
  ap.localized = undefined;
  return true;
}

module.exports = {
  AI_TEXT_LANGUAGES,
  LOCALIZED_FIELDS,
  LOCALIZED_EXTRA_TOKENS,
  normalizeAiTextLanguage,
  aiTextLanguageOf,
  activeAiTextLanguage,
  languageDirective,
  freshLocalized,
  withoutLocalized,
  displayProfile,
  dropStaleLocalized,
  proseSignature,
  dropLocalizedIfProseChanged,
};
