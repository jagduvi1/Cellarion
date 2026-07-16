/**
 * Journal entry operations — ONE implementation for both surfaces (the REST
 * routes in routes/journal.js and the MCP capture_tasting_note tool), so
 * sanitisation, reference validation, the mention-notification policy and
 * audit logging can never drift between the UI and an AI caller. Same pattern
 * as services/bottleOps.js / services/rackOps.js.
 */
const JournalEntry = require('../models/JournalEntry');
const Bottle = require('../models/Bottle');
const User = require('../models/User');
const WineDefinition = require('../models/WineDefinition');
const { logAudit } = require('./audit');
const { createNotification } = require('./notifications');
const { stripHtml } = require('../utils/sanitize');
const { isValidId } = require('../utils/validation');
const { getCellarRole } = require('../utils/cellarAccess');

const MAX_PAIRINGS = 20;
const MAX_PEOPLE = 20;
const MAX_PHOTOS = 10;
const OCCASIONS = ['dinner', 'tasting', 'celebration', 'casual', 'gift', 'travel', 'other'];

/**
 * Shape-level sanitisation of a journal entry body. Throws { status: 400 }
 * on values that must be rejected rather than silently dropped (mood).
 */
function sanitizeEntry(body) {
  const {
    date, title, occasion, people, pairings, mood, notes, photos, visibility
  } = body;

  const clean = {};

  if (date) clean.date = new Date(date);
  if (title != null) clean.title = stripHtml(String(title)).slice(0, 200);
  if (occasion && OCCASIONS.includes(occasion)) clean.occasion = occasion;
  if (mood != null) {
    const m = parseInt(mood, 10);
    if (Number.isInteger(m) && m >= 1 && m <= 5) clean.mood = m;
    else {
      // Reject instead of silently nulling — a PUT with mood: 7 used to
      // erase the stored value without any indication.
      const err = new Error('Mood must be a whole number between 1 and 5');
      err.status = 400;
      throw err;
    }
  }
  if (notes != null) clean.notes = stripHtml(String(notes)).slice(0, 2000);
  if (visibility && ['private', 'public'].includes(visibility)) clean.visibility = visibility;

  if (Array.isArray(photos)) {
    clean.photos = photos.slice(0, MAX_PHOTOS).filter(p => typeof p === 'string');
  }

  if (Array.isArray(people)) {
    clean.people = people.slice(0, MAX_PEOPLE).map(p => ({
      name: stripHtml(String(p.name || '')).slice(0, 100),
      user: p.user && isValidId(p.user) ? p.user : null
    })).filter(p => p.name.length > 0);
  }

  if (Array.isArray(pairings)) {
    clean.pairings = pairings.slice(0, MAX_PAIRINGS).map(p => ({
      dish: stripHtml(String(p.dish || '')).slice(0, 200),
      bottle: p.bottle && isValidId(String(p.bottle)) ? p.bottle : null,
      wine: p.wine && isValidId(String(p.wine)) ? p.wine : null,
      wineName: stripHtml(String(p.wineName || '')).slice(0, 200),
      notes: stripHtml(String(p.notes || '')).slice(0, 500)
    }));
  }

  return clean;
}

/**
 * Ownership/existence validation for the references sanitizeEntry accepted by
 * shape alone (audit L-5). Mirrors sanitizeEntry's style: invalid references
 * are silently dropped (nulled), never a hard 400 — exactly like a malformed
 * ObjectId already is.
 *
 *  - pairings[].bottle must resolve to a bottle the author can access: their
 *    own bottle, or one in a cellar where they hold any role (getCellarRole,
 *    same check the bottles routes use). Otherwise a foreign bottle id would
 *    be populated back as {vintage, wine name/producer/type}.
 *  - pairings[].wine is a public WineDefinition ref → existence check only.
 */
