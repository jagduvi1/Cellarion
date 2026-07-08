import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation, Trans } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import useVersion from '../hooks/useVersion';
import './Login.css';

const LOGO_WEBP = '/cellarion-logo-light.webp';
const LOGO_PNG  = '/cellarion-logo-light.png';

function Login() {
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

  const { t } = useTranslation();
  const { login, register } = useAuth();
  const navigate = useNavigate();
  const appVersion = useVersion();

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
        navigate('/cellars');
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
                <label>{t('auth.emailLabel')}</label>
                <input
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

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>{mode === 'login' ? t('auth.usernameOrEmail') : t('auth.usernameLabel')}</label>
            <input
              type="text"
              value={formData.username}
              onChange={(e) => setFormData({ ...formData, username: e.target.value })}
              required
              autoFocus
            />
          </div>
          {mode === 'register' && (
            <div className="form-group">
              <label>{t('auth.emailLabel')}</label>
              <input
                type="email"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                required
              />
            </div>
          )}
          <div className="form-group">
            <label>{t('auth.passwordLabel')}</label>
            <input
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
