const mongoose = require('mongoose');

/**
 * How often API tokens still call a deprecated route (config/apiDeprecations):
 * one row per route and UTC day, a count and nothing else — no user, no token,
 * no IP, so it holds no personal data. Read it to see what a removal would
 * break: db.apideprecateduses.find().sort({ day: -1 }).
 * Rows expire after 400 days.
 */
const apiDeprecatedUseSchema = new mongoose.Schema({
  day: { type: String, required: true },     // 'YYYY-MM-DD' (UTC)
  route: { type: String, required: true },   // 'GET /api/cellars/:id/history'
  // No defaults: rows are only ever upserted ($inc + $setOnInsert), and a
  // schema default on an upsert would collide with the $inc on `count`.
  count: { type: Number },
  createdAt: { type: Date },
});

apiDeprecatedUseSchema.index({ day: 1, route: 1 }, { unique: true });
apiDeprecatedUseSchema.index({ createdAt: 1 }, { expireAfterSeconds: 400 * 24 * 60 * 60 });

module.exports = mongoose.model('ApiDeprecatedUse', apiDeprecatedUseSchema);
