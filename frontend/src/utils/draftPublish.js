import { publishWineDraft, attachWineDraft } from '../api/wineDrafts';

/**
 * The publish step of a private draft, decoded for the UI. The API answers
 * 200 (published, possibly as a pending row for curation), 409 `similar`
 * (soft-zone candidates: pick one to attach the bottles to, or confirm a new
 * wine), 409 `duplicate` (an exact registry match: attach or cancel) or 400
 * `invalid_identity` (the producer is not usable — edit the draft first).
 *
 * Candidates come back as flat summaries; SimilarWinesModal renders the
 * registry's wine shape, so they are reshaped here once for both callers
 * (the bottle page banner and the drafts list).
 */
export function matchToWine(m) {
  return {
    _id: m.wine_id,
    name: m.name,
    producer: m.producer || '',
    appellation: m.appellation || null,
    country: m.country ? { name: m.country } : null,
    region: m.region ? { name: m.region } : null,
    type: m.type || null,
  };
}

export async function publishDraft(apiFetch, id, { confirmCreate = false } = {}) {
  let res;
  try {
    res = await publishWineDraft(apiFetch, id, { confirmCreate });
  } catch {
    return { status: 'network' };
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok) return { status: 'ok', promoted: !!data.promoted, pendingCuration: !!data.pendingCuration, wine: data.wine };
  if (res.status === 409 && data.code === 'similar' && Array.isArray(data.candidates)) {
    return { status: 'similar', candidates: data.candidates.map((c) => ({ wine: matchToWine(c), score: c.score ?? 0 })) };
  }
  if (res.status === 409 && data.code === 'duplicate' && data.match) {
    return { status: 'duplicate', candidates: [{ wine: matchToWine(data.match), score: 1 }] };
  }
  return { status: 'error', code: data.code || null, message: data.error || `Failed (${res.status})` };
}

export async function attachDraft(apiFetch, id, targetWineId) {
  let res;
  try {
    res = await attachWineDraft(apiFetch, id, targetWineId);
  } catch {
    return { status: 'network' };
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok) return { status: 'ok', bottlesMoved: data.bottlesMoved || 0, wine: data.wine };
  return { status: 'error', code: data.code || null, message: data.error || `Failed (${res.status})` };
}
