import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import CellarionLogo from '../components/CellarionLogo';
import './Login.css';

function VerifyEmail() {
  const [searchParams] = useSearchParams();
  const { verifyEmail } = useAuth();
  const navigate = useNavigate();

  const [status, setStatus] = useState('verifying'); // 'verifying' | 'success' | 'error'
  const [errorMessage, setErrorMessage] = useState('');
  const [resendEmail, setResendEmail] = useState('');
  const [resendStatus, setResendStatus] = useState(null); // null | 'sending' | 'sent' | 'error'

  useEffect(() => {
    const token = searchParams.get('token');
    if (!token) {
      setStatus('error');
      setErrorMessage('No verification token found in the URL.');
      return;
    }

    verifyEmail(token).then(result => {
      if (result.success) {
        setStatus('success');
        setTimeout(() => navigate('/cellars', { replace: true }), 1500);
      } else {
        setStatus('error');
        setErrorMessage(result.error || 'Verification failed. The link may have expired.');
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
          <p>Email Verification</p>
        </div>

        {status === 'verifying' && (
          <div className="alert alert-info">Verifying your email address...</div>
        )}

        {status === 'success' && (
          <div className="alert alert-success">
            Email verified! Redirecting you to your cellars...
          </div>
        )}

        {status === 'error' && (
          <>
            <div className="alert alert-error">{errorMessage}</div>
            <p style={{ color: 'var(--color-text-muted)', fontSize: '0.9rem', marginTop: '1.5rem' }}>
              Enter your email to get a new verification link:
            </p>
            <div className="form-group">
              <input
                type="email"
                placeholder="your@email.com"
                value={resendEmail}
                onChange={e => setResendEmail(e.target.value)}
              />
            </div>
            {resendStatus === 'sent' && (
              <div className="alert alert-success">New verification link sent. Check your inbox.</div>
            )}
            {resendStatus === 'error' && (
              <div className="alert alert-error">Failed to send. Please try again.</div>
            )}
            {resendStatus !== 'sent' && (
              <button
                className="btn btn-primary btn-full"
                onClick={handleResend}
                disabled={!resendEmail || resendStatus === 'sending'}
              >
                {resendStatus === 'sending' ? 'Sending...' : 'Resend verification email'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default VerifyEmail;
