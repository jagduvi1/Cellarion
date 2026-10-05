import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import CellarOnOrder from './CellarOnOrder';

// Bottles bought for a cellar that have not arrived yet: grouped per
// delivery, and "Mark as arrived" turns some or all of a group into ordinary
// bottles (one request: single arrive for one bottle, bulk for several).

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k, opts) => {
      if (opts && opts.count !== undefined) return `${k}:${opts.count}`;
      if (opts && opts.month) return `${k}:${opts.month}`;
      return k;
    },
    i18n: { language: 'en-GB' },
  }),
}));

let auth;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const CELLAR = { _id: 'c1', name: 'Home', userRole: 'owner' };
const ordered = (id, month) => ({
  _id: id, status: 'ordered', vintage: '2023', bottleSize: '750ml', price: 60, currency: 'EUR',
  expectedArrival: month, wineDefinition: { _id: 'w1', name: 'Léoville Barton', producer: 'Barton' },
});
const MARCH = '2027-03-01T12:00:00Z';

let api;
beforeEach(() => {
  api = vi.fn(async (url) => {
    if (url === '/api/cellars/c1/on-order') {
      return ok({ cellar: CELLAR, bottles: [ordered('b1', MARCH), ordered('b2', MARCH), ordered('b3', MARCH)], total: 3 });
    }
    if (url === '/api/bottles/bulk') return ok({ done: 2, doneIds: ['b1', 'b2'], skipped: [] });
    return ok({});
  });
  auth = { apiFetch: api, user: { id: 'u1' } };
});

const renderPage = () => render(
  <MemoryRouter initialEntries={['/cellars/c1/on-order']}>
    <Routes><Route path="/cellars/:id/on-order" element={<CellarOnOrder />} /></Routes>
  </MemoryRouter>,
);

test('one row per delivery with its count, month and the paid total', async () => {
  renderPage();
  expect(await screen.findByText('Léoville Barton')).toBeInTheDocument();
  expect(screen.getByText(/onOrder.qty:3/)).toBeInTheDocument();
  expect(screen.getByText('onOrder.expected:March 2027')).toBeInTheDocument();
  expect(screen.getByText('onOrder.paidTotal')).toBeInTheDocument();
});

test('marking two of three as arrived sends ONE bulk request and leaves the third on the list', async () => {
  renderPage();
  fireEvent.click(await screen.findByText('onOrder.markArrived'));
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '2' } });
  fireEvent.click(screen.getByText('onOrder.confirmArrived'));

  await waitFor(() => expect(screen.getByText('onOrder.arrivedNote:2')).toBeInTheDocument());
  const bulk = api.mock.calls.find(([u]) => u === '/api/bottles/bulk');
  const body = JSON.parse(bulk[1].body);
  expect(body.action).toBe('arrive');
  expect(body.bottleIds).toEqual(['b1', 'b2']);
  expect(screen.getByText(/onOrder.qty:1/)).toBeInTheDocument();
});

test('a viewer sees the list without the arrive action', async () => {
  api.mockImplementation(async (url) => (url === '/api/cellars/c1/on-order'
    ? ok({ cellar: { ...CELLAR, userRole: 'viewer' }, bottles: [ordered('b1', null)], total: 1 })
    : ok({})));
  renderPage();
  expect(await screen.findByText('onOrder.noDate')).toBeInTheDocument();
  expect(screen.queryByText('onOrder.markArrived')).toBeNull();
});

test('nothing on order shows the empty state', async () => {
  api.mockImplementation(async () => ok({ cellar: CELLAR, bottles: [], total: 0 }));
  renderPage();
  expect(await screen.findByText('onOrder.emptyTitle')).toBeInTheDocument();
});
