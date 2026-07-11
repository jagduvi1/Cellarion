import { useState, useEffect, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { getCellar } from '../api/cellars';
import { getRacks } from '../api/racks';
import { buildCellarBook, formatDrinkWindow } from '../utils/cellarBook';
import { formatRating } from '../utils/ratingUtils';
import PrintRackMap from '../components/racks/PrintRackMap';
import CellarNav from '../components/CellarNav';
import './CellarBook.css';

// The cellar bottles endpoint caps page size at 200 — loop until we have
// every active bottle. Hard ceiling well above any real cellar as a
// runaway guard.
const PAGE_SIZE = 200;
const MAX_BOTTLES = 10000;

/**
 * Cellar Book — a print-friendly snapshot of the whole cellar: per rack a
 * numbered slot map plus the bottle list keyed by position, then everything
 * not placed in a rack. Rendered outside the app Layout so browser print
 * (→ save as PDF) produces a clean document with no navigation chrome.
 */
function CellarBook() {
  const { t, i18n } = useTranslation();
  const { id } = useParams();
  const { apiFetch } = useAuth();

  const [cellar, setCellar] = useState(null);
  const [racks, setRacks] = useState([]);
  const [bottles, setBottles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Racks (slot bottles populated) + first bottle page in parallel,
        // then the remaining pages sequentially.
        const [racksRes, firstRes] = await Promise.all([
          getRacks(apiFetch, id),
          getCellar(apiFetch, id, `limit=${PAGE_SIZE}&skip=0`),
        ]);
        const racksData = await racksRes.json();
        const firstData = await firstRes.json();
        if (!racksRes.ok) throw new Error(racksData.error || 'Failed to load racks');
        if (!firstRes.ok) throw new Error(firstData.error || 'Failed to load cellar');

        const all = [...(firstData.bottles?.items || [])];
        const total = Math.min(firstData.bottles?.total ?? all.length, MAX_BOTTLES);
        while (all.length < total) {
          const res = await getCellar(apiFetch, id, `limit=${PAGE_SIZE}&skip=${all.length}`);
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Failed to load cellar');
          const items = data.bottles?.items || [];
          if (items.length === 0) break; // total shrank mid-fetch — stop cleanly
          all.push(...items);
        }

        if (cancelled) return;
        setCellar(firstData.cellar || firstData);
        setRacks(racksData.racks || []);
        setBottles(all);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err.message || 'Failed to load');
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [apiFetch, id]);

  // Browser print dialogs use the document title as the default PDF name.
  useEffect(() => {
    if (!cellar?.name) return undefined;
    const prev = document.title;
    document.title = `${cellar.name} — ${t('cellarBook.title', 'Cellar Book')}`;
    return () => { document.title = prev; };
  }, [cellar?.name, t]);

  const book = useMemo(() => buildCellarBook(racks, bottles), [racks, bottles]);

  const printedAt = new Date().toLocaleDateString(i18n.language === 'sv' ? 'sv-SE' : undefined, {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  if (loading) {
    return <div className="cellar-book cellar-book-status">{t('common.loading', 'Loading...')}</div>;
  }
  if (error) {
    return (
      <div className="cellar-book cellar-book-status">
        <div className="alert alert-error">{error}</div>
        <Link to={`/cellars/${id}`} className="btn btn-secondary">{t('cellarBook.backToCellar', 'Back to cellar')}</Link>
      </div>
    );
  }

  return (
    <div className="cellar-book">
      {/* Screen-only toolbar */}
      <div className="cb-toolbar">
        <Link to={`/cellars/${id}`} className="back-link">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>
          {t('cellarBook.backToCellar', 'Back to cellar')}
        </Link>
        <button className="btn btn-primary" onClick={() => window.print()}>
          {t('cellarBook.printBtn', 'Print / Save as PDF')}
        </button>
      </div>

      {/* Shared view switcher (screen only — CellarNav hides itself in print) */}
      <CellarNav cellarId={id} active="book" />

      {/* Book header */}
      <header className="cb-header">
        <h1>{cellar?.name}</h1>
        <p className="cb-subtitle">{t('cellarBook.title', 'Cellar Book')}</p>
        <p className="cb-meta">
          {t('cellarBook.summary', '{{total}} bottles — {{placed}} in racks, {{unplaced}} unplaced', {
            total: book.totalActive,
            placed: book.placedCount,
            unplaced: book.unplaced.length,
          })}
          {' · '}{printedAt}
        </p>
      </header>

      {book.rackSections.length === 0 && book.unplaced.length === 0 && (
        <p className="cb-empty">{t('cellarBook.empty', 'This cellar has no active bottles yet.')}</p>
      )}

      {/* One section per rack: map + position-keyed list */}
      {book.rackSections.map(({ rack, entries, filledCount, totalSlots }) => (
        <section key={rack._id} className="cb-rack-section">
          <h2>{rack.name}</h2>
          <p className="cb-rack-meta">
            {t('cellarBook.rackFilled', '{{filled}} of {{total}} slots filled', { filled: filledCount, total: totalSlots })}
          </p>
          <div className="cb-rack-map">
            <PrintRackMap rack={rack} />
          </div>
          {entries.length > 0 ? (
            <BottleTable entries={entries} t={t} />
          ) : (
            <p className="cb-rack-empty">{t('cellarBook.rackEmpty', 'No bottles in this rack.')}</p>
          )}
        </section>
      ))}

      {/* Bottles without a rack position */}
      {book.unplaced.length > 0 && (
        <section className="cb-rack-section">
          <h2>{t('cellarBook.unplacedTitle', 'Not in a rack')}</h2>
          <p className="cb-rack-meta">
            {t('cellarBook.unplacedCount', '{{count}} bottles', { count: book.unplaced.length })}
          </p>
          <BottleTable entries={book.unplaced.map(b => ({ position: null, bottle: b }))} t={t} />
        </section>
      )}

      <footer className="cb-footer">
        {t('cellarBook.footer', 'Generated by Cellarion')} · {printedAt}
      </footer>
    </div>
  );
}

function BottleTable({ entries, t }) {
  return (
    <table className="cb-table">
      <thead>
        <tr>
          <th className="cb-col-pos">{t('cellarBook.colPos', 'Pos')}</th>
          <th>{t('cellarBook.colWine', 'Wine')}</th>
          <th className="cb-col-vintage">{t('cellarBook.colVintage', 'Vintage')}</th>
          <th className="cb-col-type">{t('cellarBook.colType', 'Type')}</th>
          <th className="cb-col-rating">{t('cellarBook.colRating', 'Rating')}</th>
          <th className="cb-col-window">{t('cellarBook.colWindow', 'Drink window')}</th>
        </tr>
      </thead>
      <tbody>
        {entries.map(({ position, bottle }) => {
          const wine = bottle?.wineDefinition;
          const type = wine?.type || null;
          const window_ = formatDrinkWindow(bottle);
          return (
            <tr key={position != null ? `p${position}` : (bottle?._id || Math.random())}>
              <td className="cb-col-pos">{position ?? '—'}</td>
              <td>
                <span className="cb-wine-name">{wine?.name || t('common.unknown', 'Unknown')}</span>
                {wine?.producer && <span className="cb-wine-producer"> — {wine.producer}</span>}
              </td>
              <td className="cb-col-vintage">{bottle?.vintage || 'NV'}</td>
              <td className="cb-col-type">
                {type && <span className={`cb-type-dot type-${type}`} aria-hidden="true" />}
                {type ? t(`statistics.typeLabels.${type}`, type) : '—'}
              </td>
              <td className="cb-col-rating">
                {bottle?.rating != null ? formatRating(bottle.rating, bottle.ratingScale || '5') : '—'}
              </td>
              <td className="cb-col-window">
                {window_ ? (window_.text || t(window_.tKey)) : '—'}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export default CellarBook;
