import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import CellarionLogo from '../components/CellarionLogo';
import './Login.css';

function ResetPassword() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [status, setStatus] = useState('idle'); // 'idle' | 'submitting' | 'success' | 'error'
  const [errorMessage, setErrorMessage] = useState('');

  // Read the one-time token ONCE, then take it out of the address bar so it
  // does not linger in browser history, in the Referer of any outbound link,
  // or in an analytics pageview (audit 2026-09 F03-6). State survives the URL
  // change; the form posts the captured value.
  const [token] = useState(() => searchParams.get('token'));
  useEffect(() => {
    if (searchParams.has('token')) setSearchParams(new URLSearchParams(), { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (password !== confirm) {
      setErrorMessage(t('auth.passwordsNoMatch'));
      return;
    }
    setStatus('submitting');
    setErrorMessage('');
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password })
      });
      const data = await res.json();
      if (res.ok) {
        setStatus('success');
        setTimeout(() => navigate('/login', { replace: true }), 2000);
      } else {
        setStatus('error');
        setErrorMessage(data.error || t('auth.resetFailed'));
      }
    } catch {
      setStatus('error');
      setErrorMessage(t('auth.genericError'));
    }
  };

  if (!token) {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="login-header">
            <CellarionLogo size={90} color="var(--color-primary)" showText />
            <p>{t('auth.resetPasswordTitle')}</p>
          </div>
          <div className="alert alert-error">{t('auth.noResetToken')}</div>
          <button
            className="btn btn-secondary btn-full"
            style={{ marginTop: '1rem' }}
            onClick={() => navigate('/login')}
          >
            {t('auth.backToLogin')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-header">
          <CellarionLogo size={90} color="var(--color-primary)" showText />
          <p>{t('auth.setNewPassword')}</p>
        </div>

        {status === 'success' ? (
          <div className="alert alert-success">
            {t('auth.resetSuccess')}
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            {errorMessage && <div className="alert alert-error">{errorMessage}</div>}
            <div className="form-group">
              <label>{t('auth.newPassword')}</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div className="form-group">
              <label>{t('auth.confirmPassword')}</label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
              />
            </div>
            <p style={{ color: 'var(--color-text-muted)', fontSize: '0.8rem', marginBottom: '1rem' }}>
              {t('auth.passwordRequirements')}
            </p>
            <button
              type="submit"
              className="btn btn-primary btn-full"
              disabled={status === 'submitting'}
            >
              {status === 'submitting' ? t('auth.resetting') : t('auth.resetPasswordBtn')}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

export default ResetPassword;
