import { useState, useEffect, Suspense } from 'react';
import { lazy } from '../utils/lazyWithReload';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import { useAuth } from '../contexts/AuthContext';
import { formatTemperatureRange, temperatureUnitOf } from '../utils/temperature';

// Wine-level serving advice from the API: the temperature (the sommelier's or
// the style's) in the reader's unit, and the air trait in words. The decanting
// advice for a bottle's age lives on the bottle page, where the age is known.
function ServingLine({ serving, user, t }) {
  if (!serving?.temperature) return null;
  const range = formatTemperatureRange(serving.temperature.min, serving.temperature.max, temperatureUnitOf(user));
  const bySommelier = serving.temperature.source === 'sommelier' || !!serving.needsAir;
  return (
    <div className="bd-ai-pairings bd-ai-serving">
      <span className="bd-ai-pairings__label">{t('serving.label', { defaultValue: 'Serving' })}:</span>
      {t('serving.temperature', { range, defaultValue: 'Serve at {{range}}' })}
      {serving.needsAir ? ` · ${t(`serving.needsAir.${serving.needsAir}`)}` : ''}
      {' '}
      <span className="bd-serving-source">({bySommelier ? t('serving.bySommelier', { defaultValue: 'Set by the sommelier' }) : t('serving.byStyle', { defaultValue: 'Style guideline' })})</span>
    </div>
  );
}
import { fromNormalized } from '../utils/ratingUtils';
import Layout from '../components/Layout';
import SEOHead from '../components/SEOHead';
import SITE_URL from '../config/siteUrl';
import WineImage from '../components/WineImage';
import WineDiscussionsPanel from '../components/WineDiscussionsPanel';
import AddToCellarButton from '../components/AddToCellarButton';
import { WhenToDrinkCard, WhereFromCard, MoreWinesCard } from '../components/WineContextCards';
import { getWineImageUrl } from '../utils/wineImageUrl';
import { API_URL } from '../api/apiConstants';
import { swatchType, wineTypeLabel } from '../utils/wineColour';
import './WineDetail.css';

// Lazy like BottleDetail: the report modal is a rare interaction and must not
// weigh on the public wine page bundle.
const ReportWineModal = lazy(() => import('../components/ReportWineModal'));

// Same regex used by the backend's isValidId — 24 hex chars = ObjectId, anything
// else is treated as a slug.
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

