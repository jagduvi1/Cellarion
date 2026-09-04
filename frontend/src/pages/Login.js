import { useId, useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useTranslation, Trans } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import useVersion from '../hooks/useVersion';
import { stashPostLoginRedirect } from '../utils/postLoginRedirect';
import './Login.css';

const LOGO_WEBP = '/cellarion-logo-light.webp';
const LOGO_PNG  = '/cellarion-logo-light.png';

// Google's "G" mark, per their branding guidelines, as an inline SVG so it
// needs no extra asset/request.
function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.997 8.997 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" />
      <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" />
    </svg>
  );
}

function Login() {
  const usernameId = useId();
  const emailId = useId();
  const passwordId = useId();
  const forgotEmailId = useId();
  const [mode, setMode] = useState('login');
  const [formData, setFormData] = useState({ username: '', email: '', password: '' });
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [registered, setRegistered] = useState(false);
  const [registeredEmail, setRegisteredEmail] = useState('');
  const [pendingVerificationEmail, setPendingVerificationEmail] = useState(null);
  const [resendStatus, setResendStatus] = useState(null); // null | 'sending' | 'sent' | 'error'
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotStatus, setForgotStatus] = useState(null); // null | 'sending' | 'sent' | 'error'
  const [googleEnabled, setGoogleEnabled] = useState(false);

  const { t } = useTranslation();
  const { login, register } = useAuth();
  const navigate = useNavigate();
  // Where ProtectedRoute sent them from, when a deep link bounced them here
  // (issue #1165). Set by ProtectedRoute itself, never read from the URL.
  const location = useLocation();
  const appVersion = useVersion();

  // Ask the server which SSO providers are configured, so we only show buttons
  // that actually work on this deployment.
  useEffect(() => {
    let active = true;
    fetch('/api/auth/sso/providers')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (active && data) setGoogleEnabled(Boolean(data.google)); })
      .catch(() => { /* leave SSO buttons hidden if the probe fails */ });
    return () => { active = false; };
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setPendingVerificationEmail(null);
    setResendStatus(null);
    setLoading(true);

    let result;
    if (mode === 'login') {
      result = await login(formData.username, formData.password, rememberMe);
    } else {
      result = await register(formData.username, formData.email, formData.password, consentAccepted);
    }

    setLoading(false);

    if (result.success) {
      if (result.requiresVerification) {
        setRegisteredEmail(result.email);
        setRegistered(true);
      } else {
        // Finish the journey they started, or the default home for a plain sign-in.
        navigate(location.state?.from || '/cellars');
      }
    } else {
      if (result.code === 'EMAIL_NOT_VERIFIED') {
        setPendingVerificationEmail(result.email);
      }
      setError(result.error);
    }
  };

  const handleResend = async () => {
    if (!pendingVerificationEmail) return;
    setResendStatus('sending');
    try {
      const res = await fetch('/api/auth/resend-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: pendingVerificationEmail })
      });
      setResendStatus(res.ok ? 'sent' : 'error');
    } catch {
      setResendStatus('error');
    }
  };

  const handleForgot = async (e) => {
    e.preventDefault();
    setForgotStatus('sending');
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: forgotEmail })
      });
      setForgotStatus(res.ok ? 'sent' : 'error');
    } catch {
      setForgotStatus('error');
    }
  };

  const switchMode = (newMode) => {
    setMode(newMode);
    setError(null);
    setPendingVerificationEmail(null);
    setResendStatus(null);
    setForgotEmail('');
    setForgotStatus(null);
  };

  const footer = (
    <footer className="login-footer">
      <p>
        <Trans i18nKey="auth.footerOpenSource">
          Cellarion is <a href="https://github.com/jagduvi1/Cellarion" target="_blank" rel="noopener noreferrer">open source</a>. Have an idea or found a bug? <a href="https://github.com/jagduvi1/Cellarion/issues" target="_blank" rel="noopener noreferrer">Open an issue on GitHub</a>.
        </Trans>
      </p>
      <p>
        <Trans i18nKey="auth.footerHelp">
          Need help with your account? <a href="mailto:support@cellarion.app">Contact support</a>.
        </Trans>
      </p>
      {appVersion && (
        <p className="login-version">
          <a
            href={`https://github.com/jagduvi1/Cellarion/releases/tag/v${appVersion}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            v{appVersion}
          </a>
        </p>
      )}
    </footer>
  );

  if (mode === 'forgot') {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="login-header">
            <picture>
              <source srcSet={LOGO_WEBP} type="image/webp" />
              <img src={LOGO_PNG} alt="Cellarion" className="login-logo" width="159" height="128" />
            </picture>
            <p>{t('auth.resetYourPassword')}</p>
          </div>

          {forgotStatus === 'sent' ? (
            <>
              <div className="alert alert-success">
                {t('auth.forgotSent')}
              </div>
              <button
                className="btn btn-secondary btn-full"
                style={{ marginTop: '1rem' }}
                onClick={() => switchMode('login')}
              >
                {t('auth.backToLogin')}
              </button>
            </>
          ) : (
            <form onSubmit={handleForgot}>
              <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.9rem', marginBottom: '1.25rem' }}>
                {t('auth.forgotIntro')}
              </p>
              <div className="form-group">
                <label htmlFor={forgotEmailId}>{t('auth.emailLabel')}</label>
                <input
                  id={forgotEmailId}
                  type="email"
                  value={forgotEmail}
                  onChange={(e) => setForgotEmail(e.target.value)}
                  required
                  autoFocus
                />
              </div>
              {forgotStatus === 'error' && (
                <div className="alert alert-error">{t('auth.genericError')}</div>
              )}
              <button
                type="submit"
                className="btn btn-primary btn-full"
                disabled={forgotStatus === 'sending'}
              >
                {forgotStatus === 'sending' ? t('auth.sending') : t('auth.sendResetLink')}
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-full"
                style={{ marginTop: '0.75rem' }}
                onClick={() => switchMode('login')}
              >
                {t('auth.backToLogin')}
              </button>
            </form>
          )}
        </div>
        {footer}
      </div>
    );
  }

  if (registered) {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="login-header">
            <picture>
              <source srcSet={LOGO_WEBP} type="image/webp" />
              <img src={LOGO_PNG} alt="Cellarion" className="login-logo" width="159" height="128" />
            </picture>
          </div>
          <div className="alert alert-success">
            <strong>{t('auth.checkYourEmail')}</strong>
            <br />
            <Trans i18nKey="auth.verificationSentTo" values={{ email: registeredEmail }} components={{ 1: <strong /> }} />
          </div>
          <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.9rem', textAlign: 'center', marginTop: '1rem' }}>
            {t('auth.didntReceive')}{' '}
            <button
              className="btn btn-secondary btn-small"
              style={{ display: 'inline', padding: '4px 12px', fontSize: '0.85rem' }}
              onClick={() => {
                setPendingVerificationEmail(registeredEmail);
                setRegistered(false);
                setMode('login');
              }}
            >
              {t('auth.resendVerification')}
            </button>
          </p>
        </div>
        {footer}
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-header">
          <picture>
            <source srcSet={LOGO_WEBP} type="image/webp" />
            <img src={LOGO_PNG} alt="Cellarion" className="login-logo" />
          </picture>
          <p>{t('auth.tagline')}</p>
        </div>

        <div className="mode-toggle">
          <button
            className={mode === 'login' ? 'active' : ''}
            onClick={() => switchMode('login')}
          >
            {t('auth.login')}
          </button>
          <button
            className={mode === 'register' ? 'active' : ''}
            onClick={() => switchMode('register')}
          >
            {t('auth.register')}
          </button>
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        {pendingVerificationEmail && (
          <div style={{ marginBottom: '1rem', textAlign: 'center' }}>
            {resendStatus === 'sent' && (
              <div className="alert alert-success">{t('auth.verificationResent')}</div>
            )}
            {resendStatus === 'error' && (
              <div className="alert alert-error">{t('auth.resendFailed')}</div>
            )}
            {resendStatus !== 'sent' && (
              <button
                className="btn btn-secondary btn-small"
                onClick={handleResend}
                disabled={resendStatus === 'sending'}
              >
                {resendStatus === 'sending' ? t('auth.sending') : t('auth.resendVerification')}
              </button>
            )}
          </div>
        )}

        {googleEnabled && (
          <>
            <button
              type="button"
              className="btn btn-google btn-full"
              onClick={() => {
                // Router state does not survive the full-page trip out to
                // Google, so hand the destination over before we leave.
                stashPostLoginRedirect(location.state?.from);
                window.location.href = '/api/auth/google';
              }}
            >
              <GoogleIcon />
              <span>{t('auth.continueWithGoogle', 'Continue with Google')}</span>
            </button>
            <div className="login-divider"><span>{t('auth.or', 'or')}</span></div>
          </>
        )}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor={usernameId}>{mode === 'login' ? t('auth.usernameOrEmail') : t('auth.usernameLabel')}</label>
            <input
              id={usernameId}
              type="text"
              value={formData.username}
              onChange={(e) => setFormData({ ...formData, username: e.target.value })}
              required
              autoFocus
            />
          </div>
          {mode === 'register' && (
            <div className="form-group">
              <label htmlFor={emailId}>{t('auth.emailLabel')}</label>
              <input
                id={emailId}
                type="email"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                required
              />
            </div>
          )}
          <div className="form-group">
            <label htmlFor={passwordId}>{t('auth.passwordLabel')}</label>
            <input
              id={passwordId}
              type="password"
              value={formData.password}
              onChange={(e) => setFormData({ ...formData, password: e.target.value })}
              required
            />
          </div>
          {mode === 'register' && (
            <div className="form-group consent-group">
              <label className="consent-label">
                <input
                  type="checkbox"
                  checked={consentAccepted}
                  onChange={(e) => setConsentAccepted(e.target.checked)}
                  required
                />
                <span>
                  <Trans i18nKey="auth.consent">
                    I agree to the <a href="/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy</a> and consent to the processing of my personal data as described therein.
                  </Trans>
                </span>
              </label>
            </div>
          )}
          {mode === 'login' && (
            <div className="login-options">
              <label className="remember-me">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                />
                <span>{t('auth.rememberMe')}</span>
              </label>
              <button
                type="button"
                onClick={() => switchMode('forgot')}
                className="forgot-link"
              >
                {t('auth.forgotPassword')}
              </button>
            </div>
          )}
          <button type="submit" className="btn btn-primary btn-full" disabled={loading || (mode === 'register' && !consentAccepted)}>
            {loading ? t('auth.loading') : mode === 'login' ? t('auth.login') : t('auth.createAccount')}
          </button>
        </form>
      </div>
      {footer}
    </div>
  );
}

export default Login;
