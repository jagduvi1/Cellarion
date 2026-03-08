const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const { getCellarRole } = require('../utils/cellarAccess');

/**
 * Middleware factory that loads the bottle (by req.params.id), resolves the
 * user's role on its cellar, and gates access by minimum required role.
 *
 * Attaches req.bottle, req.cellar, req.cellarRole on success.
 *
 * Usage:
 *   router.get('/:id', requireBottleAccess('viewer'), handler);
 *   router.put('/:id', requireBottleAccess('editor'), handler);
 */
function requireBottleAccess(minRole = 'viewer') {
  return async (req, res, next) => {
    try {
      const bottle = await Bottle.findById(req.params.id);
      if (!bottle) return res.status(404).json({ error: 'Bottle not found' });

      const cellar = await Cellar.findById(bottle.cellar);
      const role = getCellarRole(cellar, req.user.id);

      if (!role) return res.status(404).json({ error: 'Bottle not found' });

      if (minRole === 'editor' && role === 'viewer') {
        return res.status(403).json({ error: 'Not authorized to modify this bottle' });
      }

      req.bottle = bottle;
      req.cellar = cellar;
      req.cellarRole = role;
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { requireBottleAccess };
