// The language of each blog post, and which posts a reader sees.
//
// A post is an ORIGINAL (translationOf null) or a TRANSLATION of one original;
// an original and its translations are one family. From each family a reader
// sees the version in their own language, else the English one, else nothing:
// an English reader never sees a Swedish post, and a Swedish reader sees the
// Swedish version in place of the English one, never both.
//
// A translation is never news. The app's unread-blog badge counts originals
// only (frontend hooks/useUnreadBlog.js), so publishing a translation does not
// tell members there is something new; it exists for readers who arrive from
// a search in that language.
//
// Posts without a `language` are English; every query here reads a missing
// value as 'en'.

const mongoose = require('mongoose');
const BlogPost = require('../models/BlogPost');
const { coerceStringQuery, isValidId } = require('../utils/validation');
const { errorBody } = require('../config/errorCodes');

const DEFAULT_LANGUAGE = 'en';
const LANGUAGE_CODE = /^[a-z]{2}$/;

/** The language a reader asks for ('fr-CA' reads as 'fr'); English when absent or malformed. */
function readerLanguage(raw) {
  const code = coerceStringQuery(raw).trim().toLowerCase().slice(0, 2);
  return LANGUAGE_CODE.test(code) ? code : DEFAULT_LANGUAGE;
}

/** Mongo condition: the post is written in `lang`. */
function writtenIn(lang) {
  return lang === DEFAULT_LANGUAGE
    ? { language: { $in: [DEFAULT_LANGUAGE, null] } }
    : { language: lang };
}

const familyId = (post) => String(post.translationOf || post._id);

/**
 * Mongo condition for the posts a reader in `lang` sees, one version per
 * family (rule at the top). Callers add `status: 'published'` themselves.
 * REST: GET /api/blog and GET /api/blog/tags. Returns a filter object.
 */
async function visibleTo(lang) {
  if (lang === DEFAULT_LANGUAGE) return writtenIn(DEFAULT_LANGUAGE);
  const own = await BlogPost.find({ status: 'published', language: lang }).select('_id translationOf').lean();
  const covered = [...new Set(own.map(familyId))].map((id) => new mongoose.Types.ObjectId(id));
  return {
    $or: [
      { language: lang },
      { ...writtenIn(DEFAULT_LANGUAGE), _id: { $nin: covered }, translationOf: { $nin: covered } },
    ],
  };
}

/**
 * The published versions of a post's family as [{ language, slug }], the
 * original first, or [] when no other version is published. The hreflang
 * alternates of a post page come from this.
 * REST: GET /api/blog/:slug; the crawler page /og/blog/:slug.
 */
async function alternatesOf(post) {
  const family = post.translationOf || post._id;
  const versions = await BlogPost.find({ status: 'published', $or: [{ _id: family }, { translationOf: family }] })
    .select('language slug translationOf').lean();
  if (!Array.isArray(versions) || versions.length < 2) return [];
  return versions
    .map((v) => ({ language: v.language || DEFAULT_LANGUAGE, slug: v.slug, original: !v.translationOf }))
    .sort((a, b) => (b.original - a.original) || a.language.localeCompare(b.language))
    .map(({ language, slug }) => ({ language, slug }));
}

/** The version search engines show when none matches the searcher's language: English, else the original. */
function defaultAlternate(alternates) {
  return alternates.find((a) => a.language === DEFAULT_LANGUAGE) || alternates[0];
}

// 400 for a request that cannot be right; 409 when it clashes with a
// translation that already exists.
const refuse = (body, status = 400) => ({ fail: { status, body } });

/**
 * Reads and checks the language fields of an admin save. `post` is the post
 * being edited, or null when creating one. Returns `{ language, translationOf }`
 * to store, or `{ fail: { status, body } }` with a coded error.
 * REST: POST and PUT /api/blog/admin/posts.
 */
async function resolveLanguageFields(body, post) {
  let language = post ? (post.language || DEFAULT_LANGUAGE) : DEFAULT_LANGUAGE;
  if (body.language !== undefined) {
    language = typeof body.language === 'string' ? body.language.trim().toLowerCase() : '';
    if (!LANGUAGE_CODE.test(language)) return refuse(errorBody('blog_language_invalid'));
  }

  let translationOf = post ? (post.translationOf || null) : null;
  if (body.translationOf !== undefined) {
    if (body.translationOf === null || body.translationOf === '') translationOf = null;
    else if (typeof body.translationOf === 'string' && isValidId(body.translationOf)) translationOf = body.translationOf;
    else return refuse(errorBody('blog_translation_of_invalid'));
  }

  if (!translationOf) {
    // An original that changes language must not land on one of its own
    // translations' languages: the family would hold that language twice.
    if (post && await BlogPost.exists({ translationOf: post._id, language })) {
      return refuse(errorBody('blog_language_taken_by_translation'), 409);
    }
    return { language, translationOf: null };
  }

  if (post && String(translationOf) === String(post._id)) return refuse(errorBody('blog_translation_of_invalid'));
  const original = await BlogPost.findById(translationOf).select('language translationOf').lean();
  if (!original) return refuse(errorBody('blog_translation_of_invalid'));
  if (original.translationOf) return refuse(errorBody('blog_translation_of_translation'));
  if ((original.language || DEFAULT_LANGUAGE) === language) return refuse(errorBody('blog_translation_same_language'));
  if (post && await BlogPost.exists({ translationOf: post._id })) return refuse(errorBody('blog_original_has_translations'));
  const taken = { translationOf, language, ...(post ? { _id: { $ne: post._id } } : {}) };
  if (await BlogPost.exists(taken)) return refuse(errorBody('blog_translation_exists'), 409);
  return { language, translationOf };
}

module.exports = {
  DEFAULT_LANGUAGE, readerLanguage, visibleTo, alternatesOf, defaultAlternate, resolveLanguageFields,
};
