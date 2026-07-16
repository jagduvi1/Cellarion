// MCP resources — read-only context a client attaches to the conversation
// (plan §3.14/§3.16). Same scope model as tools; handlers receive
// (uri, params, ctx) and return { contents: [{ uri, mimeType, text }] }.
// Errors are returned as an error JSON body (a resource read has no isError
// envelope), keeping the §5.4 taxonomy visible to the model either way.
const pkg = require('../../package.json');
const Bottle = require('../models/Bottle');
const { CONSUMED_STATUSES } = require('../config/constants');
const { registerResource } = require('./registry');
const { accessibleCellars, countBottlesByCellar } = require('./toolUtil');
const { getCellarRole } = require('../utils/cellarAccess');
const { buildBottleDetail } = require('./tools/bottles');
const { buildStats } = require('./tools/stats');

const json = (uri, body) => ({
  contents: [{ uri: String(uri), mimeType: 'application/json', text: JSON.stringify(body) }],
});

registerResource({
  name: 'about',
  uri: 'cellarion://about',
  title: 'About Cellarion',
  description: 'What Cellarion is: open-source wine cellar management, licence, source repository, this instance\'s version.',
  mimeType: 'text/markdown',
  scope: 'public',
  handler: async (uri) => ({
    contents: [{
      uri: String(uri),
      mimeType: 'text/markdown',
      text: [
        '# Cellarion',
        '',
        'Self-hosted wine cellar management (MERN). Track bottles, organise them into cellars and racks,',
        'search a shared wine registry, and get drink-window recommendations.',
        '',
        `- **Version (this instance):** ${pkg.version}`,
        '- **License:** AGPL-3.0 — free software; users interacting over a network are entitled to the source.',
        '- **Source:** https://github.com/jagduvi1/Cellarion (read the code there; this server never serves its own filesystem)',
        '- **Hosted:** https://cellarion.app — free for everyone, no paywall. Self-hosting is fully supported (Docker Compose).',
        '',
        'This MCP server exposes the connected user\'s own cellar via scoped, revocable tokens.',
        'Reads are free; the expensive reasoning is yours to do. Cheers.',
      ].join('\n'),
    }],
  }),
});

registerResource({
  name: 'cellar-snapshot',
  uri: 'cellar://snapshot',
  title: 'Cellar snapshot',
  description: 'Compact whole-collection overview: every accessible cellar with role and active/consumed bottle counts. Attach for ambient context instead of calling list tools.',
  scope: 'read',
  handler: async (uri, _params, ctx) => {
    const cellars = await accessibleCellars(ctx.user.id);
    const ids = cellars.map((c) => c._id);
    const [activeBy, consumedBy] = await Promise.all([
      countBottlesByCellar(ids),
      countBottlesByCellar(ids, { consumed: true }),
    ]);
    const data = cellars.map((c) => ({
      cellar_id: c._id,
      name: c.name,
      role: getCellarRole(c, ctx.user.id),
      active_bottles: activeBy.get(String(c._id)) || 0,
      consumed_bottles: consumedBy.get(String(c._id)) || 0,
    }));
    return json(uri, {
      summary: `${data.length} cellar(s), ${data.reduce((s, c) => s + c.active_bottles, 0)} active bottle(s)`,
      data,
    });
  },
});

registerResource({
  name: 'cellar-stats',
  uri: 'cellar://stats',
  title: 'Portfolio statistics',
  description: 'The cellar_stats payload as an attachable document: value, distributions, maturity, urgency ladder, pace.',
  scope: 'read',
  handler: async (uri, _params, ctx) => {
    const r = await buildStats(ctx.user.id);
    return json(uri, { summary: r.summary, data: r.data, ...r.extra });
  },
});

registerResource({
  name: 'bottle-dossier',
  uriTemplate: 'cellar://bottle/{id}',
  title: 'Bottle dossier',
  description: 'Full detail of one bottle by id (same shape as the get_bottle tool).',
  scope: 'read',
  handler: async (uri, params, ctx) => {
    const r = await buildBottleDetail(ctx.user.id, String(params.id || ''));
    return json(uri, r.error ? { error: r.error } : { summary: r.summary, data: r.data });
  },
});
