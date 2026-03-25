import { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';
import { PLANS } from '../config/plans';
import NotificationBell from './NotificationBell';
import SupportModal from './SupportModal';
import InstallPrompt from './InstallPrompt';
import './Layout.css';

const LOGO_LIGHT_WEBP = process.env.PUBLIC_URL + '/cellarion-logo-light.webp';
const LOGO_DARK_WEBP  = process.env.PUBLIC_URL + '/cellarion-logo-dark.webp';
const LOGO_LIGHT_PNG  = process.env.PUBLIC_URL + '/cellarion-logo-light.png';
const LOGO_DARK_PNG   = process.env.PUBLIC_URL + '/cellarion-logo-dark.png';

function Layout({ children }) {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [supportOpen, setSupportOpen] = useState(false);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const isActive = (path) => {
    return location.pathname === path || location.pathname.startsWith(path + '/');
  };

  const closeMenu = () => setMobileMenuOpen(false);

  const planLabel = user ? (PLANS[user.plan]?.label || user.plan || 'Free') : null;
  const roles = user?.roles || [];

  return (
    <div className="layout">
      <InstallPrompt />
      {/* ── Top navbar ── */}
      <nav className="navbar">
        <div className="navbar-inner">
          <div className="navbar-brand">
            <Link to="/" onClick={closeMenu} className="brand-link">
              <picture>
                <source srcSet={theme === 'dark' ? LOGO_DARK_WEBP : LOGO_LIGHT_WEBP} type="image/webp" />
                <img src={theme === 'dark' ? LOGO_DARK_PNG : LOGO_LIGHT_PNG} alt="Cellarion" className="brand-logo-img" width="159" height="128" fetchPriority="high" />
              </picture>
            </Link>
          </div>

          {user && (
            <>
              {/* Desktop navigation links */}
              <div className="navbar-links">
                <Link
                  to="/cellars"
                  className={`nav-link ${isActive('/cellars') ? 'active' : ''}`}
                >
                  {t('nav.myCellars')}
                </Link>
                <Link
                  to="/statistics"
                  className={`nav-link ${isActive('/statistics') ? 'active' : ''}`}
                >
                  Analytics
                  {user.plan !== 'premium' && (
                    <span className="nav-premium-star" aria-hidden="true">★</span>
                  )}
                </Link>
                <Link
                  to="/wishlist"
                  className={`nav-link ${isActive('/wishlist') ? 'active' : ''}`}
                >
                  Wishlist
                </Link>
                <Link
                  to="/recommendations"
                  className={`nav-link ${isActive('/recommendations') ? 'active' : ''}`}
                >
                  Recommendations
                </Link>
                <Link
                  to="/journal"
                  className={`nav-link ${isActive('/journal') ? 'active' : ''}`}
                >
                  Journal
                </Link>
                <Link
                  to="/wine-requests"
                  className={`nav-link ${isActive('/wine-requests') ? 'active' : ''}`}
                >
                  {t('nav.myRequests')}
                </Link>
                <Link
                  to="/community"
                  className={`nav-link ${isActive('/community') ? 'active' : ''}`}
                >
                  Community
                </Link>
                <Link
                  to="/cellar-chat"
                  className={`nav-link ${isActive('/cellar-chat') ? 'active' : ''}`}
                >
                  Cellar Chat
                </Link>
                <Link
                  to="/blog"
                  className={`nav-link ${isActive('/blog') ? 'active' : ''}`}
                >
                  {t('nav.blog')}
                </Link>
                <Link
                  to="/plans"
                  className={`nav-link ${isActive('/plans') ? 'active' : ''}`}
                >
                  {t('nav.plans')}
                </Link>
                <Link
                  to="/support"
                  className={`nav-link ${isActive('/support') ? 'active' : ''}`}
                >
                  Support
                </Link>

                {(roles.includes('somm') || roles.includes('admin')) && (
                  <>
                    <div className="navbar-divider" />
                    <Link
                      to="/somm/maturity"
                      className={`nav-link nav-link--somm ${isActive('/somm/maturity') ? 'active' : ''}`}
                    >
                      {t('nav.maturityQueue')}
                    </Link>
                    <Link
                      to="/somm/prices"
                      className={`nav-link nav-link--somm ${isActive('/somm/prices') ? 'active' : ''}`}
                    >
                      {t('nav.priceQueue')}
                    </Link>
                  </>
                )}

                {user.isSuperAdmin && (
                  <>
                    <div className="navbar-divider" />
                    <Link
                      to="/superadmin"
                      className={`nav-link nav-link--admin ${isActive('/superadmin') ? 'active' : ''}`}
                      title="System Monitor"
                    >
                      System Monitor
                    </Link>
                  </>
                )}

                {roles.includes('admin') && (
                  <>
                    <div className="navbar-divider" />
                    <Link to="/admin/wines" className={`nav-link nav-link--admin ${isActive('/admin/wines') ? 'active' : ''}`}>{t('nav.wineLibrary')}</Link>
                    <Link to="/admin/requests" className={`nav-link nav-link--admin ${isActive('/admin/requests') ? 'active' : ''}`}>{t('nav.adminRequests')}</Link>
                    <Link to="/admin/taxonomy" className={`nav-link nav-link--admin ${isActive('/admin/taxonomy') ? 'active' : ''}`}>{t('nav.taxonomy')}</Link>
                    <Link to="/admin/images" className={`nav-link nav-link--admin ${isActive('/admin/images') ? 'active' : ''}`}>{t('nav.imageReview')}</Link>
                    <Link to="/admin/support" className={`nav-link nav-link--admin ${isActive('/admin/support') ? 'active' : ''}`}>Support Tickets</Link>
                    <Link to="/admin/wine-reports" className={`nav-link nav-link--admin ${isActive('/admin/wine-reports') ? 'active' : ''}`}>Wine Reports</Link>
                    <Link to="/admin/blog" className={`nav-link nav-link--admin ${isActive('/admin/blog') ? 'active' : ''}`}>{t('nav.blogAdmin')}</Link>
                  </>
                )}
              </div>

              {/* Desktop right section */}
              <div className="navbar-right">
                <button
                  className="theme-toggle"
                  onClick={toggleTheme}
                  aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
                  title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
                >
                  {theme === 'light' ? (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
                  )}
                </button>
                <NotificationBell />
                <span className="user-info">
                  {user.username}
                  {roles.includes('admin') && <span className="badge badge--admin">{t('nav.badge.admin')}</span>}
                  {roles.includes('somm')  && <span className="badge badge--somm">{t('nav.badge.somm')}</span>}
                  {roles.includes('moderator') && <span className="badge badge--mod">Mod</span>}
                  <span className={`badge badge--plan badge--plan-${user.plan || 'free'}`}>{planLabel}</span>
                </span>
                <Link to="/settings" className={`btn-icon-nav ${isActive('/settings') ? 'active' : ''}`} aria-label={t('nav.settings')}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                </Link>
                <button onClick={handleLogout} className="btn-logout">
                  {t('nav.logout')}
                </button>
              </div>

              {/* Mobile hamburger (for admin/extra links) */}
              <button
                className="hamburger"
                onClick={() => setMobileMenuOpen(o => !o)}
                aria-label={t('nav.toggleNav')}
                aria-expanded={mobileMenuOpen}
              >
                <span className={`hamburger-icon ${mobileMenuOpen ? 'open' : ''}`}>
                  <span /><span /><span />
                </span>
              </button>
            </>
          )}
        </div>

        {/* Mobile slide-down menu (for admin/somm/extra links) */}
        {user && mobileMenuOpen && (
          <div className="mobile-menu">
            <div className="mobile-menu-section">
              <Link to="/community" className={`mobile-menu-link ${isActive('/community') ? 'active' : ''}`} onClick={closeMenu}>Community</Link>
              <Link to="/wishlist" className={`mobile-menu-link ${isActive('/wishlist') ? 'active' : ''}`} onClick={closeMenu}>Wishlist</Link>
              <Link to="/recommendations" className={`mobile-menu-link ${isActive('/recommendations') ? 'active' : ''}`} onClick={closeMenu}>Recommendations</Link>
              <Link to="/journal" className={`mobile-menu-link ${isActive('/journal') ? 'active' : ''}`} onClick={closeMenu}>Journal</Link>
              <Link to="/wine-requests" className={`mobile-menu-link ${isActive('/wine-requests') ? 'active' : ''}`} onClick={closeMenu}>{t('nav.myRequests')}</Link>
              <Link to="/cellar-chat" className={`mobile-menu-link ${isActive('/cellar-chat') ? 'active' : ''}`} onClick={closeMenu}>Cellar Chat</Link>
              <Link to="/blog" className={`mobile-menu-link ${isActive('/blog') ? 'active' : ''}`} onClick={closeMenu}>{t('nav.blog')}</Link>
              <Link to="/plans" className={`mobile-menu-link ${isActive('/plans') ? 'active' : ''}`} onClick={closeMenu}>{t('nav.plans')}</Link>
              <Link to="/support" className={`mobile-menu-link ${isActive('/support') ? 'active' : ''}`} onClick={closeMenu}>Support</Link>
            </div>

            {(roles.includes('somm') || roles.includes('admin')) && (
              <div className="mobile-menu-section">
                <div className="mobile-menu-label">Sommelier</div>
                <Link to="/somm/maturity" className={`mobile-menu-link ${isActive('/somm/maturity') ? 'active' : ''}`} onClick={closeMenu}>{t('nav.maturityQueue')}</Link>
                <Link to="/somm/prices" className={`mobile-menu-link ${isActive('/somm/prices') ? 'active' : ''}`} onClick={closeMenu}>{t('nav.priceQueue')}</Link>
              </div>
            )}

            {roles.includes('admin') && (
              <div className="mobile-menu-section">
                <div className="mobile-menu-label">Admin</div>
                <Link to="/admin/wines" className={`mobile-menu-link ${isActive('/admin/wines') ? 'active' : ''}`} onClick={closeMenu}>{t('nav.wineLibrary')}</Link>
                <Link to="/admin/requests" className={`mobile-menu-link ${isActive('/admin/requests') ? 'active' : ''}`} onClick={closeMenu}>{t('nav.adminRequests')}</Link>
                <Link to="/admin/taxonomy" className={`mobile-menu-link ${isActive('/admin/taxonomy') ? 'active' : ''}`} onClick={closeMenu}>{t('nav.taxonomy')}</Link>
                <Link to="/admin/images" className={`mobile-menu-link ${isActive('/admin/images') ? 'active' : ''}`} onClick={closeMenu}>{t('nav.imageReview')}</Link>
                <Link to="/admin/support" className={`mobile-menu-link ${isActive('/admin/support') ? 'active' : ''}`} onClick={closeMenu}>Support Tickets</Link>
                <Link to="/admin/wine-reports" className={`mobile-menu-link ${isActive('/admin/wine-reports') ? 'active' : ''}`} onClick={closeMenu}>Wine Reports</Link>
                <Link to="/admin/blog" className={`mobile-menu-link ${isActive('/admin/blog') ? 'active' : ''}`} onClick={closeMenu}>{t('nav.blogAdmin')}</Link>
              </div>
            )}

            <div className="mobile-menu-section mobile-menu-footer">
              <div className="mobile-menu-user">
                <span className="user-info">
                  {user.username}
                  {roles.includes('admin') && <span className="badge badge--admin">{t('nav.badge.admin')}</span>}
                  {roles.includes('somm')  && <span className="badge badge--somm">{t('nav.badge.somm')}</span>}
                  {roles.includes('moderator') && <span className="badge badge--mod">Mod</span>}
                  <span className={`badge badge--plan badge--plan-${user.plan || 'free'}`}>{planLabel}</span>
                </span>
              </div>
              <div className="mobile-menu-actions">
                <button className="theme-toggle" onClick={toggleTheme} aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}>
                  {theme === 'light' ? (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
                  )}
                </button>
                <button onClick={handleLogout} className="btn-logout">
                  {t('nav.logout')}
                </button>
              </div>
            </div>
          </div>
        )}
      </nav>

      <main className="main-content">
        {children}
      </main>

      {/* ── Mobile bottom tab bar ── */}
      {user && (
        <nav className="bottom-nav" aria-label="Main navigation">
          <Link to="/cellars" className={`bottom-nav-item ${isActive('/cellars') ? 'active' : ''}`} onClick={closeMenu}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
            <span>Cellars</span>
          </Link>
          <Link to="/community" className={`bottom-nav-item ${isActive('/community') ? 'active' : ''}`} onClick={closeMenu}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            <span>Community</span>
          </Link>
          <Link to="/statistics" className={`bottom-nav-item ${isActive('/statistics') ? 'active' : ''}`} onClick={closeMenu}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
            <span>Analytics</span>
          </Link>
          <Link to="/settings" className={`bottom-nav-item ${isActive('/settings') ? 'active' : ''}`} onClick={closeMenu}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            <span>Settings</span>
          </Link>
          <button className="bottom-nav-item" onClick={() => setMobileMenuOpen(o => !o)} aria-label="More" aria-expanded={mobileMenuOpen}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
            <span>More</span>
          </button>
        </nav>
      )}

      {supportOpen && (
        <SupportModal onClose={() => setSupportOpen(false)} />
      )}
    </div>
  );
}

export default Layout;
