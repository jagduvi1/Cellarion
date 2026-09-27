import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import CellarHistory from './CellarHistory';

// The history is paged (2026-09-27): it used to receive and render every
// consumed bottle at once, and a history imported from another app can hold
// thousands. The page asks for 50 at a time and appends the next page on
// "Load more"; the summary and the section headers show the server's counts
// for the whole history, not only what is loaded.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k, opts) => (opts && opts.count !== undefined ? `${k}:${opts.count}` : k), i18n: { language: 'en' } }),
}));

let auth;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const CELLAR = { _id: 'c1', name: 'Home', userRole: 'owner' };
const bottle = (id, reason) => ({
  _id: id, status: reason, consumedReason: reason, consumedAt: '2026-01-01T00:00:00.000Z',
  wineDefinition: { _id: `w-${id}`, name: `Wine ${id}`, producer: 'P' },
});

const PAGES = {
  0: [bottle('b1', 'drank'), bottle('b2', 'drank')],
  2: [bottle('b3', 'gifted')],
};
const api = vi.fn(async (url) => {
  if (url.startsWith('/api/cellars/c1/history?')) {
    const skip = Number(new URLSearchParams(url.split('?')[1]).get('skip'));
    return ok({
      cellar: CELLAR,
      bottles: PAGES[skip] || [],
      total: 3,
      reasonCounts: { drank: 2, gifted: 1, sold: 0, other: 0 },
      facets: {}, baseFacets: {}, facetMeta: {},
    });
  }
  if (url === '/api/cellars') return ok({ cellars: [CELLAR] });
  return ok({});
});

beforeEach(() => {
  api.mockClear();
  auth = { apiFetch: api, user: { id: 'u1' } };
});

const renderPage = () => render(
  <MemoryRouter initialEntries={['/cellars/c1/history']}>
    <Routes><Route path="/cellars/:id/history" element={<CellarHistory />} /></Routes>
  </MemoryRouter>,
);
const historyCalls = () => api.mock.calls.map(([u]) => u).filter((u) => u.startsWith('/api/cellars/c1/history?'));

test('asks for one page; the summary shows the whole history\'s counts; "Load more" appends the next page', async () => {
  renderPage();

  await waitFor(() => expect(screen.getByText('Wine b1')).toBeInTheDocument());
  const first = new URLSearchParams(historyCalls()[0].split('?')[1]);
  expect(first.get('limit')).toBe('50');
  expect(first.get('skip')).toBe('0');
  expect(screen.getByText('history.bottleCount:3')).toBeInTheDocument();

  // The gifted bottle isn't loaded yet, but the summary counts it.
  const giftedPill = screen.getAllByText('history.reasonGifted')[0].closest('.history-summary-pill');
  expect(within(giftedPill).getByText('1')).toBeInTheDocument();
  expect(screen.queryByText('Wine b3')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'cellarDetail.loadMore' }));

  await waitFor(() => expect(screen.getByText('Wine b3')).toBeInTheDocument());
  expect(new URLSearchParams(historyCalls()[1].split('?')[1]).get('skip')).toBe('2');
  expect(screen.getByText('Wine b1')).toBeInTheDocument(); // appended, not replaced
  expect(screen.queryByRole('button', { name: 'cellarDetail.loadMore' })).toBeNull();
});
