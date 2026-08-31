/**
 * Forum language sections — the shared rules, so every surface that reads or
 * writes a thread's language agrees on them.
 *
 * POLICY (Johan, 2026-08-31): English is the forum. It is the default for the
 * thread list and for a new thread, and a member who wants another language
 * picks it deliberately. See models/ForumLanguage for the lifecycle.
 */
const ForumLanguage = require('../models/ForumLanguage');

const DEFAULT_LANGUAGE = 'en';

/**
 * The English section is a constant, not a document: it must exist even on a
 * fresh database, must not be retirable, and is what every thread falls back
 * to. Shaped like a ForumLanguage row so callers can treat the list uniformly.
 */
const ENGLISH = Object.freeze({
  code: DEFAULT_LANGUAGE,
  name: 'English',
  nativeName: 'English',
  status: 'active',
  isDefault: true,
});

/** Same shape for every consumer; hides the mongoose document. */
function toPublic(doc) {
  return {
    code: doc.code,
    name: doc.name,
    nativeName: doc.nativeName || null,
    status: doc.status,
    isDefault: false,
  };
}

/**
 * Every section a member may post in, English first and the rest by name.
 * English leads because it is the default rather than because "E" sorts early.
 *
 * @returns {Promise<Array<{code: string, name: string, nativeName: string|null, status: string, isDefault: boolean}>>}
 */
async function listActive() {
  const rows = await ForumLanguage.find({ status: 'active' }).sort({ name: 1 }).lean();
  return [ENGLISH, ...rows.filter(r => r.code !== DEFAULT_LANGUAGE).map(toPublic)];
}

/**
 * Normalise and validate a language a caller wants to WRITE (new thread, or a
 * moderator moving one).
 *
 * Empty/absent means English — the policy default, not an error, so the
 * existing clients that send no language keep working unchanged.
 *
 * @param {*} raw
 * @returns {Promise<{code: string}|{error: string}>}
 */
async function resolveWritableLanguage(raw) {
  if (raw === undefined || raw === null || raw === '') return { code: DEFAULT_LANGUAGE };
  if (typeof raw !== 'string') return { error: 'Language must be a string' };
  const code = raw.trim().toLowerCase();
  if (!code || code === DEFAULT_LANGUAGE) return { code: DEFAULT_LANGUAGE };

  const doc = await ForumLanguage.findOne({ code }).select('status name').lean();
  if (!doc) return { error: 'No such forum language' };
  // A retired section takes no new writing, but a moderator can still MOVE a
  // thread into it — see moveTargetError below for that narrower rule.
  if (doc.status !== 'active') return { error: `The ${doc.name} section is not open for new threads` };
  return { code };
}

/**
 * A moderator moving a thread may target any language that EXISTS, including a
 * retired one — consolidating the last few threads of a closed section is
 * exactly the kind of tidying a move is for. Only a code nobody ever opened is
 * refused.
 *
 * @param {*} raw
 * @returns {Promise<{code: string}|{error: string}>}
 */
async function resolveMoveTarget(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { error: 'A target language is required' };
  const code = raw.trim().toLowerCase();
  if (code === DEFAULT_LANGUAGE) return { code: DEFAULT_LANGUAGE };
  const doc = await ForumLanguage.findOne({ code }).select('_id').lean();
  if (!doc) return { error: 'No such forum language' };
  return { code };
}

/**
 * Normalise a language a caller wants to READ by. Unlike the write path an
 * unknown code is NOT an error — a stale bookmark for a language that was
 * never opened should show the default section rather than a 400. The literal
 * 'all' opts out of filtering entirely, which the blog-post and wine-page
 * thread lists use: those are scoped to one subject, and hiding a French
 * thread about that subject would answer a different question than the one
 * asked.
 *
 * @param {*} raw
 * @returns {Promise<string|null>} a code to filter by, or null for "no filter"
 */
async function resolveReadableLanguage(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return DEFAULT_LANGUAGE;
  const code = raw.trim().toLowerCase();
  if (code === 'all') return null;
  if (code === DEFAULT_LANGUAGE) return DEFAULT_LANGUAGE;
  const exists = await ForumLanguage.exists({ code });
  return exists ? code : DEFAULT_LANGUAGE;
}

module.exports = {
  DEFAULT_LANGUAGE,
  ENGLISH,
  listActive,
  resolveWritableLanguage,
  resolveMoveTarget,
  resolveReadableLanguage,
  toPublic,
};
