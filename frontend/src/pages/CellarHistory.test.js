import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
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
// POST /api/bottles/:id/restore ("Move back to cellar" on a card).
let restoreAnswer;
const api = vi.fn(async (url) => {
  if (url.startsWith('/api/cellars/c1/history?')) return answer(new URLSearchParams(url.split('?')[1]));
  if (url === '/api/cellars') return ok({ cellars: [CELLAR] });
  if (/^\/api\/bottles\/[^/]+\/restore$/.test(url)) return restoreAnswer();
  return ok({});
});

// "Add again" opens the shared Add more bottles dialog with the card's bottle.
vi.mock('../components/AddMoreBottlesModal', () => ({
  default: ({ bottle, onAdded, onClose, copyDetailsDefault }) => (
    <div data-testid="add-more">
      {bottle._id}|copy:{String(copyDetailsDefault)}
      <button type="button" onClick={() => onAdded(2)}>add-two</button>
      <button type="button" onClick={onClose}>close-add</button>
    </div>
  ),
}));

beforeEach(() => {
  api.mockClear();
  restoreAnswer = () => ok({ bottle: {} });
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

test('Back from a bottle finds the same search and scope (kept per cellar for this tab)', async () => {
  const m = new Map();
  vi.stubGlobal('sessionStorage', {
    getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k), clear: () => m.clear(),
  });
  try {
    sessionStorage.setItem('cellarion.historyView.c1', JSON.stringify({ filters: { search: 'barolo' }, scope: ['c1'] }));
    answer = () => page([bottle('b1', 'drank', 9)]);
    renderPage();
    await waitFor(() => expect(historyCalls().length).toBeGreaterThan(0));
    // The very first request already searches: no unfiltered load first.
    expect(historyCalls()[0].get('search')).toBe('barolo');
    expect(screen.getByDisplayValue('barolo')).toBeInTheDocument();
  } finally {
    vi.unstubAllGlobals();
  }
});

test('a link to the history opens it fresh (only Back finds the kept search)', async () => {
  const m = new Map();
  vi.stubGlobal('sessionStorage', {
    getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k), clear: () => m.clear(),
  });
  try {
    sessionStorage.setItem('cellarion.historyView.c1', JSON.stringify({ filters: { search: 'barolo' }, scope: ['c1'] }));
    answer = () => page([bottle('b1', 'drank', 9)]);
    function Start() {
      const navigate = useNavigate();
      return <button type="button" onClick={() => navigate('/cellars/c1/history')}>to history</button>;
    }
    render(
      <MemoryRouter initialEntries={['/start']}>
        <Routes>
          <Route path="/start" element={<Start />} />
          <Route path="/cellars/:id/history" element={<CellarHistory />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText('to history'));
    await waitFor(() => expect(historyCalls().length).toBeGreaterThan(0));
    expect(historyCalls()[0].get('search')).toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }
});

test('a search with no matches says so — never "nothing taken out yet"', async () => {
  const m = new Map();
  vi.stubGlobal('sessionStorage', {
    getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k), clear: () => m.clear(),
  });
  try {
    // Back to a history whose kept search finds nothing.
    sessionStorage.setItem('cellarion.historyView.c1', JSON.stringify({ filters: { search: 'zzz' }, scope: ['c1'] }));
    answer = () => page([], { total: 0, reasonCounts: { drank: 0, gifted: 0, sold: 0, other: 0 } });
    renderPage();
    expect(await screen.findByText('cellarDetail.noSearchResults')).toBeInTheDocument();
    expect(screen.queryByText('history.emptyHistoryHint')).toBeNull();
    expect(screen.queryByText(/^history.noHistory/)).toBeNull(); // the subtitle too
  } finally {
    vi.unstubAllGlobals();
  }
});

test('a filter and a search that find nothing say so once', async () => {
  const m = new Map();
  vi.stubGlobal('sessionStorage', {
    getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k), clear: () => m.clear(),
  });
  try {
    sessionStorage.setItem('cellarion.historyView.c1', JSON.stringify({ filters: { search: 'zzz', type: ['Rosé'] }, scope: ['c1'] }));
    answer = () => page([], { total: 0, reasonCounts: { drank: 0, gifted: 0, sold: 0, other: 0 } });
    renderPage();
    expect(await screen.findAllByText('cellarDetail.noSearchResults')).toHaveLength(1);
    expect(screen.queryByText('history.noResults')).toBeNull();
    expect(screen.queryByText('history.emptyHistoryHint')).toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }
});

// A drink logged by mistake could only be undone from the bottle's own page,
// which nobody found from here: the card offers it too, within the same two
// days, and "Add again" puts new bottles of it in the cellar (the wishlist
// never does).
const justNow = (b) => ({ ...b, consumedLoggedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), vintage: '2016' });
const cardOf = (name) => screen.getByText(name).closest('.history-bottle-card');

