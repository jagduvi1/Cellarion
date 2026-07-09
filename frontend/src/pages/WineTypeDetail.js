import { useState, useEffect } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import SEOHead from '../components/SEOHead';
import Layout from '../components/Layout';
import { useAuth } from '../contexts/AuthContext';
import SITE_URL from '../config/siteUrl';
import { API_URL } from '../api/apiConstants';
import './TaxonomyDetail.css';

const TYPE_DESCRIPTIONS = {
  red: 'Red wines are made from dark-skinned grape varieties. They range from light and fruity to bold and tannic, and are generally better suited to cellaring than whites.',
  white: 'White wines are produced from green or yellow grapes, or from dark grapes with minimal skin contact. Styles range from crisp and mineral to rich and oaky.',
  rosé: 'Rosé wines are made with brief skin contact from red grapes, producing their characteristic pink colour. Most are dry and designed to be consumed young.',
  sparkling: 'Sparkling wines contain significant levels of carbon dioxide, making them effervescent. The finest examples undergo secondary fermentation in the bottle.',
  dessert: 'Dessert wines are sweet wines typically served with or as dessert. They are made by various methods including late harvest, botrytis, ice wine, and fortification.',
  fortified: 'Fortified wines have a distilled spirit — usually grape brandy — added during or after fermentation. Examples include Port, Sherry, Madeira, and Marsala.',
};

export default function WineTypeDetail() {
  const { t } = useTranslation();
  // Wrap in Layout for logged-in users so they keep the app navbar
  // (same pattern as WineDetail — these public SEO pages interlink).
  const { user } = useAuth();
  const wrap = (node) => (user ? <Layout>{node}</Layout> : node);
  const { type } = useParams();
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
    fetch(`${API_URL}/api/taxonomy/wine-types/${encodeURIComponent(type)}?limit=${limit}&offset=${(page - 1) * limit}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(d => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch(() => { if (!cancelled) { setError(true); setLoading(false); } });
    return () => { cancelled = true; };
  }, [type, page]);

  if (loading) return wrap(<div className="taxonomy-loading">{t('taxonomy.loading')}</div>);
  if (error || !data) return wrap(<div className="taxonomy-error"><p>{t('taxonomy.wineTypeNotFound')}</p><Link to="/" className="btn btn-secondary">{t('taxonomy.home')}</Link></div>);

  const { wines, total } = data;
  const pages = Math.ceil(total / limit);
  const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);
  const description = TYPE_DESCRIPTIONS[type] || `Explore ${typeLabel} wines tracked by Cellarion collectors.`;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'CollectionPage',
        name: `${typeLabel} wines`,
        description: description.slice(0, 157),
        url: `${SITE_URL}/wines/type/${type}`,
        isPartOf: { '@type': 'WebSite', '@id': `${SITE_URL}/#website` }
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Cellarion', item: SITE_URL },
          { '@type': 'ListItem', position: 2, name: `${typeLabel} wines`, item: `${SITE_URL}/wines/type/${type}` }
        ]
      }
    ]
  };

  return wrap(
    <div className="taxonomy-page">
      <SEOHead
        title={`${typeLabel} wines — Cellarion`}
        description={description.slice(0, 157)}
        path={`/wines/type/${type}`}
        jsonLd={jsonLd}
      />

      <div className="taxonomy-header">
        <h1>{typeLabel} wines</h1>
      </div>

      <p className="taxonomy-description">{description}</p>

      <h2 className="taxonomy-section-title">
        {t('wineDetail.wines')} ({total})
      </h2>

      {wines.length === 0 ? (
        <p className="taxonomy-empty">{t('taxonomy.noWines')}</p>
      ) : (
        <div className="taxonomy-wine-grid">
          {wines.map(wine => (
            <Link key={wine._id} to={`/wines/${wine.slug || wine._id}`} className="taxonomy-wine-card">
              <span className="taxonomy-wine-name">{wine.name}</span>
              <span className="taxonomy-wine-producer">{wine.producer}</span>
              {(wine.region?.name || wine.country?.name) && (
                <span className="taxonomy-wine-meta">{[wine.region?.name, wine.country?.name].filter(Boolean).join(', ')}</span>
              )}
            </Link>
          ))}
        </div>
      )}

      {pages > 1 && (
        <div className="taxonomy-pagination">
          <button className="btn btn-secondary" disabled={page <= 1} onClick={() => setSearchParams({ page: page - 1 })}>{t('taxonomy.prev')}</button>
          <span className="taxonomy-pagination-info">{page} / {pages}</span>
          <button className="btn btn-secondary" disabled={page >= pages} onClick={() => setSearchParams({ page: page + 1 })}>{t('taxonomy.next')}</button>
        </div>
      )}
    </div>
  );
}
