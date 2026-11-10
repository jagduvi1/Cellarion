// Sommelier tools: grapes — adding a variety the taxonomy lacks and editing
// one (synonyms, regional names), so a curator closes taxonomy gaps without an
// admin request for each.
//
// Registered where its block sat in somm.js, so the tool order is unchanged.
const { z } = require('zod');
const { registerTool } = require('../../registry');
const { ok, fail, SOMM_ROLES, requireSomm } = require('../../toolUtil');
const { logAudit } = require('../../../services/audit');
const { logAction } = require('../../actionLedger');
const { stripHtml } = require('../../../utils/sanitize');
const { normalizeString, sanitizeTaxonomyName, resolveGrapeName } = require('../../../utils/normalize');
const { claimKey, findGrapeClaim } = require('../../../services/grapeClaims');

registerTool({
  name: 'add_grape',
  title: 'Sommelier: add a variety to the grape taxonomy',
  description:
    'Adds a NEW grape variety to the shared taxonomy — the unblock for set_wine_profile/propose_wine_correction ' +
    'failing with "not in the grape taxonomy". No admin or support ticket is needed: wine data is somm-owned, and ' +
    'taxonomy is wine data. Match-first: if the name or any synonym already resolves to an existing variety, ' +
    'nothing is created and the tool tells you what it resolves to — so calling it "just in case" is safe. Include ' +
    'the synonyms owners actually write (accents, hyphens, Cynthiana-for-Norton) — they are what the resolver ' +
    'matches label text against. colour follows the registry rule: the colour of the BERRY (Red/White), null only ' +
    'for genuine edge cases. Adds are audited and attributed to you. ' +
    'A known alias such as Shiraz counts as its canonical variety (Syrah): it matches that variety, or the new ' +
    'row is stored under the canonical name and the reply says so.',
  scope: 'write',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: false, openWorldHint: false },
  inputSchema: {
    name: z.string().min(1).max(60).describe('Canonical variety name, e.g. "St. Pepin"'),
    colour: z.enum(['Red', 'White']).nullable().describe('Berry colour. Red covers rosé-capable reds; null only for a genuine edge case'),
    synonyms: z.array(z.string().min(1).max(60)).max(8).optional()
      .describe('Alternative spellings and true synonyms, e.g. ["St-Pepin","Saint Pepin"] — what the resolver matches against'),
    origin: z.string().max(80).optional().describe('Country or region of origin, e.g. "Portugal"'),
    description: z.string().max(500).optional().describe('One or two plain-text sentences: what the variety is and where it matters'),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;
    const Grape = require('../../../models/Grape');

    const typed = sanitizeTaxonomyName(args.name);
    // A static alias ("Shiraz") is stored under its canonical variety (Syrah):
    // resolveGrapeIdsStrict folds every name through the alias map before it
    // looks a variety up, so a row named after the alias could never be reached.
    const name = sanitizeTaxonomyName(resolveGrapeName(typed));
    if (!name) return fail('invalid_input', 'name is empty after sanitising');
    const substitution = normalizeString(typed) !== normalizeString(name) ? `${typed} → ${name}` : null;
    const synonyms = [...new Set((args.synonyms || []).map((s) => sanitizeTaxonomyName(s)).filter(Boolean))]
      .filter((s) => normalizeString(s) !== normalizeString(name));

    // Every string this row would claim — canonical name and all synonyms —
    // must be unclaimed, under the same fold resolveGrapeIdsStrict uses. Two
    // varieties answering to one string would make it ambiguous for every
    // later profile write.
    const taken = await findGrapeClaim([name, ...synonyms]);
    if (taken) {
      return fail('conflict',
        `Already in the taxonomy: "${taken.name}"${taken.synonyms?.length ? ` (synonyms: ${taken.synonyms.join(', ')})` : ''} ` +
        'claims one of these names. Use that variety, or propose a rename instead of a second row.');
    }

    const grape = new Grape({
      name,
      normalizedName: normalizeString(name),
      color: args.colour ?? null,
      synonyms,
      origin: args.origin ? String(args.origin).trim() : null,
      description: args.description ? stripHtml(String(args.description)).trim() : '',
      createdBy: ctx.user.id,
    });
    await grape.save();
    // The public taxonomy lists are cached; the admin taxonomy routes clear
    // them after every change, and so does this one.
    require('../../../routes/taxonomy').clearTaxonomyListCache();

    logAudit(ctx.req, 'somm.taxonomy.create',
      { type: 'grape', id: grape._id }, { name: grape.name, colour: grape.color, synonyms });

    const envelope = {
      summary: `Added "${grape.name}" (${grape.color || 'no colour'}) to the grape taxonomy${synonyms.length ? ` with ${synonyms.length} synonym(s)` : ''}` +
        (substitution ? ` — "${typed}" is a known alias, stored under its canonical name ${grape.name}` : ''),
      data: {
        grape_id: String(grape._id),
        name: grape.name,
        colour: grape.color,
        synonyms,
        ...(substitution ? { substitution } : {}),
        note: 'Resolves immediately — re-run the set_wine_profile or correction that failed on it.',
      },
    };
    await logAction(ctx, {
      tool: 'add_grape',
      action: 'somm_grape',
      detail: { grapeId: String(grape._id), name: grape.name },
      prev: null,
      result: envelope,
    });
    return ok(envelope.summary, envelope.data);
  },
});

