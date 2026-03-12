import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';
import './LandingPage.css';

const LOGO_LIGHT = process.env.PUBLIC_URL + '/cellarion-logo-light.png';
const LOGO_DARK  = process.env.PUBLIC_URL + '/cellarion-logo-dark.png';

const features = [
  {
    icon: '🍷',
    title: 'Bottle Tracking',
    desc: 'Log every bottle in your collection — vintage, producer, region, price, personal rating, and tasting notes, all in one place.',
  },
  {
    icon: '🗄️',
    title: 'Cellar & Rack Management',
    desc: 'Organize bottles across multiple cellars and visualize your physical racks on an interactive grid. Know exactly where each bottle lives.',
  },
  {
    icon: '⏰',
    title: 'Drink Window Alerts',
    desc: 'Get notified when a bottle is approaching its peak or past it. Never open a great wine too early — or too late.',
  },
  {
    icon: '📊',
    title: 'Rich Statistics',
    desc: 'Explore your cellar with charts and maps — breakdown by country, grape, value, drink status, and more.',
  },
  {
    icon: '🔍',
    title: 'Smart Wine Search',
    desc: 'Powered by Meilisearch with fuzzy matching and deduplication so you always find the right wine, even with a typo.',
  },
  {
    icon: '🤝',
    title: 'Share Your Cellar',
    desc: 'Invite friends or colleagues to browse or co-manage a cellar. Granular role-based access keeps you in control.',
  },
  {
    icon: '📷',
    title: 'Label Scanning',
    desc: 'Snap a photo of the label and let AI fill in the details. Background removal keeps bottle images clean and beautiful.',
  },
  {
    icon: '📥',
    title: 'Import & Export',
    desc: 'Bring your existing collection in via CSV. A structured wine registry shared across users ensures clean, consistent data.',
  },
];

export default function LandingPage() {
  const { user } = useAuth();
  const { theme } = useTheme();
  const [contactEmail, setContactEmail] = useState(null);

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.contactEmail) setContactEmail(d.contactEmail); })
      .catch(() => {});
  }, []);

  return (
    <div className="landing">
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
              My Cellar →
            </Link>
          ) : (
            <Link to="/login" className="btn-landing-primary">
              Sign In
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
            Your wine cellar,<br />
            <span className="landing-headline-accent">beautifully organised.</span>
          </h1>
          <p className="landing-subline">
            Cellarion is a self-hosted, open-source wine cellar manager.
            Track bottles, visualise racks, get drink-window alerts, and share cellars —
            all from a clean, private interface you own.
          </p>
          <div className="landing-cta-group">
            {user ? (
              <Link to="/cellars" className="btn-landing-primary btn-landing-large">
                Go to My Cellar
              </Link>
            ) : (
              <>
                <Link to="/login" className="btn-landing-primary btn-landing-large">
                  Get Started — it&apos;s free
                </Link>
                <a
                  href="https://github.com/jagduvi1/Cellarion"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-landing-ghost btn-landing-large"
                >
                  ★ Star on GitHub
                </a>
              </>
            )}
          </div>
          <p className="landing-hosted-note">
            Hosted at{' '}
            <a href="https://cellarion.app" className="landing-link">
              cellarion.app
            </a>{' '}
            · or self-host in minutes with Docker
          </p>
        </div>
      </section>

      {/* ── Features ── */}
      <section className="landing-features">
        <div className="landing-section-inner">
          <h2 className="landing-section-title">Everything your cellar needs</h2>
          <p className="landing-section-sub">
            From a single bottle to a thousand, Cellarion keeps your collection organised and drinkable.
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
          <div className="landing-oss-badge">Open Source</div>
          <h2 className="landing-oss-title">Built in the open, owned by you</h2>
          <p className="landing-oss-body">
            Cellarion is released under the <strong>AGPL-3.0</strong> license.
            The full source code is on GitHub — audit it, fork it, self-host it.
            No vendor lock-in, no subscription required, no data sent to third parties.
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
            View source on GitHub →
          </a>
        </div>
      </section>

      {/* ── Final CTA ── */}
      <section className="landing-final-cta">
        <div className="landing-section-inner landing-final-inner">
          <img src={theme === 'dark' ? LOGO_DARK : LOGO_LIGHT} alt="Cellarion" className="landing-final-logo-img" />
          <h2 className="landing-final-title">Start managing your cellar today</h2>
          <p className="landing-final-sub">
            Free to use at cellarion.app, or deploy your own instance in minutes.
          </p>
          {user ? (
            <Link to="/cellars" className="btn-landing-primary btn-landing-large">
              Open My Cellar
            </Link>
          ) : (
            <Link to="/login" className="btn-landing-primary btn-landing-large">
              Create a free account
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
              AGPL-3.0
            </a>
            {contactEmail && (
              <a href={`mailto:${contactEmail}`}>{contactEmail}</a>
            )}
            <Link to="/login">Login</Link>
          </div>
          <span className="landing-footer-copy">
            © {new Date().getFullYear()} Cellarion contributors
          </span>
        </div>
      </footer>
    </div>
  );
}
