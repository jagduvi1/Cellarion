import { useState, useEffect } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import SEOHead from '../components/SEOHead';
import Layout from '../components/Layout';
import { useAuth } from '../contexts/AuthContext';
import SITE_URL from '../config/siteUrl';
import { API_URL } from '../api/apiConstants';
import './TaxonomyDetail.css';

export default function GrapeDetail() {
  const { t } = useTranslation();
  // Wrap in Layout for logged-in users so they keep the app navbar
  // (same pattern as WineDetail — these public SEO pages interlink).
  const { user } = useAuth();
  const wrap = (node) => (user ? <Layout>{node}</Layout> : node);
  const { slug } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const page = Math.max(1, parseInt(searchParams.get('page'), 10) || 1);
  const limit = 24;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`${API_URL}/api/taxonomy/grapes/${encodeURIComponent(slug)}?limit=${limit}&offset=${(page - 1) * limit}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(d => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch(() => { if (!cancelled) { setError(true); setLoading(false); } });
    return () => { cancelled = true; };
  }, [slug, page]);

  if (loading) return wrap(<div className="taxonomy-loading">Loading…</div>);
  if (error || !data) return wrap(<div className="taxonomy-error"><p>Grape not found.</p><Link to="/" className="btn btn-secondary">Home</Link></div>);

  const { grape, wines, total } = data;
  const pages = Math.ceil(total / limit);

  const description = grape.description || `Discover wines made from ${grape.name}${grape.origin ? ` originating in ${grape.origin}` : ''}.`;
  const metaDescription = description.replace(/\n/g, ' ').slice(0, 157);

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': ['CollectionPage', 'DefinedTerm'],
        name: `${grape.name} wines`,
        description: metaDescription,
        url: `${SITE_URL}/grapes/${grape.slug}`,
        isPartOf: { '@type': 'WebSite', '@id': `${SITE_URL}/#website` }
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Cellarion', item: SITE_URL },
          { '@type': 'ListItem', position: 2, name: `${grape.name} wines`, item: `${SITE_URL}/grapes/${grape.slug}` }
        ]
      }
    ]
  };

  return wrap(
    <div className="taxonomy-page">
      <SEOHead
        title={`${grape.name} wines — Cellarion`}
        description={metaDescription}
        path={`/grapes/${grape.slug}`}
        jsonLd={jsonLd}
      />

      <div className="taxonomy-header">
        <h1>{grape.name}</h1>
        <p className="taxonomy-subtitle">
          {[grape.color, grape.origin].filter(Boolean).join(' · ')}
        </p>
      </div>

      {grape.description && (
        <p className="taxonomy-description">{grape.description}</p>
      )}

      {grape.characteristics?.length > 0 && (
        <div className="taxonomy-meta-pills">
          {grape.characteristics.map((c, i) => (
            <span key={i} className="taxonomy-pill">{c}</span>
          ))}
        </div>
      )}

      {grape.synonyms?.length > 0 && (
        <p className="taxonomy-description" style={{ fontSize: '0.88rem' }}>
          Also known as: {grape.synonyms.join(', ')}
        </p>
      )}

      {grape.agingPotential && (
        <p className="taxonomy-description" style={{ fontSize: '0.88rem' }}>
          Aging potential: {grape.agingPotential}
        </p>
      )}

      <h2 className="taxonomy-section-title">
        {t('wineDetail.wines')} ({total})
      </h2>

      {wines.length === 0 ? (
        <p className="taxonomy-empty">No wines found.</p>
      ) : (
        <div className="taxonomy-wine-grid">
          {wines.map(wine => (
            <Link key={wine._id} to={`/wines/${wine.slug || wine._id}`} className="taxonomy-wine-card">
              <span className="taxonomy-wine-name">{wine.name}</span>
              <span className="taxonomy-wine-producer">{wine.producer}</span>
              {wine.region?.name && <span className="taxonomy-wine-meta">{wine.region.name}{wine.country?.name ? `, ${wine.country.name}` : ''}</span>}
            </Link>
          ))}
        </div>
      )}

      {pages > 1 && (
        <div className="taxonomy-pagination">
          <button className="btn btn-secondary" disabled={page <= 1} onClick={() => setSearchParams({ page: page - 1 })}>← Prev</button>
          <span className="taxonomy-pagination-info">{page} / {pages}</span>
          <button className="btn btn-secondary" disabled={page >= pages} onClick={() => setSearchParams({ page: page + 1 })}>Next →</button>
        </div>
      )}
    </div>
  );
}
