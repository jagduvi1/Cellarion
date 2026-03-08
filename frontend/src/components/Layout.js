import { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { PLANS } from '../config/plans';
import NotificationBell from './NotificationBell';
import './Layout.css';

const LOGO_IMG = process.env.PUBLIC_URL + '/cellarion-logo.jpg';

function Layout({ children }) {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

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
      <nav className="navbar">
        <div className="navbar-top">
          <div className="navbar-brand">
            <Link to="/" onClick={closeMenu} className="brand-link">
              <img src={LOGO_IMG} alt="Cellarion" className="brand-logo-img" />
              <span>Cellarion</span>
            </Link>
          </div>

          {user && (
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
          )}
        </div>

        {user && (
          <div className={`navbar-menu ${mobileMenuOpen ? 'open' : ''}`}>
            <Link
              to="/cellars"
              className={isActive('/cellars') ? 'active' : ''}
              onClick={closeMenu}
            >
              {t('nav.myCellars')}
            </Link>
            <Link
              to="/statistics"
              className={isActive('/statistics') ? 'active' : ''}
              onClick={closeMenu}
            >
              Analytics
              {user.plan !== 'premium' && (
                <span className="nav-stats-hint" title="Premium feature">★</span>
              )}
            </Link>
            <Link
              to="/wine-requests"
              className={isActive('/wine-requests') ? 'active' : ''}
              onClick={closeMenu}
            >
              {t('nav.myRequests')}
            </Link>
            <Link
              to="/cellar-chat"
              className={isActive('/cellar-chat') ? 'active' : ''}
              onClick={closeMenu}
            >
              Cellar Chat
            </Link>
            <Link
              to="/plans"
              className={isActive('/plans') ? 'active' : ''}
              onClick={closeMenu}
            >
              {t('nav.plans')}
            </Link>

            {(roles.includes('somm') || roles.includes('admin')) && (
              <>
                <div className="navbar-divider" />
                <Link
                  to="/somm/maturity"
                  className={`somm-link ${isActive('/somm/maturity') ? 'active' : ''}`}
                  onClick={closeMenu}
                >
                  {t('nav.maturityQueue')}
                </Link>
                <Link
                  to="/somm/prices"
                  className={`somm-link ${isActive('/somm/prices') ? 'active' : ''}`}
                  onClick={closeMenu}
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
                  className={`admin-link ${isActive('/superadmin') ? 'active' : ''}`}
                  onClick={closeMenu}
                  title="System Monitor"
                >
                  System Monitor
                </Link>
              </>
            )}

            {roles.includes('admin') && (
              <>
                <div className="navbar-divider" />
                <Link
                  to="/admin/wines"
                  className={`admin-link ${isActive('/admin/wines') ? 'active' : ''}`}
                  onClick={closeMenu}
                >
                  {t('nav.wineLibrary')}
                </Link>
                <Link
                  to="/admin/requests"
                  className={`admin-link ${isActive('/admin/requests') ? 'active' : ''}`}
                  onClick={closeMenu}
                >
                  {t('nav.adminRequests')}
                </Link>
                <Link
                  to="/admin/taxonomy"
                  className={`admin-link ${isActive('/admin/taxonomy') ? 'active' : ''}`}
                  onClick={closeMenu}
                >
                  {t('nav.taxonomy')}
                </Link>
                <Link
                  to="/admin/images"
                  className={`admin-link ${isActive('/admin/images') ? 'active' : ''}`}
                  onClick={closeMenu}
                >
                  {t('nav.imageReview')}
                </Link>
                <Link
                  to="/admin/audit"
                  className={`admin-link ${isActive('/admin/audit') ? 'active' : ''}`}
                  onClick={closeMenu}
                >
                  {t('nav.auditLog')}
                </Link>
                <Link
                  to="/admin/users"
                  className={`admin-link ${isActive('/admin/users') ? 'active' : ''}`}
                  onClick={closeMenu}
                >
                  {t('nav.users')}
                </Link>
                <Link
                  to="/admin/import"
                  className={`admin-link ${isActive('/admin/import') ? 'active' : ''}`}
                  onClick={closeMenu}
                >
                  Import Wines
                </Link>
              </>
            )}

            <div className="navbar-user">
              <span className="user-info">
                👤 {user.username}
                {roles.includes('admin') && <span className="badge">{t('nav.badge.admin')}</span>}
                {roles.includes('somm')  && <span className="badge badge--somm">{t('nav.badge.somm')}</span>}
                <span className={`badge badge--plan badge--plan-${user.plan || 'free'}`}>{planLabel}</span>
              </span>
              <div className="navbar-user-actions">
                <NotificationBell />
                <Link to="/settings" className={`btn-settings ${isActive('/settings') ? 'active' : ''}`} onClick={closeMenu}>
                  {t('nav.settings')}
                </Link>
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
    </div>
  );
}

export default Layout;
