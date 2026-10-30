import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Settings → API tokens: a token that still calls routes on their way out
// (backend services/apiDeprecationNotices) carries a short warning — which
// routes, the day they stop answering tokens, and where to read what replaces
// them. Every other token looks as it always did.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Components pass English fallbacks inline (a string, or defaultValue for
    // a plural) — return those so assertions read like the real UI.
    t: (key, a, b) => {
      const opts = a && typeof a === 'object' ? a : b;
      const text = typeof a === 'string' ? a : (opts?.defaultValue ?? key);
      return text.replace(/\{\{(\w+)\}\}/g, (m, name) => opts?.[name] ?? m);
    },
    i18n: { language: 'en-GB' },
  }),
}));
let auth;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

const ApiTokensSection = (await import('./ApiTokensSection')).default;

const SUNSET = '2027-05-01T00:00:00.000Z';
const token = (over = {}) => ({
  id: 't1', name: 'Home Assistant', scopes: ['read'],
  lastUsedAt: '2026-10-30T09:00:00.000Z', createdAt: '2026-01-10T09:00:00.000Z', deprecatedUse: null, ...over,
});

function renderWith(tokens) {
  auth = {
    user: { id: 'u1', hasPassword: true },
    apiFetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => tokens })),
  };
  return render(<MemoryRouter><ApiTokensSection /></MemoryRouter>);
}

const rowOf = (name) => screen.getByText(name).closest('li');

test('warns on the token still calling a deprecated route, and on no other', async () => {
  const { container } = renderWith([
    token({ deprecatedUse: { routes: ['GET /api/cellars/:id'], sunset: SUNSET, firstAt: '2026-10-29T08:00:00.000Z', lastAt: '2026-10-30T09:00:00.000Z' } }),
    token({ id: 't2', name: 'Backup script' }),
  ]);
  await screen.findByText('Home Assistant');

  const warnings = container.querySelectorAll('.api-token-deprecated');
  expect(warnings).toHaveLength(1);
  const warning = within(rowOf('Home Assistant')).getByText(/Still calls a route/);
  expect(warning).toBe(warnings[0]);
  // The shared warning colours, in both themes.
  expect(warning).toHaveClass('alert', 'alert-warning');
  // The day, in the user's language, as a UTC date (the sunset is 00:00 UTC).
  expect(warning).toHaveTextContent('Still calls a route that API tokens can no longer use from 1 May 2027: GET /api/cellars/:id.');
  expect(within(warning).getByText('GET /api/cellars/:id').tagName).toBe('CODE');
  expect(within(warning).getByRole('link', { name: 'What to use instead' })).toHaveAttribute('href', '/developers');

  expect(within(rowOf('Backup script')).queryByText(/Still calls/)).toBeNull();
});

test('several routes read as a list; a list without any marker shows no warning', async () => {
  const { container, unmount } = renderWith([
    token({ deprecatedUse: { routes: ['GET /api/cellars/:id', 'GET /api/stats/value-history'], sunset: SUNSET } }),
  ]);
  await screen.findByText('Home Assistant');
  const warning = container.querySelector('.api-token-deprecated');
  expect(warning).toHaveTextContent('Still calls routes that API tokens can no longer use from 1 May 2027: GET /api/cellars/:id, GET /api/stats/value-history.');
  unmount();

  // An older server sends no deprecatedUse at all.
  const plain = token();
  delete plain.deprecatedUse;
  const second = renderWith([plain, token({ id: 't2', name: 'Backup script' })]);
  await screen.findByText('Backup script');
  expect(second.container.querySelector('.api-token-deprecated')).toBeNull();
});
