const mongoose = require('mongoose');

const entrySchema = new mongoose.Schema({
  bottle: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Bottle',
    required: true
  },
  listPrice: {
    type: Number,
    min: [0, 'Price cannot be negative']
  },
  glassPrice: {
    type: Number,
    min: [0, 'Glass price cannot be negative']
  },
  sortOrder: {
    type: Number,
    default: 0
  }
}, { _id: false });

const sectionSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true,
    maxlength: [200, 'Section title too long']
  },
  sortOrder: {
    type: Number,
    default: 0
  },
  entries: {
    type: [entrySchema],
    default: []
  }
}, { _id: false });

const wineListSchema = new mongoose.Schema({
  cellar: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Cellar',
    required: [true, 'Cellar is required'],
    index: true
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  name: {
    type: String,
    required: [true, 'Wine list name is required'],
    trim: true,
    maxlength: [200, 'Name too long']
  },

  // Public sharing
  shareToken: {
    type: String,
    unique: true,
    sparse: true,
    index: true
  },
  shareTokenCreatedAt: { type: Date },
  isPublished: {
    type: Boolean,
    default: false
  },

  // Language for PDF section headers
  language: {
    type: String,
    enum: ['en', 'sv', 'fr', 'de', 'es', 'it'],
    default: 'en'
  },

  // Structure mode
  structureMode: {
    type: String,
    enum: ['auto', 'custom'],
    default: 'auto'
  },

  // Custom mode: user-defined sections with entries
  sections: {
    type: [sectionSchema],
    default: []
  },

  // Auto mode: grouping config
  autoGrouping: {
    groupBy: {
      type: String,
      enum: ['type', 'country', 'region'],
      default: 'type'
    },
    typeOrder: {
      type: [String],
      default: ['sparkling', 'white', 'rosé', 'red', 'dessert', 'fortified']
    },
    withinGroup: {
      type: String,
      enum: ['country-region-name', 'name', 'price-asc', 'price-desc', 'vintage'],
      default: 'country-region-name'
    }
  },

  // Auto mode: flat list of selected bottles with overrides
  autoGroupEntries: {
    type: [entrySchema],
    default: []
  },

  // Branding
  branding: {
    restaurantName: {
      type: String,
      trim: true,
      maxlength: [200, 'Restaurant name too long']
    },
    tagline: {
      type: String,
      trim: true,
      maxlength: [300, 'Tagline too long']
    },
    logoUrl: {
      type: String,
      trim: true
    },
    footerText: {
      type: String,
      trim: true,
      maxlength: [500, 'Footer text too long']
    }
  },

  // Layout
  layout: {
    colorScheme: {
      type: String,
      enum: ['classic', 'modern', 'elegant', 'minimal'],
      default: 'classic'
    },
    fontFamily: {
      type: String,
      enum: ['serif', 'sans-serif'],
      default: 'serif'
    },
    showGlassPrice: { type: Boolean, default: false },
    glassesPerBottle: {
      type: Number,
      default: 6,
      min: [1, 'Must have at least 1 glass per bottle'],
      max: [20, 'Too many glasses per bottle'],
    },
    glassMarkup: {
      type: Number,
      default: 0,
      min: [-100, 'Markup cannot be less than -100%'],
    },
    currency: {
      type: String,
      default: 'USD',
      uppercase: true,
      trim: true
    },
    currencySymbol: {
      type: String,
      default: '$',
      trim: true
    },
    pageSize: {
      type: String,
      enum: ['A4', 'letter'],
      default: 'A4'
    }
  },

  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, { optimisticConcurrency: true });

// Indexes
wineListSchema.index({ user: 1, cellar: 1 });

// Update timestamp on save
wineListSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('WineList', wineListSchema);
