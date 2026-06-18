import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import Discussions from './Discussions';
import './ReviewFeed.css';

function CommunityDiscussions() {
  const location = useLocation();
  const { t } = useTranslation();
  const { user } = useAuth();

  return (
    <div className="review-feed-page">
      <div className="review-feed__header">
        <h1>{t('discussions.community')}</h1>
        {/* Reviews tab is hidden for anonymous visitors — that feed is auth-only
            and would just bounce them back here via /community redirect. */}
        {user && (
          <div className="review-feed__section-tabs">
            <Link
              to="/community/discussions"
              className={`review-feed__section-tab ${location.pathname.startsWith('/community/discussions') ? 'active' : ''}`}
            >
              {t('discussions.discussions')}
            </Link>
            <Link
              to="/community"
              className={`review-feed__section-tab ${location.pathname === '/community' ? 'active' : ''}`}
            >
              {t('discussions.reviews')}
            </Link>
          </div>
        )}
      </div>

      <Discussions />
    </div>
  );
}

export default CommunityDiscussions;
