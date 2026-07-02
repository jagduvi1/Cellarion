import { useState, useEffect } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import SEOHead from '../components/SEOHead';
import Layout from '../components/Layout';
import { useAuth } from '../contexts/AuthContext';
import SITE_URL from '../config/siteUrl';
import { API_URL } from '../api/apiConstants';
import './TaxonomyDetail.css';

export default function RegionDetail() {
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
    fetch(`${API_URL}/api/taxonomy/regions/${encodeURIComponent(slug)}?limit=${limit}&offset=${(page - 1) * limit}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(d => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch(() => { if (!cancelled) { setError(true); setLoading(false); } });
    return () => { cancelled = true; };
  }, [slug, page]);

  if (loading) return wrap(<div className="taxonomy-loading">Loading…</div>);
  if (error || !data) return wrap(<div className="taxonomy-error"><p>Region not found.</p><Link to="/" className="btn btn-secondary">Home</Link></div>);

  const { region, wines, total } = data;
  const pages = Math.ceil(total / limit);

  const description = region.description || `Explore wines from ${region.name}${region.country?.name ? `, ${region.country.name}` : ''} tracked by Cellarion collectors.`;
  const metaDescription = description.replace(/\n/g, ' ').slice(0, 157);

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': ['CollectionPage', 'Place'],
        name: region.name,
        description: metaDescription,
        url: `${SITE_URL}/regions/${region.slug}`,
        isPartOf: { '@type': 'WebSite', '@id': `${SITE_URL}/#website` }
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Cellarion', item: SITE_URL },
          ...(region.country ? [{ '@type': 'ListItem', position: 2, name: region.country.name, item: `${SITE_URL}/countries/${region.country.slug}` }] : []),
          { '@type': 'ListItem', position: region.country ? 3 : 2, name: region.name, item: `${SITE_URL}/regions/${region.slug}` }
        ]
      }
    ]
  };

  return wrap(
    <div className="taxonomy-page">
      <SEOHead
        title={`${region.name} wines — Cellarion`}
        description={metaDescription}
        path={`/regions/${region.slug}`}
        jsonLd={jsonLd}
      />

      <div className="taxonomy-header">
        <h1>{region.name}</h1>
        {region.country?.name && (
          <p className="taxonomy-subtitle">
            <Link to={`/countries/${region.country.slug}`}>{region.country.name}</Link>
            {region.classification ? ` · ${region.classification}` : ''}
          </p>
        )}
      </div>

      {region.description && (
        <p className="taxonomy-description">{region.description}</p>
      )}

      {region.typicalGrapes?.length > 0 && (
        <>
          <h2 className="taxonomy-section-title">Typical grapes</h2>
          <div className="taxonomy-related-list">
            {region.typicalGrapes.map(g => (
              <Link key={g._id} to={`/grapes/${g.slug}`} className="taxonomy-related-chip">
                {g.name}
              </Link>
            ))}
          </div>
        </>
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
              {wine.type && <span className="taxonomy-wine-meta">{wine.type.charAt(0).toUpperCase() + wine.type.slice(1)}</span>}
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
