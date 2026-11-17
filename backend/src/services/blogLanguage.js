// The language of each blog post, and how its translations are reached.
//
// A post is an ORIGINAL (translationOf null) or a TRANSLATION of one original;
// an original and its translations are one family. The originals are what is
// written (in English); the translations are made from them. So every reader
// sees the same blog: the list, its tags and the unread badge hold originals
// only, whatever language the app shows. A translation is reached from its
// original's page ("Also in"), from search engines (hreflang between the
// versions) and from the MCP guide list; it is never news, so publishing one
// tells no member there is something new.
//
// Posts without a `language` are English.

const BlogPost = require('../models/BlogPost');
const { isValidId } = require('../utils/validation');
const { errorBody } = require('../config/errorCodes');

const DEFAULT_LANGUAGE = 'en';
const LANGUAGE_CODE = /^[a-z]{2}$/;

/** Mongo condition for the posts the blog lists: originals (a missing translationOf is one). */
const LISTED = Object.freeze({ translationOf: null });

/**
 * The published versions of a post's family as [{ language, slug, original }],
 * the original first, or [] when no other version is published. A post page's
 * language links and hreflang alternates come from this.
 * REST: GET /api/blog/:slug; the crawler page /og/blog/:slug; MCP read_guide.
 */
async function alternatesOf(post) {
  const family = post.translationOf || post._id;
  const versions = await BlogPost.find({ status: 'published', $or: [{ _id: family }, { translationOf: family }] })
    .select('language slug translationOf').lean();
  if (!Array.isArray(versions) || versions.length < 2) return [];
  return versions
    .map((v) => ({ language: v.language || DEFAULT_LANGUAGE, slug: v.slug, original: !v.translationOf }))
    .sort((a, b) => (b.original - a.original) || a.language.localeCompare(b.language));
}

/**
 * A language's name in itself, capitalised ('sv' → 'Svenska'), or its code
 * when the runtime cannot name it: the label of a link to a translation, as
 * the app's post page labels it (frontend utils/blogLanguage.js).
 */
function nativeLanguageName(code) {
  let name = code;
  try {
    name = new Intl.DisplayNames([code], { type: 'language' }).of(code) || code;
  } catch { /* an unknown code is shown as itself */ }
  return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
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
  DEFAULT_LANGUAGE, LISTED, alternatesOf, defaultAlternate, nativeLanguageName, resolveLanguageFields,
};
