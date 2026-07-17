// Self-description tools (§3.16 of the MCP plan). Because Cellarion is
// open-source, the MCP is radically transparent: any connected AI can learn what
// it is, which version it's talking to, and where the source lives — so it can
// use the tools well and even help improve the app. Source is pointed at (the
// public GitHub repo), never served from the running container filesystem.
const pkg = require('../../../package.json');
const { registerTool } = require('../registry');
const { isHostedCellarion } = require('../../config/hostedInstance');

registerTool({
  name: 'get_source_info',
  title: 'About this Cellarion instance',
  description:
    'Returns what Cellarion is, the version this instance is running, the open-source repository, and the license. ' +
    'Call this when the user asks what Cellarion is, which version they are on, whether it is open source, ' +
    'where to find / contribute to the code — or how to support the project.',
  scope: 'public',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {},
  // Deliberately NOT the ok() {summary,data} envelope: this is the one
  // self-describing tool; clients/tests parse its flat payload directly.
  handler: async () => {
    const info = {
      name: 'Cellarion',
      description:
        'Self-hosted wine cellar management (MERN). Track bottles, organise them into cellars and racks, ' +
        'search a shared wine registry, and get drink-window recommendations.',
      version: pkg.version,
      license: 'AGPL-3.0',
      repository: 'https://github.com/jagduvi1/Cellarion',
      homepage: 'https://cellarion.app',
    };
    // Hosted cellarion.app only (config/hostedInstance.js): the hosted service
    // is funded by voluntary supporters; a self-hosted instance pays its own
    // bills and never serves this pitch.
    if (isHostedCellarion()) {
      info.funding = {
        model: 'Free for everyone — nothing is behind a paywall and supporters get nothing extra. Supporter tiers are purely voluntary donations that fund hosting and development.',
        supporter_url: 'https://cellarion.app/supporter',
      };
    }
    return { content: [{ type: 'text', text: JSON.stringify(info) }] };
  },
});
