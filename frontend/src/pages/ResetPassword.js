import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import CellarionLogo from '../components/CellarionLogo';
import './Login.css';

function ResetPassword() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token') || '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [status, setStatus] = useState('idle'); // 'idle' | 'loading' | 'success' | 'error'
  const [errorMessage, setErrorMessage] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setErrorMessage('');

    if (password !== confirm) {
      setErrorMessage('Passwords do not match.');
      return;
    }

    setStatus('loading');

    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password })
      });

      const data = await res.json();

      if (!res.ok) {
        setErrorMessage(data.error || 'Something went wrong. Please try again.');
        setStatus('error');
      } else {
        setStatus('success');
        setTimeout(() => navigate('/login', { replace: true }), 2000);
      }
    } catch {
      setErrorMessage('Network error. Please try again.');
      setStatus('error');
    }
  };

  if (!token) {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="login-header">
            <CellarionLogo size={90} color="#7B9E88" showText />
          </div>
          <div className="alert alert-error">
            No reset token found. Please use the link from your email.
          </div>
          <p style={{ textAlign: 'center', marginTop: '1rem', fontSize: '0.9rem' }}>
            <Link to="/forgot-password" style={{ color: '#7B9E88' }}>Request a new reset link</Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-header">
          <CellarionLogo size={90} color="#7B9E88" showText />
          <p>Set a new password</p>
        </div>

        {status === 'success' ? (
          <div className="alert alert-success">
            Password reset! Redirecting you to login...
          </div>
        ) : (
          <>
            {errorMessage && (
              <div className="alert alert-error">
                {errorMessage}
                {status === 'error' && (
                  <span>
                    {' '}
                    <Link to="/forgot-password" style={{ color: 'inherit', textDecoration: 'underline' }}>
                      Request a new link
                    </Link>
                    .
                  </span>
                )}
              </div>
            )}
            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label>New password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoFocus
                  minLength={12}
                />
              </div>
              <div className="form-group">
                <label>Confirm new password</label>
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  minLength={12}
                />
              </div>
              <p style={{ fontSize: '0.8rem', color: '#9A9484', marginBottom: '1rem' }}>
                Minimum 12 characters with uppercase, lowercase, number, and special character.
              </p>
              <button
                type="submit"
                className="btn btn-primary btn-full"
                disabled={status === 'loading'}
              >
                {status === 'loading' ? 'Resetting...' : 'Reset password'}
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

export default ResetPassword;
