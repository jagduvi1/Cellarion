/**
 * A wine a self-hosted install CONTRIBUTES to the shared registry, registry
 * side (Registry Bridge, POST /api/bridge/v1/contributions). The install half
 * is services/registryContributionOps.js.
 *
 * It lands in the wine-request queue as a new_wine request, the queue a
 * forwarded "Request a wine" also uses, but carrying the identity the install
 * already holds: the producer, the geography and type as `hints` (pre-filled
 * on the admin page like an import's), the grapes as suggestedGrapes, the
 * label photo, and the drink windows set there as proposedWindows. Nothing
 * reaches the registry from here. An admin resolves the request, creating the
 * wine as the registry's rules want it or linking one the registry already
 * has, and the windows then wait in the maturity queue as suggestions for a
 * curator to adjust and review (services/wineRequestOps).
 *
 * The install follows every contribution: it asks GET /v1/requests for the
 * outcome and links its own wine, so installFollowsAt is set at once and the
 * decision here does not notify the key owner a second time.
 */
const WineRequest = require('../models/WineRequest');
const { originFrom } = require('../utils/contributionOrigin');
const { validateImageRef } = require('./accountOps');
const { PHASE_FIELDS, checkWindow } = require('./maturityOps');
const { parseAndValidateVintage } = require('../utils/validation');

const NAME_MAX = 300;
const PRODUCER_MAX = 200;
const GRAPES_MAX = 20;
const GRAPE_NAME_MAX = 80;
const WINDOWS_MAX = 30;
// The phases as GET /v1/wines/:id serves them, so an install sends windows in
// the shape it reads them.
const WIRE_PHASES = [['early', 'earlyFrom', 'earlyUntil'], ['peak', 'peakFrom', 'peakUntil'], ['late', 'lateFrom', 'lateUntil']];

// The hints a contribution may carry, with the WineRequest.hints limits.
const HINT_MAX = { country: 100, region: 100, appellation: 150, type: 20, classification: 150, colour: 20, sweetness: 40, lwin: 20 };
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// '' for nothing, the trimmed text, or null when it is not text, is too long,
// or carries a control character (a NUL would make the lookup in
// fileContribution throw after the quota was spent).
function text(value, max) {
  if (value == null) return '';
  if (typeof value !== 'string') return null;
  const s = value.trim();
  return s.length > max || CONTROL.test(s) ? null : s;
}

/** The windows as stored (proposedWindows), or { error }. */
function parseWindows(raw) {
  if (raw == null) return { windows: [] };
  if (!Array.isArray(raw)) return { error: 'windows must be a list' };
  if (raw.length > WINDOWS_MAX) return { error: `At most ${WINDOWS_MAX} drink windows` };
  const windows = [];
  const seen = new Set();
  for (const w of raw) {
    const parsed = w && typeof w.vintage !== 'object' ? parseAndValidateVintage(w.vintage) : { ok: false };
    const vintage = parsed.ok ? parsed.value : '';
    if (!/^\d{4}$/.test(vintage)) return { error: 'windows: each vintage must be a year from 1900 to this year' };
    if (seen.has(vintage)) return { error: `windows: ${vintage} is listed twice` };
    seen.add(vintage);
    const incoming = {};
    for (const [phase, from, until] of WIRE_PHASES) {
      for (const [field, value] of [[from, w[phase]?.from], [until, w[phase]?.until]]) {
        if (value == null) continue;
        if (!Number.isInteger(value)) return { error: `windows: ${vintage} has a phase that is not a year` };
        incoming[field] = value;
      }
    }
    if (!Object.keys(incoming).length) continue;
    const checked = checkWindow({ vintage }, incoming);
    if (!checked.ok) {
      return { error: `windows: ${vintage} — ${checked.rule === 'order' ? `${checked.field} lies before ${checked.after}` : `${checked.field} is outside 1900–2200`}` };
    }
    const row = { vintage };
    for (const f of PHASE_FIELDS) {
      if (checked.next[f] != null) row[f] = checked.next[f];
    }
    windows.push(row);
  }
  return { windows };
}

/**
 * Check a contribution body and shape it for storage: { contribution } or
 * { error } (a sentence the route sends as 400). Runs before the bridge quota
 * is spent, so a malformed call costs nothing.
 */
