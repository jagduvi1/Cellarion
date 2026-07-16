// Self-description tools (§3.16 of the MCP plan). Because Cellarion is
// open-source, the MCP is radically transparent: any connected AI can learn what
// it is, which version it's talking to, and where the source lives — so it can
// use the tools well and even help improve the app. Source is pointed at (the
// public GitHub repo), never served from the running container filesystem.
const pkg = require('../../../package.json');
const { registerTool } = require('../registry');

registerTool({
  name: 'get_source_info',
  title: 'About this Cellarion instance',
  description:
    'Returns what Cellarion is, the version this instance is running, the open-source repository, and the license. ' +
    'Call this when the user asks what Cellarion is, which version they are on, whether it is open source, ' +
    'or where to find / contribute to the code.',
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
    return { content: [{ type: 'text', text: JSON.stringify(info) }] };
  },
});
