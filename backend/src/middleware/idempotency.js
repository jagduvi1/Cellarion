/**
 * Idempotent writes (#1355): a non-GET request carrying an `Idempotency-Key`
 * header is applied at most once per user. The first request's status and JSON
 * body are stored (models/IdempotencyRecord, 48 h); a repeat with the same key
 * gets that stored answer back (`Idempotent-Replayed: true`) without running
 * the handler again.
 *
 *  - Repeat while the first is still running → 409, `Retry-After: 2`.
 *  - Same key reused for a different method/path → 422.
 *  - 5xx answers are not stored: the key stays free for a real retry.
 *  - No header → untouched, exactly as before.
 *
 * The outcome is stored the moment the handler answers (res.json), not when
 * the response finishes: in a dead zone the client is often gone by then, and
 * that is precisely the case the key exists for. A record left "in progress"
 * (the process died mid-request) is treated as abandoned after STALE_MS.
 *
 * Mounted after requireAuth on the routers whose writes the offline queue
 * sends (bottles, racks).
 */
const IdempotencyRecord = require('../models/IdempotencyRecord');

const KEY_PATTERN = /^[A-Za-z0-9_-]{16,100}$/;
const MAX_STORED_BODY = 256 * 1024; // bytes of JSON; larger answers replay as { replayed: true }
const STALE_MS = 2 * 60 * 1000;

async function claim(scope, method, path) {
  try {
    return { record: await IdempotencyRecord.create({ ...scope, method, path }) };
  } catch (err) {
    if (!err || err.code !== 11000) throw err;
    return { existing: await IdempotencyRecord.findOne(scope).lean() };
  }
}

async function idempotency(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const key = req.get('Idempotency-Key');
  if (!key) return next();
  if (!KEY_PATTERN.test(key)) return res.status(400).json({ error: 'Invalid Idempotency-Key' });
  if (!req.user?.id) return next();

  const path = req.originalUrl.split('?')[0];
  const scope = { user: req.user.id, key };

  let claimed;
  try {
    claimed = await claim(scope, req.method, path);
    const e = claimed.existing;
    if (e && e.status == null && Date.now() - new Date(e.createdAt).getTime() > STALE_MS) {
      // Abandoned mid-request: free it and try once more.
      await IdempotencyRecord.deleteOne({ _id: e._id, status: null });
      claimed = await claim(scope, req.method, path);
    }
  } catch (err) {
    return next(err);
  }

  const existing = claimed.existing;
  if (!claimed.record) {
    if (!existing || existing.status == null) {
      return res.status(409).set('Retry-After', '2').json({ error: 'Request in progress' });
    }
    if (existing.method !== req.method || existing.path !== path) {
      return res.status(422).json({ error: 'Idempotency-Key was already used for a different request' });
    }
    res.set('Idempotent-Replayed', 'true');
    return res.status(existing.status).json(existing.body ?? { replayed: true });
  }

  const recordId = claimed.record._id;
  let settled = false;
  const settle = (status, body) => {
    if (settled) return;
    settled = true;
    if (status >= 500) {
      IdempotencyRecord.deleteOne({ _id: recordId }).catch(() => {});
      return;
    }
    let stored = body === undefined ? null : body;
    try {
      if (stored != null && JSON.stringify(stored).length > MAX_STORED_BODY) stored = { replayed: true };
    } catch { stored = { replayed: true }; }
    IdempotencyRecord.updateOne({ _id: recordId }, { $set: { status, body: stored } }).catch(() => {});
  };

  const originalJson = res.json.bind(res);
  res.json = (body) => { settle(res.statusCode, body); return originalJson(body); };
  // A handler that answered without res.json (none of the mounted routes do):
  // store the status alone. NOT on 'close': a client that hung up early does
  // not stop the handler, which still applies the write and still calls
  // res.json — freeing the key there would let the retry apply it twice. A
  // handler that never answers at all is covered by STALE_MS.
  res.on('finish', () => settle(res.statusCode, undefined));
  return next();
}

module.exports = { idempotency, KEY_PATTERN, STALE_MS };