test('a bottle taken out in the last two days moves back from its card: it leaves the list, the counts drop, and it says so', async () => {
  answer = () => page([justNow(bottle('b1', 'drank', 9)), bottle('b2', 'drank', 8)]);
  renderPage();
  await waitFor(() => expect(screen.getByText('Wine b1')).toBeInTheDocument());

  // Only the recent one: b2 left in January.
  expect(within(cardOf('Wine b2')).queryByRole('button', { name: /bottleDetail\.restore$/ })).toBeNull();
  const reads = historyCalls().length;
  fireEvent.click(within(cardOf('Wine b1')).getByRole('button', { name: /bottleDetail\.restore$/ }));

  await waitFor(() => expect(screen.queryByText('Wine b1')).toBeNull());
  const restores = api.mock.calls.filter(([u]) => u === '/api/bottles/b1/restore');
  expect(restores).toHaveLength(1);
  expect(restores[0][1]).toMatchObject({ method: 'POST' });
  expect(screen.getByRole('status')).toHaveTextContent('bottleNotice.restored');
  // Updated where it stands, not read again from the first page.
  expect(historyCalls().length).toBe(reads);
  expect(screen.getByText('history.bottleCount:3')).toBeInTheDocument();
  expect(within(section('history.reasonDrank')).getByRole('heading', { level: 2 })).toHaveTextContent('(2)');
  expect(cardNames(section('history.reasonDrank'))).toEqual(['Wine b2']);
});

test('the pages "Load more" brought are kept when a bottle moves back', async () => {
  answer = (q) => (q.get('reason') === 'drank'
    ? page([bottle('b3', 'drank', 2)], { remaining: 0 })
    : page([justNow(bottle('b1', 'drank', 9)), bottle('b2', 'drank', 8)]));
  renderPage();
  await waitFor(() => expect(screen.getByText('Wine b1')).toBeInTheDocument());
  fireEvent.click(within(section('history.reasonDrank')).getByRole('button', { name: 'cellarDetail.loadMore' }));
  await waitFor(() => expect(screen.getByText('Wine b3')).toBeInTheDocument());

  fireEvent.click(within(cardOf('Wine b1')).getByRole('button', { name: /bottleDetail\.restore$/ }));

  await waitFor(() => expect(screen.queryByText('Wine b1')).toBeNull());
  expect(cardNames(section('history.reasonDrank'))).toEqual(['Wine b2', 'Wine b3']);
});

test('a rate-limited move back is worded with the wait, not the limiter\'s English', async () => {
  answer = () => page([justNow(bottle('b1', 'drank', 9))]);
  restoreAnswer = () => ({
    ok: false, status: 429, headers: { get: (h) => (h === 'Retry-After' ? '300' : null) },
    json: async () => ({ error: 'Too many write requests, please try again later.' }),
  });
  renderPage();
  await waitFor(() => expect(screen.getByText('Wine b1')).toBeInTheDocument());

  fireEvent.click(within(cardOf('Wine b1')).getByRole('button', { name: /bottleDetail\.restore$/ }));

  const alert = await within(cardOf('Wine b1')).findByRole('alert');
  expect(alert).toHaveTextContent('errors.rateLimitedFor');
  expect(alert).not.toHaveTextContent('Too many write requests');
});

test('a refused move back says why on the card, and the list stays as it is', async () => {
  answer = () => page([justNow(bottle('b1', 'drank', 9))]);
  restoreAnswer = () => ({
    ok: false, status: 400,
    json: async () => ({ error: 'This bottle was removed too long ago to move back. Add it again as a new bottle instead.' }),
  });
  renderPage();
  await waitFor(() => expect(screen.getByText('Wine b1')).toBeInTheDocument());
  const reads = historyCalls().length;

  fireEvent.click(within(cardOf('Wine b1')).getByRole('button', { name: /bottleDetail\.restore$/ }));

  expect(await within(cardOf('Wine b1')).findByRole('alert')).toHaveTextContent('removed too long ago');
  expect(historyCalls().length).toBe(reads);
  expect(screen.queryByText('bottleNotice.restored')).toBeNull();
  // Free to try again.
  expect(within(cardOf('Wine b1')).getByRole('button', { name: /bottleDetail\.restore$/ })).not.toBeDisabled();
});

test('a cellar the member may only view: no Move back and no Add again', async () => {
  answer = () => page([justNow(bottle('b1', 'drank', 9))], { cellar: { ...CELLAR, userRole: 'viewer' } });
  renderPage();
  await waitFor(() => expect(screen.getByText('Wine b1')).toBeInTheDocument());

  expect(within(cardOf('Wine b1')).queryByRole('button', { name: /bottleDetail\.restore$/ })).toBeNull();
  expect(within(cardOf('Wine b1')).queryByRole('button', { name: 'bottleDetail.addAgain' })).toBeNull();
  // The wishlist stays.
  expect(within(cardOf('Wine b1')).getByText('history.addToWishlist')).toBeInTheDocument();
});

test('"Add again" opens Add more bottles with that bottle; once added, the line says so', async () => {
  answer = () => page([bottle('b1', 'drank', 9), bottle('b2', 'gifted', 8)]);
  renderPage();
  await waitFor(() => expect(screen.getByText('Wine b2')).toBeInTheDocument());

  fireEvent.click(within(cardOf('Wine b2')).getByRole('button', { name: 'bottleDetail.addAgain' }));
  // A new purchase: the old bottle's details are not copied unless asked for.
  expect(await screen.findByTestId('add-more')).toHaveTextContent('b2|copy:false');

  fireEvent.click(screen.getByText('add-two'));
  expect(screen.queryByTestId('add-more')).toBeNull();
  expect(screen.getByRole('status')).toHaveTextContent('bottleNotice.added:2');
});

test('a demo visitor gets no "Add again" (adding bottles is not open to the demo)', async () => {
  auth = { apiFetch: api, user: { id: 'u1', isDemo: true } };
  answer = () => page([bottle('b1', 'drank', 9)]);
  renderPage();
  await waitFor(() => expect(screen.getByText('Wine b1')).toBeInTheDocument());
  expect(screen.queryByRole('button', { name: 'bottleDetail.addAgain' })).toBeNull();
});
