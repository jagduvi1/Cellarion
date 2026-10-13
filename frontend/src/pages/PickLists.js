import { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { getPickLists, createPickList } from '../api/pickLists';
import BetaBadge from '../components/BetaBadge';
import './PickList.css';

/**
 * Pick lists (early access, flag pickLists; forum request 2026-10-13): the
 * member's named lists of bottles to fetch — "Saturday dinner", "Drink next".
 * Bottles are added from the cellar's Select mode or a bottle's ⋮ menu; each
 * list shows where every bottle sits.
 */
export default function PickLists() {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const navigate = useNavigate();
  const [lists, setLists] = useState(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await getPickLists(apiFetch);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setLists(data.lists || []);
    } catch {
      setError(t('pickLists.loadError', 'Could not load your pick lists.'));
      setLists([]);
    }
  }, [apiFetch]); // eslint-disable-line react-hooks/exhaustive-deps -- t is read at call time; a new t must not reload

  useEffect(() => { load(); }, [load]);

  const create = async (e) => {
    e.preventDefault();
    if (!name.trim() || creating) return;
    setCreating(true);
    setError('');
    try {
      const res = await createPickList(apiFetch, { name: name.trim() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('pickLists.createFailed', 'Could not create the pick list.'));
      navigate(`/pick-lists/${data.list.id}`);
    } catch (err) {
      setError(err.message);
      setCreating(false);
    }
  };

  return (
    <div className="pick-lists-page">
      <h1>{t('pickLists.title', 'Pick lists')}</h1>
      <BetaBadge feature="pickLists" note={t('pickLists.betaNote', 'Pick lists are in early access.')} />
      <p className="pick-lists-intro">
        {t('pickLists.intro', 'A pick list is the bottles you are about to fetch — for a dinner, a tasting, or what to drink next — with the cellar, rack and slot of each, in the order you walk past them. To add bottles, tap Select in your cellar, pick them and choose Pick list, or use ⋮ on a bottle\'s page.')}
      </p>

      {error && <p className="error-message" role="alert">{error}</p>}

      {lists === null ? (
        <p className="loading">{t('common.loading', 'Loading…')}</p>
      ) : lists.length === 0 ? (
        <p className="empty-state">{t('pickLists.none', 'No pick lists yet.')}</p>
      ) : (
        <ul className="pick-lists-index">
          {lists.map((l) => (
            <li key={l.id}>
              <Link to={`/pick-lists/${l.id}`} className="pick-lists-index-link">
                <span className="pick-lists-index-name">{l.name}</span>
                <span className="pick-lists-index-count">
                  {t('pickLists.countLine', { count: l.count, picked: l.picked, defaultValue: `${l.count} bottles · ${l.picked} picked` })}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <form className="pick-lists-new" onSubmit={create}>
        <label>
          <span>{t('pickLists.newName', 'Name of the new pick list')}</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            placeholder={t('pickLists.namePlaceholder', 'e.g. Saturday dinner')}
            disabled={creating}
          />
        </label>
        <button type="submit" className="btn btn-primary" disabled={!name.trim() || creating}>
          {t('pickLists.create', 'Create pick list')}
        </button>
      </form>
    </div>
  );
}
