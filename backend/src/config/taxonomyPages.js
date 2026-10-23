// A region, country or grape gets a public page (and a sitemap entry, and a
// link from a wine page) only when at least this many public wines use it.
// One value for routes/taxonomy.js, routes/sitemap.js and
// services/winePageContext.js, so a wine page never links to a page that
// answers 404.
const MIN_WINES = 3;

module.exports = { MIN_WINES };
