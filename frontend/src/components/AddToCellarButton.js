import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { listCellars } from '../api/cellars';
import { afterPopupEntryGone } from '../utils/useBackToClose';
import Modal from './Modal';

/** Add Bottle with this wine (and vintage) already chosen — pages/AddBottle reads ?wine and ?vintage. */
export function addBottlePath(cellarId, wineId, vintage) {
  const q = new URLSearchParams({ wine: wineId });
  if (vintage) q.set('vintage', vintage);
  return `/cellars/${cellarId}/add-bottle?${q}`;
}

/**
 * "Add to cellar" for a registry wine: on a wishlist item ("Bought" only ticks
 * the wishlist — a member expected it to add the bottle) and on the wine's
 * page. Opens Add Bottle with the wine already chosen, and the vintage when
 * known, so only the bottle's own details are left.
 *
 * Which cellar: the member's default cellar (set on the Cellars page) when
 * they may add to it, else their only one, else they pick from a short list.
 * Cellars they may only view are left out — adding needs owner or editor, as
 * on the server. With none, the cellars page (where the first one is made)
 * opens instead.
 */
export default function AddToCellarButton({ wineId, vintage, className = 'btn btn-small btn-secondary' }) {
  const { t } = useTranslation();
  const { apiFetch, user } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [choices, setChoices] = useState(null); // cellars to pick from, while the list is open
  const [error, setError] = useState(null);

  // Demo accounts cannot add bottles (POST /api/bottles is requireNonDemo).
  if (!wineId || user?.isDemo) return null;

  // No `cameFrom`: Add Bottle's back link says "Back to cellar" and goes
  // there; the phone's Back still returns here.
  const go = (cellarId) => navigate(addBottlePath(cellarId, wineId, vintage));

  const start = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await listCellars(apiFetch);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error);
      const editable = (data.cellars || []).filter((c) => c.userRole === 'owner' || c.userRole === 'editor');
      const preferred = editable.find((c) => c._id === user?.preferences?.defaultCellarId);
      if (preferred) go(preferred._id);
      else if (editable.length === 1) go(editable[0]._id);
      else if (editable.length === 0) navigate('/cellars');
      else setChoices(editable);
    } catch {
      setError(t('addToCellar.loadError', 'Could not load your cellars. Please try again.'));
      setChoices([]);
    } finally {
      setBusy(false);
    }
  };

  // The list closes first, then Add Bottle opens: the list's own Back entry
  // must be gone, or Back from Add Bottle would land on it.
  const pick = (cellarId) => {
    setChoices(null);
    afterPopupEntryGone(() => go(cellarId));
  };

  return (
    <>
      <button type="button" className={className} onClick={start} disabled={busy}>
        {t('addToCellar.action', 'Add to cellar')}
      </button>
      {choices && (
        <Modal title={t('addToCellar.pickTitle', 'Add to which cellar?')} onClose={() => setChoices(null)} showClose trapFocus>
          {error ? (
            <p className="error-message" role="alert">{error}</p>
          ) : (
            <div style={{ display: 'grid', gap: '0.5rem' }}>
              {choices.map((c) => (
                <button key={c._id} type="button" className="btn btn-secondary" onClick={() => pick(c._id)}>
                  {c.name}
                </button>
              ))}
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
