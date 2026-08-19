const mongoose = require('mongoose');

// A saved analytics view (#987 saved-views slice, Johan 2026-08-19): any
// table state — rows or grouped, filters, columns, chart — under a name the
// user chose, plus the starring that orders the views menu. Two kinds share
// the collection so one GDPR entry and one routes file cover both:
//
//   kind 'own'         — a user-created view: name + query + viz, starrable
//   kind 'preset-star' — a star on one of the built-in presets; existence IS
//                        the star, presetKey names which. No query stored —
//                        presets live in the frontend as constants.
//
// Stored queries are DATA: the analytics engine revalidates on every run, so
// persisting one grants nothing the live endpoint would refuse.

const savedViewSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  kind: {
    type: String,
    enum: ['own', 'preset-star'],
    required: true,
  },
  // own only
  name: {
    type: String,
    trim: true,
    maxlength: [80, 'View name too long'],
    required: function () { return this.kind === 'own'; },
  },
  starred: { type: Boolean, default: false },
  viz: {
    type: String,
    enum: ['table', 'kpi', 'bar', 'donut', 'line'],
    default: 'table',
  },
  query: {
    type: mongoose.Schema.Types.Mixed,
    required: function () { return this.kind === 'own'; },
  },
  // preset-star only
  presetKey: {
    type: String,
    trim: true,
    maxlength: 60,
    required: function () { return this.kind === 'preset-star'; },
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// One star per (user, preset); own views are free-form but capped in the route.
savedViewSchema.index(
  { user: 1, kind: 1, presetKey: 1 },
  { unique: true, partialFilterExpression: { kind: 'preset-star' } }
);

savedViewSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('SavedView', savedViewSchema);
