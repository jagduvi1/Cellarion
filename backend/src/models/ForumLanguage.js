const mongoose = require('mongoose');

/**
 * ForumLanguage — which languages the community forum is open in.
 *
 * POLICY (Johan, 2026-08-31): **English is the forum.** The list defaults to
 * English everywhere — the thread list, and the language field on a new
 * thread — and a member who wants to write in their own language has to pick
 * it deliberately. Writing another language in the English section is not an
 * offence, it is a mis-file: a moderator moves the thread to that language's
 * section (PATCH /api/discussions/:idOrSlug/language) rather than deleting it.
 *
 * A language therefore is not a category. A French tasting note is still a
 * tasting note, so `language` is a second axis on Discussion and the two
 * filter independently — otherwise every category would need a copy per
 * language, and moving a thread between languages would silently re-file its
 * subject too.
 *
 * Lifecycle: `requested` (a member asked for it) → `active` (a moderator
 * opened it; it appears in the pickers) → `retired` (a moderator closed it;
 * it leaves the pickers but its threads stay readable and moveable, because
 * hiding a dead section must never orphan the writing in it). A rejected
 * request is deleted rather than kept as a tombstone — the member can ask
 * again, and a queue of permanent "no"s helps nobody.
 */
const forumLanguageSchema = new mongoose.Schema({
  // ISO 639-1 where one exists — the same vocabulary the UI locales use, so
  // "the French forum" and "the French interface" can never mean two
  // different codes.
  code: {
    type: String,
    required: [true, 'Language code is required'],
    trim: true,
    lowercase: true,
    unique: true,
    minlength: [2, 'Language code is too short'],
    maxlength: [8, 'Language code is too long'],
    match: [/^[a-z]{2,3}(-[a-z]{2,4})?$/, 'Language code must look like "fr" or "pt-br"'],
  },
  // English name ("French") — the moderator-facing label.
  name: {
    type: String,
    required: [true, 'Language name is required'],
    trim: true,
    maxlength: [60, 'Language name is too long'],
  },
  // Endonym ("Français") — what the switcher shows a speaker of it, because
  // someone looking for their own language scans for their own word for it.
  nativeName: {
    type: String,
    trim: true,
    maxlength: [60, 'Native name is too long'],
    default: null,
  },
  status: {
    type: String,
    enum: ['requested', 'active', 'retired'],
    default: 'requested',
    index: true,
  },
  // Who asked, and why — a moderator judging "should we open Portuguese?"
  // needs the case that was made for it. Null for languages seeded by us.
  requestedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  requestReason: {
    type: String,
    trim: true,
    maxlength: [500, 'Reason is too long'],
    default: null,
  },
  decidedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  decidedAt: { type: Date, default: null },
}, { timestamps: true });

// The switcher and the moderation queue both read by status, oldest first.
forumLanguageSchema.index({ status: 1, createdAt: 1 });

/**
 * English is not a row anybody can retire, rename or re-request — it is the
 * forum's default and the fallback every thread falls back to. Kept as a
 * constant rather than a seeded document so a wiped collection cannot take
 * the default section down with it.
 */
const DEFAULT_LANGUAGE = 'en';

module.exports = mongoose.model('ForumLanguage', forumLanguageSchema);
module.exports.DEFAULT_LANGUAGE = DEFAULT_LANGUAGE;
