import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { approveOAuthConnection } from '../api/mcp';
import './Login.css';
import './ConnectAiAuthorize.css';

// OAuth 2.1 consent screen for the MCP connector (plan §2.4 Phase B). The
// backend's GET /api/mcp/oauth/authorize validates the request, then redirects
// the browser here carrying the (validated) params. The user approves, we POST
// back to /approve which mints the code, and we send the browser to the
// client's redirect_uri with ?code. Everything is re-validated server-side —
// this page is UX, not a trust boundary.
//
// Login is rendered INLINE when logged out (rather than bouncing to /login),
// so the OAuth params stay in the URL through authentication — the standard
// "log in, then consent" one-screen flow.

// What each cel_ scope grants, in the user's language of the cellar.
const SCOPE_INFO = {
  read: { key: 'scopeRead', fallback: 'View your cellars, bottles, stats, wishlist and journal' },
  consume: { key: 'scopeConsume', fallback: 'Mark bottles as opened, poured or drunk (reversible)' },
  write: { key: 'scopeWrite', fallback: 'Add and edit bottles, racks and cellars' },
};
const GRANTABLE = ['read', 'consume', 'write'];

// Access levels the user can choose at consent. Each level is a PREFIX of the
// canonically-ordered offered scopes, so narrowing is the only possible
// direction — the server re-validates (subset of the client's request, read
// mandatory) either way. Labelled by the level's topmost capability.
const LEVEL_LABELS = {
  read: { key: 'levelRead', fallback: 'Read only — it can look, never change anything' },
  consume: { key: 'levelConsume', fallback: 'Read + log drinking — it can also mark bottles opened or drunk (reversible)' },
  write: { key: 'levelFull', fallback: 'Full access — it can also add and edit bottles, racks and cellars' },
};