registerTool({
  name: 'edit_grape',
  title: 'Sommelier: correct an existing grape — colour, synonyms, regional names',
  description:
    'Edits a variety ALREADY in the taxonomy. add_grape only creates, which left no route to fix a row that ' +
    'arrived incomplete — a curator could see the hole and not fill it. ' +
    'COLOUR IS THE ONE THAT MATTERS MOST. A grape with no colour cannot take part in the colour-conflict check ' +
    'at all: wines built on it are not failing that check, they are never evaluated, so the queue reports zero ' +
    'and reads as clean. Filling a null colour can immediately surface a wine typed red whose only grape is ' +
    'white. If you see a variety with no colour, that is a silent hole in a live validation rule. ' +
    'REGIONAL NAMES render the label a drinker in that country would actually see — Gouveio on a Douro wine ' +
    'rather than Godello, Durif in Australia rather than Petite Sirah — while storage keeps ONE canonical ' +
    'variety. Pass region as well as country where a variety has several (Carignan is Mazuelo in Rioja and ' +
    'Carignano in Sardinia), and add the same string as a synonym so label text and imports resolve INBOUND too, ' +
    'not only render outbound. One display name per place — a second name for the same country/region is refused. ' +
    'Synonyms and regional names are additive; nothing is ever removed.',
  scope: 'write',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: false, openWorldHint: false },
  inputSchema: {
    grape: z.string().min(1).max(60).describe('The variety to edit, by canonical name or an existing synonym'),
    colour: z.enum(['Red', 'White']).optional()
      .describe('Berry colour. Only settable while it is unset — changing an established colour is a merge-shaped decision, so it is refused.'),
    add_synonyms: z.array(z.string().min(1).max(60)).max(8).optional()
      .describe('Alternative spellings to resolve INBOUND. Additive.'),
    regional_name: z.string().min(1).max(60).optional()
      .describe('The label form used in one country, e.g. "Durif". Requires country.'),
    country: z.string().min(1).max(60).optional().describe('Country the regional_name applies in, by name, e.g. "Australia"'),
    region: z.string().min(1).max(60).optional()
      .describe('Narrow the regional_name to one region, e.g. "Rioja" for Mazuelo. Omit for country-wide.'),
    origin: z.string().max(80).optional(),
    description: z.string().max(500).optional(),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;
    const Grape = require('../../../models/Grape');
    const Country = require('../../../models/Country');
    const Region = require('../../../models/Region');

    // Looked up under the fold the wine write path uses, so an alias finds the
    // variety set_wine_profile would store it under ("Shiraz" → Syrah).
    const key = claimKey(args.grape);
    const grape = await Grape.findOne({ $or: [{ normalizedName: key }, { normalizedSynonyms: key }] });
    if (!grape) return fail('not_found', `No variety resolves from "${args.grape}" — add_grape creates a new one.`);

    const before = { color: grape.color, synonyms: [...(grape.synonyms || [])], regionalNames: (grape.regionalNames || []).length };
    const applied = [];
    let regionalNameAdded = false;

    if (args.colour !== undefined) {
      // An established colour is load-bearing: the conflict check and the
      // registry's colour rule both read it, and flipping one would re-judge
      // every wine built on the variety. Setting an UNSET one is the fix this
      // tool exists for; overwriting is a different, larger decision.
      if (grape.color && grape.color !== args.colour) {
        return fail('conflict',
          `"${grape.name}" is already ${grape.color}. Changing an established colour re-judges every wine built on it — ` +
          'file a support ticket with the evidence rather than flipping it here.');
      }
      if (!grape.color) { grape.color = args.colour; applied.push(`colour ${args.colour}`); }
    }

    if (Array.isArray(args.add_synonyms) && args.add_synonyms.length) {
      const claims = args.add_synonyms.map((s) => sanitizeTaxonomyName(s)).filter(Boolean);
      for (const s of claims) {
        const n = normalizeString(s);
        // A synonym another variety already answers to — directly or through
        // the alias map — would make the resolver ambiguous for every later write.
        const taken = await findGrapeClaim([s], { excludeId: grape._id });
        if (taken) return fail('conflict', `"${s}" already resolves to "${taken.name}" — one string cannot mean two varieties.`);
        if (n === normalizeString(grape.name)) continue;
        if (!(grape.synonyms || []).some((x) => normalizeString(x) === n)) {
          grape.synonyms.push(s);
          applied.push(`synonym ${s}`);
        }
      }
    }

    if (args.regional_name) {
      if (!args.country) return fail('invalid_input', 'regional_name needs a country — a label form is only true somewhere.');
      const country = await Country.findOne({ normalizedName: normalizeString(args.country) }).select('_id name').lean();
      if (!country) return fail('not_found', `Unknown country "${args.country}".`);
      let regionDoc = null;
      if (args.region) {
        regionDoc = await Region.findOne({ country: country._id, normalizedName: normalizeString(args.region) }).select('_id name').lean();
        if (!regionDoc) return fail('not_found', `No region "${args.region}" in ${country.name}.`);
      }
      const rn = sanitizeTaxonomyName(args.regional_name);
      const existing = (grape.regionalNames || []).map((x) => ({ country: x.country, region: x.region || null, name: x.name }));
      const dup = existing.some((x) =>
        String(x.country) === String(country._id) &&
        String(x.region || '') === String(regionDoc ? regionDoc._id : '') &&
        normalizeString(x.name) === normalizeString(rn));
      if (!dup) {
        // The admin grape editor's validator, over the whole list as it will
        // be saved: one display name per (country, region) — two would make
        // the rendered label depend on array order — and at most 20.
        const { validateGrapeRegionalNames } = require('../../../services/grapeRegionalNames');
        const check = await validateGrapeRegionalNames([
          ...existing,
          { country: country._id, region: regionDoc ? regionDoc._id : null, name: rn },
        ]);
        if (check.error) {
          return fail('conflict',
            `Cannot add regional name "${rn}" to "${grape.name}": ${check.error}. This tool only adds — changing or removing a ` +
            'regional name is an admin edit.');
        }
        grape.regionalNames = check.value;
        regionalNameAdded = true;
        applied.push(`regional name ${rn} (${country.name}${regionDoc ? ' / ' + regionDoc.name : ''})`);
      }
    }

    if (args.origin && !grape.origin) { grape.origin = String(args.origin).trim(); applied.push('origin'); }
    if (args.description && !grape.description) { grape.description = stripHtml(String(args.description)).trim(); applied.push('description'); }

    if (applied.length === 0) return ok(`Nothing to change on "${grape.name}" — every value given is already set.`, { grape: grape.name });
    await grape.save();

    // The same follow-through as the admin grape editor: the public taxonomy
    // lists (colour, synonyms) are cached, and regional names feed the
    // registry search index (regional display recall), so a new one rebuilds it.
    require('../../../routes/taxonomy').clearTaxonomyListCache();
    if (regionalNameAdded) require('../../../services/search').fullSync().catch(() => {});

    logAudit(ctx.req, 'somm.taxonomy.update', { type: 'grape', id: grape._id },
      { name: grape.name, applied, from: before });

    const envelope = {
      summary: `Updated "${grape.name}": ${applied.join(', ')}`,
      data: {
        grape_id: String(grape._id),
        name: grape.name,
        colour: grape.color,
        synonyms: grape.synonyms,
        applied,
        note: args.colour
          ? 'Wines built on this variety are now visible to the colour-conflict check — worth running list_colour_conflicts.'
          : 'Regional names render on owner-facing surfaces; the stored variety is unchanged.',
      },
    };
    await logAction(ctx, {
      tool: 'edit_grape',
      action: 'somm_grape',
      detail: { grapeId: String(grape._id), name: grape.name, applied },
      prev: before,
      result: envelope,
    });
    return ok(envelope.summary, envelope.data);
  },
});
