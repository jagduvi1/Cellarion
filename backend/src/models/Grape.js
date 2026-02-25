const mongoose = require('mongoose');

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

module.exports = mongoose.model('Grape', grapeSchema);
