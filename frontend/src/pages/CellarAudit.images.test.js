import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// Photo changes on a cellar's bottles (added, linked, default chosen) appear in
// the cellar's audit log in words, with a photo icon — never as raw action keys.

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
        { _id: 'l1', action: 'image.attach', detail: { via: 'web', imageId: 'i1' }, timestamp: '2026-10-24T10:00:00.000Z', actor: { userId: { username: 'anna' } } },
        { _id: 'l2', action: 'image.link', detail: { imageIds: ['i2'], via: 'web' }, timestamp: '2026-10-24T09:59:00.000Z', actor: { userId: { username: 'anna' } } },
        { _id: 'l3', action: 'image.default', detail: { imageId: 'i1', prev: null }, timestamp: '2026-10-24T09:58:00.000Z', actor: { userId: { username: 'anna' } } },
      ],
    });
  }
  return ok({});
});

const { default: CellarAudit } = await import('./CellarAudit');

test('photo rows read as words with a photo icon, not raw action names', async () => {
  auth = { apiFetch: api, user: { id: 'u1' } };
  const { container } = render(
    <MemoryRouter initialEntries={['/cellars/c1/audit']}>
      <Routes><Route path="/cellars/:id/audit" element={<CellarAudit />} /></Routes>
    </MemoryRouter>,
  );

  expect(await screen.findByText('cellarAudit.actions.imageAttach')).toBeInTheDocument();
  expect(screen.getByText('cellarAudit.actions.imageLink')).toBeInTheDocument();
  expect(screen.getByText('cellarAudit.actions.imageDefault')).toBeInTheDocument();
  for (const raw of ['image.attach', 'image.link', 'image.default']) {
    expect(screen.queryByText(raw)).toBeNull();
  }
  const icons = [...container.querySelectorAll('.cellar-audit-icon')].map((el) => el.textContent);
  expect(icons).toEqual(['📷', '📷', '📷']);
});
