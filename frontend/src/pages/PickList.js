import { useState, useEffect, useCallback, useRef, Suspense } from 'react';
import { lazy } from '../utils/lazyWithReload';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useBackHere } from '../utils/useBackHere';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { getPickList, renamePickList, removeFromPickList, setPicked, deletePickList } from '../api/pickLists';
import { buildRackUrl } from '../utils/rackNavigation';
import { bottleSizeLabel } from '../config/bottleSizes';
import BetaBadge from '../components/BetaBadge';
import './PickList.css';
import { formatVintage } from '../utils/vintage';

const BulkConsumeModal = lazy(() => import('../components/BulkConsumeModal'));

// Ticks are sent in batches: the write limiter counts requests, not bottles,
// and a member ticking a case one by one in the cellar must not hit it.
const TICK_FLUSH_MS = 700;

/**
 * One pick list (early access, flag pickLists; forum request 2026-10-13):
 * the bottles to fetch, grouped by cellar and rack in walking order, each
 * with its slot, a tick box, and a way out to the rack. Rendered outside the
 * app Layout, like Cellar Book, so Print gives a clean sheet to take down to
 * the cellar.
 */
export default function PickList() {
  const { t } = useTranslation();
  // Handed to the bottle page so its back link returns here (BottleDetail).
  const backHere = useBackHere('pickList');
  const { id } = useParams();
  const navigate = useNavigate();
  const { apiFetch, user } = useAuth();
  const [list, setList] = useState(null);
  const [error, setError] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [consumeOpen, setConsumeOpen] = useState(false);
  // Ticks not yet confirmed by the server: waiting for the next batch, or
  // sent and not answered yet. A reload lays both over what it fetched, so a
  // tick is never lost to a reload in between (release audit 2026-10-13).
  const pending = useRef(new Map()); // bottleId → picked, not yet sent
  const inFlight = useRef(new Map()); // bottleId → picked, sent, not answered
  const flushing = useRef(Promise.resolve()); // batches go one at a time, in order
  const flushTimer = useRef(null);
  const rackPref = user?.preferences?.rackNavigation || 'auto';
  // Read through a ref: the loads must not re-run when t changes identity.
  const tRef = useRef(t);
  tRef.current = t;

  // The newest load wins: an older answer (history navigation between two
  // lists on this same page) must not land over it (audit 2026-10-14).
  const loadSeq = useRef(0);

  /** Loads the list; true when it worked. Never clears an error: the caller decides. */
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const res = await getPickList(apiFetch, id);
      const data = await res.json().catch(() => ({}));
      if (seq !== loadSeq.current) return true;
      if (!res.ok || !data.list) throw new Error(data.error || tRef.current('pickLists.loadOneError', 'Could not load this pick list.'));
      const overlay = new Map([...inFlight.current, ...pending.current]);
      const items = data.list.items.map((it) => {
        const k = String(it.bottleId);
        if (!overlay.has(k)) return it;
        return { ...it, pickedAt: overlay.get(k) ? (it.pickedAt || new Date().toISOString()) : null };
      });
      setList({ ...data.list, items, picked: items.filter((it) => it.pickedAt).length });
      return true;
    } catch (err) {
      if (seq !== loadSeq.current) return false;
      // A dropped connection throws a TypeError with the browser's own text
      // ("Failed to fetch"), not a message for the user (audit 2026-10-14).
      setError(err instanceof TypeError ? tRef.current('common.networkError', 'Network error') : err.message);
      return false;
    }
  }, [apiFetch, id]);

  useEffect(() => { load(); }, [load]);

  const flush = useCallback(() => {
    flushTimer.current = null;
    if (!pending.current.size) return flushing.current;
    const batch = new Map(pending.current);
    pending.current.clear();
    for (const [k, v] of batch) inFlight.current.set(k, v);
    const settle = () => { for (const [k, v] of batch) if (inFlight.current.get(k) === v) inFlight.current.delete(k); };
    flushing.current = flushing.current.then(async () => {
      const on = [...batch].filter(([, v]) => v).map(([k]) => k);
      const off = [...batch].filter(([, v]) => !v).map(([k]) => k);
      try {
        for (const [ids, picked] of [[on, true], [off, false]]) {
          if (!ids.length) continue;
          const res = await setPicked(apiFetch, id, ids, picked);
          if (!res.ok) throw new Error();
        }
        settle();
      } catch {
        settle();
        await load();
        setError(tRef.current('pickLists.tickError', 'A tick could not be saved. The list was reloaded.'));
      }
    });
    return flushing.current;
  }, [apiFetch, id, load]);

  // Send what is still pending when the page closes, or when this same page
  // moves to another list (history navigation) — only then: a ref, so a
  // re-render (a new flush) never sends a batch early. The ticks go to the
  // list they were made on (flush closes over its id); nothing of that list
  // may then lie over the next one (audit 2026-10-14).
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => () => {
    if (flushTimer.current) { clearTimeout(flushTimer.current); flushRef.current(); }
    pending.current.clear();
    inFlight.current.clear();
  }, [id]);

  const toggle = (bottleId, picked) => {
    setList((prev) => ({
      ...prev,
      picked: prev.picked + (picked ? 1 : -1),
      items: prev.items.map((it) => (String(it.bottleId) === String(bottleId) ? { ...it, pickedAt: picked ? new Date().toISOString() : null } : it)),
    }));
    pending.current.set(String(bottleId), picked);
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(flush, TICK_FLUSH_MS);
  };

  // Every action catches a network failure too, and shows its error AFTER
  // the reload (release audit 2026-10-13: the reload wiped it).
  const remove = async (bottleIds) => {
    setError('');
    let ok = false;
    try {
      const res = await removeFromPickList(apiFetch, id, bottleIds.map(String));
      ok = res.ok;
    } catch { /* shown below */ }
    await load();
    if (!ok) setError(t('pickLists.removeError', 'Could not remove that from the list.'));
  };

  const rename = async (e) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setError('');
    try {
      const res = await renamePickList(apiFetch, id, newName.trim());
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error);
      setRenaming(false);
      await load();
    } catch (err) {
      setError(err instanceof TypeError ? t('common.networkError', 'Network error') : (err.message || t('pickLists.renameError', 'Could not rename the list.')));
    }
  };

  const destroy = async () => {
    setError('');
    try {
      const res = await deletePickList(apiFetch, id);
      if (!res.ok) throw new Error();
      navigate('/pick-lists');
    } catch {
      setError(t('pickLists.deleteError', 'Could not delete the list.'));
    }
  };

  if (error && !list) {
    return (
      <div className="pick-list-page">
        <Link to="/pick-lists" className="pick-list-back">← {t('pickLists.all', 'All pick lists')}</Link>
        <p className="error-message" role="alert">{error}</p>
        <button type="button" className="btn btn-secondary btn-small" onClick={() => { setError(''); load(); }}>
          {t('common.retry', 'Retry')}
        </button>
      </div>
    );
  }
  if (!list) return <div className="pick-list-page"><p className="loading">{t('common.loading', 'Loading…')}</p></div>;

  const inCellar = list.items.filter((it) => it.state === 'in_cellar');
  const gone = list.items.filter((it) => it.state === 'drunk' || it.state === 'ordered');
  const unavailable = list.items.filter((it) => it.state === 'unavailable');
  const pickedInCellar = inCellar.filter((it) => it.pickedAt).map((it) => String(it.bottleId));

  // Walking order comes from the server; group consecutive rows by cellar → rack.
  const groups = [];
  for (const it of inCellar) {
    const key = `${it.cellar.id}|${it.rack ? it.rack.rackId : 'none'}`;
    if (!groups.length || groups[groups.length - 1].key !== key) groups.push({ key, cellar: it.cellar, rack: it.rack, items: [] });
    groups[groups.length - 1].items.push(it);
  }
  const multiCellar = new Set(inCellar.map((it) => String(it.cellar.id))).size > 1;

  const wineText = (it) => [
    [it.wine.producer, it.wine.name].filter(Boolean).join(' — ') || t('common.unknownWine', 'Unknown wine'),
    it.vintage && it.vintage !== 'Unknown' ? formatVintage(it.vintage, t) : null,
    it.bottleSize && it.bottleSize !== '750ml' ? bottleSizeLabel(it.bottleSize, t) : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="pick-list-page">
      <div className="pick-list-top no-print">
        <Link to="/pick-lists" className="pick-list-back">← {t('pickLists.all', 'All pick lists')}</Link>
      </div>

      {renaming ? (
        <form className="pick-list-rename no-print" onSubmit={rename}>
          <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={100} autoFocus aria-label={t('pickLists.nameLabel', 'Name')} />
          <button type="submit" className="btn btn-primary btn-small" disabled={!newName.trim()}>{t('common.save', 'Save')}</button>
          <button type="button" className="btn btn-secondary btn-small" onClick={() => setRenaming(false)}>{t('common.cancel', 'Cancel')}</button>
        </form>
      ) : (
        <div className="pick-list-title">
          {/* The button sits beside the heading, not in it: a screen reader
              would read "Saturday dinner Rename" as the heading (audit 2026-10-14). */}
          <h1 className="pick-list-title-text">{list.name}</h1>
          <button type="button" className="pick-list-icon-btn no-print" onClick={() => { setNewName(list.name); setRenaming(true); }} aria-label={t('pickLists.rename', 'Rename')} title={t('pickLists.rename', 'Rename')}>✎</button>
        </div>
      )}
      <p className="pick-list-meta">
        {t('pickLists.countLine', { count: list.count, picked: list.picked, defaultValue: `${list.count} bottles · ${list.picked} picked` })}
      </p>

      <div className="no-print">
        <BetaBadge feature="pickLists" note={t('pickLists.betaNote', 'Pick lists are in early access.')} />
      </div>

      <div className="pick-list-actions no-print">
        <button type="button" className="btn btn-secondary" onClick={() => window.print()}>{t('pickLists.print', 'Print')}</button>
        {pickedInCellar.length > 0 && (
          <button type="button" className="btn btn-primary" onClick={() => setConsumeOpen(true)}>
            {t('pickLists.drinkPicked', { count: pickedInCellar.length, defaultValue: `Mark ${pickedInCellar.length} picked as drunk` })}
          </button>
        )}
        {confirmDelete ? (
          <span className="pick-list-confirm">
            {t('pickLists.deleteConfirm', 'Delete this pick list? The bottles stay in your cellar.')}
            <button type="button" className="btn btn-danger btn-small" onClick={destroy}>{t('pickLists.delete', 'Delete list')}</button>
            <button type="button" className="btn btn-secondary btn-small" onClick={() => setConfirmDelete(false)}>{t('common.cancel', 'Cancel')}</button>
          </span>
        ) : (
          <button type="button" className="pick-list-link-btn pick-list-delete" onClick={() => setConfirmDelete(true)}>{t('pickLists.delete', 'Delete list')}</button>
        )}
      </div>

      {error && <p className="error-message" role="alert">{error}</p>}

      {list.items.length === 0 && (
        <p className="empty-state">{t('pickLists.empty', 'This list is empty. In your cellar, tap Select, pick bottles and choose Pick list — or use ⋮ on a bottle\'s page.')}</p>
      )}

      {groups.map((g) => (
        <section key={g.key} className="pick-list-group">
          <h2 className="pick-list-group-title">
            {multiCellar && <span className="pick-list-cellar">{g.cellar.name} · </span>}
            {g.rack
              ? <>{g.rack.rackName}{g.rack.rackGroup ? <span className="pick-list-rack-group"> ({g.rack.rackGroup})</span> : null}</>
              : t('pickLists.notInRack', 'Not in a rack')}
          </h2>
          <ul className="pick-list-rows">
            {g.items.map((it) => (
              <li key={String(it.bottleId)} className={`pick-list-row${it.pickedAt ? ' pick-list-row--picked' : ''}`}>
                <label className="pick-list-tick">
                  <input
                    type="checkbox"
                    checked={!!it.pickedAt}
                    onChange={(e) => toggle(it.bottleId, e.target.checked)}
                    aria-label={t('pickLists.tick', { wine: wineText(it), defaultValue: `Picked: ${wineText(it)}` })}
                  />
                </label>
                <span className="pick-list-slot">
                  {it.rack ? (
                    <Link to={buildRackUrl(it.cellar.id, { rackId: it.rack.rackId, bottleId: it.bottleId, inRoom: it.rack.inRoom, preference: rackPref })}>
                      {t('pickLists.slot', { position: it.rack.position, defaultValue: `slot ${it.rack.position}` })}
                    </Link>
                  ) : <span title={it.location || undefined}>{it.location || '—'}</span>}
                </span>
                <Link className="pick-list-wine" to={`/cellars/${it.cellar.id}/bottles/${it.bottleId}`} state={backHere}>{wineText(it)}</Link>
                <button type="button" className="pick-list-icon-btn no-print" onClick={() => remove([it.bottleId])} aria-label={t('pickLists.remove', 'Remove from the list')} title={t('pickLists.remove', 'Remove from the list')}>×</button>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {gone.length > 0 && (
        <section className="pick-list-group pick-list-group--done no-print">
          <h2 className="pick-list-group-title">{t('pickLists.goneTitle', 'No longer in the cellar')}</h2>
          <ul className="pick-list-rows">
            {gone.map((it) => (
              <li key={String(it.bottleId)} className="pick-list-row pick-list-row--muted">
                <span className="pick-list-wine">{wineText(it)}</span>
                <span className="pick-list-state">{it.state === 'ordered' ? t('pickLists.ordered', 'On order') : t('pickLists.drunk', 'Drunk')}</span>
              </li>
            ))}
          </ul>
          <button type="button" className="btn btn-secondary btn-small" onClick={() => remove(gone.map((it) => it.bottleId))}>
            {t('pickLists.clearGone', 'Remove these from the list')}
          </button>
        </section>
      )}

      {unavailable.length > 0 && (
        <section className="pick-list-group pick-list-group--done no-print">
          <p className="pick-list-unavailable">
            {t('pickLists.unavailable', { count: unavailable.length, defaultValue: `${unavailable.length} bottle(s) on this list are no longer available — deleted, or in a cellar no longer shared with you.` })}
          </p>
          <button type="button" className="btn btn-secondary btn-small" onClick={() => remove(unavailable.map((it) => it.bottleId))}>
            {t('pickLists.clearUnavailable', 'Remove them from the list')}
          </button>
        </section>
      )}

      {consumeOpen && (
        <Suspense fallback={null}>
          <BulkConsumeModal
            bottleIds={pickedInCellar}
            onClose={() => setConsumeOpen(false)}
            onDone={() => { setConsumeOpen(false); load(); }}
          />
        </Suspense>
      )}
    </div>
  );
}
