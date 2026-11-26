import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// A move row in the cellar's activity log names the other cellar, except when
// the move handed the bottle to or from another account: then that account's
// cellar is "a cellar of another account" (services/rackOps leaves its name
// out of the row).

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k, o) => (o && typeof o === 'object' ? `${k}:${JSON.stringify(o)}` : k) }),
}));

let auth;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const row = (id, action, detail) => ({ _id: id, action, detail, timestamp: '2026-11-26T10:00:00.000Z', actor: { userId: { username: 'andrew' } } });
const api = vi.fn(async (url) => {
  if (url === '/api/cellars/c1') return ok({ cellar: { _id: 'c1', name: 'Home' } });
  if (url === '/api/cellars/c1/audit') {
    return ok({
      logs: [
        row('l1', 'bottle.move.in', { fromOtherAccount: true }),
        row('l2', 'bottle.move.out', { toOtherAccount: true }),
        row('l3', 'bottle.move.out', { toCellarId: 'c2', toCellarName: 'Attic' }),
      ],
    });
  }
  return ok({});
});

const { default: CellarAudit } = await import('./CellarAudit');

test('a move to or from another account names no cellar of that account', async () => {
  auth = { apiFetch: api, user: { id: 'u1' } };
  render(
    <MemoryRouter initialEntries={['/cellars/c1/audit']}>
      <Routes><Route path="/cellars/:id/audit" element={<CellarAudit />} /></Routes>
    </MemoryRouter>,
  );

  expect(await screen.findByText(/← cellarAudit\.otherAccountCellar/)).toBeInTheDocument();
  expect(screen.getByText(/→ cellarAudit\.otherAccountCellar/)).toBeInTheDocument();
  expect(screen.getByText(/→ Attic/)).toBeInTheDocument();
});
