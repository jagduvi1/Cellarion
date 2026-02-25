const express = require('express');
const { requireAuth, requireRole } = require('../../middleware/auth');
const User = require('../../models/User');
const { PLAN_NAMES } = require('../../config/plans');
const { logAudit } = require('../../services/audit');

const router = express.Router();

const VALID_ROLES = ['user', 'somm', 'admin'];

// All routes require admin
router.use(requireAuth, requireRole('admin'));

// GET /api/admin/users - List all users with optional filters and pagination
router.get('/', async (req, res) => {
  try {
    const { search, plan, role, limit = 50, offset = 0 } = req.query;

    const filter = {};

    if (search) {
      const re = new RegExp(search.trim(), 'i');
      filter.$or = [{ username: re }, { email: re }];
    }
    if (plan && PLAN_NAMES.includes(plan)) {
      filter.plan = plan;
    }
    if (role && VALID_ROLES.includes(role)) {
      // Match users who have this role in their roles array
      filter.roles = role;
    }

    const [users, total] = await Promise.all([
      User.find(filter)
        .select('username email roles plan createdAt')
        .sort({ createdAt: -1 })
        .skip(Number(offset))
        .limit(Number(limit)),
      User.countDocuments(filter),
    ]);

    res.json({ total, users });
  } catch (error) {
    console.error('Admin list users error:', error);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

// PATCH /api/admin/users/:id/plan - Change a user's plan
router.patch('/:id/plan', async (req, res) => {
  try {
    const { plan } = req.body;

    if (!plan || !PLAN_NAMES.includes(plan)) {
      return res.status(400).json({ error: `plan must be one of: ${PLAN_NAMES.join(', ')}` });
    }

    const user = await User.findById(req.params.id).select('username email roles plan');
    if (!user) return res.status(404).json({ error: 'User not found' });

    const previousPlan = user.plan;
    user.plan = plan;
    await user.save();

    logAudit(req, 'admin.user.plan.change',
      { type: 'user', id: user._id },
      { username: user.username, from: previousPlan, to: plan }
    );

    res.json({ user: { _id: user._id, username: user.username, email: user.email, roles: user.roles, plan: user.plan } });
  } catch (error) {
    console.error('Admin change plan error:', error);
    res.status(500).json({ error: 'Failed to change plan' });
  }
});

// PATCH /api/admin/users/:id/roles - Set the full roles array for a user
router.patch('/:id/roles', async (req, res) => {
  try {
    const { roles } = req.body;

    if (!Array.isArray(roles) || roles.length === 0) {
      return res.status(400).json({ error: 'roles must be a non-empty array' });
    }

    const invalid = roles.filter(r => !VALID_ROLES.includes(r));
    if (invalid.length > 0) {
      return res.status(400).json({ error: `Invalid roles: ${invalid.join(', ')}. Must be: ${VALID_ROLES.join(', ')}` });
    }

    // Prevent self-modification of roles
    if (req.params.id === req.user.id.toString()) {
      return res.status(400).json({ error: 'You cannot change your own roles' });
    }

    const user = await User.findById(req.params.id).select('username email roles plan');
    if (!user) return res.status(404).json({ error: 'User not found' });

    const previousRoles = [...user.roles];
    user.roles = [...new Set(roles)]; // deduplicate
    await user.save();

    logAudit(req, 'admin.user.roles.change',
      { type: 'user', id: user._id },
      { username: user.username, from: previousRoles, to: user.roles }
    );

    res.json({ user: { _id: user._id, username: user.username, email: user.email, roles: user.roles, plan: user.plan } });
  } catch (error) {
    console.error('Admin change roles error:', error);
    res.status(500).json({ error: 'Failed to change roles' });
  }
});

module.exports = router;
