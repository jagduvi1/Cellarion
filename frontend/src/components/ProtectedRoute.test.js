import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import ProtectedRoute from './ProtectedRoute';

/**
 * Signing in from a deep link should finish the journey you started
 * (issue #1165, deltabeat).
 *
 * The case that makes it more than a nicety: NFC tags on a fridge shelf open
 * Safari rather than the installed PWA, and iOS gives a standalone web app its
 * own cookie jar — so that Safari session has nearly always expired by the next
 * tap. Landing on /cellars means walking back to the fridge and tapping again.
 *
 * The destination travels in router state, never a ?next= query parameter, so
 * it cannot be steered by a crafted link. These pin both halves: that the
 * intended path is captured, and that it is captured as state.
 */

let mockAuth = { user: null, loading: false };
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => mockAuth }));

/** Renders the router state the redirect arrived with. */
function LoginProbe() {
  const location = useLocation();
  return <div data-testid="from">{location.state?.from ?? '(none)'}</div>;
}

const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/login" element={<LoginProbe />} />
      <Route path="/nfc/rack/:id" element={<ProtectedRoute><div>rack</div></ProtectedRoute>} />
      <Route path="/cellars" element={<ProtectedRoute><div>cellars</div></ProtectedRoute>} />
    </Routes>
  </MemoryRouter>
);

beforeEach(() => { mockAuth = { user: null, loading: false }; });

describe('signed out', () => {
  test('redirects to /login carrying the path that was asked for', () => {
    renderAt('/nfc/rack/abc123');
    expect(screen.getByTestId('from')).toHaveTextContent('/nfc/rack/abc123');
  });

  test('preserves the query string, which a bare pathname would drop', () => {
    renderAt('/cellars?tab=overview&sort=name');
    expect(screen.getByTestId('from')).toHaveTextContent('/cellars?tab=overview&sort=name');
  });
});

describe('signed in', () => {
  test('renders the protected page and never touches /login', () => {
    mockAuth = { user: { id: 'u1', roles: ['user'] }, loading: false };
    renderAt('/nfc/rack/abc123');
    expect(screen.getByText('rack')).toBeInTheDocument();
    expect(screen.queryByTestId('from')).toBeNull();
  });
});

describe('still loading', () => {
  test('waits rather than redirecting — an unresolved session is not a signed-out one', () => {
    mockAuth = { user: null, loading: true };
    renderAt('/nfc/rack/abc123');
    expect(screen.queryByTestId('from')).toBeNull();
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });
});
