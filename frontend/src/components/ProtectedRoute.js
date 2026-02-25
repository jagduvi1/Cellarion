import { Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

/**
 * Protected Route Component
 * Redirects to login if user is not authenticated.
 * requireAdmin — user must have the 'admin' role
 * requireSomm  — user must have the 'somm' or 'admin' role
 */
function ProtectedRoute({ children, requireAdmin = false, requireSomm = false }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center' }}>
        <p>Loading...</p>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  const roles = user.roles || [];

  if (requireAdmin && !roles.includes('admin')) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center' }}>
        <h2>Access Denied</h2>
        <p>You need admin privileges to access this page.</p>
      </div>
    );
  }

  if (requireSomm && !roles.includes('somm') && !roles.includes('admin')) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center' }}>
        <h2>Access Denied</h2>
        <p>You need sommelier (or admin) privileges to access this page.</p>
      </div>
    );
  }

  return children;
}

export default ProtectedRoute;
