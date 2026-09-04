import { useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { takePostLoginRedirect } from '../utils/postLoginRedirect';
import './Login.css';

// Landing route for the OAuth round-trip (backend redirects here after Google).
// The backend has already set the httpOnly refresh cookie, and AuthProvider runs
// its session-restore on mount BEFORE this renders (the app gates on `loading`),
// so by the time we get here `user` is populated on success — no token ever
// travels in the URL.
const ERROR_MESSAGES = {
  no_verified_email: "Your Google account doesn't have a verified email address, so we couldn't sign you in.",
  access_denied: 'Google sign-in was cancelled.',
  not_configured: 'Google sign-in is not enabled on this server.',
  server_error: 'Something went wrong while signing you in. Please try again.',
  google: 'Google sign-in failed. Please try again.'
};

function OAuthCallback() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const error = params.get('error');

  // The stashed destination is single-use, and StrictMode double-invokes mount
  // effects in dev (index.js): run one would consume it and navigate, run two
  // would find nothing and replace with /cellars — so the fix would work in
  // production and silently not in dev. Run once per mount cycle, as
  // VerifyEmail does for its single-use token.
  const ranRef = useRef(false);
  const signedIn = Boolean(user);

  useEffect(() => {
    if (error) return; // show the error card + let the user go back to login
    if (ranRef.current) return;
    ranRef.current = true;
    // No error: the session either restored (→ wherever they were heading
    // before the sign-in interrupted them, else home) or silently failed
    // (→ login). The stash is left alone on failure so that retrying still
    // finishes the journey.
    navigate(signedIn ? (takePostLoginRedirect() || '/cellars') : '/login', { replace: true });
  }, [error, signedIn, navigate]);

  if (error) {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="alert alert-error">{ERROR_MESSAGES[error] || ERROR_MESSAGES.server_error}</div>
          <button
            className="btn btn-primary btn-full"
            style={{ marginTop: '1rem' }}
            onClick={() => navigate('/login', { replace: true })}
          >
            Back to login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <p style={{ textAlign: 'center', color: 'var(--color-text-secondary)' }}>Signing you in…</p>
      </div>
    </div>
  );
}

export default OAuthCallback;
