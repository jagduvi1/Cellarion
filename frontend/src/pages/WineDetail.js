import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { useAuth } from '../contexts/AuthContext';
import { fromNormalized } from '../utils/ratingUtils';
import './WineDetail.css';

const API_URL = process.env.REACT_APP_API_URL || '';
const SITE_URL = process.env.REACT_APP_SITE_URL || 'https://cellarion.app';

export default function WineDetail() {
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
          setError('Wine not found');
        }
      } catch {
        setError('Failed to load wine');
      }
      setLoading(false);
    };
    fetchWine();
  }, [id]);

  if (loading) return <div className="wd-loading">Loading...</div>;
  if (error || !wine) return (
    <div className="wd-error">
      <p>{error || 'Wine not found'}</p>
      <Link to="/" className="btn btn-secondary">Go to Cellarion</Link>
    </div>
  );

  const pageTitle = `${wine.name} — ${wine.producer}`;
  const description = [
    wine.type && wine.type.charAt(0).toUpperCase() + wine.type.slice(1),
    wine.appellation,
    wine.region?.name,
    wine.country?.name
  ].filter(Boolean).join(' · ');
  const metaDescription = `${pageTitle}. ${description}. Discover, track, and manage your wine cellar with Cellarion.`;
  const pageUrl = `${SITE_URL}/wines/${wine._id}`;
  const imageUrl = wine.image ? `${API_URL}/api/uploads/${wine.image}` : `${SITE_URL}/cellarion-logo.jpg`;
  const grapeNames = wine.grapes?.map(g => g.name).filter(Boolean) || [];

  const ratingScale = user?.preferences?.ratingScale || '5';
  const hasRating = wine.communityRating?.reviewCount > 0;

  // JSON-LD structured data
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: wine.name,
    description: metaDescription,
    brand: { '@type': 'Brand', name: wine.producer },
    image: imageUrl,
    url: pageUrl,
    category: wine.type ? `${wine.type} wine` : 'wine'
  };
  if (hasRating) {
    jsonLd.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: fromNormalized(wine.communityRating.averageNormalized, '5').toFixed(1),
      bestRating: '5',
      reviewCount: wine.communityRating.reviewCount
    };
  }

  return (
    <div className="wine-detail-page">
      <Helmet>
        <title>{pageTitle} — Cellarion</title>
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
        <script type="application/ld+json">{JSON.stringify(jsonLd)}</script>
      </Helmet>

      <div className="wd-card">
        {wine.image && (
          <div className="wd-image-wrap">
            <img
              src={`${API_URL}/api/uploads/${wine.image}`}
              alt={wine.name}
              className="wd-image"
            />
          </div>
        )}

        <div className="wd-info">
          <h1 className="wd-name">{wine.name}</h1>
          <p className="wd-producer">{wine.producer}</p>

          {wine.type && (
            <span className={`wine-type-pill ${wine.type}`}>{wine.type}</span>
          )}

          <div className="wd-details">
            {wine.appellation && (
              <div className="wd-detail">
                <span className="wd-detail-label">Appellation</span>
                <span className="wd-detail-value">{wine.appellation}</span>
              </div>
            )}
            {wine.classification && (
              <div className="wd-detail">
                <span className="wd-detail-label">Classification</span>
                <span className="wd-detail-value">{wine.classification}</span>
              </div>
            )}
            {wine.region?.name && (
              <div className="wd-detail">
                <span className="wd-detail-label">Region</span>
                <span className="wd-detail-value">{wine.region.name}</span>
              </div>
            )}
            {wine.country?.name && (
              <div className="wd-detail">
                <span className="wd-detail-label">Country</span>
                <span className="wd-detail-value">{wine.country.name}</span>
              </div>
            )}
            {grapeNames.length > 0 && (
              <div className="wd-detail">
                <span className="wd-detail-label">Grapes</span>
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
                {wine.communityRating.reviewCount} review{wine.communityRating.reviewCount !== 1 ? 's' : ''}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* CTA banner — subtle promotion for non-authenticated visitors */}
      {!user && (
        <div className="wd-cta">
          <div className="wd-cta-content">
            <h2 className="wd-cta-title">Track your wine collection</h2>
            <p className="wd-cta-text">
              Save this wine to your wishlist, manage your cellar, get drink-window alerts, and more.
            </p>
            <div className="wd-cta-actions">
              <Link to="/login" className="btn btn-primary">Sign up free</Link>
              <Link to="/" className="btn btn-secondary">Learn more</Link>
            </div>
          </div>
        </div>
      )}

      {/* If user is logged in, show action to add to wishlist */}
      {user && (
        <div className="wd-actions">
          <Link to={`/wishlist/add?wine=${wine._id}`} className="btn btn-primary">
            Add to Wishlist
          </Link>
          <Link to="/cellars" className="btn btn-secondary">
            Back to Cellars
          </Link>
        </div>
      )}
    </div>
  );
}
