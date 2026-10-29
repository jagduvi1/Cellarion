// The classification taxonomy for an AI: the quality tiers a wine's
// classification may name (models/Classification), by kind and country.
// Read scope, like the other taxonomy references — the same list the admin
// taxonomy screen and the pickers use, and the ONLY values the write rule
// (services/classificationOps.assignClassification) accepts on any
// classification field, so a client reads it before writing one.
const { z } = require('zod');
const Country = require('../../models/Country');
const { registerTool } = require('../registry');
const { ok, fail } = require('../toolUtil');
const { loadTaxonomy, KIND_ORDER } = require('../../services/classificationOps');
const { normalizeString } = require('../../utils/normalize');

const KINDS = ['vineyard_rank', 'ripeness', 'ageing', 'other'];
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

registerTool({
  name: 'list_classifications',
  title: 'List the classification tiers',
  description:
    'The registry\'s classification taxonomy: every quality tier a wine may carry on top of its appellation, with its ' +
    'kind (vineyard_rank: Grand Cru Classé, VDP Grosse Lage, Cru Bourgeois; ripeness: Kabinett … Trockenbeerenauslese, ' +
    'Smaragd; ageing: Riserva, Gran Reserva, Vintage Port; other: Reserve, Estate), the system it belongs to, its ' +
    'country when the word is law there, and the accepted spellings. Call it before writing a classification anywhere ' +
    '(add_bottle new_wine, propose_wine_correction, suggest_wine_correction, fix_pending_wine, update_wine_draft): only ' +
    'these names are accepted, several comma-separated ("Spätlese, VDP Grosse Lage"); a regulatory mark (DOCG, AOC) is ' +
    'never one. Filter by country (its own tiers plus the country-less ones) or by kind.',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    country: z.string().min(1).max(80).optional().describe('Country name — returns its own tiers plus the tiers that belong to no single country'),
    kind: z.enum(KINDS).optional().describe('vineyard_rank | ripeness | ageing | other'),
  },
  handler: async (args) => {
    const tax = await loadTaxonomy();
    let countryId = null;
    let countryName = null;
    if (args.country) {
      const raw = String(args.country).trim();
      const c = await Country.findOne({ $or: [{ name: new RegExp(`^${escapeRegex(raw)}$`, 'i') }, { normalizedName: normalizeString(raw) }] }).select('name').lean();
      if (!c) return fail('not_found', `No country matching "${raw}". Country names come from get_wine or describe_country.`);
      countryId = String(c._id);
      countryName = c.name;
    }
    const ids = [...new Set(tax.rows.map((r) => r.country && String(r.country._id || r.country)).filter(Boolean))];
    const names = ids.length
      ? new Map((await Country.find({ _id: { $in: ids } }).select('name').lean()).map((c) => [String(c._id), c.name]))
      : new Map();
    const rows = tax.rows
      .filter((r) => !args.kind || r.kind === args.kind)
      .filter((r) => !countryId || !r.country || String(r.country._id || r.country) === countryId)
      .sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || a.name.localeCompare(b.name))
      .map((r) => ({
        name: r.name,
        kind: r.kind,
        system: r.system || null,
        country: r.country ? names.get(String(r.country._id || r.country)) || null : null,
        synonyms: r.synonyms || [],
      }));
    const scope = [countryName ? `for ${countryName}` : null, args.kind ? `kind ${args.kind}` : null].filter(Boolean).join(', ');
    return ok(`${rows.length} classification tier${rows.length === 1 ? '' : 's'}${scope ? ` ${scope}` : ''}`, {
      classifications: rows,
      kinds: KINDS,
      note: 'A classification field accepts these names (or a listed spelling), several comma-separated. The string a wine shows is derived from its rows in the order vineyard rank, ripeness, ageing, other.',
    });
  },
});

module.exports = {};
