// Self-service analytics over MCP (#987): the same bounded query engine the
// web table uses, exposed as a two-step pair the model can compose freely —
// list_analytics_fields teaches the vocabulary (including THIS user's typed
// personal keys and the public registry vocabulary), analyze_cellar runs one
// query. This answers arbitrary portfolio questions with a dozen numbers from
// one bounded aggregation, where cellar_stats hydrates the entire portfolio.
//
// Everything hard lives in services/analytics/queryEngine: whitelisted
// operators, per-type value casting, server-derived cellar scope (the caller
// can only narrow), maxTimeMS + row/bucket caps, per-row currency conversion
// and star-scale rating normalization. This file only translates envelopes.
const { z } = require('zod');
const { registerTool } = require('../registry');
const { ok, fail } = require('../toolUtil');

// MCP responses land in a model's context — clamp rows harder than the REST
// cap (the engine allows 200; a model rarely benefits past a few dozen).
const MCP_ROWS_MAX = 50;

registerTool({
  name: 'list_analytics_fields',
  title: 'Analytics: the queryable field catalogue',
  description:
    'Step 1 of cellar analytics. Returns every field analyze_cellar can filter, sort, group or aggregate — wine ' +
    'identity, inventory, purchase, star-scale ratings, consumption, maturity, plus the USER\'S OWN typed personal ' +
    'keys and the public registry vocabulary (their keys embed an id: "personal.<id>", "registry.<id>"). Each entry ' +
    'carries type, unit, the allowed filter ops, allowed aggregations, and whether it can sort/group. Call this ' +
    'once before composing analyze_cellar queries; field keys are exact.',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {},
  handler: async (args, ctx) => {
    const { composeCatalogue, opsForType } = require('../../services/analytics/fieldCatalogue');
    const fields = await composeCatalogue(ctx.user.id);
    return ok(`${fields.length} queryable field(s)`, fields.map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      unit: f.unit || undefined,
      ops: f.filterable ? opsForType(f.type) : [],
      aggregations: (f.aggregations || []).length ? f.aggregations : undefined,
      sortable: !!f.sortable,
      groupable: !!f.groupable,
      enum_options: f.enumOptions || undefined,
    })));
  },
});

registerTool({
  name: 'analyze_cellar',
  title: 'Analytics: run one bounded query (rows or grouped)',
  description:
    'Step 2 of cellar analytics: one typed query over the user\'s bottles. mode "grouped" (default) buckets by 1-2 ' +
    'dimensions with measures like {field:"*",agg:"count"} or {field:"purchase.price",agg:"sum"} — use it for ' +
    '"how much / how many / average per X" questions; monetary measures convert currencies per-row and report the ' +
    'target + unconvertible count, ratings aggregate in stars. mode "rows" returns flat bottles with chosen ' +
    'columns, filters and sort — use it for "which bottles" questions. Filters are {field, op, value} with field ' +
    'keys and ops exactly as list_analytics_fields declares them; date values are YYYY-MM-DD and match whole days; ' +
    'rating values are stars 0-5. Scope: cellars "all" (default) or an id subset; bottles "active" (default), ' +
    '"consumed" or "all" — say which scope you used when presenting numbers.',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    mode: z.enum(['rows', 'grouped']).optional().describe('Default grouped'),
    scope: z.object({
      cellars: z.union([z.literal('all'), z.array(z.string())]).optional(),
      bottles: z.enum(['active', 'consumed', 'all']).optional(),
    }).optional(),
    filters: z.array(z.object({
      field: z.string(),
      op: z.string(),
      // NEVER z.any() here, and never z.array(z.any()) inside it. Both
      // serialise to a bare `{}`, and Home Assistant's MCP client converts
      // every tool schema through voluptuous_openapi.convert_to_voluptuous
      // (homeassistant/components/mcp/coordinator.py), which raises
      // "Invalid schema, missing type" on a node with no `type` keyword —
      // and HA aborts the WHOLE config entry on one tool's failure, so a
      // single untyped node takes every Cellarion tool offline in HA.
      // Reported 2026-08-21 and reproduced against HA's own converter: the
      // naive union with z.array(z.any()) still fails, because the empty {}
      // simply moves down into `items`.
      //
      // The union below is the engine's real contract, so nothing is coerced:
      // scalars for eq/gt/contains, arrays for `in` and the two-element
      // `between`. anyOf itself is fine — HA has converted the 26 anyOf nodes
      // in our other tools since July, and that was verified too.
      value: z.union([
        z.string(),
        z.number(),
        z.boolean(),
        z.array(z.union([z.string(), z.number()])),
      ]),
    })).max(12).optional(),
    dimensions: z.array(z.string()).max(2).optional().describe('grouped mode: 1-2 groupable field keys'),
    measures: z.array(z.object({
      field: z.string().describe('"*" with agg "count", or an aggregatable field key'),
      agg: z.enum(['count', 'sum', 'avg', 'min', 'max']),
    })).max(5).optional().describe('grouped mode; defaults to count'),
    columns: z.array(z.string()).max(15).optional().describe('rows mode: field keys to return'),
    sort: z.object({ field: z.string(), dir: z.enum(['asc', 'desc']) }).optional().describe('rows mode'),
    limit: z.number().int().min(1).max(MCP_ROWS_MAX).optional().describe(`rows mode, default 20, max ${MCP_ROWS_MAX}`),
    offset: z.number().int().min(0).optional(),
  },
  handler: async (args, ctx) => {
    const { runQuery, QueryError } = require('../../services/analytics/queryEngine');
    const mode = args.mode || 'grouped';
    const q = {
      mode,
      scope: args.scope,
      filters: args.filters,
      sort: args.sort,
      offset: args.offset,
      limit: Math.min(args.limit || 20, MCP_ROWS_MAX),
    };
    if (mode === 'grouped') {
      q.dimensions = args.dimensions && args.dimensions.length ? args.dimensions : ['wine.type'];
      q.measures = args.measures && args.measures.length ? args.measures : [{ field: '*', agg: 'count' }];
    } else {
      q.columns = args.columns;
    }
    try {
      const out = await runQuery(ctx.user.id, q);
      const summary = mode === 'grouped'
        ? `${out.buckets.length} bucket(s) over ${out.dimensionKeys.join(' × ')} — scope: ${out.scope.bottles} bottles, ${out.scope.cellars.length} cellar(s)`
        : `${out.page.returned} of ${out.total} row(s) — scope: ${out.scope.bottles} bottles, ${out.scope.cellars.length} cellar(s)`;
      return ok(summary, out);
    } catch (err) {
      if (err instanceof QueryError) {
        return fail('invalid_input', err.message);
      }
      if (err && (err.codeName === 'MaxTimeMSExpired' || err.code === 50)) {
        return fail('busy', 'The query exceeded its time budget — narrow the scope or filters and retry');
      }
      throw err;
    }
  },
});
