import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router-dom';
import { getHelpContent } from '../api/help';
import SEOHead from '../components/SEOHead';
import SITE_URL from '../config/siteUrl';
import { useFeature, useFeatureFlags } from '../utils/featureFlags';
import scrollBelowNavbar from '../utils/scrollBelowNavbar';
import { SECTION_KEYS, sectionKeyFor } from '../utils/helpSections';
import './Help.css';

function sectionKeyForHash(hash) {
  try {
    return sectionKeyFor(decodeURIComponent((hash || '').slice(1)));
  } catch {
    return null; // a malformed escape in the address
  }
}

function Help() {
  const { t } = useTranslation();
  const { hash } = useLocation();
  const linked = sectionKeyForHash(hash);
  const [search, setSearch] = useState('');
  const [openSection, setOpenSection] = useState(linked);
  const [routes, setRoutes] = useState({});
  // Pick lists follow their flag, which changes without a deploy (SuperAdmin
  // → Feature flags): in beta the section says it is early access and how to
  // turn that on; out for everyone it is an ordinary section; switched off
  // it is not shown. Its page is offered to the members who see it in the
  // menu.
  const pickListsOn = useFeature('pickLists');
  const pickListsState = useFeatureFlags().find(f => f.key === 'pickLists')?.state || 'off';

  // Fetch route mappings from backend (for "Go to" links)
  useEffect(() => {
    getHelpContent()
      .then(data => {
        const map = {};
        for (const s of data.sections) {
          const key = sectionKeyFor(s.id);
          if (key && s.route) map[key] = s.route;
        }
        setRoutes(map);
      })
      .catch(() => {});
  }, []);

  // /help#<section>: open that section and bring it into view — on arrival,
  // and again when a link inside the app changes the hash. A search would
  // hide the section, so it is cleared.
  useEffect(() => {
    if (!linked) return;
    setSearch('');
    setOpenSection(linked);
    requestAnimationFrame(() => scrollBelowNavbar(document.getElementById(linked)));
  }, [linked, hash]);

  const sections = useMemo(() => SECTION_KEYS.filter(key => key !== 'pickLists' || pickListsState !== 'off').map(key => {
    const prefix = `help.sections.${key}`;
    const name = t(`${prefix}.title`);
    const early = key === 'pickLists' && pickListsState === 'beta';
    const title = early ? t(`${prefix}.earlyTitle`) : name;
    const summary = t(`${prefix}.summary`);

    // Collect detail bullets (d1, d2, d3, ...)
    const details = early ? [t(`${prefix}.earlyNote`)] : [];
    for (let i = 1; i <= 10; i++) {
      const val = t(`${prefix}.d${i}`, { defaultValue: '' });
      if (val) details.push(val);
      else break;
    }

    // "Go to …" takes its page from the server's help content (/api/help,
    // backend/src/data/helpContent.js); pick lists' only for members who have
    // them (the server gives them none).
    const route = routes[key] || (key === 'pickLists' && pickListsOn ? '/pick-lists' : null);
    return { key, name, title, summary, details, route };
  }), [t, routes, pickListsOn, pickListsState]);

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

  // FAQPage + BreadcrumbList JSON-LD. Uses @graph so a single <script> tag
  // emits both entities, which is what Google's Rich Results Test prefers.
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'FAQPage',
        mainEntity: filtered.slice(0, 10).map(s => ({
          '@type': 'Question',
          name: s.title,
          acceptedAnswer: {
            '@type': 'Answer',
            text: s.details.length > 0 ? s.details.join(' ') : s.summary,
          }
        }))
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Cellarion', item: SITE_URL },
          { '@type': 'ListItem', position: 2, name: t('help.title'), item: `${SITE_URL}/help` }
        ]
      }
    ]
  };

  return (
    <div className="help-page">
      <SEOHead
        title={`${t('help.title')} — Cellarion`}
        description={t('help.subtitle')}
        path="/help"
        jsonLd={jsonLd}
      />
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
              <div key={section.key} id={section.key} className={`help-section ${isOpen ? 'help-section--open' : ''}`}>
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
                    {/* In-app navigation: a full page load would fetch the
                        app again (and fail offline, which one section is
                        about). Settings opens a group from the hash. */}
                    {section.route && (
                      <Link to={section.route} className="help-section-link">
                        {t('help.goTo', { name: section.name })} &rarr;
                      </Link>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <p className="help-connect-ai">
          <Link to="/connect-ai">{t('help.connectAiLink')} &rarr;</Link>
        </p>
      </div>
    </div>
  );
}

export default Help;
