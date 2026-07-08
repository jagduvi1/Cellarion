import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import CellarionLogo from '../components/CellarionLogo';
import './Login.css';

function VerifyEmail() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const { verifyEmail } = useAuth();
  const navigate = useNavigate();

  const [status, setStatus] = useState('verifying'); // 'verifying' | 'success' | 'error'
  const [errorMessage, setErrorMessage] = useState('');
  const [resendEmail, setResendEmail] = useState('');
  const [resendStatus, setResendStatus] = useState(null); // null | 'sending' | 'sent' | 'error'

  // The token is single-use: StrictMode's dev double-mount would consume it
  // on the first run and overwrite the success state with "invalid token"
  // from the second — run exactly once per mount cycle.
  const ranRef = useRef(false);
  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    const token = searchParams.get('token');
    if (!token) {
      setStatus('error');
      setErrorMessage(t('auth.noVerifyToken'));
      return;
    }

    verifyEmail(token).then(result => {
      if (result.success) {
        setStatus('success');
        setTimeout(() => navigate('/cellars', { replace: true }), 1500);
      } else {
        setStatus('error');
        setErrorMessage(result.error || t('auth.verificationFailed'));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleResend = async () => {
    if (!resendEmail) return;
    setResendStatus('sending');
    try {
      const res = await fetch('/api/auth/resend-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: resendEmail })
      });
      setResendStatus(res.ok ? 'sent' : 'error');
    } catch {
      setResendStatus('error');
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-header">
          <CellarionLogo size={90} color="var(--color-primary)" showText />
          <p>{t('auth.emailVerification')}</p>
        </div>

        {status === 'verifying' && (
          <div className="alert alert-info">{t('auth.verifying')}</div>
        )}

        {status === 'success' && (
          <div className="alert alert-success">
            {t('auth.verified')}
          </div>
        )}

        {status === 'error' && (
          <>
            <div className="alert alert-error">{errorMessage}</div>
            <p style={{ color: 'var(--color-text-muted)', fontSize: '0.9rem', marginTop: '1.5rem' }}>
              {t('auth.enterEmailForNewLink')}
            </p>
            <div className="form-group">
              <input
                type="email"
                placeholder={t('auth.emailExamplePlaceholder')}
                value={resendEmail}
                onChange={e => setResendEmail(e.target.value)}
              />
            </div>
            {resendStatus === 'sent' && (
              <div className="alert alert-success">{t('auth.newLinkSent')}</div>
            )}
            {resendStatus === 'error' && (
              <div className="alert alert-error">{t('auth.sendFailed')}</div>
            )}
            {resendStatus !== 'sent' && (
              <button
                className="btn btn-primary btn-full"
                onClick={handleResend}
                disabled={!resendEmail || resendStatus === 'sending'}
              >
                {resendStatus === 'sending' ? t('auth.sending') : t('auth.resendVerification')}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default VerifyEmail;
