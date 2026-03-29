import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Discussions from './Discussions';
import './ReviewFeed.css';

function CommunityDiscussions() {
  const location = useLocation();
  const { t } = useTranslation();

  return (
    <div className="review-feed-page">
      <div className="review-feed__header">
        <h1>{t('discussions.community')}</h1>
        <div className="review-feed__section-tabs">
          <Link
            to="/community"
            className={`review-feed__section-tab ${location.pathname === '/community' ? 'active' : ''}`}
          >
            {t('discussions.reviews')}
          </Link>
          <Link
            to="/community/discussions"
            className={`review-feed__section-tab ${location.pathname.startsWith('/community/discussions') ? 'active' : ''}`}
          >
            {t('discussions.discussions')}
          </Link>
        </div>
      </div>

      <Discussions />
    </div>
  );
}

export default CommunityDiscussions;
