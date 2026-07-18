// Taxonomy lookup tools: let an AI fetch the curated reference profile for a
// grape, region or country (the same markdown descriptions the public
// /grapes, /regions and /countries pages render). Scope 'read' — served to
// any authenticated token, but NOT the anonymous /api/mcp/public surface:
// the descriptions are an account-holder benefit, and the public website
// already carries them for discovery/AEO.
const { z } = require('zod');
const Grape = require('../../models/Grape');
const Region = require('../../models/Region');
const Country = require('../../models/Country');
const WineDefinition = require('../../models/WineDefinition');
const { registerTool } = require('../registry');
const { ok, fail } = require('../toolUtil');
const { normalizeString } = require('../../utils/normalize');
const { siteBaseUrl } = require('../../utils/siteUrl');

const clean = (v) => (v == null || v === '' ? null : v);

registerTool({
  name: 'describe_grape',
  title: 'Describe a grape variety',
  description:
    'Cellarion\'s reference profile for a grape variety: colour, origin, a markdown description (character, where it ' +
    'grows, food, cellaring), synonyms and how many registry wines use it. Call when the user asks about a grape, or ' +
    'to ground a recommendation. Accepts the grape name, a synonym (e.g. "Shiraz" finds Syrah) or its page slug.',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    grape: z.string().min(1).max(120).describe('Grape name, a known synonym, or the page slug'),
  },
  handler: async (args) => {
    const raw = String(args.grape || '').trim();
    if (!raw) return fail('invalid_input', 'grape is required (a name, synonym or slug).');
    const norm = normalizeString(raw);
    const grape = await Grape.findOne({
      $or: [{ normalizedName: norm }, { normalizedSynonyms: norm }, { slug: raw.toLowerCase() }],
    }).select('name slug color origin characteristics agingPotential prestige synonyms description').lean();
    if (!grape) {
      return fail('not_found', `No grape matching "${raw}". Grape names come from get_wine (a wine's grapes array).`);
    }
    const wineCount = await WineDefinition.countDocuments({ grapes: grape._id });
    return ok(`${grape.name}${grape.color ? ` (${grape.color})` : ''}`, {
      name: grape.name,
      color: clean(grape.color),
      origin: clean(grape.origin),
      characteristics: grape.characteristics?.length ? grape.characteristics : [],
      aging_potential: clean(grape.agingPotential),
      prestige: clean(grape.prestige),
      synonyms: grape.synonyms?.length ? grape.synonyms : [],
      description: clean(grape.description),
      wine_count: wineCount,
      public_url: grape.slug ? `${siteBaseUrl()}/grapes/${grape.slug}` : null,
    });
  },
});

registerTool({
  name: 'describe_region',
  title: 'Describe a wine region',
  description:
    'Cellarion\'s reference profile for a wine region: its country, classification, a markdown description, typical ' +
    'grapes and how many registry wines come from it. Region names repeat across countries — pass `country` to ' +
    'disambiguate; without it the best-matched region (most registry wines) is returned with a note.',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    region: z.string().min(1).max(160).describe('Region name or page slug'),
    country: z.string().max(120).optional().describe('Country name or ISO code to disambiguate'),
  },
  handler: async (args) => {
    const raw = String(args.region || '').trim();
    if (!raw) return fail('invalid_input', 'region is required (a name or slug).');
    const norm = normalizeString(raw);

    let countryFilter = null;
    if (args.country && String(args.country).trim()) {
      const c = String(args.country).trim();
      const country = await Country.findOne({
        $or: [{ normalizedName: normalizeString(c) }, { code: c.toUpperCase() }, { slug: c.toLowerCase() }],
      }).select('_id name').lean();
      if (!country) return fail('not_found', `No country matching "${c}".`);
      countryFilter = country._id;
    }

    const query = {
      $or: [{ normalizedName: norm }, { normalizedSynonyms: norm }, { slug: raw.toLowerCase() }],
    };
    if (countryFilter) query.country = countryFilter;

    const matches = await Region.find(query)
      .select('name slug classification styles prestigeLevel typicalGrapes description country')
      .populate('country', 'name')
      .populate('typicalGrapes', 'name')
      .lean();
    if (!matches.length) {
      return fail('not_found', `No region matching "${raw}"${args.country ? ` in ${args.country}` : ''}.`);
    }

    // Rank by registry wine count so the "best" region wins when a name repeats.
    const counts = await Promise.all(matches.map((r) => WineDefinition.countDocuments({ region: r._id })));
    let best = 0;
    for (let i = 1; i < matches.length; i += 1) if (counts[i] > counts[best]) best = i;
    const r = matches[best];

    const extra = {};
    if (matches.length > 1) {
      extra.warnings = [
        `"${raw}" exists in ${matches.length} countries (${matches.map((m) => m.country?.name || '?').join(', ')}); ` +
        `returning the ${r.country?.name || '?'} one. Pass country to pick another.`,
      ];
    }
    return ok(`${r.name}${r.country?.name ? `, ${r.country.name}` : ''}`, {
      name: r.name,
      country: r.country?.name || null,
      classification: clean(r.classification),
      styles: r.styles?.length ? r.styles : [],
      prestige_level: clean(r.prestigeLevel),
      typical_grapes: (r.typicalGrapes || []).map((g) => g.name).filter(Boolean),
      description: clean(r.description),
      wine_count: counts[best],
      public_url: r.slug ? `${siteBaseUrl()}/regions/${r.slug}` : null,
    }, extra);
  },
});

registerTool({
  name: 'describe_country',
  title: 'Describe a wine country',
  description:
    'Cellarion\'s reference profile for a wine-producing country: ISO code, a markdown description of its wine scene, ' +
    'plus how many registry regions and wines it has. Accepts the country name, its ISO code, or the page slug.',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    country: z.string().min(1).max(120).describe('Country name, ISO 3166-1 alpha-2 code, or page slug'),
  },
  handler: async (args) => {
    const raw = String(args.country || '').trim();
    if (!raw) return fail('invalid_input', 'country is required (a name, code or slug).');
    const country = await Country.findOne({
      $or: [{ normalizedName: normalizeString(raw) }, { code: raw.toUpperCase() }, { slug: raw.toLowerCase() }],
    }).select('name slug code description').lean();
    if (!country) return fail('not_found', `No wine country matching "${raw}".`);
    const [regionCount, wineCount] = await Promise.all([
      Region.countDocuments({ country: country._id }),
      WineDefinition.countDocuments({ country: country._id }),
    ]);
    return ok(country.name, {
      name: country.name,
      code: clean(country.code),
      description: clean(country.description),
      region_count: regionCount,
      wine_count: wineCount,
      public_url: country.slug ? `${siteBaseUrl()}/countries/${country.slug}` : null,
    });
  },
});

module.exports = {};
