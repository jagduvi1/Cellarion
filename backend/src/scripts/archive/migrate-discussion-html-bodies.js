/**
 * Convert existing plain-text discussion + reply bodies to HTML.
 *
 * Phase 4b switches the composer from a plain `<textarea>` to TipTap rich
 * text. New posts come in as sanitized HTML; existing posts are still
 * plaintext with `\n` line breaks. Without this migration, old posts would
 * render as one long line because HTML collapses whitespace.
 *
 * Conversion: split body on blank lines into paragraphs; within each
 * paragraph, replace single newlines with `<br>`. Escape `< > &` defensively
 * (old bodies were stripHtml'd so should already be plain, but if any HTML
 * leaked through stripHtml, escaping protects against accidental rendering).
 *
 * Idempotent: a post that already starts with `<p>` or another known block
 * tag is skipped. Safe to run twice.
 *
 * Run inside the backend container:
 *   docker exec cellarion-backend node src/scripts/migrate-discussion-html-bodies.js
 */

const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Discussion = require('../models/Discussion');
const DiscussionReply = require('../models/DiscussionReply');

// Treat the body as already-HTML if it begins with one of these block tags.
// We don't want to wrap a sanitized HTML body in another `<p>`.
const HTML_LEADING_RE = /^\s*<(p|br|strong|em|s|u|blockquote|ul|ol|li|a)[\s>/]/i;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function plaintextToHtml(plain) {
  if (!plain) return '';
  // Split on 2+ newlines into paragraphs; within paragraphs replace single
  // newlines with `<br>`. Empty paragraphs are dropped.
  const paragraphs = plain
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`);
  return paragraphs.join('');
}

async function migrateCollection(Model, label) {
  const total = await Model.countDocuments({});
  console.log(`[migrate-html] ${label}: ${total} total docs`);

  const cursor = Model.find().select('_id body').cursor();
  const ops = [];
  let updated = 0;
  let skipped = 0;

  for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
    const body = doc.body || '';
    if (HTML_LEADING_RE.test(body)) {
      skipped++;
      continue;
    }
    const html = plaintextToHtml(body);
    ops.push({
      updateOne: {
        filter: { _id: doc._id },
        update: { $set: { body: html } }
      }
    });
    updated++;

    if (ops.length >= 500) {
      await Model.bulkWrite(ops, { ordered: false });
      ops.length = 0;
    }
  }

  if (ops.length > 0) {
    await Model.bulkWrite(ops, { ordered: false });
  }

  console.log(`[migrate-html] ${label}: converted ${updated}, skipped ${skipped} (already HTML)`);
}

(async () => {
  await connectDB();
  await migrateCollection(Discussion, 'discussions');
  await migrateCollection(DiscussionReply, 'replies');
  await mongoose.disconnect();
})().catch(err => {
  console.error('[migrate-html] FAILED:', err);
  process.exit(1);
});
