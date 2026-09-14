const mongoose = require('mongoose');

const pairingSchema = new mongoose.Schema({
  dish: {
    type: String,
    trim: true,
    maxlength: 200,
    default: ''
  },
  bottle: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Bottle',
    default: null
  },
  wine: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WineDefinition',
    default: null
  },
  wineName: {
    type: String,
    trim: true,
    maxlength: 200,
    default: ''
  },
  // The vintage as picked, kept beside the bottle reference: the reference is
  // the truth while the bottle exists, and this survives its deletion so the
  // entry still prints the year (audit 2026-09-14 M2). Empty for free text.
  vintage: {
    type: String,
    trim: true,
    maxlength: 12,
    default: ''
  },
  notes: {
    type: String,
    trim: true,
    maxlength: 500,
    default: ''
  }
}, { _id: true });

const personSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  }
}, { _id: true });

const journalEntrySchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  date: {
    type: Date,
    required: true,
    index: true
  },
  title: {
    type: String,
    trim: true,
    maxlength: 200,
    default: ''
  },
  occasion: {
    type: String,
    enum: ['dinner', 'tasting', 'celebration', 'casual', 'gift', 'travel', 'other'],
    default: 'dinner'
  },
  people: [personSchema],
  pairings: [pairingSchema],
  mood: {
    type: Number,
    min: 1,
    max: 5,
    default: null
  },
  notes: {
    type: String,
    trim: true,
    maxlength: 2000,
    default: ''
  },
  photos: [{
    type: String
  }],
  visibility: {
    type: String,
    enum: ['private', 'public'],
    default: 'private'
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

journalEntrySchema.index({ user: 1, date: -1 });
journalEntrySchema.index({ user: 1, createdAt: -1 });

journalEntrySchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('JournalEntry', journalEntrySchema);
