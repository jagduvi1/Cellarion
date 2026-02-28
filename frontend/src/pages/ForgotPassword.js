import { useState } from 'react';
import { Link } from 'react-router-dom';
import CellarionLogo from '../components/CellarionLogo';
import './Login.css';

function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState('idle'); // 'idle' | 'loading' | 'sent' | 'error'
  const [errorMessage, setErrorMessage] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setStatus('loading');
    setErrorMessage('');

    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });

      const data = await res.json();

      if (res.status === 503) {
        setErrorMessage(data.error || 'Password reset is not available on this server.');
        setStatus('error');
      } else if (!res.ok) {
        setErrorMessage(data.error || 'Something went wrong. Please try again.');
        setStatus('error');
      } else {
        setStatus('sent');
      }
    } catch {
      setErrorMessage('Network error. Please try again.');
      setStatus('error');
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-header">
          <CellarionLogo size={90} color="#7B9E88" showText />
          <p>Reset your password</p>
        </div>

        {status === 'sent' ? (
          <div className="alert alert-success">
            If that email exists in our system, we've sent a reset link. Check your inbox.
          </div>
        ) : (
          <>
            {status === 'error' && (
              <div className="alert alert-error">{errorMessage}</div>
            )}
            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label>Email address</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus
                  placeholder="your@email.com"
                />
              </div>
              <button
                type="submit"
                className="btn btn-primary btn-full"
                disabled={status === 'loading'}
              >
                {status === 'loading' ? 'Sending...' : 'Send reset link'}
              </button>
            </form>
          </>
        )}

        <p style={{ textAlign: 'center', marginTop: '1.25rem', fontSize: '0.9rem', color: '#9A9484' }}>
          <Link to="/login" style={{ color: '#7B9E88' }}>Back to login</Link>
        </p>
      </div>
    </div>
  );
}

export default ForgotPassword;
