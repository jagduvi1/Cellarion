// The label sweetness vocabulary for an AI: the terms a wine's label sweetness
// may name (models/SweetnessTerm, GitHub discussion #1754), by scale and band.
// Read scope, like list_classifications — the same list the admin taxonomy
// screen and the pickers use, and the ONLY values any label sweetness field
// accepts, so a client reads it before writing one.
const { z } = require('zod');
const Country = require('../../models/Country');
const SweetnessTerm = require('../../models/SweetnessTerm');
const { registerTool } = require('../registry');
const { ok, fail } = require('../toolUtil');
const { loadTerms } = require('../../services/sweetnessOps');
const { normalizeString } = require('../../utils/normalize');

const { SCALES, BANDS } = SweetnessTerm;
const BAND_ORDER = Object.fromEntries([...BANDS.still, ...BANDS.sparkling].map((b, i) => [b, i]));
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

registerTool({
  name: 'list_sweetness_terms',
  title: 'List the label sweetness terms',
  description:
    'The registry\'s label sweetness vocabulary: every term a label may print for how sweet the wine is, with its ' +
    'scale (still: trocken, halbtrocken, feinherb, lieblich, süß, sec, demi-sec, moelleux, doux, secco, abboccato, ' +
    'amabile, dolce, seco, semiseco, dulce, meio seco, dry, medium dry, sweet …; sparkling: Brut Nature, Pas Dosé, ' +
    'Extra Brut, Brut, Extra Dry, Sec, Demi-Sec, Doux and their German, Italian, Spanish and Portuguese words), its ' +
    'band on one shared ladder (still: dry, off-dry, medium-sweet, sweet; sparkling: brut-nature … doux), whether ' +
    'the word has a legal definition, the accepted spellings, and the country when the word is law in one country. ' +
    'The same word can sit on both scales: "trocken" is the dry band on a still wine and the sec band on a Sekt. ' +
    'Call it before writing a label sweetness anywhere: only these names (or a listed spelling) are accepted, one per ' +
    'wine, as the label prints it — never derived from a Kabinett/Spätlese tier, and never the tasting profile\'s ' +
    'dry/off-dry/sweet estimate. Filter by scale (pass the wine\'s: sparkling → sparkling, anything else → still; ' +
    'fortified wines carry no term) or by country (its own terms plus the country-less ones).',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    scale: z.enum(SCALES).optional().describe('still | sparkling — the wine\'s scale, from its type'),
    country: z.string().min(1).max(80).optional().describe('Country name — returns its own terms plus the terms that belong to no single country'),
  },
  handler: async (args) => {
    const terms = await loadTerms();
    let countryId = null;
    let countryName = null;
    if (args.country) {
      const raw = String(args.country).trim();
      const c = await Country.findOne({ $or: [{ name: new RegExp(`^${escapeRegex(raw)}$`, 'i') }, { normalizedName: normalizeString(raw) }] }).select('name').lean();
      if (!c) return fail('not_found', `No country matching "${raw}". Country names come from get_wine or describe_country.`);
      countryId = String(c._id);
      countryName = c.name;
    }
    const ids = [...new Set(terms.rows.map((r) => r.country && String(r.country._id || r.country)).filter(Boolean))];
    const names = ids.length
      ? new Map((await Country.find({ _id: { $in: ids } }).select('name').lean()).map((c) => [String(c._id), c.name]))
      : new Map();
    const rows = terms.rows
      .filter((r) => !args.scale || r.scale === args.scale)
      .filter((r) => !countryId || !r.country || String(r.country._id || r.country) === countryId)
      .sort((a, b) => a.scale.localeCompare(b.scale) || (BAND_ORDER[a.band] ?? 99) - (BAND_ORDER[b.band] ?? 99) || a.name.localeCompare(b.name))
      .map((r) => ({
        name: r.name,
        scale: r.scale,
        band: r.band,
        regulated: r.regulated !== false,
        system: r.system || null,
        country: r.country ? names.get(String(r.country._id || r.country)) || null : null,
        synonyms: r.synonyms || [],
      }));
    const scope = [args.scale ? `${args.scale} scale` : null, countryName ? `for ${countryName}` : null].filter(Boolean).join(', ');
    return ok(`${rows.length} sweetness term${rows.length === 1 ? '' : 's'}${scope ? ` (${scope})` : ''}`, {
      terms: rows,
      scales: SCALES,
      bands: BANDS,
      note: 'A label sweetness accepts one of these names (or a listed spelling), resolved on the wine\'s scale. The band is the shared ladder behind every language; regulated:false marks a customary word without a legal definition.',
    });
  },
});

module.exports = {};