function ConnectAiAuthorize() {
  const { t } = useTranslation();
  const { user, loading, apiFetch, login } = useAuth();
  const [params] = useSearchParams();

  const clientId = params.get('client_id');
  const redirectUri = params.get('redirect_uri');
  const codeChallenge = params.get('code_challenge');
  const codeChallengeMethod = params.get('code_challenge_method') || 'S256';
  const scope = params.get('scope') || '';
  const state = params.get('state') || '';
  const resource = params.get('resource') || '';
  const clientName = params.get('client_name') || '';

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  // Inline-login form state.
  const [creds, setCreds] = useState({ username: '', password: '' });
  const [loginError, setLoginError] = useState(null);
  const [loggingIn, setLoggingIn] = useState(false);
  // How much of the offered scope set the user grants — an index into
  // `levelOptions` below; null = the full offered set (the default, and
  // today's behavior for everyone who just clicks Approve).
  const [chosenLevel, setChosenLevel] = useState(null);

  // The request is unusable without these three — show a hard error rather than
  // POSTing something the backend will reject.
  const requestValid = clientId && redirectUri && codeChallenge && codeChallengeMethod === 'S256';

  // The scopes we'll actually grant (mirror of the server's grantedScopes:
  // intersect requested with the grantable set; read is the floor).
  const requested = scope.split(/\s+/).filter(Boolean);
  const displayScopes = GRANTABLE.filter((s) => requested.includes(s));
  if (displayScopes.length === 0) displayScopes.push('read');

  // One selectable level per prefix of the offered set ("Read only" …
  // "Full access"). A single-scope request renders as one pre-picked option.
  const levelOptions = displayScopes.map((_, i) => displayScopes.slice(0, i + 1));
  const grantScopes = chosenLevel === null ? displayScopes : levelOptions[chosenLevel];

  let redirectHost = '';
  try { redirectHost = new URL(redirectUri).host; } catch { /* shown-nothing */ }

  const decide = async (approved) => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await approveOAuthConnection(apiFetch, {
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: codeChallenge,
        code_challenge_method: codeChallengeMethod,
        scope,
        state,
        resource,
        approved,
        // The user's choice — a prefix of the offered set; the server
        // re-validates (subset of the client's request, read mandatory).
        ...(approved ? { scopes: grantScopes } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.redirect) {
        setError(data.error || t('oauthConsent.failed', 'Could not complete the authorization. Please try again.'));
        setSubmitting(false);
        return;
      }
      // Full-page navigation — redirect_uri is an external client callback.
      window.location.href = data.redirect;
    } catch {
      setError(t('oauthConsent.failed', 'Could not complete the authorization. Please try again.'));
      setSubmitting(false);
    }
  };

  const submitLogin = async (e) => {
    e.preventDefault();
    setLoginError(null);
    setLoggingIn(true);
    const result = await login(creds.username, creds.password, true);
    setLoggingIn(false);
    if (!result.success) setLoginError(result.error || t('oauthConsent.loginFailed', 'Login failed.'));
    // On success, AuthContext sets `user`; this page re-renders into the consent view.
  };

  const shell = (children) => (
    <div className="login-page">
      <div className="login-card oauth-consent-card">{children}</div>
    </div>
  );

  if (!requestValid) {
    return shell(
      <div className="alert alert-error">
        {t('oauthConsent.invalidRequest', 'This authorization link is invalid or incomplete. Start the connection again from your AI assistant.')}
      </div>
    );
  }

  if (loading) {
    return shell(<p className="oauth-consent-muted">{t('common.loading', 'Loading…')}</p>);
  }

  // Logged out → inline login (keeps the OAuth params in the URL).
  if (!user) {
    return shell(
      <>
        <h1 className="oauth-consent-title">{t('oauthConsent.loginTitle', 'Log in to connect your AI')}</h1>
        <p className="oauth-consent-muted">
          {t('oauthConsent.loginHint', 'Sign in to your Cellarion account to authorize this connection.')}
        </p>
        {loginError && <div className="alert alert-error">{loginError}</div>}
        <form onSubmit={submitLogin}>
          <input
            className="form-input"
            type="text"
            autoComplete="username"
            placeholder={t('oauthConsent.username', 'Username or email')}
            value={creds.username}
            onChange={(e) => setCreds({ ...creds, username: e.target.value })}
            required
          />
          <input
            className="form-input"
            type="password"
            autoComplete="current-password"
            placeholder={t('oauthConsent.password', 'Password')}
            value={creds.password}
            onChange={(e) => setCreds({ ...creds, password: e.target.value })}
            required
            style={{ marginTop: '0.75rem' }}
          />
          <button className="btn btn-primary btn-full" type="submit" disabled={loggingIn} style={{ marginTop: '1rem' }}>
            {loggingIn ? t('oauthConsent.loggingIn', 'Signing in…') : t('oauthConsent.logIn', 'Log in')}
          </button>
        </form>
      </>
    );
  }

  if (user.isDemo) {
    return shell(
      <div className="alert alert-error">
        {t('oauthConsent.demoBlocked', 'Connecting an AI assistant is not available in the demo. Create a free account to use it.')}
      </div>
    );
  }

  // Consent.
  const who = clientName || t('oauthConsent.anAiAssistant', 'An AI assistant');
  return shell(
    <>
      <h1 className="oauth-consent-title">
        {t('oauthConsent.title', 'Connect your AI assistant')}
        <span className="oauth-consent-beta">{t('oauthConsent.beta', 'Beta')}</span>
      </h1>
      {/* This is the moment access is granted, so the beta framing has to be
          here too — not only back in Settings where the flow started. */}
      <div className="alert alert-info">
        {t('oauthConsent.betaNotice',
          'Connecting an AI is a beta feature and you use it at your own risk — it is new and still being tested. Everything it changes is reversible, and you can revoke access at any time in Settings.')}
      </div>
      <p className="oauth-consent-lead">
        <strong>{who}</strong>{' '}
        {t('oauthConsent.wantsChoose', 'wants to connect to your Cellarion cellar. Choose how much it may do:')}
      </p>
      <div className="oauth-consent-levels" role="radiogroup" aria-label={t('oauthConsent.accessLevel', 'Access level')}>
        {levelOptions.map((scopes, i) => {
          const top = scopes[scopes.length - 1];
          const selected = grantScopes.length === scopes.length;
          return (
            <label key={top} className={`oauth-consent-level ${selected ? 'selected' : ''}`}>
              <input
                type="radio"
                name="access-level"
                checked={selected}
                onChange={() => setChosenLevel(i)}
                disabled={submitting}
              />
              <span className="oauth-consent-level-text">
                <strong>{t(`oauthConsent.${LEVEL_LABELS[top].key}`, LEVEL_LABELS[top].fallback)}</strong>
                <small>
                  {scopes.map((s) => t(`oauthConsent.${SCOPE_INFO[s].key}`, SCOPE_INFO[s].fallback)).join(' · ')}
                </small>
              </span>
            </label>
          );
        })}
      </div>
      <p className="oauth-consent-muted">
        {t('oauthConsent.revokeNote', 'You can revoke this access anytime in Settings. You stay in control — the assistant confirms every change before it happens.')}
      </p>
      {redirectHost && (
        <p className="oauth-consent-redirect">
          {t('oauthConsent.returnedTo', 'After approving, you\'ll be returned to')} <strong>{redirectHost}</strong>
        </p>
      )}
      {error && <div className="alert alert-error">{error}</div>}
      <div className="oauth-consent-actions">
        <button className="btn btn-secondary" type="button" onClick={() => decide(false)} disabled={submitting}>
          {t('oauthConsent.deny', 'Cancel')}
        </button>
        <button className="btn btn-primary" type="button" onClick={() => decide(true)} disabled={submitting}>
          {submitting ? t('oauthConsent.working', 'Working…') : t('oauthConsent.approve', 'Approve')}
        </button>
      </div>
    </>
  );
}

export default ConnectAiAuthorize;