export default function WineDetail() {
  const { t } = useTranslation();
  const { idOrSlug } = useParams();
  const { user, apiFetch } = useAuth();
  const [wine, setWine] = useState(null);
  // Links, region and grape notes, related wines and drink windows around the
  // wine (backend services/winePageContext); null when the server sent none.
  const [context, setContext] = useState(null);
  const [showReport, setShowReport] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    // The page is keyed by the address (App.js), so a link to another wine
    // starts a fresh page: open it at the top, not where the last one ended.
    window.scrollTo(0, 0);
    let ignore = false;
    const fetchWine = async () => {
      try {
        // Signed in: send the session along so the same endpoint returns the
        // full profile; anonymous visitors get the prose-only tier (registry
        // lockdown 2026-09-06).
        const url = `${API_URL}/api/wines/${encodeURIComponent(idOrSlug)}/public`;
        const res = user ? await apiFetch(url) : await fetch(url);
        if (ignore) return;
        if (res.ok) {
          const data = await res.json();
          if (ignore) return;
          setWine(data.wine);
          setContext(data.context || null);
          // If we landed on an ObjectId URL but the wine has a slug, transparently
          // upgrade the URL bar to the slug so users see + share the pretty form.
          // replaceState avoids a navigation event and preserves history.
          if (OBJECT_ID_RE.test(idOrSlug) && data.wine?.slug) {
            window.history.replaceState(window.history.state, '', `/wines/${data.wine.slug}`);
          }
        } else {
          setError(t('wineDetail.wineNotFound'));
        }
      } catch {
        if (!ignore) setError(t('wineDetail.wineNotFound'));
      }
      if (!ignore) setLoading(false);
    };
    fetchWine();
    return () => { ignore = true; };
  }, [idOrSlug]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <div className="wd-loading">Loading...</div>;
  if (error || !wine) {
    const content = (
      <div className="wd-error">
        <p>{error || t('wineDetail.wineNotFound')}</p>
        <Link to="/" className="btn btn-secondary">{t('wineDetail.goToCellarion')}</Link>
      </div>
    );
    return user ? <Layout>{content}</Layout> : content;
  }

  const fullTitle = `${wine.name} — ${wine.producer}`;
  const titleTag = fullTitle.length > 47 ? fullTitle.slice(0, 57) : `${fullTitle} — Cellarion`;
  // Canonical URL: prefer slug whenever the wine has one. ObjectId is the fallback
  // for any wine not yet migrated.
  const winePath = `/wines/${wine.slug || wine._id}`;
  const description = [
    wine.type && wine.type.charAt(0).toUpperCase() + wine.type.slice(1),
    wine.appellation,
    wine.region?.name,
    wine.country?.name
  ].filter(Boolean).join(' · ');
  // Same rule as the crawler page (backend og.js): the tasting prose makes the
  // description this wine's own; cut on a word.
  const fullDesc = wine.aiProfile?.description
    ? `${fullTitle}. ${wine.aiProfile.description}`
    : `${fullTitle}. ${description}. Discover, track, and manage your wine cellar with Cellarion.`;
  let metaDescription = fullDesc;
  if (fullDesc.length > 160) {
    const cut = fullDesc.slice(0, 157);
    const lastSpace = cut.lastIndexOf(' ');
    metaDescription = (lastSpace > 100 ? cut.slice(0, lastSpace) : cut).replace(/[\s,.;:]+$/, '') + '…';
  }
  const pageUrl = `${SITE_URL}${winePath}`;
  const wineImageSrc = getWineImageUrl(wine.image);
  const imageUrl = wineImageSrc || `${SITE_URL}/cellarion-logo.jpg`;
  // Prefer the regionally correct label when the backend resolved one
  // ("Tinta Roriz" on a Douro Port); g.name stays the canonical variety.
  const grapeNames = wine.grapes?.map(g => g.displayName || g.name).filter(Boolean) || [];
  // A region, country or grape links to its page when the server says one
  // exists (context entries carry a path); otherwise it stays plain text.
  const grapeEntries = new Map((context?.grapes || []).map((g) => [g.name, g]));
  const placeLink = (entry, label) => (entry?.path
    ? <Link to={entry.path} className="wd-detail-link">{label}</Link>
    : label);

  const ratingScale = user?.preferences?.ratingScale || '5';
  const hasRating = wine.communityRating?.reviewCount > 0;
  const reviewCount = wine.communityRating?.reviewCount || 0;

  // JSON-LD structured data — only use Product type when we have aggregateRating,
  // otherwise Google flags it as invalid (requires offers, review, or aggregateRating).
  const mainEntity = hasRating
    ? {
        '@type': 'Product',
        name: wine.name,
        description: metaDescription,
        brand: { '@type': 'Brand', name: wine.producer },
        image: imageUrl,
        url: pageUrl,
        category: wine.type ? `${wine.type} wine` : 'wine',
        aggregateRating: {
          '@type': 'AggregateRating',
          ratingValue: fromNormalized(wine.communityRating.averageNormalized, '5').toFixed(1),
          bestRating: '5',
          reviewCount
        }
      }
    : {
        '@type': 'WebPage',
        name: wine.name,
        description: metaDescription,
        url: pageUrl
      };

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      mainEntity,
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Cellarion', item: SITE_URL },
          { '@type': 'ListItem', position: 2, name: t('wineDetail.wines'), item: `${SITE_URL}/wines` },
          { '@type': 'ListItem', position: 3, name: wine.name, item: pageUrl }
        ]
      }
    ]
  };

  const page = (
    <div className="wine-detail-page">
      <SEOHead
        title={titleTag}
        description={metaDescription}
        path={winePath}
        image={imageUrl}
        ogType={hasRating ? 'product' : 'website'}
        jsonLd={jsonLd}
      />

      <div className="wd-card">
        <WineImage image={wine.image} alt={wine.name} className="wd-image" wrapClass="wd-image-wrap" full />

        <div className="wd-info">
          <h1 className="wd-name">{wine.name}</h1>
          <p className="wd-producer">{wine.producer}</p>

          {wine.type && (
            <span className={`wine-type-pill ${swatchType(wine)}`}>{wineTypeLabel(wine, t)}</span>
          )}

          <div className="wd-details">
            {wine.appellation && (
              <div className="wd-detail">
                <span className="wd-detail-label">{t('wineDetail.appellation')}</span>
                <span className="wd-detail-value">{wine.appellation}</span>
              </div>
            )}
            {wine.classification && (
              <div className="wd-detail">
                <span className="wd-detail-label">{t('wineDetail.classification')}</span>
                <span className="wd-detail-value">{wine.classification}</span>
              </div>
            )}
            {wine.region?.name && (
              <div className="wd-detail">
                <span className="wd-detail-label">{t('wineDetail.region')}</span>
                <span className="wd-detail-value">{placeLink(context?.region, wine.region.name)}</span>
              </div>
            )}
            {wine.country?.name && (
              <div className="wd-detail">
                <span className="wd-detail-label">{t('wineDetail.country')}</span>
                <span className="wd-detail-value">{placeLink(context?.country, wine.country.name)}</span>
              </div>
            )}
            {grapeNames.length > 0 && (
              <div className="wd-detail">
                <span className="wd-detail-label">{t('wineDetail.grapes')}</span>
                <span className="wd-detail-value">
                  {(wine.grapes || []).filter((g) => g.displayName || g.name).map((g, i) => (
                    <span key={g.name || i}>
                      {i > 0 && ', '}
                      {placeLink(grapeEntries.get(g.name), g.displayName || g.name)}
                    </span>
                  ))}
                </span>
              </div>
            )}
          </div>

          {hasRating && (
            <div className="wd-rating">
              <span className="wd-rating-value">
                {fromNormalized(wine.communityRating.averageNormalized, ratingScale).toFixed(1)}
                {ratingScale === '100' ? 'pts' : ratingScale === '20' ? '/20' : '★'}
              </span>
              <span className="wd-rating-count">
                {reviewCount} {reviewCount !== 1 ? t('wineDetail.reviews') : t('wineDetail.review')}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* AI tasting profile (generated, vintage-neutral) — public, no login needed */}
      {wine.aiProfile?.description && (
        <div className="wd-card bd-ai-profile">
          <div className="bd-ai-profile__header">
            <h2>{t('wineDetail.tastingProfile', 'Tasting profile')}</h2>
            {/* Provenance is load-bearing here too (#985): the public page
                must never present AI-generated text as established fact. */}
            {wine.aiProfile.source === 'curator' ? (
              <span className="bd-ai-tag bd-ai-tag--curator" title={t('wineDetail.provenanceCuratorTitle', 'A sommelier has verified this profile')}>
                {t('wineDetail.provenanceCurator', 'Curator-verified')}
              </span>
            ) : (
              <span className="bd-ai-tag" title={t('wineDetail.provenanceAiTitle', 'Written by AI from the wine’s identity — a starting point, not a fact')}>
                {t('wineDetail.provenanceAi', 'AI-generated')}
              </span>
            )}
          </div>

          {(() => {
            const ap = wine.aiProfile;
            // Anonymous visitors receive the structure as one `style` line
            // instead of the fields; members get the fields.
            const structure = ap.style ? [ap.style] : [
              ap.body && `${ap.body}-bodied`,
              ap.tannin && `${ap.tannin} tannin`,
              ap.acidity && `${ap.acidity} acidity`,
              ap.sweetness,
            ].filter(Boolean);
            const flavours = ap.flavors || [];
            return (
              <>
                {structure.length > 0 && (
                  <div className="bd-ai-group">
                    <span className="bd-ai-group-label">{t('wineDetail.structure', 'Structure')}</span>
                    <div className="bd-ai-chips">
                      {structure.map((c, i) => <span key={`s${i}`} className="bd-ai-chip bd-ai-chip--style">{c}</span>)}
                    </div>
                  </div>
                )}
                {flavours.length > 0 && (
                  <div className="bd-ai-group">
                    <span className="bd-ai-group-label">{t('wineDetail.flavours', 'Flavours')}</span>
                    <div className="bd-ai-chips">
                      {flavours.map((f, i) => <span key={`f${i}`} className="bd-ai-chip">{f}</span>)}
                    </div>
                  </div>
                )}
              </>
            );
          })()}

          <div className="bd-ai-prose">
            <ReactMarkdown rehypePlugins={[rehypeSanitize]} disallowedElements={['img']} unwrapDisallowed>{wine.aiProfile.description}</ReactMarkdown>
          </div>

          {wine.aiProfile.foodPairings?.length > 0 && (
            <div className="bd-ai-pairings">
              <span className="bd-ai-pairings__label">{t('wineDetail.pairsWith', 'Pairs with')}:</span>
              {wine.aiProfile.foodPairings.join(' · ')}
            </div>
          )}
          <ServingLine serving={wine.serving} user={user} t={t} />
        </div>
      )}

      {/* No published profile — same honest pending state as the bottle page
          (somm ticket 6a83e765): held and never-generated must read alike. */}
      {!wine.aiProfile?.description && (
        <div className="wd-card bd-ai-profile">
          <div className="bd-ai-profile__header">
            <h2>{t('wineDetail.tastingProfile', 'Tasting profile')}</h2>
            <span className="bd-ai-tag" title={t('wineDetail.profilePendingTitle', 'This wine has not been through assessment yet — profiles are generated and reviewed over time')}>
              {t('wineDetail.profilePending', 'Not yet assessed')}
            </span>
          </div>
          <p style={{ color: 'var(--color-text-muted)', margin: 0, fontSize: '0.9rem' }}>
            {t('wineDetail.profilePendingBody', 'This wine hasn’t been assessed yet. A tasting profile appears here once it has been.')}
          </p>
          <ServingLine serving={wine.serving} user={user} t={t} />
        </div>
      )}

      <WhenToDrinkCard context={context} signedIn={!!user} />

      {/* CTA banner for non-authenticated visitors */}
      {!user && (
        <div className="wd-cta">
          <div className="wd-cta-content">
            <h2 className="wd-cta-title">{t('wineDetail.ctaTitle')}</h2>
            <p className="wd-cta-text">{t('wineDetail.ctaText')}</p>
            <div className="wd-cta-actions">
              <Link to="/login?mode=register" className="btn btn-primary">{t('wineDetail.signUp')}</Link>
              <Link to="/" className="btn btn-secondary">{t('wineDetail.learnMore')}</Link>
            </div>
          </div>
        </div>
      )}

      {user && (
        <div className="wd-actions">
          <Link to={`/wishlist/add?wine=${wine._id}`} className="btn btn-primary">
            {t('wineDetail.addToWishlist')}
          </Link>
          {/* A bottle of it straight into a cellar — the wishlist never adds one. */}
          <AddToCellarButton wineId={wine._id} className="btn btn-secondary" />
          <Link to="/cellars" className="btn btn-secondary">
            {t('wineDetail.backToCellars')}
          </Link>
          {/* R7: the report link used to exist only on the bottle page — but
              wrong shared data is most visible to NON-owners, right here. */}
          <button type="button" className="btn btn-secondary" onClick={() => setShowReport(true)}>
            {t('wineDetail.reportIssue')}
          </button>
        </div>
      )}

      <WhereFromCard context={context} countryName={wine.country?.name} />
      <MoreWinesCard context={context} wine={wine} />

      {showReport && (
        <Suspense fallback={null}>
          <ReportWineModal wine={wine} onClose={() => setShowReport(false)} />
        </Suspense>
      )}

      <WineDiscussionsPanel wine={wine} />
    </div>
  );

  // Wrap in Layout for logged-in users so they get the navbar
  return user ? <Layout>{page}</Layout> : page;
}
