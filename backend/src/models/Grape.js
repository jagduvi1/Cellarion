const mongoose = require('mongoose');
const { slugify } = require('../utils/normalize');

const grapeSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Grape name is required'],
    unique: true,
    trim: true
  },
  normalizedName: {
    type: String,
    required: true,
    lowercase: true,
    unique: true,
    index: true
  },
  color: {
    type: String,
    enum: ['Red', 'White'],
    default: null
  },
  origin: {
    type: String,
    trim: true,
    default: null
  },
  characteristics: {
    type: [String],
    default: []
  },
  agingPotential: {
    type: String,
    trim: true,
    default: null
  },
  prestige: {
    type: String,
    trim: true,
    default: null
  },
  synonyms: {
    type: [String],
    default: []
  },
  slug: { type: String, trim: true, lowercase: true, unique: true, sparse: true, index: true },
  description: { type: String, trim: true, default: '' },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

grapeSchema.pre('save', async function(next) {
  if (this.slug || !this.isNew) return next();
  const base = slugify(this.name);
  if (!base) return next();
  let candidate = base;
  for (let i = 2; i < 100; i++) {
    const hit = await this.constructor.findOne({ slug: candidate }).select('_id').lean();
    if (!hit) break;
    candidate = `${base}-${i}`;
  }
  this.slug = candidate;
  next();
});

module.exports = mongoose.model('Grape', grapeSchema);
