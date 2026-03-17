const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: [true, 'Username is required'],
    unique: true,
    trim: true,
    lowercase: true,
    minlength: [3, 'Username must be at least 3 characters']
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    trim: true,
    lowercase: true,
    match: [/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/, 'Please enter a valid email']
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    validate: {
      validator: (v) => /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^a-zA-Z\d]).{12,}$/.test(v),
      message: 'Password must be at least 12 characters and include an uppercase letter, lowercase letter, number, and special character'
    }
  },
  roles: {
    type: [String],
    enum: ['user', 'somm', 'admin'],
    default: ['user'],
    validate: {
      validator: (arr) => arr.length > 0,
      message: 'User must have at least one role'
    }
  },
  plan: {
    type: String,
    enum: ['free', 'basic', 'premium'],
    default: 'free'
  },
  planStartedAt: {
    type: Date,
    default: null
  },
  planExpiresAt: {
    type: Date,
    default: null   // null = no expiry (indefinite)
  },
  trialEligible: {
    type: Boolean,
    default: true   // admin can reset to true to allow another trial
  },
  preferences: {
    currency: {
      type: String,
      default: 'USD',
      uppercase: true,
      trim: true
    },
    language: {
      type: String,
      default: 'en',
      trim: true
    },
    ratingScale: {
      type: String,
      enum: ['5', '20', '100'],
      default: '5'
    },
    defaultCellarId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cellar',
      default: null
    }
  },
  refreshTokenHash: {
    type: String,
    default: null
  },
  emailVerified: {
    type: Boolean,
    default: false
  },
  emailVerificationTokenHash: {
    type: String,
    default: null
  },
  emailVerificationExpiresAt: {
    type: Date,
    default: null
  },
  passwordResetTokenHash: {
    type: String,
    default: null
  },
  passwordResetExpiresAt: {
    type: Date,
    default: null
  },
  displayName: {
    type: String,
    trim: true,
    maxlength: [50, 'Display name too long'],
    default: null
  },
  bio: {
    type: String,
    trim: true,
    maxlength: [500, 'Bio too long'],
    default: null
  },
  followersCount: {
    type: Number,
    default: 0
  },
  followingCount: {
    type: Number,
    default: 0
  },
  reviewCount: {
    type: Number,
    default: 0
  },
  profileVisibility: {
    type: String,
    enum: ['public', 'private'],
    default: 'public'
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Sparse index so verify-email lookup is efficient; sparse avoids bloat after verification
userSchema.index({ emailVerificationTokenHash: 1 }, { sparse: true });
userSchema.index({ passwordResetTokenHash: 1 }, { sparse: true });

// Hash password before saving
userSchema.pre('save', async function(next) {
  // Only hash if password is modified or new
  if (!this.isModified('password')) {
    return next();
  }

  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Method to compare password for login
userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Store a hashed refresh token
userSchema.methods.setRefreshToken = function(token) {
  this.refreshTokenHash = crypto.createHash('sha256').update(token).digest('hex');
};

// Validate a refresh token against the stored hash
userSchema.methods.validateRefreshToken = function(token) {
  if (!this.refreshTokenHash) return false;
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(this.refreshTokenHash));
};

// Generate a raw verification token, store its hash, set 24h expiry; returns raw token to email
userSchema.methods.setEmailVerificationToken = function() {
  const token = crypto.randomBytes(32).toString('hex');
  this.emailVerificationTokenHash = crypto.createHash('sha256').update(token).digest('hex');
  this.emailVerificationExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return token;
};

// Validate a candidate token against the stored hash and expiry
userSchema.methods.validateEmailVerificationToken = function(candidateToken) {
  if (!this.emailVerificationTokenHash || !this.emailVerificationExpiresAt) return false;
  if (Date.now() > this.emailVerificationExpiresAt.getTime()) return false;
  const hash = crypto.createHash('sha256').update(candidateToken).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(this.emailVerificationTokenHash));
};

// Generate a raw password-reset token, store its hash, set 1h expiry; returns raw token to email
userSchema.methods.setPasswordResetToken = function() {
  const token = crypto.randomBytes(32).toString('hex');
  this.passwordResetTokenHash = crypto.createHash('sha256').update(token).digest('hex');
  this.passwordResetExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
  return token;
};

// Validate a password-reset token against the stored hash and expiry
userSchema.methods.validatePasswordResetToken = function(candidateToken) {
  if (!this.passwordResetTokenHash || !this.passwordResetExpiresAt) return false;
  if (Date.now() > this.passwordResetExpiresAt.getTime()) return false;
  const hash = crypto.createHash('sha256').update(candidateToken).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(this.passwordResetTokenHash));
};

// Remove sensitive fields from JSON responses
userSchema.methods.toJSON = function() {
  const obj = this.toObject();
  delete obj.password;
  delete obj.refreshTokenHash;
  delete obj.emailVerificationTokenHash;
  delete obj.emailVerificationExpiresAt;
  delete obj.passwordResetTokenHash;
  delete obj.passwordResetExpiresAt;
  return obj;
};

module.exports = mongoose.model('User', userSchema);
