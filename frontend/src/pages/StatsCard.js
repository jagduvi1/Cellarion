import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { getStatsOverview } from '../api/stats';
import CellarStatsCard from '../components/CellarStatsCard';
import { toPng, toBlob } from 'html-to-image';
import './StatsCard.css';

export default function StatsCard() {
  const { t } = useTranslation();
  const { apiFetch, user } = useAuth();
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showValue, setShowValue] = useState(false);
  const [exporting, setExporting] = useState(false);
  const cardRef = useRef(null);

  useEffect(() => {
    const fetch = async () => {
      try {
        const res = await getStatsOverview(apiFetch);
        if (res.ok) {
          const data = await res.json();
          setStats(data.stats);
        }
      } catch { /* ignore */ }
      setLoading(false);
    };
    fetch();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const exportOptions = {
    pixelRatio: 2,
    cacheBust: true,
  };

  const handleDownload = async () => {
    if (!cardRef.current) return;
    setExporting(true);
    try {
      const dataUrl = await toPng(cardRef.current, exportOptions);
      const link = document.createElement('a');
      link.download = `cellarion-stats-${user?.username || 'card'}.png`;
      link.href = dataUrl;
      link.click();
    } catch (err) {
      console.error('Export failed:', err);
    }
    setExporting(false);
  };

  const handleShare = async () => {
    if (!cardRef.current || !navigator.share) return;
    setExporting(true);
    try {
      const blob = await toBlob(cardRef.current, exportOptions);
      const file = new File([blob], 'cellarion-stats.png', { type: 'image/png' });
      await navigator.share({
        title: t('statsCard.shareTitle', 'My Cellarion Stats'),
        files: [file],
      });
    } catch {
      // User cancelled or not supported — try download as fallback
      handleDownload();
    }
    setExporting(false);
  };

  const displayName = user?.displayName || user?.username || '';
  const ratingScale = user?.preferences?.ratingScale || '5';

  if (loading) return <div className="stats-card-page"><p className="stats-card-loading">{t('statsCard.loading', 'Loading stats...')}</p></div>;
  if (!stats) return <div className="stats-card-page"><p className="stats-card-empty">{t('statsCard.noData', 'No stats available yet. Add some bottles to your cellar first.')}</p></div>;

  return (
    <div className="stats-card-page">
      <h1>{t('statsCard.title', 'Your Cellar Card')}</h1>
      <p className="stats-card-subtitle">{t('statsCard.subtitle', 'A snapshot of your wine collection — download or share it.')}</p>

      {/* Controls */}
      <div className="stats-card-controls">
        <label className="stats-card-toggle">
          <input
            type="checkbox"
            checked={showValue}
            onChange={(e) => setShowValue(e.target.checked)}
          />
          <span>{t('statsCard.showValue', 'Show cellar value')}</span>
        </label>
      </div>

      {/* Card preview */}
      <div className="stats-card-preview">
        <CellarStatsCard
          ref={cardRef}
          stats={stats}
          username={displayName}
          showValue={showValue}
          ratingScale={ratingScale}
        />
      </div>

      {/* Actions */}
      <div className="stats-card-actions">
        <button className="btn btn-primary" onClick={handleDownload} disabled={exporting}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          {exporting ? t('statsCard.exporting', 'Exporting...') : t('statsCard.download', 'Download image')}
        </button>
        {navigator.share && (
          <button className="btn btn-secondary" onClick={handleShare} disabled={exporting}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
            {t('statsCard.share', 'Share')}
          </button>
        )}
      </div>
    </div>
  );
}
