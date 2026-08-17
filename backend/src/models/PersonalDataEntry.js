const mongoose = require('mongoose');

// A typed personal value on a wine or a bottle (issue #986). "Personal" means
// not published to the shared registry — NOT hidden from shared-cellar
// members: entries are visible to everyone who can see the bottle, always
// attributed to their author (same rule Bottle.notes follows, but attributed).
//
// Exactly one of wineDefinition/bottle is set, matching targetType:
//   wine   — applies to every bottle of that wine the author owns
//   bottle — true of this bottle alone
//
// `value` is Mixed: the service layer casts and validates it against the
// key's declared type BEFORE it gets here (utils/personalDataTypes.js).

const personalDataEntrySchema = new mongoose.Schema({
  author: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  key: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PersonalDataKey',
    required: [true, 'Key is required']
  },
  targetType: {
    type: String,
    enum: ['wine', 'bottle'],
    required: true
  },
  wineDefinition: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WineDefinition',
    required: function () { return this.targetType === 'wine'; },
    index: true
  },
  bottle: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Bottle',
    required: function () { return this.targetType === 'bottle'; },
    index: true
  },
  value: {
    type: mongoose.Schema.Types.Mixed,
    required: [true, 'Value is required']
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

personalDataEntrySchema.index({ author: 1, bottle: 1 });
personalDataEntrySchema.index({ author: 1, wineDefinition: 1 });

// A target carries exactly one ref; the other must be absent so an entry can
// never straddle both levels.
personalDataEntrySchema.pre('validate', function (next) {
  if (this.targetType === 'wine' && this.bottle) {
    return next(new Error('A wine-level entry must not reference a bottle'));
  }
  if (this.targetType === 'bottle' && this.wineDefinition) {
    return next(new Error('A bottle-level entry must not reference a wine definition'));
  }
  next();
});

personalDataEntrySchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('PersonalDataEntry', personalDataEntrySchema);
