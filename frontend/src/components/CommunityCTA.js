import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import './CommunityCTA.css';

// "Sign in to join the conversation" banner shown to anonymous users on
// public community pages. The login link preserves the current path so users
// land back where they were after authenticating.
export default function CommunityCTA({ variant = 'banner', message }) {
  const { t } = useTranslation();
  const { pathname, search } = useLocation();
  const next = encodeURIComponent(pathname + search);
  const loginHref = `/login?next=${next}`;

  return (
    <div className={`community-cta community-cta--${variant} card`}>
      <p className="community-cta__message">
        {message || t('discussions.signInToJoin')}
      </p>
      <div className="community-cta__actions">
        <Link to={loginHref} className="btn btn-primary btn-small">
          {t('discussions.signIn')}
        </Link>
        <Link to="/login?mode=register" className="btn btn-secondary btn-small">
          {t('discussions.createAccount')}
        </Link>
      </div>
    </div>
  );
}
