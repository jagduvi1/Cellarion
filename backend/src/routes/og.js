// The crawler-rendered pages, mounted at /api/og. nginx sends search engines
// and AI crawlers here instead of to the SPA, so each page carries its text and
// its structured data as plain HTML. One file per page family in routes/og/;
// every page counts against the one rate limiter in og/shared.js.
const express = require('express');

const router = express.Router();

// The landing page, Help, Developers and the two connect-AI pages.
router.use(require('./og/site'));

// A registry wine.
router.use(require('./og/wine'));

// The blog index and a post.
router.use(require('./og/blog'));

// A region, a country, a grape, a wine type.
router.use(require('./og/taxonomy'));

// The forum list and a thread.
router.use(require('./og/discussions'));

module.exports = router;
