import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';
import SEOHead from '../components/SEOHead';
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

  const whyPoints = [
    { icon: '🎁', title: t('landing.whyFreeTitle'), desc: t('landing.whyFreeDesc') },
    { icon: '📤', title: t('landing.whyExportTitle'), desc: t('landing.whyExportDesc') },
    { icon: '🔒', title: t('landing.whyPrivacyTitle'), desc: t('landing.whyPrivacyDesc') },
    { icon: '🇪🇺', title: t('landing.whyGdprTitle'), desc: t('landing.whyGdprDesc') },
  ];

  // Visible Q&A on the page MUST match the FAQPage JSON-LD verbatim — Google penalises
  // schema-only Q&A that doesn't appear on the page.
  const faqs = [
    { q: t('landing.faq.q1'), a: t('landing.faq.a1') },
    { q: t('landing.faq.q2'), a: t('landing.faq.a2') },
    { q: t('landing.faq.q3'), a: t('landing.faq.a3') },
    { q: t('landing.faq.q4'), a: t('landing.faq.a4') },
    { q: t('landing.faq.q5'), a: t('landing.faq.a5') },
    { q: t('landing.faq.q6'), a: t('landing.faq.a6') },
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
      },
      {
        '@type': 'FAQPage',
        '@id': `${SITE_URL}/#faq`,
        mainEntity: faqs.map(({ q, a }) => ({
          '@type': 'Question',
          name: q,
          acceptedAnswer: { '@type': 'Answer', text: a }
        }))
      }
    ]
  };

  return (
    <div className="landing">
      <SEOHead
        title={t('landing.metaTitle')}
        description={t('landing.metaDescription')}
        path="/"
        language={lang}
        jsonLd={jsonLd}
      />

      {/* ── Nav ── */}
      <nav className="landing-nav">
        <div className="landing-nav-brand">
          <img src={theme === 'dark' ? LOGO_DARK : LOGO_LIGHT} alt="Cellarion" className="landing-nav-logo-img" />
        </div>
        <div className="landing-nav-actions">
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
              <Link to="/login" className="btn-landing-primary btn-landing-large">
                {t('landing.getStarted')}
              </Link>
            )}
          </div>
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

      {/* ── Why Cellarion ── */}
      <section className="landing-why">
        <div className="landing-section-inner">
          <h2 className="landing-section-title">{t('landing.whyTitle')}</h2>
          <p className="landing-section-sub">{t('landing.whySub')}</p>
          <div className="landing-features-grid">
            {whyPoints.map((p) => (
              <div key={p.title} className="landing-feature-card">
                <span className="landing-feature-icon">{p.icon}</span>
                <h3 className="landing-feature-title">{p.title}</h3>
                <p className="landing-feature-desc">{p.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── FAQ ── */}
      <section className="landing-faq">
        <div className="landing-section-inner">
          <h2 className="landing-section-title">{t('landing.faqTitle')}</h2>
          <p className="landing-section-sub">{t('landing.faqSub')}</p>
          <div className="landing-faq-list">
            {faqs.map(({ q, a }, i) => (
              <details key={i} className="landing-faq-item">
                <summary className="landing-faq-question">{q}</summary>
                <p className="landing-faq-answer">{a}</p>
              </details>
            ))}
          </div>
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
            <Link to="/privacy">Privacy</Link>
            {contactEmail && (
              <a href={`mailto:${contactEmail}`}>{contactEmail}</a>
            )}
            <Link to="/login">Login</Link>
            <a
              href="https://github.com/jagduvi1/Cellarion"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('landing.footerSourceLink')}
            </a>
          </div>
          <span className="landing-footer-copy">
            © {new Date().getFullYear()} {t('landing.footerCopy')}
          </span>
        </div>
      </footer>
    </div>
  );
}
