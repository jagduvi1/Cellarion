import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Helmet } from 'react-helmet-async';
import { getHelpContent } from '../api/help';
import SITE_URL from '../config/siteUrl';
import './Help.css';

const SECTION_KEYS = [
  'cellars', 'bottles', 'labelScan', 'sharing', 'racks', 'roomView',
  'wishlist', 'restock', 'journal', 'recommendations', 'cellarChat',
  'analytics', 'community', 'wineRequests', 'import', 'settings',
  'history', 'other',
];

function Help() {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [openSection, setOpenSection] = useState(null);
  const [routes, setRoutes] = useState({});

  // Fetch route mappings from backend (for "Go to" links)
  useEffect(() => {
    getHelpContent()
      .then(data => {
        const map = {};
        for (const s of data.sections) map[s.id] = s.route;
        setRoutes(map);
      })
      .catch(() => {});
  }, []);

  const sections = useMemo(() => SECTION_KEYS.map(key => {
    const prefix = `help.sections.${key}`;
    const title = t(`${prefix}.title`);
    const summary = t(`${prefix}.summary`);

    // Collect detail bullets (d1, d2, d3, ...)
    const details = [];
    for (let i = 1; i <= 10; i++) {
      const val = t(`${prefix}.d${i}`, { defaultValue: '' });
      if (val) details.push(val);
      else break;
    }

    return { key, title, summary, details, route: routes[key] || null };
  }), [t, routes]);

  const filtered = search.trim()
    ? sections.filter(s => {
        const q = search.toLowerCase();
        return (
          s.title.toLowerCase().includes(q) ||
          s.summary.toLowerCase().includes(q) ||
          s.details.some(d => d.toLowerCase().includes(q))
        );
      })
    : sections;

  const toggleSection = (key) => {
    setOpenSection(prev => prev === key ? null : key);
  };

  // FAQPage JSON-LD — uses the first 10 sections as Q&A pairs
  const faqJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: filtered.slice(0, 10).map(s => ({
      '@type': 'Question',
      name: s.title,
      acceptedAnswer: {
        '@type': 'Answer',
        text: s.details.length > 0 ? s.details.join(' ') : s.summary,
      }
    }))
  };

  return (
    <div className="help-page">
      <Helmet>
        <title>{t('help.title')} — Cellarion</title>
        <meta name="description" content={t('help.subtitle')} />
        <meta property="og:type" content="website" />
        <meta property="og:title" content={`${t('help.title')} — Cellarion`} />
        <meta property="og:description" content={t('help.subtitle')} />
        <meta property="og:url" content={`${SITE_URL}/help`} />
        <link rel="canonical" href={`${SITE_URL}/help`} />
        <link rel="alternate" hrefLang="en" href={`${SITE_URL}/help`} />
        <link rel="alternate" hrefLang="sv" href={`${SITE_URL}/help`} />
        <link rel="alternate" hrefLang="x-default" href={`${SITE_URL}/help`} />
        <script type="application/ld+json">{JSON.stringify(faqJsonLd)}</script>
      </Helmet>
      <div className="help-container">
        <div className="help-header">
          <h1>{t('help.title')}</h1>
          <p className="help-subtitle">{t('help.subtitle')}</p>
          <input
            className="help-search"
            type="text"
            placeholder={t('help.searchPlaceholder')}
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        <div className="help-sections">
          {filtered.length === 0 && (
            <p className="help-no-results">{t('help.noResults')}</p>
          )}

          {filtered.map(section => {
            const isOpen = openSection === section.key || search.trim().length > 0;

            return (
              <div key={section.key} className={`help-section ${isOpen ? 'help-section--open' : ''}`}>
                <button
                  className="help-section-header"
                  onClick={() => toggleSection(section.key)}
                  aria-expanded={isOpen}
                >
                  <div className="help-section-header-text">
                    <h2>{section.title}</h2>
                    <p>{section.summary}</p>
                  </div>
                  <svg
                    className="help-section-chevron"
                    width="20" height="20" viewBox="0 0 24 24"
                    fill="none" stroke="currentColor" strokeWidth="2"
                    strokeLinecap="round" strokeLinejoin="round"
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>

                {isOpen && (
                  <div className="help-section-body">
                    <ul>
                      {section.details.map((detail, i) => (
                        <li key={i}>{detail}</li>
                      ))}
                    </ul>
                    {section.route && (
                      <a href={section.route} className="help-section-link">
                        {t('help.goTo', { name: section.title })} &rarr;
                      </a>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default Help;
