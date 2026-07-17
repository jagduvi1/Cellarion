// Single source for the public site base URL (MCP-audit M5). Every user-facing
// link must derive from FRONTEND_URL so a self-hosted instance emits its OWN
// origin, never a hardcoded https://cellarion.app (whose /wines and /blog paths
// don't exist on someone else's deployment). Same fallback as routes/og.js,
// routes/sitemap.js, services/indexNow.js and mcp/tools/export.js — kept here so
// there is one place to change it. Trailing slashes are trimmed so
// `${siteBaseUrl()}/wines/x` never produces a double slash.
function siteBaseUrl() {
  return (process.env.FRONTEND_URL || 'https://cellarion.app').replace(/\/+$/, '');
}

module.exports = { siteBaseUrl };
