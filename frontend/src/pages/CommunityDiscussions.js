import { Link, useLocation } from 'react-router-dom';
import Discussions from './Discussions';
import './ReviewFeed.css';

function CommunityDiscussions() {
  const location = useLocation();

  return (
    <div className="review-feed-page">
      <div className="review-feed__header">
        <h1>Community</h1>
        <div className="review-feed__section-tabs">
          <Link
            to="/community"
            className={`review-feed__section-tab ${location.pathname === '/community' ? 'active' : ''}`}
          >
            Reviews
          </Link>
          <Link
            to="/community/discussions"
            className={`review-feed__section-tab ${location.pathname.startsWith('/community/discussions') ? 'active' : ''}`}
          >
            Discussions
          </Link>
        </div>
      </div>

      <Discussions />
    </div>
  );
}

export default CommunityDiscussions;
