const mongoose = require('mongoose');
const Cellar = require('../models/Cellar');
const { getCellarRole } = require('../utils/cellarAccess');

const ROLE_LEVELS = { viewer: 1, editor: 2, owner: 3 };

/**
 * Middleware factory that loads a cellar, resolves the user's role, and
 * gates access by minimum required role.
 *
 * Cellar ID is extracted from (in order):
 *   req.params.cellarId  →  req.query.cellar  →  req.body.cellar / req.body.cellarId
 *
 * Attaches req.cellar and req.cellarRole on success.
 *
 * Usage:
 *   router.get('/', requireCellarAccess('viewer'), handler);
 *   router.post('/', requireCellarAccess('editor'), handler);
 *   router.delete('/:cellarId', requireCellarAccess('owner'), handler);
 */
function requireCellarAccess(minRole = 'viewer') {
  return async (req, res, next) => {
    try {
      const cellarId =
        req.params.cellarId ||
        req.query.cellar ||
        req.body.cellar ||
        req.body.cellarId;

      if (!cellarId || !mongoose.Types.ObjectId.isValid(cellarId)) {
        return res.status(400).json({ error: 'Cellar ID is required' });
      }

      const cellar = await Cellar.findById(cellarId);
      if (!cellar) {
        return res.status(404).json({ error: 'Cellar not found' });
      }

      const role = getCellarRole(cellar, req.user.id);
      if (!role) {
        return res.status(404).json({ error: 'Cellar not found' });
      }

      const userLevel = ROLE_LEVELS[role] || 0;
      const requiredLevel = ROLE_LEVELS[minRole] || 0;

      if (userLevel < requiredLevel) {
        return res.status(403).json({ error: 'Not authorized for this cellar' });
      }

      req.cellar = cellar;
      req.cellarRole = role;
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { requireCellarAccess };