function parseContribution(body) {
  const b = body && typeof body === 'object' ? body : {};
  const name = text(b.name, NAME_MAX);
  if (!name) return { error: `name is required (at most ${NAME_MAX} characters)` };
  const producer = text(b.producer, PRODUCER_MAX);
  if (!producer) return { error: `producer is required (at most ${PRODUCER_MAX} characters)` };

  let grapes = [];
  if (b.grapes != null) {
    if (!Array.isArray(b.grapes) || b.grapes.length > GRAPES_MAX) return { error: `grapes must be a list of at most ${GRAPES_MAX} names` };
    for (const g of b.grapes) {
      const n = text(g, GRAPE_NAME_MAX);
      if (n === null) return { error: `grapes: each name is text of at most ${GRAPE_NAME_MAX} characters` };
      if (n && !grapes.some((x) => x.toLowerCase() === n.toLowerCase())) grapes.push(n);
    }
  }

  const hints = {};
  for (const [key, max] of Object.entries(HINT_MAX)) {
    const v = text(b[key], max);
    if (v === null) return { error: `${key} must be text of at most ${max} characters` };
    if (v) hints[key] = key === 'type' || key === 'colour' ? v.toLowerCase() : v;
  }

  // An inline photo only, as the install sends it: a link would make a
  // picture the contributor can swap later, and a bare path names a file on
  // the INSTALL's server.
  const image = typeof b.image === 'string' ? b.image.trim() : '';
  if (b.image != null && (typeof b.image !== 'string' || (image && !image.startsWith('data:image/')))) {
    return { error: 'image must be an inline image (data:image/…)' };
  }
  const imageErr = validateImageRef(image);
  if (imageErr) return { error: imageErr };

  // The install's own id for the wine, opaque here: what "the same wine sent
  // again" means (fileContribution).
  if (b.ref != null && !(typeof b.ref === 'string' && /^[a-f0-9]{24}$/i.test(b.ref))) return { error: 'ref must be the install\'s wine id' };

  const parsed = parseWindows(b.windows);
  if (parsed.error) return { error: parsed.error };

  return {
    contribution: {
      name,
      producer,
      hints: Object.keys(hints).length ? hints : null,
      grapes,
      image: image || null,
      windows: parsed.windows,
      ref: b.ref != null ? String(b.ref) : null,
    },
  };
}

/**
 * File a parsed contribution for the key owner (`userId`) as a pending
 * new_wine request. The same wine sent again while the first is still
 * pending answers that request (reused: true) rather than queueing a second:
 * the same install wine id (`ref`) from this account. Without a ref, the
 * name, producer and appellation must all match. Caller: routes/bridgeV1.js
 * POST /contributions. Returns { wineRequest, reused }.
 */
async function fileContribution(userId, contribution, { via = 'bridge', req } = {}) {
  const { name, producer, hints, grapes, image, windows, ref } = contribution;
  const exact = (v) => new RegExp(`^${escapeRegex(v)}$`, 'i');
  const same = ref
    ? { contributionRef: ref }
    : {
      wineName: exact(name),
      producer: exact(producer),
      'hints.appellation': hints?.appellation ? exact(hints.appellation) : { $in: [null, ''] },
    };
  const existing = await WineRequest.findOne({ user: userId, via: 'bridge', requestType: 'new_wine', status: 'pending', ...same });
  if (existing) return { wineRequest: existing, reused: true };

  const wineRequest = new WineRequest({
    requestType: 'new_wine',
    wineName: name,
    producer,
    ...(hints ? { hints } : {}),
    ...(grapes.length ? { suggestedGrapes: grapes } : {}),
    image,
    ...(windows.length ? { proposedWindows: windows } : {}),
    ...(ref ? { contributionRef: ref } : {}),
    user: userId,
    status: 'pending',
    installFollowsAt: new Date(),
    // Which key and which install sent it, on the record (utils/contributionOrigin.js).
    ...originFrom(req, via),
  });
  await wineRequest.save();
  return { wineRequest, reused: false };
}

module.exports = { parseContribution, fileContribution, WINDOWS_MAX };
