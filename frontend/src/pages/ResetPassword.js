import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import CellarionLogo from '../components/CellarionLogo';
import './Login.css';

function ResetPassword() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [status, setStatus] = useState('idle'); // 'idle' | 'submitting' | 'success' | 'error'
  const [errorMessage, setErrorMessage] = useState('');

  const token = searchParams.get('token');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (password !== confirm) {
      setErrorMessage('Passwords do not match.');
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
        setErrorMessage(data.error || 'Failed to reset password. The link may have expired.');
      }
    } catch {
      setStatus('error');
      setErrorMessage('Something went wrong. Please try again.');
    }
  };

  if (!token) {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="login-header">
            <CellarionLogo size={90} color="#7B9E88" showText />
            <p>Reset Password</p>
          </div>
          <div className="alert alert-error">No reset token found in the URL.</div>
          <button
            className="btn btn-secondary btn-full"
            style={{ marginTop: '1rem' }}
            onClick={() => navigate('/login')}
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
        <div className="login-header">
          <CellarionLogo size={90} color="#7B9E88" showText />
          <p>Set a new password</p>
        </div>

        {status === 'success' ? (
          <div className="alert alert-success">
            Password reset successfully! Redirecting to login...
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            {errorMessage && <div className="alert alert-error">{errorMessage}</div>}
            <div className="form-group">
              <label>New password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div className="form-group">
              <label>Confirm password</label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
              />
            </div>
            <p style={{ color: '#9A9484', fontSize: '0.8rem', marginBottom: '1rem' }}>
              Must be at least 12 characters with uppercase, lowercase, number, and special character.
            </p>
            <button
              type="submit"
              className="btn btn-primary btn-full"
              disabled={status === 'submitting'}
            >
              {status === 'submitting' ? 'Resetting...' : 'Reset password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

export default ResetPassword;
