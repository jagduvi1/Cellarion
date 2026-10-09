import { useState, useEffect, useMemo, Suspense } from 'react';
import { lazy } from '../utils/lazyWithReload';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { getCellarVintage } from '../api/cellars';
import { lookupMaturityProfile } from '../api/somm';
import AuthImage from '../components/AuthImage';
import BottleCard from '../components/BottleCard';
import CellarNav from '../components/CellarNav';
import CellarPageHeader from '../components/CellarPageHeader';
import MaturityPhaseTable from '../components/bottle/MaturityPhaseTable';
import LotHistory from '../components/bottle/LotHistory';
import PersonalDataCard from '../components/bottle/PersonalDataCard';
import WineRecordSection from '../components/bottle/WineRecordSection';
import JournalPrompt, { journalPromptOptedOut } from '../components/JournalPrompt';
import { getMaturityStatus } from '../utils/drinkStatus';
import { bottleAnchorYear } from '../utils/maturityUtils';
import { totalsByCurrency } from '../utils/onOrder';
import './CellarDetail.css';
import './BottleDetail.css';
import './CellarVintage.css';

const DrinkOneModal = lazy(() => import('../components/DrinkOneModal'));
const BulkDrinkWindowModal = lazy(() => import('../components/BulkDrinkWindowModal'));

/**
 * One wine and vintage in a cellar — the page behind a grouped "n identical
 * bottles" entry (support ticket 2026-10-09). The bottle list groups bottles
 * of one wine and vintage, but the group had no page of its own: a click only
 * expanded it. Much of what a collector keeps belongs to the vintage, not to
 * one bottle, so this page gathers it: the wine's registry record with this
 * vintage's public values, the sommelier window, what every bottle shares
 * (a note or drink window identical on all of them), the bottles with their
 * slots, what already happened to the others, and the personal data at wine
 * and vintage scope. A view over existing data — nothing is stored here.
 */
