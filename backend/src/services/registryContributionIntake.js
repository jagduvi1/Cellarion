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
const { pickImportHints } = require('./wineRequestIntake');
const { PHASE_FIELDS, checkWindow } = require('./maturityOps');

const NAME_MAX = 300;
const PRODUCER_MAX = 200;
const GRAPES_MAX = 20;
const GRAPE_NAME_MAX = 80;
const WINDOWS_MAX = 30;
// The phases as GET /v1/wines/:id serves them, so an install sends windows in
// the shape it reads them.
const WIRE_PHASES = [['early', 'earlyFrom', 'earlyUntil'], ['peak', 'peakFrom', 'peakUntil'], ['late', 'lateFrom', 'lateUntil']];

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function text(value, max) {
  if (value == null) return '';
  if (typeof value !== 'string') return null;
  const s = value.trim();
  return s.length > max ? null : s;
}

/** The windows as stored (proposedWindows), or { error }. */
function parseWindows(raw) {
  if (raw == null) return { windows: [] };
  if (!Array.isArray(raw)) return { error: 'windows must be a list' };
  if (raw.length > WINDOWS_MAX) return { error: `At most ${WINDOWS_MAX} drink windows` };
  const windows = [];
  const seen = new Set();
  for (const w of raw) {
    const vintage = w && typeof w.vintage !== 'object' ? String(w.vintage ?? '').trim() : '';
    if (!/^\d{4}$/.test(vintage)) return { error: 'windows: each vintage must be a year' };
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

  // A link or an inline photo. A bare path names a file on the INSTALL's
  // server, which means nothing here.
  const image = typeof b.image === 'string' ? b.image.trim() : '';
  if (b.image != null && typeof b.image !== 'string') return { error: 'image must be an http(s) link or an inline image' };
  if (image.startsWith('/')) return { error: 'image must be an http(s) link or an inline image' };
  const imageErr = validateImageRef(image);
  if (imageErr) return { error: imageErr };

  const parsed = parseWindows(b.windows);
  if (parsed.error) return { error: parsed.error };

  return {
    contribution: {
      name,
      producer,
      hints: pickImportHints({ country: b.country, region: b.region, appellation: b.appellation, type: b.type }),
      grapes,
      image: image || null,
      windows: parsed.windows,
    },
  };
}

/**
 * File a parsed contribution for the key owner (`userId`) as a pending
 * new_wine request. The same wine sent again while the first is still
 * pending answers that request (reused: true) rather than queueing a second.
 * Caller: routes/bridgeV1.js POST /contributions. Returns
 * { wineRequest, reused }.
 */
async function fileContribution(userId, contribution, { via = 'bridge', req } = {}) {
  const { name, producer, hints, grapes, image, windows } = contribution;
  const existing = await WineRequest.findOne({
    user: userId,
    via: 'bridge',
    requestType: 'new_wine',
    status: 'pending',
    wineName: new RegExp(`^${escapeRegex(name)}$`, 'i'),
    producer: new RegExp(`^${escapeRegex(producer)}$`, 'i'),
  });
  if (existing) return { wineRequest: existing, reused: true };

  const wineRequest = new WineRequest({
    requestType: 'new_wine',
    wineName: name,
    producer,
    ...(hints ? { hints } : {}),
    ...(grapes.length ? { suggestedGrapes: grapes } : {}),
    image,
    ...(windows.length ? { proposedWindows: windows } : {}),
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
