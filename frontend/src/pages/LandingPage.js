import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Helmet } from 'react-helmet-async';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';
import SITE_URL from '../config/siteUrl';
import './LandingPage.css';

const LOGO_LIGHT = process.env.PUBLIC_URL + '/cellarion-logo-light.png';
const LOGO_DARK  = process.env.PUBLIC_URL + '/cellarion-logo-dark.png';

export default function LandingPage() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const { theme } = useTheme();
  const [contactEmail, setContactEmail] = useState(null);

  const features = [
    { icon: '🍷', title: t('landing.featureBottleTitle'), desc: t('landing.featureBottleDesc') },
    { icon: '🗄️', title: t('landing.featureCellarTitle'), desc: t('landing.featureCellarDesc') },
    { icon: '⏰', title: t('landing.featureDrinkTitle'), desc: t('landing.featureDrinkDesc') },
    { icon: '📊', title: t('landing.featureStatsTitle'), desc: t('landing.featureStatsDesc') },
    { icon: '🔍', title: t('landing.featureSearchTitle'), desc: t('landing.featureSearchDesc') },
    { icon: '🤝', title: t('landing.featureShareTitle'), desc: t('landing.featureShareDesc') },
    { icon: '📷', title: t('landing.featureLabelTitle'), desc: t('landing.featureLabelDesc') },
    { icon: '📥', title: t('landing.featureImportTitle'), desc: t('landing.featureImportDesc') },
  ];

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.contactEmail) setContactEmail(d.contactEmail); })
      .catch(() => {});
  }, []);

  const lang = i18n.language?.startsWith('sv') ? 'sv' : 'en';
  const altLang = lang === 'sv' ? 'en' : 'sv';

  // WebSite + Organization JSON-LD
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        '@id': `${SITE_URL}/#website`,
        url: SITE_URL,
        name: 'Cellarion',
        description: t('landing.metaDescription'),
        inLanguage: [lang, altLang],
      },
      {
        '@type': 'Organization',
        '@id': `${SITE_URL}/#organization`,
        name: 'Cellarion',
        url: SITE_URL,
        logo: `${SITE_URL}/cellarion-logo.jpg`,
        sameAs: ['https://github.com/jagduvi1/Cellarion'],
      },
      {
        '@type': 'SoftwareApplication',
        '@id': `${SITE_URL}/#app`,
        name: 'Cellarion',
        description: t('landing.metaDescription'),
        applicationCategory: 'LifestyleApplication',
        operatingSystem: 'Web',
        url: SITE_URL,
        offers: {
          '@type': 'Offer',
          price: '0',
          priceCurrency: 'USD'
        }
      }
    ]
  };

  return (
    <div className="landing">
      <Helmet>
        <html lang={lang} />
        <title>Cellarion — Track & Manage Your Wine Collection | Free Open-Source Wine Cellar App</title>
        <meta name="description" content={t('landing.metaDescription')} />
        <meta property="og:type" content="website" />
        <meta property="og:title" content="Cellarion — Track & Manage Your Wine Collection" />
        <meta property="og:description" content={t('landing.metaDescription')} />
        <meta property="og:url" content={SITE_URL} />
        <meta property="og:image" content={`${SITE_URL}/cellarion-logo.jpg`} />
        <meta property="og:site_name" content="Cellarion" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="Cellarion — Track & Manage Your Wine Collection" />
        <meta name="twitter:description" content={t('landing.metaDescription')} />
        <meta name="twitter:image" content={`${SITE_URL}/cellarion-logo.jpg`} />
        <link rel="canonical" href={SITE_URL} />
        <link rel="alternate" hrefLang="en" href={SITE_URL} />
        <link rel="alternate" hrefLang="sv" href={SITE_URL} />
        <link rel="alternate" hrefLang="x-default" href={SITE_URL} />
        <script type="application/ld+json">{JSON.stringify(jsonLd)}</script>
      </Helmet>

      {/* ── Nav ── */}
      <nav className="landing-nav">
        <div className="landing-nav-brand">
          <img src={theme === 'dark' ? LOGO_DARK : LOGO_LIGHT} alt="Cellarion" className="landing-nav-logo-img" />
        </div>
        <div className="landing-nav-actions">
          <a
            href="https://github.com/jagduvi1/Cellarion"
            target="_blank"
            rel="noopener noreferrer"
            className="landing-nav-link"
          >
            GitHub
          </a>
          {user ? (
            <Link to="/cellars" className="btn-landing-primary">
              {t('landing.myCellar')} →
            </Link>
          ) : (
            <Link to="/login" className="btn-landing-primary">
              {t('landing.signIn')}
            </Link>
          )}
        </div>
      </nav>

      {/* ── Hero ── */}
      <section className="landing-hero">
        <div className="landing-hero-glow" aria-hidden="true" />
        <div className="landing-hero-content">
          <div className="landing-logo-wrap">
            <img src={theme === 'dark' ? LOGO_DARK : LOGO_LIGHT} alt="Cellarion" className="landing-hero-logo-img" />
          </div>
          <h1 className="landing-headline">
            {t('landing.heroHeadline')}<br />
            <span className="landing-headline-accent">{t('landing.heroAccent')}</span>
          </h1>
          <p className="landing-subline">
            {t('landing.heroSubline')}
          </p>
          <div className="landing-cta-group">
            {user ? (
              <Link to="/cellars" className="btn-landing-primary btn-landing-large">
                {t('landing.goToCellar')}
              </Link>
            ) : (
              <>
                <Link to="/login" className="btn-landing-primary btn-landing-large">
                  {t('landing.getStarted')}
                </Link>
                <a
                  href="https://github.com/jagduvi1/Cellarion"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-landing-ghost btn-landing-large"
                >
                  ★ {t('landing.starOnGithub')}
                </a>
              </>
            )}
          </div>
          <p className="landing-hosted-note">
            {t('landing.hostedAt')}{' '}
            <a href="https://cellarion.app" className="landing-link">
              cellarion.app
            </a>{' '}
            · {t('landing.selfHost')}
          </p>
        </div>
      </section>

      {/* ── What is Cellarion — AI-extractable definition block ── */}
      <section className="landing-about">
        <div className="landing-section-inner">
          <h2 className="landing-section-title">{t('landing.aboutTitle')}</h2>
          <p className="landing-about-text">
            {t('landing.aboutText')}
          </p>
        </div>
      </section>

      {/* ── Features ── */}
      <section className="landing-features">
        <div className="landing-section-inner">
          <h2 className="landing-section-title">{t('landing.featuresTitle')}</h2>
          <p className="landing-section-sub">
            {t('landing.featuresSub')}
          </p>
          <div className="landing-features-grid">
            {features.map((f) => (
              <div key={f.title} className="landing-feature-card">
                <span className="landing-feature-icon">{f.icon}</span>
                <h3 className="landing-feature-title">{f.title}</h3>
                <p className="landing-feature-desc">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Open source banner ── */}
      <section className="landing-oss">
        <div className="landing-section-inner landing-oss-inner">
          <div className="landing-oss-badge">{t('landing.ossBadge')}</div>
          <h2 className="landing-oss-title">{t('landing.ossTitle')}</h2>
          <p className="landing-oss-body">
            {t('landing.ossBody')}
          </p>
          <div className="landing-oss-pills">
            <span className="landing-pill">AGPL-3.0</span>
            <span className="landing-pill">Self-hostable</span>
            <span className="landing-pill">Docker Compose</span>
            <span className="landing-pill">MongoDB</span>
            <span className="landing-pill">React 19</span>
            <span className="landing-pill">Node.js 20</span>
            <span className="landing-pill">Meilisearch</span>
          </div>
          <a
            href="https://github.com/jagduvi1/Cellarion"
            target="_blank"
            rel="noopener noreferrer"
            className="btn-landing-primary"
          >
            {t('landing.ossViewSource')} →
          </a>
        </div>
      </section>

      {/* ── Final CTA ── */}
      <section className="landing-final-cta">
        <div className="landing-section-inner landing-final-inner">
          <img src={theme === 'dark' ? LOGO_DARK : LOGO_LIGHT} alt="Cellarion" className="landing-final-logo-img" />
          <h2 className="landing-final-title">{t('landing.finalTitle')}</h2>
          <p className="landing-final-sub">
            {t('landing.finalSub')}
          </p>
          {user ? (
            <Link to="/cellars" className="btn-landing-primary btn-landing-large">
              {t('landing.openCellar')}
            </Link>
          ) : (
            <Link to="/login" className="btn-landing-primary btn-landing-large">
              {t('landing.createAccount')}
            </Link>
          )}
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="landing-footer">
        <div className="landing-footer-inner">
          <span className="landing-footer-brand">
            <img src={theme === 'dark' ? LOGO_DARK : LOGO_LIGHT} alt="" className="landing-footer-logo-img" /> Cellarion
          </span>
          <div className="landing-footer-links">
            <a
              href="https://github.com/jagduvi1/Cellarion"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub
            </a>
            <a
              href="https://github.com/jagduvi1/Cellarion/blob/main/LICENSE"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('landing.footerLicense')}
            </a>
            {contactEmail && (
              <a href={`mailto:${contactEmail}`}>{contactEmail}</a>
            )}
            <Link to="/login">Login</Link>
          </div>
          <span className="landing-footer-copy">
            © {new Date().getFullYear()} {t('landing.footerContributors')}
          </span>
        </div>
      </footer>
    </div>
  );
}
