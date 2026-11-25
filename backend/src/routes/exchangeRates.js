const express = require('express');
const { getOrCreateDailySnapshot } = require('../utils/exchangeRates');

const router = express.Router();

// GET /api/exchange-rates — today's USD-based rates, served from the daily
// snapshot the backend already keeps for price anchoring. Public and cheap:
// at most ONE upstream call per day happens here, on the server, so the
// browser never contacts open.er-api.com itself: a visitor's IP must not reach
// a provider the privacy policy does not name.
router.get('/', async (req, res) => {
  try {
    const snapshot = await getOrCreateDailySnapshot();
    if (!snapshot || !snapshot.rates) {
      return res.status(503).json({ error: 'Exchange rates are temporarily unavailable' });
    }
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ base: 'USD', date: snapshot.date, fetchedAt: snapshot.fetchedAt, rates: snapshot.rates });
  } catch (error) {
    console.error('Exchange rates error:', error);
    res.status(500).json({ error: 'Failed to load exchange rates' });
  }
});

module.exports = router;
