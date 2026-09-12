import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { publishDraft, attachDraft } from '../../utils/draftPublish';
import SimilarWinesModal from '../SimilarWinesModal';
import DraftWineEditModal from '../DraftWineEditModal';
import './DraftWineBanner.css';

/**
 * The bottle page's view of a PRIVATE DRAFT wine (support ticket
 * 2026-09-12). Its creator edits and publishes from here; a member of a
 * shared cellar holding a bottle of it only sees what it is.
 *
 * Publish outcomes: published (or filed for curation when the producer is
 * missing), `similar` (pick a registry wine to attach the bottles to, or
 * confirm a new one), `duplicate` (the registry already holds it — attach or
 * cancel, never "create new"), or a refusal to fix in the edit form.
 *
 * Props:
 *   wine       — the populated draft wine
 *   wineDraft  — { mine, expiresAt } from GET /api/bottles/:id
 *   onChanged  — re-fetch the bottle after an edit / publish / attach
 */
function DraftWineBanner({ wine, wineDraft, onChanged }) {
  const { t } = useTranslation();
  const { apiFetch, user } = useAuth();
  const mine = wineDraft?.mine === true;
  const canAct = mine && !user?.isDemo;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [editing, setEditing] = useState(false);
  const [choice, setChoice] = useState(null); // { kind: 'similar' | 'duplicate', candidates }
  const expires = wineDraft?.expiresAt ? new Date(wineDraft.expiresAt) : null;

  const runPublish = async (opts = {}) => {
    setBusy(true);
    setError(null);
    const r = await publishDraft(apiFetch, wine._id, opts);
    setBusy(false);
    if (r.status === 'ok') {
      setChoice(null);
      setNotice(r.pendingCuration
        ? t('draftWine.publishedPending', 'Published. The producer is still missing, so a curator will complete the record.')
        : t('draftWine.published', 'Published to the shared registry.'));
      onChanged?.();
      return;
    }
    if (r.status === 'similar' || r.status === 'duplicate') { setChoice({ kind: r.status, candidates: r.candidates }); return; }
    setError(r.status === 'network' ? t('common.networkError', 'Network error') : r.message);
  };

  const runAttach = async (target) => {
    setBusy(true);
    setError(null);
    const r = await attachDraft(apiFetch, wine._id, target._id);
    setBusy(false);
    if (r.status === 'ok') {
      setChoice(null);
      setNotice(t('draftWine.attached', 'Your bottles now sit on the registry wine.'));
      onChanged?.();
      return;
    }
    setError(r.status === 'network' ? t('common.networkError', 'Network error') : r.message);
  };

  return (
    <div className="draft-wine-banner" role="status">
      <div className="draft-wine-banner-text">
        <strong>{t('draftWine.bannerTitle', 'Private draft')}</strong>
        <span>
          {mine
            ? t('draftWine.bannerMine', 'Only you, and members of cellars holding a bottle of it, can see this wine. Edit it freely and publish it when the record is complete.')
            : t('draftWine.bannerTheirs', 'This wine is a private draft of the person who added it. It is not in the shared registry yet.')}
          {mine && expires && (
            <> {t('draftWine.bannerExpiry', 'Left untouched, it publishes by itself on {{date}}.', { date: expires.toLocaleDateString() })}</>
          )}
        </span>
        {mine && <Link to="/wine-drafts" className="draft-wine-banner-link">{t('draftWine.allDrafts', 'All my drafts')}</Link>}
      </div>
      {canAct && (
        <div className="draft-wine-banner-actions">
          <button type="button" className="btn btn-secondary btn-small" disabled={busy} onClick={() => setEditing(true)}>
            {t('draftWine.edit', 'Edit')}
          </button>
          <button type="button" className="btn btn-primary btn-small" disabled={busy} onClick={() => runPublish()}>
            {busy ? t('common.saving', 'Saving…') : t('draftWine.publish', 'Publish')}
          </button>
        </div>
      )}
      {error && <div className="alert alert-error draft-wine-banner-alert" role="alert">{error}</div>}
      {notice && <div className="alert alert-success draft-wine-banner-alert">{notice}</div>}

      {editing && (
        <DraftWineEditModal
          apiFetch={apiFetch}
          wine={wine}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); onChanged?.(); }}
        />
      )}
      {choice && (
        <SimilarWinesModal
          candidates={choice.candidates}
          queryName={wine.name}
          busy={busy}
          allowCreateNew={choice.kind === 'similar'}
          introKey={choice.kind === 'duplicate' ? 'draftWine.duplicateIntro' : 'draftWine.similarIntro'}
          pickLabel={t('draftWine.attachHere', 'Attach my bottles')}
          onPick={runAttach}
          onCreateNew={() => runPublish({ confirmCreate: true })}
          onCancel={() => setChoice(null)}
        />
      )}
    </div>
  );
}

export default DraftWineBanner;
