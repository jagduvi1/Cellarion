import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import CellarHistory from './CellarHistory';

// The history is paged (2026-09-27): it used to receive and render every
// consumed bottle at once, and a history imported from another app can hold
// thousands. The page asks for 50 at a time: first the newest bottles of every
// section, then each section's "Load more" asks for that section's next page,
// after the last bottle it shows. The summary and the section headers show the
// server's counts for the whole history, not only what is loaded.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k, opts) => (opts && opts.count !== undefined ? `${k}:${opts.count}` : k), i18n: { language: 'en' } }),
}));

let auth;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const CELLAR = { _id: 'c1', name: 'Home', userRole: 'owner' };
const bottle = (id, reason, day) => ({
  _id: id, status: reason, consumedReason: reason, consumedAt: `2026-01-${String(day).padStart(2, '0')}T00:00:00.000Z`,
  wineDefinition: { _id: `w-${id}`, name: `Wine ${id}`, producer: 'P' },
});
const COUNTS = { drank: 3, gifted: 1, sold: 0, other: 0 };
const page = (bottles, extra = {}) => ok({
  cellar: CELLAR, bottles, total: 4, reasonCounts: COUNTS, facets: {}, baseFacets: {}, facetMeta: {}, ...extra,
});

// Answers per request, by its query: the test sets `answer`.
let answer;
const api = vi.fn(async (url) => {
  if (url.startsWith('/api/cellars/c1/history?')) return answer(new URLSearchParams(url.split('?')[1]));
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
const historyCalls = () => api.mock.calls.map(([u]) => u).filter((u) => u.startsWith('/api/cellars/c1/history?'))
  .map((u) => new URLSearchParams(u.split('?')[1]));
const section = (labelKey) => screen.getByRole('heading', { name: new RegExp(labelKey) }).closest('section');
const cardNames = (el) => within(el).queryAllByRole('heading', { level: 3 }).map((h) => h.textContent);

test('each section shows the whole history\'s count and loads its own next page after its last bottle', async () => {
  answer = (q) => {
    if (!q.get('reason')) return page([bottle('b1', 'drank', 9), bottle('b2', 'drank', 8)]);
    // b2 is already listed (it moved in the order since, say): not repeated.
    if (q.get('reason') === 'drank') return page([bottle('b2', 'drank', 8), bottle('b3', 'drank', 2)], { remaining: 0 });
    return page([bottle('g1', 'gifted', 5)], { remaining: 0 });
  };
  renderPage();

  await waitFor(() => expect(screen.getByText('Wine b1')).toBeInTheDocument());
  const first = historyCalls()[0];
  expect(first.get('limit')).toBe('50');
  expect(first.get('reason')).toBeNull();
  expect(first.get('before')).toBeNull();
  expect(screen.getByText('history.bottleCount:4')).toBeInTheDocument();

  // Nothing of the gifted section is loaded yet, but it shows, with its count
  // and its own button; the summary counts it too.
  const giftedPill = screen.getAllByText('history.reasonGifted')[0].closest('.history-summary-pill');
  expect(within(giftedPill).getByText('1')).toBeInTheDocument();
  expect(cardNames(section('history.reasonGifted'))).toEqual([]);
  expect(within(section('history.reasonGifted')).getByRole('button', { name: 'cellarDetail.loadMore' })).toBeInTheDocument();

  // The drank section's next page starts after b2, and lands in that section.
  fireEvent.click(within(section('history.reasonDrank')).getByRole('button', { name: 'cellarDetail.loadMore' }));
  await waitFor(() => expect(screen.getByText('Wine b3')).toBeInTheDocument());
  const more = historyCalls()[1];
  expect(more.get('reason')).toBe('drank');
  expect(more.get('before')).toBe('2026-01-08T00:00:00.000Z|b2');
  expect(cardNames(section('history.reasonDrank'))).toEqual(['Wine b1', 'Wine b2', 'Wine b3']);
  expect(within(section('history.reasonDrank')).queryByRole('button', { name: 'cellarDetail.loadMore' })).toBeNull();

  // The gifted section's first page: no cursor.
  fireEvent.click(within(section('history.reasonGifted')).getByRole('button', { name: 'cellarDetail.loadMore' }));
  await waitFor(() => expect(screen.getByText('Wine g1')).toBeInTheDocument());
  const gifted = historyCalls()[2];
  expect(gifted.get('reason')).toBe('gifted');
  expect(gifted.get('before')).toBeNull();
  expect(screen.queryByRole('button', { name: 'cellarDetail.loadMore' })).toBeNull();
});

test('a "Load more" answer that arrives after the search changed is dropped; the buttons wait for the new list', async () => {
  let releaseMore;
  answer = (q) => {
    if (q.get('search')) return page([bottle('s1', 'drank', 7)], { total: 1, reasonCounts: { drank: 1, gifted: 0, sold: 0, other: 0 } });
    if (!q.get('reason')) return page([bottle('b1', 'drank', 9), bottle('b2', 'drank', 8)]);
    return new Promise((resolve) => { releaseMore = () => resolve(page([bottle('b3', 'drank', 2)], { remaining: 0 })); });
  };
  renderPage();
  await waitFor(() => expect(screen.getByText('Wine b1')).toBeInTheDocument());

  const drankMore = within(section('history.reasonDrank')).getByRole('button', { name: 'cellarDetail.loadMore' });
  fireEvent.click(drankMore);
  // While a page is on its way, every section's button waits.
  await waitFor(() => expect(within(section('history.reasonGifted')).getByRole('button', { name: 'cellarDetail.loadMore' })).toBeDisabled());

  fireEvent.change(screen.getByLabelText('cellarDetail.searchPlaceholder'), { target: { value: 'sancerre' } });
  await waitFor(() => expect(screen.getByText('Wine s1')).toBeInTheDocument(), { timeout: 2000 });

  releaseMore();
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.queryByText('Wine b3')).toBeNull();
  expect(screen.queryByText('Wine b1')).toBeNull();
  expect(cardNames(section('history.reasonDrank'))).toEqual(['Wine s1']);
});

// Support ticket 2026-10-09 (follow-up): the vintage page must stay reachable
// once the last bottle is drunk — from the history card, since the cellar
// list's group is gone by then.
test('a history card links to the vintage page of its wine and vintage', async () => {
  answer = (q) => (q.get('reason') ? page([], { remaining: 0 }) : page([{ ...bottle('b1', 'drank', 9), vintage: '2015' }]));
  renderPage();
  await waitFor(() => expect(screen.getByText('Wine b1')).toBeInTheDocument());
  expect(screen.getByText('history.vintagePage')).toHaveAttribute('href', '/cellars/c1/vintages/w-b1/2015');
});
