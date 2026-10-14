import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { getPickLists, createPickList, addToPickList } from '../api/pickLists';
import Modal from './Modal';

const NEW_LIST = '__new__';

/**
 * "Add to a pick list" (early access, flag pickLists): the selected bottles —
 * from Select mode, or the one bottle on its own page — go on one of the
 * user's pick lists, or a list created right here. Bottles already on it, or
 * no longer in the cellar, come back as skipped. The done screen links to the
 * list, where each bottle shows its cellar, rack and slot.
 */
export default function AddToPickListModal({ bottleIds, onClose, onDone }) {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const count = bottleIds.length;
  const [lists, setLists] = useState(null); // null while loading
  const [target, setTarget] = useState('');
  const [newName, setNewName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let active = true;
    getPickLists(apiFetch)
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error();
        return data;
      })
      .then((data) => {
        if (!active) return;
        const arr = Array.isArray(data?.lists) ? data.lists : [];
        setLists(arr);
        setTarget(arr.length ? String(arr[0].id) : NEW_LIST);
      })
      // Say so: silently offering "new list" invites a duplicate of one that
      // exists (release audit 2026-10-13).
      .catch(() => {
        if (!active) return;
        setLists([]);
        setTarget(NEW_LIST);
        setLoadFailed(true);
      });
    return () => { active = false; };
  }, [apiFetch]);

  const canSubmit = target && (target !== NEW_LIST || newName.trim());

  const submit = async (e) => {
    e.preventDefault();
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const res = target === NEW_LIST
        ? await createPickList(apiFetch, { name: newName.trim(), bottleIds })
        : await addToPickList(apiFetch, target, bottleIds);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('pickLists.addFailed', 'Could not add to the pick list'));
      setResult({ id: data.list.id, name: data.list.name, added: data.added ?? 0, skipped: (data.skipped || []).length });
    } catch (err) {
      // A dropped connection throws a TypeError with the browser's own text
      // ("Failed to fetch"), not a message for the user (audit 2026-10-14).
      setError(err instanceof TypeError ? t('common.networkError', 'Network error') : err.message);
      setSubmitting(false);
    }
  };

  if (result) {
    return (
      <Modal title={t('pickLists.addedTitle', 'Added to the pick list')} onClose={onDone} showClose trapFocus>
        <p className="move-bottle-wine"><strong>{result.name}</strong></p>
        <p className="move-bottle-success">{t('pickLists.addedCount', { count: result.added, defaultValue: result.added === 1 ? '1 bottle added.' : `${result.added} bottles added.` })}</p>
        {result.skipped > 0 && (
          <p className="move-bottle-skipped" role="status">
            {t('pickLists.addedSkipped', { count: result.skipped, defaultValue: `${result.skipped} skipped: already on the list, or no longer in the cellar.` })}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onDone}>{t('bulk.close', 'Close')}</button>
          <Link className="btn btn-primary" to={`/pick-lists/${result.id}`} onClick={onDone}>
            {t('pickLists.openList', 'Open the pick list')}
          </Link>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={t('pickLists.addTitle', { count, defaultValue: count === 1 ? 'Add 1 bottle to a pick list' : `Add ${count} bottles to a pick list` })} onClose={onClose} showClose trapFocus>
      <p>{t('pickLists.addIntro', 'A pick list shows where each bottle sits — cellar, rack and slot — so you can fetch them in one go.')}</p>
      <form onSubmit={submit} className="bulk-form">
        {lists === null ? (
          <p className="loading">{t('common.loading', 'Loading…')}</p>
        ) : (
          <>
            {lists.length > 0 && (
              <label className="form-group">
                <span>{t('pickLists.listLabel', 'Pick list')}</span>
                <select className="form-select" value={target} onChange={(e) => setTarget(e.target.value)} disabled={submitting}>
                  {lists.map((l) => <option key={l.id} value={String(l.id)}>{l.name}</option>)}
                  <option value={NEW_LIST}>{t('pickLists.newList', 'New pick list…')}</option>
                </select>
              </label>
            )}
            {target === NEW_LIST && (
              <label className="form-group">
                <span>{t('pickLists.newName', 'Name of the new pick list')}</span>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  maxLength={100}
                  placeholder={t('pickLists.namePlaceholder', 'e.g. Saturday dinner')}
                  disabled={submitting}
                  autoFocus
                />
              </label>
            )}
          </>
        )}

        {loadFailed && <p className="error-message" role="alert">{t('pickLists.loadError', 'Could not load your pick lists.')}</p>}
        {error && <p className="error-message" role="alert">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={submitting}>
            {t('common.cancel', 'Cancel')}
          </button>
          <button type="submit" className="btn btn-primary" disabled={submitting || !canSubmit}>
            {submitting ? t('pickLists.adding', 'Adding…') : t('pickLists.addButton', 'Add')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
