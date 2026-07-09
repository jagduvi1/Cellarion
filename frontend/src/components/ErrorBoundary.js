import { Component } from 'react';
import i18n from '../i18n';

// The boundary must render even if i18n itself failed to initialize —
// never let a translation lookup throw inside the fallback UI.
function tSafe(key, fallback) {
  try {
    const value = i18n.t(key);
    return value && value !== key ? value : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Catches unhandled React render errors and shows a friendly fallback UI
 * instead of a blank page.
 */
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('ErrorBoundary caught:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
          padding: '2rem',
          textAlign: 'center'
        }}>
          <h1 style={{ fontSize: '1.5rem', color: 'var(--color-danger)', marginBottom: '1rem' }}>
            {tSafe('errorBoundary.title', 'Something went wrong')}
          </h1>
          <p style={{ color: 'var(--color-text-muted)', marginBottom: '1.5rem' }}>
            {tSafe('errorBoundary.message', 'An unexpected error occurred. Please refresh the page to try again.')}
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '0.75rem 1.5rem',
              background: 'var(--color-primary)',
              color: 'var(--color-text-inverse)',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
              fontSize: '1rem'
            }}
          >
            {tSafe('errorBoundary.refresh', 'Refresh Page')}
          </button>
          {import.meta.env.DEV && this.state.error && (
            <pre style={{
              marginTop: '2rem',
              padding: '1rem',
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm)',
              textAlign: 'left',
              fontSize: '0.8rem',
              maxWidth: '600px',
              overflow: 'auto',
              color: 'var(--color-danger)'
            }}>
              {this.state.error.toString()}
            </pre>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
