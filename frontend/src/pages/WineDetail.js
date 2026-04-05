import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { fromNormalized } from '../utils/ratingUtils';
import Layout from '../components/Layout';
import SITE_URL from '../config/siteUrl';
import WineImage from '../components/WineImage';
import { getWineImageUrl } from '../utils/wineImageUrl';
import { API_URL } from '../api/apiConstants';
import './WineDetail.css';

export default function WineDetail() {
  const { t } = useTranslation();
  const { id } = useParams();
  const { user } = useAuth();
  const [wine, setWine] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchWine = async () => {
      try {
        const res = await fetch(`${API_URL}/api/wines/${id}/public`);
        if (res.ok) {
          const data = await res.json();
          setWine(data.wine);
        } else {
          setError(t('wineDetail.wineNotFound'));
        }
      } catch {
        setError(t('wineDetail.wineNotFound'));
      }
      setLoading(false);
    };
    fetchWine();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const pageTitle = fullTitle.length > 47 ? fullTitle.slice(0, 57) : fullTitle;
  const titleTag = pageTitle.length > 47 ? pageTitle : `${pageTitle} — Cellarion`;
  const description = [
    wine.type && wine.type.charAt(0).toUpperCase() + wine.type.slice(1),
    wine.appellation,
    wine.region?.name,
    wine.country?.name
  ].filter(Boolean).join(' · ');
  const fullDesc = `${fullTitle}. ${description}. Discover, track, and manage your wine cellar with Cellarion.`;
  const metaDescription = fullDesc.length > 160 ? fullDesc.slice(0, 157) + '...' : fullDesc;
  const pageUrl = `${SITE_URL}/wines/${wine._id}`;
  const wineImageSrc = getWineImageUrl(wine.image);
  const imageUrl = wineImageSrc || `${SITE_URL}/cellarion-logo.jpg`;
  const grapeNames = wine.grapes?.map(g => g.name).filter(Boolean) || [];

  const ratingScale = user?.preferences?.ratingScale || '5';
  const hasRating = wine.communityRating?.reviewCount > 0;
  const reviewCount = wine.communityRating?.reviewCount || 0;

  // JSON-LD structured data — only use Product type when we have aggregateRating,
  // otherwise Google flags it as invalid (requires offers, review, or aggregateRating).
  const jsonLd = hasRating
    ? {
        '@context': 'https://schema.org',
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
        '@context': 'https://schema.org',
        '@type': 'WebPage',
        name: wine.name,
        description: metaDescription,
        url: pageUrl
      };

  const page = (
    <div className="wine-detail-page">
      <Helmet>
        <title>{titleTag}</title>
        <meta name="description" content={metaDescription} />
        <meta property="og:type" content="product" />
        <meta property="og:title" content={pageTitle} />
        <meta property="og:description" content={metaDescription} />
        <meta property="og:image" content={imageUrl} />
        <meta property="og:url" content={pageUrl} />
        <meta property="og:site_name" content="Cellarion" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={pageTitle} />
        <meta name="twitter:description" content={metaDescription} />
        <meta name="twitter:image" content={imageUrl} />
        <link rel="canonical" href={pageUrl} />
        <link rel="alternate" hrefLang="en" href={pageUrl} />
        <link rel="alternate" hrefLang="sv" href={pageUrl} />
        <link rel="alternate" hrefLang="x-default" href={pageUrl} />
        <script type="application/ld+json">{JSON.stringify(jsonLd)}</script>
      </Helmet>

      <div className="wd-card">
        <WineImage image={wine.image} alt={wine.name} className="wd-image" wrapClass="wd-image-wrap" />

        <div className="wd-info">
          <h1 className="wd-name">{wine.name}</h1>
          <p className="wd-producer">{wine.producer}</p>

          {wine.type && (
            <span className={`wine-type-pill ${wine.type}`}>{wine.type}</span>
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
                <span className="wd-detail-value">{wine.region.name}</span>
              </div>
            )}
            {wine.country?.name && (
              <div className="wd-detail">
                <span className="wd-detail-label">{t('wineDetail.country')}</span>
                <span className="wd-detail-value">{wine.country.name}</span>
              </div>
            )}
            {grapeNames.length > 0 && (
              <div className="wd-detail">
                <span className="wd-detail-label">{t('wineDetail.grapes')}</span>
                <span className="wd-detail-value">{grapeNames.join(', ')}</span>
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

      {/* CTA banner for non-authenticated visitors */}
      {!user && (
        <div className="wd-cta">
          <div className="wd-cta-content">
            <h2 className="wd-cta-title">{t('wineDetail.ctaTitle')}</h2>
            <p className="wd-cta-text">{t('wineDetail.ctaText')}</p>
            <div className="wd-cta-actions">
              <Link to="/login" className="btn btn-primary">{t('wineDetail.signUp')}</Link>
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
          <Link to="/cellars" className="btn btn-secondary">
            {t('wineDetail.backToCellars')}
          </Link>
        </div>
      )}
    </div>
  );

  // Wrap in Layout for logged-in users so they get the navbar
  return user ? <Layout>{page}</Layout> : page;
}
