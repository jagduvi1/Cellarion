import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { listMyWineDrafts, publishWineDrafts, deleteWineDraft } from '../api/wineDrafts';
import { publishDraft, attachDraft, matchToWine } from '../utils/draftPublish';
import SimilarWinesModal from '../components/SimilarWinesModal';
import DraftWineEditModal from '../components/DraftWineEditModal';
import './WineDrafts.css';

/**
 * My private draft wines (support ticket 2026-09-12): every wine the user
 * created as a draft, with its bottle count and its untouched-clock deadline.
 * Publish one, publish a selection, edit, or delete an empty one. A publish
 * that meets a registry match opens the same "attach instead" dialog the
 * bottle page uses, one row at a time.
 */
function WineDrafts() {
  const { t } = useTranslation();
  const { apiFetch, user } = useAuth();
  const [drafts, setDrafts] = useState(null); // null = loading
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [rowState, setRowState] = useState({}); // id -> { status, message }
  const [editing, setEditing] = useState(null); // draft being edited
  const [choice, setChoice] = useState(null);   // { draft, kind, candidates }
  const canAct = !user?.isDemo;

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await listMyWineDrafts(apiFetch);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error || t('common.error', 'Something went wrong')); setDrafts([]); return; }
      setDrafts(data.drafts || []);
      setSelected((prev) => new Set([...prev].filter((id) => (data.drafts || []).some((d) => d._id === id))));
    } catch {
      setError(t('common.networkError', 'Network error'));
      setDrafts([]);
    }
    // `t` is stable in react-i18next; keeping it out of the deps means a
    // translation-mock that re-creates it can never turn this into a loop.
  }, [apiFetch]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  const setRow = (id, status, message) => setRowState((s) => ({ ...s, [id]: { status, message } }));

  const handleResult = (draft, r) => {
    if (r.status === 'ok') {
      setRow(draft._id, 'done', r.pendingCuration
        ? t('draftWine.rowPendingCuration', 'Published — a curator will complete the producer')
        : t('draftWine.rowPublished', 'Published'));
      return true;
    }
    if (r.status === 'similar' || r.status === 'duplicate') {
      setChoice({ draft, kind: r.status, candidates: r.candidates });
      setRow(draft._id, 'choice', r.status === 'duplicate'
        ? t('draftWine.rowDuplicate', 'Already in the registry — attach your bottles to it')
        : t('draftWine.rowSimilar', 'Similar wines exist — choose'));
      return false;
    }
    setRow(draft._id, 'error', r.status === 'network' ? t('common.networkError', 'Network error') : r.message);
    return false;
  };

  const publishOne = async (draft, opts = {}) => {
    setBusy(true);
    const r = await publishDraft(apiFetch, draft._id, opts);
    setBusy(false);
    if (handleResult(draft, r)) await load();
  };

  const publishSelected = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBusy(true);
    try {
      const res = await publishWineDrafts(apiFetch, ids);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error || t('common.error', 'Something went wrong')); return; }
      for (const row of data.results || []) {
        const draft = drafts.find((d) => d._id === row.id);
        if (!draft) continue;
        if (row.status === 'published') setRow(row.id, 'done', t('draftWine.rowPublished', 'Published'));
        else if (row.status === 'pending_curation') setRow(row.id, 'done', t('draftWine.rowPendingCuration', 'Published — a curator will complete the producer'));
        else if (row.status === 'duplicate' && row.match) setRow(row.id, 'choice', t('draftWine.rowDuplicate', 'Already in the registry — attach your bottles to it'));
        else if (row.status === 'similar') setRow(row.id, 'choice', t('draftWine.rowSimilar', 'Similar wines exist — choose'));
        else setRow(row.id, 'error', row.error || row.status);
      }
      // Keep the choices for the rows that need one: the first opens now.
      const first = (data.results || []).find((row) => (row.status === 'duplicate' && row.match) || (row.status === 'similar' && row.candidates));
      if (first) {
        const draft = drafts.find((d) => d._id === first.id);
        const candidates = first.status === 'duplicate'
          ? [{ wine: matchToWine(first.match), score: 1 }]
          : first.candidates.map((c) => ({ wine: matchToWine(c), score: c.score ?? 0 }));
        setChoice({ draft, kind: first.status, candidates });
      }
      await load();
    } catch {
      setError(t('common.networkError', 'Network error'));
    } finally {
      setBusy(false);
    }
  };

  const attach = async (target) => {
    if (!choice) return;
    setBusy(true);
    const r = await attachDraft(apiFetch, choice.draft._id, target._id);
    setBusy(false);
    if (r.status === 'ok') {
      setRow(choice.draft._id, 'done', t('draftWine.rowAttached', 'Bottles attached to {{wine}}', { wine: target.name }));
      setChoice(null);
      await load();
    } else {
      setRow(choice.draft._id, 'error', r.status === 'network' ? t('common.networkError', 'Network error') : r.message);
      setChoice(null);
    }
  };

  const remove = async (draft) => {
    if (!window.confirm(t('draftWine.deleteConfirm', 'Delete this empty draft?'))) return;
    setBusy(true);
    try {
      const res = await deleteWineDraft(apiFetch, draft._id);
      if (res.ok) { await load(); return; }
      const data = await res.json().catch(() => ({}));
      setRow(draft._id, 'error', data.error || t('common.error', 'Something went wrong'));
    } catch {
      setRow(draft._id, 'error', t('common.networkError', 'Network error'));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div className="wine-drafts-page">
      <div className="wine-drafts-header">
        <h1>{t('draftWine.pageTitle', 'My draft wines')}</h1>
        <p className="wine-drafts-intro">
          {t('draftWine.pageIntro', 'Wines you created as private drafts. Only you can see them; edit them freely, then publish them to the shared registry. An untouched draft with bottles publishes by itself after 7 days; an empty one is deleted.')}
        </p>
      </div>

      {error && <div className="alert alert-error" role="alert">{error}</div>}

      {drafts === null ? (
        <div className="loading">{t('common.loading', 'Loading…')}</div>
      ) : drafts.length === 0 ? (
        <div className="empty-state">
          <p>{t('draftWine.none', 'No drafts. When you add a bottle of a wine the registry does not know, you can keep it as a private draft first.')}</p>
        </div>
      ) : (
        <>
          {canAct && (
            <div className="wine-drafts-toolbar">
              <button type="button" className="btn btn-primary" disabled={busy || selected.size === 0} onClick={publishSelected}>
                {t('draftWine.publishSelected', 'Publish selected ({{count}})', { count: selected.size })}
              </button>
            </div>
          )}
          <ul className="wine-drafts-list">
            {drafts.map((d) => {
              const state = rowState[d._id];
              return (
                <li key={d._id} className="wine-draft-row">
                  {canAct && (
                    <input type="checkbox" aria-label={t('draftWine.select', 'Select {{name}}', { name: d.name })} checked={selected.has(d._id)} onChange={() => toggle(d._id)} />
                  )}
                  <div className="wine-draft-main">
                    <div className="wine-draft-name">{d.producer ? `${d.producer} — ${d.name}` : d.name}</div>
                    <div className="wine-draft-meta">
                      {[d.appellation, d.region, d.country].filter(Boolean).join(' · ')}
                      {d.grapes?.length ? ` · ${d.grapes.join(', ')}` : ''}
                    </div>
                    <div className="wine-draft-meta">
                      {t('draftWine.bottleCount', '{{count}} bottle(s)', { count: d.bottleCount || 0 })}
                      {d.draftExpiresAt && ` · ${d.bottleCount ? t('draftWine.autoPublishes', 'publishes by itself on {{date}}', { date: new Date(d.draftExpiresAt).toLocaleDateString() }) : t('draftWine.expires', 'expires {{date}}', { date: new Date(d.draftExpiresAt).toLocaleDateString() })}`}
                    </div>
                    {state && <div className={`wine-draft-state wine-draft-state--${state.status}`}>{state.message}</div>}
                  </div>
                  {canAct && (
                    <div className="wine-draft-actions">
                      <button type="button" className="btn btn-secondary btn-small" disabled={busy} onClick={() => setEditing(d)}>{t('draftWine.edit', 'Edit')}</button>
                      <button type="button" className="btn btn-primary btn-small" disabled={busy} onClick={() => publishOne(d)}>{t('draftWine.publish', 'Publish')}</button>
                      {!d.bottleCount && (
                        <button type="button" className="btn btn-danger btn-small" disabled={busy} onClick={() => remove(d)}>{t('common.delete', 'Delete')}</button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      <p className="wine-drafts-footer">
        <Link to="/cellars">{t('draftWine.backToCellars', '← Back to my cellars')}</Link>
      </p>

      {editing && (
        <DraftWineEditModal
          apiFetch={apiFetch}
          wine={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
      {choice && (
        <SimilarWinesModal
          candidates={choice.candidates}
          queryName={choice.draft.name}
          busy={busy}
          allowCreateNew={choice.kind === 'similar'}
          introKey={choice.kind === 'duplicate' ? 'draftWine.duplicateIntro' : 'draftWine.similarIntro'}
          pickLabel={t('draftWine.attachHere', 'Attach my bottles')}
          onPick={attach}
          onCreateNew={() => { const d = choice.draft; setChoice(null); publishOne(d, { confirmCreate: true }); }}
          onCancel={() => setChoice(null)}
        />
      )}
    </div>
  );
}

export default WineDrafts;
