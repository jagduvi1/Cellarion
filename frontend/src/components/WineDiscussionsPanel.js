import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { getWineDiscussions } from '../api/wines';
import DiscussionCard from './DiscussionCard';
import './WineDiscussionsPanel.css';

// Bottom-of-page widget on wine detail pages: shows up to 5 most recently
// active discussions linked to this wine, plus a CTA to start a new one
// (logged-in users) or a "sign in to join" prompt (anon).
//
// Public-readable: anonymous visitors see the panel and can click through to
// any thread. Writes (the "Start a discussion" action) require auth.
export default function WineDiscussionsPanel({ wine }) {
  const { t } = useTranslation();
  const { apiFetch, user } = useAuth();
  const [discussions, setDiscussions] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const wineId = wine?.slug || wine?._id;

  useEffect(() => {
    let cancelled = false;
    if (!wineId) return undefined;

    (async () => {
      try {
        const res = await getWineDiscussions(apiFetch, wineId, 'limit=5');
        if (!cancelled && res.ok) {
          const data = await res.json();
          setDiscussions(data.discussions || []);
          setTotal(data.total || 0);
        }
      } catch {
        // Network failure → render the empty state quietly.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [apiFetch, wineId]);

  if (loading) return null; // Quiet load — no skeleton, no flash
  if (!wine) return null;

  const hasDiscussions = discussions.length > 0;

  return (
    <section className="wine-discussions-panel">
      <div className="wine-discussions-panel__header">
        <h2>{t('wineDiscussions.title')}</h2>
        {user ? (
          <Link
            to="/community/discussions"
            state={{ newDiscussionWine: wine }}
            className="btn btn-secondary btn-small"
          >
            {t('wineDiscussions.startCta')}
          </Link>
        ) : (
          <Link to={`/login?next=/wines/${wineId}`} className="btn btn-secondary btn-small">
            {t('wineDiscussions.signInToStart')}
          </Link>
        )}
      </div>

      {hasDiscussions ? (
        <>
          <div className="wine-discussions-panel__list">
            {discussions.map(d => (
              <DiscussionCard key={d._id} discussion={d} />
            ))}
          </div>
          {total > discussions.length && (
            <div className="wine-discussions-panel__footer">
              <Link to="/community/discussions" className="wine-discussions-panel__more">
                {t('wineDiscussions.viewAll', { count: total })}
              </Link>
            </div>
          )}
        </>
      ) : (
        <p className="wine-discussions-panel__empty">{t('wineDiscussions.empty')}</p>
      )}
    </section>
  );
}
