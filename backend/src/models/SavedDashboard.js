const mongoose = require('mongoose');

// A user's analytics dashboard (#987 R-E): a named grid of widgets, each one
// a stored analytics query + a visualization + a size. cube.dev-style "pages
// you just look at" — the default 'My cellar' dashboard is client-side until
// the user customizes, so a row exists only for people who made one.
//
// The stored `query` is DATA, revalidated by the analytics engine on every
// render — persisting it grants nothing the live endpoint would refuse (the
// engine re-derives scope per request; a stale cellar id simply narrows to
// nothing).
//
// MULTI-DASHBOARD (Johan 2026-08-19): several named dashboards per user,
// unique on (user, name), capped in the route. ⚠️ The first release shipped
// one-per-user with a UNIQUE index on `user` alone — that index must be
// DROPPED on prod at deploy (scripts/migrate-dashboards-multi.js) or the
// second dashboard insert throws E11000.

const widgetSchema = new mongoose.Schema({
  title: { type: String, trim: true, maxlength: [80, 'Widget title too long'], required: true },
  // 'kpi' renders grouped/no-dimension buckets as big numbers; the chart
  // kinds mirror the analytics table's toggles; 'table' shows compact rows
  // or buckets.
  viz: { type: String, enum: ['kpi', 'bar', 'donut', 'line', 'table'], required: true },
  size: { type: String, enum: ['half', 'full'], default: 'half' },
  // The exact /api/analytics/query body. Mixed on purpose: the engine is the
  // validator (whitelisted fields/ops, caps), and duplicating its rules in a
  // schema would drift. Bounded by the widget cap + the 16KB doc math below.
  query: { type: mongoose.Schema.Types.Mixed, required: true },
}, { _id: false });

const savedDashboardSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  name: {
    type: String,
    trim: true,
    maxlength: [60, 'Dashboard name too long'],
    default: 'My cellar',
  },
  widgets: {
    type: [widgetSchema],
    default: [],
    validate: {
      validator: (v) => v.length <= 12,
      message: 'A dashboard holds at most 12 widgets',
    },
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

savedDashboardSchema.index({ user: 1, name: 1 }, { unique: true });

savedDashboardSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('SavedDashboard', savedDashboardSchema);
