import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// The cellar's audit log names "Move back to cellar" and the bulk Undo of a
// "mark as drunk" in words, as it names the take-out itself — not as raw
// action keys.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k, o) => (o && typeof o === 'object' ? `${k}:${JSON.stringify(o)}` : k) }),
}));

let auth;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const api = vi.fn(async (url) => {
  if (url === '/api/cellars/c1') return ok({ cellar: { _id: 'c1', name: 'Home' } });
  if (url === '/api/cellars/c1/audit') {
    return ok({
      logs: [
        { _id: 'l1', action: 'bottle.bulk_restore', detail: { requested: 4, done: 3, skipped: 1 }, timestamp: '2026-10-17T10:00:00.000Z', actor: { userId: { username: 'anna' } } },
        { _id: 'l2', action: 'bottle.restore', detail: { from: 'drank' }, timestamp: '2026-10-17T09:59:00.000Z', actor: { userId: { username: 'anna' } } },
      ],
    });
  }
  return ok({});
});

const { default: CellarAudit } = await import('./CellarAudit');

test('a bulk Undo and a single move back read as words, with the bulk count', async () => {
  auth = { apiFetch: api, user: { id: 'u1' } };
  render(
    <MemoryRouter initialEntries={['/cellars/c1/audit']}>
      <Routes><Route path="/cellars/:id/audit" element={<CellarAudit />} /></Routes>
    </MemoryRouter>,
  );

  expect(await screen.findByText('cellarAudit.actions.bottleBulkRestore')).toBeInTheDocument();
  expect(screen.getByText('— cellarAudit.bulkRestoreDetail:{"done":3,"requested":4}')).toBeInTheDocument();
  expect(screen.getByText('cellarAudit.actions.bottleRestore')).toBeInTheDocument();
  expect(screen.queryByText('bottle.bulk_restore')).toBeNull();
});
