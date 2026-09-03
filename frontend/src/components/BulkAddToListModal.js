import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { getWineLists, getWineList, createWineList, addBottlesToWineList } from '../api/wineLists';
import Modal from './Modal';
import BulkOutcome from './BulkOutcome';

const NEW_LIST = '__new__';

/**
 * Bulk "Add to a wine list": the wines of every selected bottle go on one of
 * this cellar's lists (or a list created right here). Entries are wine +
 * vintage + size, so a case collapses into one line; wines already on the
 * list, and wines still awaiting identification, come back as skipped. A
 * custom-structured list needs a section — pick one, or type a new name.
 */
export default function BulkAddToListModal({ bottleIds, cellarId, onClose, onDone }) {
  const { t } = useTranslation();
  const { apiFetch, user } = useAuth();
  const count = bottleIds.length;
  const [lists, setLists] = useState(null); // null while loading
  const [target, setTarget] = useState('');
  const [newName, setNewName] = useState('');
  const [sections, setSections] = useState([]); // titles, for a custom list
  const [section, setSection] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  useEffect(() => {
    let active = true;
    getWineLists(apiFetch, cellarId)
      .then((r) => r.json())
      .then((data) => {
        if (!active) return;
        const arr = Array.isArray(data) ? data : [];
        setLists(arr);
        if (arr.length === 0) setTarget(NEW_LIST);
      })
      .catch(() => { if (active) { setLists([]); setTarget(NEW_LIST); setError(t('bulk.listLoadError')); } });
    return () => { active = false; };
  }, [apiFetch, cellarId, t]);

  const chosen = (lists || []).find((l) => String(l._id) === String(target));
  const isCustom = chosen?.structureMode === 'custom';

  // A custom list's sections come from its detail endpoint (the listing is a summary).
  useEffect(() => {
    if (!isCustom) { setSections([]); setSection(''); return; }
    let active = true;
    getWineList(apiFetch, target)
      .then((r) => r.json())
      .then((data) => {
        if (!active) return;
        const titles = (data.sections || []).map((s) => s.title);
        setSections(titles);
        setSection(titles.length === 1 ? titles[0] : '');
      })
      .catch(() => { if (active) setSections([]); });
    return () => { active = false; };
  }, [apiFetch, target, isCustom]);

  const canSubmit = target && (target !== NEW_LIST || newName.trim()) && (!isCustom || section.trim());

  const submit = async (e) => {
    e.preventDefault();
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      let listId = target;
      if (target === NEW_LIST) {
        const created = await createWineList(apiFetch, {
          cellar: cellarId,
          name: newName.trim(),
          currency: user?.preferences?.currency || undefined,
        });
        const createdData = await created.json().catch(() => ({}));
        if (!created.ok) throw new Error(createdData.error || t('bulk.failed'));
        listId = createdData._id;
      }
      const res = await addBottlesToWineList(apiFetch, listId, bottleIds, isCustom ? section.trim() : undefined);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('bulk.failed'));
      setResult({ added: data.added ?? 0, skipped: (data.skipped || []).length, listName: data.list?.name || newName.trim() || chosen?.name || '' });
    } catch (err) {
      setError(err.message || t('bulk.failed'));
      setSubmitting(false);
    }
  };

  if (result) {
    return (
      <BulkOutcome
        title={t('bulk.listDoneTitle')}
        done={result.added}
        skipped={result.skipped}
        skippedKey="bulk.listSkippedInfo"
        extra={<p className="move-bottle-wine"><strong>{result.listName}</strong></p>}
        onClose={onDone}
      />
    );
  }

  return (
    <Modal title={t('bulk.listTitle', { count })} onClose={onClose} showClose trapFocus>
      <p>{t('bulk.listIntro')}</p>
      <form onSubmit={submit} className="bulk-form">
        {lists === null ? (
          <p className="loading">{t('moveBottle.loading')}</p>
        ) : (
          <>
            {lists.length === 0 && <p className="empty-state">{t('bulk.listNone')}</p>}
            {lists.length > 0 && (
              <label className="form-group">
                <span>{t('bulk.listLabel')}</span>
                <select className="form-select" value={target} onChange={(e) => setTarget(e.target.value)} disabled={submitting}>
                  <option value="">{t('bulk.listSelect')}</option>
                  {lists.map((l) => <option key={l._id} value={l._id}>{l.name}</option>)}
                  <option value={NEW_LIST}>{t('bulk.listNew')}</option>
                </select>
              </label>
            )}
            {target === NEW_LIST && (
              <label className="form-group">
                <span>{t('bulk.listNewName')}</span>
                <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={200} disabled={submitting} />
              </label>
            )}
            {isCustom && (
              <label className="form-group">
                <span>{t('bulk.listSection')}</span>
                <input type="text" list="bulk-list-sections" value={section} onChange={(e) => setSection(e.target.value)} maxLength={200} disabled={submitting} />
                <datalist id="bulk-list-sections">
                  {sections.map((s) => <option key={s} value={s} />)}
                </datalist>
                <small>{t('bulk.listSectionHint')}</small>
              </label>
            )}
          </>
        )}

        {error && <p className="error-message" role="alert">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={submitting}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn btn-primary" disabled={submitting || !canSubmit}>
            {submitting ? t('common.saving') : t('bulk.listSubmit')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