async function validatePairingRefs(clean, userId) {
  if (!Array.isArray(clean.pairings) || clean.pairings.length === 0) return;

  const bottleIds = [...new Set(clean.pairings.filter(p => p.bottle).map(p => String(p.bottle)))];
  if (bottleIds.length) {
    const bottles = await Bottle.find({ _id: { $in: bottleIds } })
      .select('user cellar')
      .populate('cellar', 'user members deletedAt')
      .lean();
    const accessible = new Set(
      bottles
        .filter(b =>
          String(b.user) === String(userId) ||
          (b.cellar && !b.cellar.deletedAt && getCellarRole(b.cellar, userId))
        )
        .map(b => String(b._id))
    );
    for (const p of clean.pairings) {
      if (p.bottle && !accessible.has(String(p.bottle))) p.bottle = null;
    }
  }

  const wineIds = [...new Set(clean.pairings.filter(p => p.wine).map(p => String(p.wine)))];
  if (wineIds.length) {
    const wines = await WineDefinition.find({ _id: { $in: wineIds } }).select('_id').lean();
    const existing = new Set(wines.map(w => String(w._id)));
    for (const p of clean.pairings) {
      if (p.wine && !existing.has(String(p.wine))) p.wine = null;
    }
  }
}

/**
 * Create a journal entry: sanitise → validate refs → create → mention
 * notifications (public entries only) → audit. The single write path for both
 * surfaces. Returns { entry } (unpopulated doc) or { error: {status, message} }.
 *
 * opts.auditMeta rides into the journal.create audit row (e.g. { via: 'mcp' }).
 */
async function createEntry(userId, body, req, opts = {}) {
  let clean;
  try {
    clean = sanitizeEntry(body);
  } catch (err) {
    if (err.status === 400) return { error: { status: 400, message: err.message } };
    throw err;
  }
  if (!clean.date || isNaN(clean.date.getTime())) {
    return { error: { status: 400, message: 'Valid date is required' } };
  }

  await validatePairingRefs(clean, userId);

  const entry = await JournalEntry.create({ user: userId, ...clean });

  // Notify tagged Cellarion users (public entries only). The mention policy
  // lives HERE so no surface can accidentally re-introduce notification spam
  // from private or machine-written entries.
  if (entry.visibility === 'public' && entry.people?.some((p) => p.user)) {
    const sender = await User.findById(userId).select('username displayName').lean();
    const senderName = sender?.displayName || sender?.username || 'Someone';
    for (const person of entry.people) {
      if (person.user && String(person.user) !== String(userId)) {
        createNotification(
          person.user,
          'journal_mention',
          'Journal Mention',
          `${senderName} mentioned you in a journal entry: "${entry.title || 'Untitled'}"`,
          // No link: journal entries are private to their owner (there is no
          // route or endpoint to view another user's entry), so a per-entry
          // deep link would 404. Keep the notification informational-only.
          null,
          undefined,
          userId // actor — lets GDPR erasure remove this on the mentioner's deletion
        );
      }
    }
  }

  logAudit(req, 'journal.create', { type: 'journal', id: entry._id }, opts.auditMeta);
  return { entry };
}

/**
 * Delete one of the user's entries (owner-scoped) with the audit row. Returns
 * { deleted: boolean, entry? }. Shared by the REST DELETE route and the MCP
 * tasting-note undo, so a reversal is audited exactly like a manual deletion.
 */
async function deleteEntry(userId, entryId, req, opts = {}) {
  if (!isValidId(String(entryId))) return { deleted: false };
  const entry = await JournalEntry.findOneAndDelete({ _id: entryId, user: userId });
  if (!entry) return { deleted: false };
  logAudit(req, 'journal.delete', { type: 'journal', id: entry._id }, opts.auditMeta);
  return { deleted: true, entry };
}

module.exports = {
  sanitizeEntry, validatePairingRefs, createEntry, deleteEntry,
  OCCASIONS, MAX_PAIRINGS, MAX_PEOPLE, MAX_PHOTOS,
};
