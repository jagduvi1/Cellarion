/**
 * One-off: copy the wine vectors from the retired Qdrant container onto their
 * WineEmbedding rows (services/vectorStore), so nothing has to be re-embedded.
 *
 * Run it after upgrading, while the old Qdrant container is still running:
 *   docker compose exec -e QDRANT_URL=http://qdrant:6333 backend node src/scripts/migrate-vectors-from-qdrant.js
 *   docker compose exec -e QDRANT_URL=http://qdrant:6333 backend node src/scripts/migrate-vectors-from-qdrant.js --apply
 * The first is a dry run (counts only); --apply writes. Then remove the old
 * container: docker compose up -d --remove-orphans (its volume can go too).
 *
 * Or skip it: a FULL embedding job (SuperAdmin → AI) re-embeds every wine
 * through the provider instead — slower, and one embedding call per pair.
 *
 * Every `wines_*` collection is read. A point is matched to its row by the
 * row's qdrantPointId (left in place, so a rollback still works). A row that
 * already has a vector keeps it (this version wrote a fresher one). Points
 * without a row are leftovers and are skipped. Prints counts only.
 */
const mongoose = require('mongoose');
const WineEmbedding = require('../models/WineEmbedding');
const { encodeVector } = require('../services/vectorStore');

const APPLY = process.argv.includes('--apply');
const QDRANT_URL = (process.env.QDRANT_URL || '').replace(/\/$/, '');
const PAGE = 256;

async function qdrant(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.QDRANT_API_KEY) headers['api-key'] = process.env.QDRANT_API_KEY;
  const res = await fetch(`${QDRANT_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Qdrant ${method} ${path} → ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
  return json.result;
}

async function migrate({ apply = APPLY } = {}) {
  if (!QDRANT_URL) {
    throw new Error('QDRANT_URL is not set — pass it for this run, e.g. docker compose exec -e QDRANT_URL=http://qdrant:6333 backend node src/scripts/migrate-vectors-from-qdrant.js');
  }
  const collections = ((await qdrant('GET', '/collections')).collections || [])
    .map((c) => c.name)
    .filter((n) => n.startsWith('wines_'));
  console.log(`Qdrant collections to read: ${collections.join(', ') || '(none)'}`);

  // Every row with a point id, once (the vector itself is not loaded).
  const rows = await WineEmbedding.find({ qdrantPointId: { $type: 'string' } })
    .select('_id qdrantPointId dim')
    .lean();
  const byPoint = new Map(rows.map((r) => [r.qdrantPointId, r]));
  console.log(`Rows with a Qdrant point id: ${rows.length}`);

  const counts = { points: 0, copied: 0, alreadyHadVector: 0, noRow: 0, noVector: 0 };
  for (const name of collections) {
    let offset = null;
    do {
      const page = await qdrant('POST', `/collections/${name}/points/scroll`, {
        limit: PAGE, with_payload: false, with_vector: true, offset,
      });
      const ops = [];
      for (const p of page.points || []) {
        counts.points += 1;
        const row = byPoint.get(String(p.id));
        if (!row) { counts.noRow += 1; continue; }
        if (row.dim > 0) { counts.alreadyHadVector += 1; continue; }
        if (!Array.isArray(p.vector) || !p.vector.length) { counts.noVector += 1; continue; }
        const { vector, norm, dim } = encodeVector(p.vector);
        ops.push({ updateOne: { filter: { _id: row._id, dim: { $exists: false } }, update: { $set: { vector, norm, dim } } } });
        counts.copied += 1;
      }
      if (apply && ops.length) await WineEmbedding.bulkWrite(ops, { ordered: false });
      offset = page.next_page_offset;
    } while (offset !== null && offset !== undefined);
  }

  const withoutVector = await WineEmbedding.countDocuments({ dim: { $exists: false } });
  console.log(`Points read: ${counts.points}`);
  console.log(`${apply ? 'Vectors copied' : 'Vectors to copy'}: ${counts.copied}`);
  console.log(`Rows that already had a vector (kept): ${counts.alreadyHadVector}`);
  console.log(`Points without a row (leftovers, skipped): ${counts.noRow}`);
  if (counts.noVector) console.log(`Points without a vector (skipped): ${counts.noVector}`);
  console.log(`Rows still without a vector${apply ? '' : ' (before this run)'}: ${withoutVector} — the next incremental embedding job embeds them`);
  if (!apply) console.log('\nDry run — nothing written. Re-run with --apply.');
  return { ...counts, withoutVector };
}

if (require.main === module) {
  mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar')
    .then(migrate)
    .then(() => mongoose.disconnect())
    .catch(async (err) => {
      console.error('Migration failed:', err.message);
      await mongoose.disconnect().catch(() => {});
      process.exit(1);
    });
}

module.exports = { migrate };