function CellarVintage() {
  const { t, i18n } = useTranslation();
  const { id, wineId, vintage: vintageParam } = useParams();
  const { apiFetch, user } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [profile, setProfile] = useState(null);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [drinkOpen, setDrinkOpen] = useState(false);
  const [windowOpen, setWindowOpen] = useState(false);
  const [journalBottle, setJournalBottle] = useState(null);
  const [notice, setNotice] = useState(null);

  const vintage = decodeURIComponent(vintageParam || 'NV');

  const load = async () => {
    try {
      const res = await getCellarVintage(apiFetch, id, wineId, vintage);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(body.error || t('cellarVintage.loadFailed', 'Could not load this vintage.')); return; }
      setData(body);
    } catch {
      setError(t('cellarVintage.loadFailed', 'Could not load this vintage.'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [id, wineId, vintage]); // eslint-disable-line react-hooks/exhaustive-deps

  // The sommelier window for this vintage, as on the bottle page. NV has
  // relative windows measured from each bottle's purchase year; the page
  // anchors on the first bottle like the lot does.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await lookupMaturityProfile(apiFetch, wineId, vintage);
        const body = await res.json().catch(() => ({}));
        if (!cancelled) setProfile(res.ok ? body.profile || null : null);
      } catch {
        if (!cancelled) setProfile(null);
      } finally {
        if (!cancelled) setProfileLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [apiFetch, wineId, vintage]);

  const bottles = data?.bottles || [];
  const wine = data?.wine || null;
  const cellar = data?.cellar || null;
  const canEdit = !!cellar && ['owner', 'editor'].includes(cellar.userRole);
  const isOwner = cellar?.userRole === 'owner';
  const first = bottles[0] || null;

  // The card's rack badge reads a bottle → slot map; the server already
  // answered the slots, so the map is built from them.
  const rackMap = useMemo(() => {
    const m = new Map();
    for (const b of bottles) if (b.rackInfo) m.set(String(b._id), b.rackInfo);
    return m;
  }, [bottles]);
  // Where the bottles sit, as one line: "Rack A · slots 3, 4, 7".
  const placements = useMemo(() => {
    const byRack = new Map();
    for (const b of bottles) {
      if (!b.rackInfo) continue;
      const key = String(b.rackInfo.rackId);
      if (!byRack.has(key)) byRack.set(key, { name: b.rackInfo.rackName, positions: [] });
      if (b.rackInfo.position != null) byRack.get(key).positions.push(b.rackInfo.position);
    }
    return [...byRack.values()].map((r) => ({ ...r, positions: r.positions.sort((a, b) => a - b) }));
  }, [bottles]);
  const unplaced = bottles.filter((b) => !b.rackInfo).length;
  const totals = useMemo(() => totalsByCurrency(bottles), [bottles]);
  const totalText = totals
    .map(({ currency, total }) => `${total.toLocaleString(i18n.language, { maximumFractionDigits: 2 })} ${currency}`)
    .join(' + ');

  const shared = data?.shared || {};
  const sharedWindow = shared.drinkFrom != null || shared.drinkTo != null
    ? `${shared.drinkFrom ?? '…'}–${shared.drinkTo ?? '…'}`
    : null;
  const sharedPeak = shared.peakFrom != null || shared.peakUntil != null
    ? `${shared.peakFrom ?? '…'}–${shared.peakUntil ?? '…'}`
    : null;

  const anchorYear = bottleAnchorYear(first);
  const maturityStatus = profile ? getMaturityStatus(profile, anchorYear) : null;
  const profileReviewed = profile?.status === 'reviewed';

  // Hero: the same order as the cards — a chosen or own photo, a public
  // photo of this vintage, the registry image.
  const heroSrc = first?.defaultImageUrl || first?.pendingImageUrl || first?.vintageImageUrl || wine?.image || null;
  const heroCredit = first?.defaultImageUrl || first?.pendingImageUrl ? null : (first?.vintageImageUrl ? first?.vintageImageCredit : wine?.imageCredit);

  const handleDrunk = (bottle, reason) => {
    setDrinkOpen(false);
    setNotice(t('cellarVintage.drunkNote', 'Logged. One bottle fewer of this vintage.'));
    if (reason === 'drank' && !journalPromptOptedOut()) setJournalBottle(bottle);
    else load();
  };

  const title = wine ? `${wine.name} ${vintage}` : t('cellarVintage.title', 'Vintage');

  return (
    <div className="cellar-detail-page cellar-vintage-page">
      {error && (
        <div className="alert alert-error" role="alert">
          {error}
          <button type="button" className="btn btn-small btn-secondary" style={{ marginLeft: '0.75rem' }} onClick={() => setError(null)}>✕</button>
        </div>
      )}
      <CellarPageHeader
        backTo={`/cellars/${id}`}
        backLabel={t('history.backTo', { cellarName: cellar?.name || '…' })}
        title={title}
        loading={loading}
        userColor={cellar?.userColor}
        subtitle={wine?.producer || null}
      />

      <CellarNav cellarId={id} />

      {notice && (
        <div className="alert alert-success cellar-vintage-notice" role="status">
          <span>{notice}</span>
          <button type="button" className="cellar-vintage-notice-close" aria-label={t('common.close', 'Close')} onClick={() => setNotice(null)}>✕</button>
        </div>
      )}

      {loading ? (
        <div className="loading">{t('common.loading')}</div>
      ) : !data ? null : (
        <div className="cellar-vintage-grid">
          <aside className="cellar-vintage-side">
            {/* No photo, no box: an empty frame says nothing a reader needs. */}
            {heroSrc && (
              <div className="cellar-vintage-hero">
                <AuthImage src={heroSrc} alt={title} className="cellar-vintage-hero-img" onError={(e) => { e.target.style.display = 'none'; }} />
                {heroCredit && <span className="bd-wine-image-credit">{heroCredit}</span>}
              </div>
            )}

            <div className="card cellar-vintage-summary">
              <div className="cellar-vintage-count">
                {t('cellarVintage.inCellar', { count: bottles.length })}
              </div>
              {data.onOrderCount > 0 && (
                <Link to={`/cellars/${id}/on-order`} className="cellar-vintage-aux">{t('cellarVintage.onOrder', { count: data.onOrderCount })}</Link>
              )}
              {data.consumedCount > 0 && (
                <Link to={`/cellars/${id}/history`} className="cellar-vintage-aux">{t('cellarVintage.drunk', { count: data.consumedCount })}</Link>
              )}
              {totalText && <div className="cellar-vintage-aux">{t('cellarVintage.paidTotal', { amount: totalText })}</div>}
              {placements.length > 0 && (
                <ul className="cellar-vintage-slots">
                  {placements.map((r) => (
                    <li key={r.name}>
                      <span aria-hidden="true">📍</span> {r.positions.length
                        ? t('cellarVintage.rackSlots', '{{rack}} · slots {{slots}}', { rack: r.name, slots: r.positions.join(', ') })
                        : r.name}
                    </li>
                  ))}
                  {unplaced > 0 && <li>{t('cellarVintage.unplaced', { count: unplaced })}</li>}
                </ul>
              )}
              {canEdit && bottles.length > 0 && (
                <div className="cellar-vintage-actions">
                  <button type="button" className="btn btn-primary" onClick={() => setDrinkOpen(true)}>
                    <span aria-hidden="true">🍷</span> {t('cellarVintage.drinkOne', 'Drink one')}
                  </button>
                  {isOwner && (
                    <button type="button" className="btn btn-secondary" onClick={() => setWindowOpen(true)}>
                      {t('cellarVintage.setWindowAll', { count: bottles.length })}
                    </button>
                  )}
                </div>
              )}
              {wine?.slug && (
                <Link to={`/wines/${wine.slug}`} className="cellar-vintage-aux cellar-vintage-wine-link">{t('cellarVintage.registryLink', 'Open in the shared registry →')}</Link>
              )}
            </div>
          </aside>

          <div className="cellar-vintage-main">
            {/* This vintage: the sommelier window. */}
            <section className="card cellar-vintage-section">
              <h2 className="cellar-vintage-h2">{t('cellarVintage.windowTitle', 'This vintage')}</h2>
              {!profileLoaded ? (
                <span className="bd-no-dates">{t('bottleDetail.loadingMaturity')}</span>
              ) : !profileReviewed ? (
                <div className="bd-maturity-pending">
                  <span className="maturity-badge maturity-badge--pending">{t('bottleDetail.awaitingSommelier')}</span>
                  <span className="bd-maturity-note">{t('bottleDetail.sommelierWillSet')}</span>
                </div>
              ) : (
                <div className="bd-maturity-reviewed">
                  {maturityStatus && !sharedWindow && (
                    <span className={`maturity-badge maturity-badge--${maturityStatus.status}`}>{maturityStatus.label}</span>
                  )}
                  <MaturityPhaseTable profile={profile} anchorYear={anchorYear} />
                  {profile.sommNotes && <p className="bd-maturity-notes">{profile.sommNotes}</p>}
                </div>
              )}
            </section>

            {/* What every bottle shares — shown once, not n times. */}
            {(sharedWindow || shared.notes) && (
              <section className="card cellar-vintage-section">
                <h2 className="cellar-vintage-h2">{t('cellarVintage.sharedTitle', { count: bottles.length })}</h2>
                {sharedWindow && (
                  <p className="cellar-vintage-shared-row">
                    <span className="bd-section-label">{t('cellarVintage.yourWindow', 'Your drink window')}</span>
                    {sharedWindow}{sharedPeak && <span className="cellar-vintage-peak"> · {t('cellarVintage.peak', 'peak {{range}}', { range: sharedPeak })}</span>}
                  </p>
                )}
                {shared.notes && (
                  <div className="cellar-vintage-shared-row">
                    <span className="bd-section-label">{t('common.notes')}</span>
                    <p className="cellar-vintage-notes">{shared.notes}</p>
                  </div>
                )}
              </section>
            )}

            {/* The bottles, with their slots — each still its own page. */}
            <section className="cellar-vintage-section">
              <h2 className="cellar-vintage-h2">{t('cellarVintage.bottlesTitle', 'Your bottles')}</h2>
              {bottles.length === 0 ? (
                <p className="cellar-vintage-empty">{t('cellarVintage.noneLeft', 'None of this vintage left in this cellar.')}</p>
              ) : (
                <div className="bottles-list cellar-vintage-bottles">
                  {bottles.map((b) => (
                    <BottleCard key={b._id} bottle={b} rackMap={rackMap} cellarId={id} viewMode="list" rackKnown showNotes={!shared.notes} />
                  ))}
                </div>
              )}
            </section>

            {wine && (
              <section className="card cellar-vintage-section">
                <WineRecordSection
                  wine={wine}
                  vintage={vintage}
                  canSuggest={!user?.isDemo && wine.draft !== true}
                  apiFetch={apiFetch}
                />
              </section>
            )}

            {data.historyBottleId && (
              <PersonalDataCard apiFetch={apiFetch} bottleId={data.historyBottleId} currentUserId={user?.id} wineId={wine?._id} vintage={vintage} />
            )}

            {data.historyBottleId && (
              <LotHistory apiFetch={apiFetch} bottleId={data.historyBottleId} vintage={vintage} isOwner={isOwner} />
            )}
          </div>
        </div>
      )}

      <Suspense fallback={null}>
        {drinkOpen && (
          <DrinkOneModal
            bottles={bottles}
            rackMap={rackMap}
            wineName={title}
            onClose={() => setDrinkOpen(false)}
            onDone={handleDrunk}
          />
        )}
        {windowOpen && (
          <BulkDrinkWindowModal bottleIds={bottles.map((b) => b._id)} onClose={() => setWindowOpen(false)} onDone={() => { setWindowOpen(false); load(); }} />
        )}
      </Suspense>
      {journalBottle && (
        <JournalPrompt bottle={journalBottle} onDone={() => { setJournalBottle(null); load(); }} />
      )}
    </div>
  );
}

export default CellarVintage;
