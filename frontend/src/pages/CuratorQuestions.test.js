/**
 * The list of every curator question addressed to the member: the ones
 * waiting for an answer grouped by the cellar where a bottle of the wine is
 * (by name in the app's language, "not in a cellar" last, newest first inside
 * a group), then the answered ones; one heading outline; answering in place
 * with the real card; an empty state; a retry; and a late answer never
 * replacing a newer one.
 */
import { render, screen, fireEvent, within, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const auth = vi.hoisted(() => ({ apiFetch: null }));
const lang = vi.hoisted(() => ({ current: 'en' }));

// English fallbacks with their {{placeholders}} filled, as the real UI reads.
const t = vi.hoisted(() => (key, fallback, opts) => (typeof fallback === 'string'
  ? fallback.replace(/{{(\w+)}}/g, (_, name) => String(opts?.[name] ?? ''))
  : key));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t, i18n: { language: lang.current } }),
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch: auth.apiFetch }) }));

const CuratorQuestions = (await import('./CuratorQuestions')).default;

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const WINE = { _id: 'w1', name: 'Barolo', producer: 'Pira' };
const SUMMER = { _id: 'c2', name: 'Summer house' };
const FLAT = { _id: 'c1', name: 'apartment' };
const q = (id, over = {}) => ({
  _id: id, status: 'open', question: `Question ${id}?`, wine: WINE, responded: false,
  myResponse: null, curatorReply: null, cellar: null, vintage: null, createdAt: '2026-11-01T00:00:00.000Z', ...over,
});
// The list answers GET /mine; every other call fails the test loudly.
const serveList = (inquiries) => auth.apiFetch.mockImplementation(async (url) => {
  if (url === '/api/owner-inquiries/mine') return reply(200, { inquiries });
  throw new Error(`unexpected request ${url}`);
});

const renderPage = () => render(<MemoryRouter><CuratorQuestions /></MemoryRouter>);
// Each item's question, in order (its first quote is always the question).
const questionIds = (container) => within(container).getAllByRole('listitem')
  .map((li) => li.querySelector('blockquote').textContent.replace(/^Question (\w+)\?$/, '$1'));
const OWN_INTRO = /You own a bottle of it/;
const NO_CELLAR_INTRO = /If you remember the label/;

beforeEach(() => {
  auth.apiFetch = vi.fn();
  lang.current = 'en';
});

test('waiting questions grouped by cellar, by name, with "not in a cellar" last and the newest first in each group', async () => {
  serveList([
    q('q4', { createdAt: '2026-11-15T00:00:00.000Z' }), // newest, but in no cellar
    q('q3', { cellar: SUMMER, vintage: 'NV', createdAt: '2026-11-10T00:00:00.000Z' }),
    q('q1', { cellar: SUMMER, vintage: '2016', createdAt: '2026-11-01T00:00:00.000Z' }),
    q('q2', { cellar: FLAT, createdAt: '2026-10-01T00:00:00.000Z' }),
  ]);
  renderPage();

  const waiting = (await screen.findByRole('heading', { name: 'Waiting for your answer' })).closest('section');
  expect(within(waiting).getAllByRole('heading', { level: 3 }).map((h) => h.textContent))
    .toEqual(['apartment', 'Summer house', 'Not in any of your cellars']);
  expect(questionIds(waiting)).toEqual(['q2', 'q3', 'q1', 'q4']);
  expect(auth.apiFetch).toHaveBeenCalledWith('/api/owner-inquiries/mine');

  // Wine, producer and the vintage when known.
  expect(screen.getByText('2016', { exact: false }).textContent).toBe('Pira — Barolo 2016');
  const items = within(waiting).getAllByRole('listitem');
  // A bottle in no cellar of theirs: the card does not say "you own a bottle of it".
  expect(items[0]).toHaveTextContent(OWN_INTRO);
  expect(items[3]).toHaveTextContent(NO_CELLAR_INTRO);
  expect(items[3]).not.toHaveTextContent(OWN_INTRO);
  expect(screen.queryByRole('heading', { name: 'Answered' })).toBeNull();
});

test('"Open the bottle" only where there is a bottle on a shelf to open', async () => {
  serveList([
    q('none', { createdAt: '2026-11-15T00:00:00.000Z' }),
    q('flat', { cellar: FLAT }),
    q('gone', { status: 'resolved', responded: true, myResponse: 'E. Pira' }),
    q('kept', { status: 'answered', responded: true, myResponse: 'E. Pira', cellar: SUMMER }),
  ]);
  renderPage();

  await screen.findByRole('heading', { name: 'Answered' });
  // Through the question's own page, which goes on to the bottle.
  expect(screen.getAllByRole('link', { name: 'Open the bottle' }).map((a) => a.getAttribute('href')))
    .toEqual(['/questions/flat', '/questions/kept']);
});

test('the cellars are sorted in the app\'s language', async () => {
  const rows = [
    q('z', { cellar: { _id: 'cz', name: 'Zeta' } }),
    q('a', { cellar: { _id: 'ca', name: 'Ängen' } }),
    q('b', { cellar: FLAT }),
  ];
  const cellarOrder = async () => {
    const waiting = (await screen.findByRole('heading', { name: 'Waiting for your answer' })).closest('section');
    return within(waiting).getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
  };

  serveList(rows);
  const { unmount } = renderPage();
  expect(await cellarOrder()).toEqual(['Ängen', 'apartment', 'Zeta']);
  unmount();

  // In Swedish Ä comes after Z.
  lang.current = 'sv';
  renderPage();
  expect(await cellarOrder()).toEqual(['apartment', 'Zeta', 'Ängen']);
});

test('one heading outline: each card sits under its cellar or section, and each answer box names its wine', async () => {
  serveList([
    q('open1', { cellar: FLAT }),
    q('open2', { wine: { _id: 'w2', name: 'Chablis', producer: 'Raveneau' }, createdAt: '2026-10-01T00:00:00.000Z' }),
    q('replied', { status: 'resolved', responded: true, myResponse: 'E. Pira', curatorReply: 'Thanks — fixed.' }),
  ]);
  renderPage();
  await screen.findByRole('heading', { name: 'Answered' });

  expect(screen.getAllByRole('heading').map((h) => [Number(h.tagName.slice(1)), h.textContent])).toEqual([
    [1, 'Questions from the curators'],
    [2, 'Waiting for your answer'],
    [3, 'apartment'],
    [4, 'A curator has a question about this wine'],
    [3, 'Not in any of your cellars'],
    [4, 'A curator has a question about this wine'],
    [2, 'Answered'],
    [3, 'A curator replied about this wine'],
  ]);
  expect(screen.getAllByRole('textbox').map((box) => box.getAttribute('aria-label'))).toEqual([
    'Your answer about Pira — Barolo',
    'Your answer about Raveneau — Chablis',
  ]);
  expect(screen.getByRole('textbox', { name: 'Your answer about Raveneau — Chablis' })).toBeInTheDocument();
});

test('an answer sent in place moves the question to "Answered" with the answer and the thank-you, without asking for the list again', async () => {
  auth.apiFetch.mockImplementation(async (url, opts) => {
    if (url === '/api/owner-inquiries/mine') {
      return reply(200, { inquiries: [
        q('q1', { cellar: FLAT }),
        q('q2', { wine: { _id: 'w2', name: 'Chablis', producer: 'Raveneau' }, createdAt: '2026-10-01T00:00:00.000Z' }),
      ] });
    }
    if (url === '/api/owner-inquiries/q1/respond' && opts?.method === 'POST') return reply(200, { message: 'ok', status: 'answered' });
    throw new Error(`unexpected request ${url}`);
  });
  renderPage();

  const box = await screen.findByRole('textbox', { name: 'Your answer about Pira — Barolo' });
  const firstItem = box.closest('li');
  expect(firstItem).toHaveTextContent('Question q1?');
  fireEvent.change(box, { target: { value: '  The back label says E. Pira e Figli.  ' } });
  fireEvent.click(within(firstItem).getByRole('button', { name: 'Send answer' }));

  const answered = (await screen.findByRole('heading', { name: 'Answered' })).closest('section');
  const [moved] = within(answered).getAllByRole('listitem');
  expect(moved).toHaveTextContent('Question q1?');
  expect(moved).toHaveTextContent('The back label says E. Pira e Figli.');
  expect(within(moved).getByRole('status')).toHaveTextContent('Thank you — your answer was sent to the curators and helps keep the shared registry accurate.');
  expect(within(moved).queryByRole('textbox')).toBeNull();
  // The member lands on the moved question, not on the page body. The page
  // moves focus in an effect, which can run after the heading is found.
  await waitFor(() => expect(moved).toHaveFocus());
  expect(within(moved).getByRole('link', { name: 'Open the bottle' })).toHaveAttribute('href', '/questions/q1');

  const waiting = screen.getByRole('heading', { name: 'Waiting for your answer' }).closest('section');
  expect(questionIds(waiting)).toEqual(['q2']);
  expect(within(waiting).queryByRole('heading', { name: 'apartment' })).toBeNull();
  // The list and the answer: nothing else.
  expect(auth.apiFetch.mock.calls.map(([url]) => url)).toEqual(['/api/owner-inquiries/mine', '/api/owner-inquiries/q1/respond']);
  expect(JSON.parse(auth.apiFetch.mock.calls[1][1].body)).toEqual({ response: 'The back label says E. Pira e Figli.' });
});

test('a refused answer leaves the question waiting, with the error on its card', async () => {
  auth.apiFetch.mockImplementation(async (url) => {
    if (url === '/api/owner-inquiries/mine') return reply(200, { inquiries: [q('q1', { cellar: FLAT })] });
    return reply(409, { error: 'This inquiry is no longer open' });
  });
  renderPage();

  fireEvent.change(await screen.findByRole('textbox', { name: 'Your answer about Pira — Barolo' }), { target: { value: 'An answer' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));

  expect(await screen.findByText('This inquiry is no longer open')).toBeInTheDocument();
  const waiting = screen.getByRole('heading', { name: 'Waiting for your answer' }).closest('section');
  expect(questionIds(waiting)).toEqual(['q1']);
  expect(screen.queryByRole('heading', { name: 'Answered' })).toBeNull();
});

test('answered questions follow: waiting for the curators, closed, or with the curator reply on the card', async () => {
  serveList([
    q('open1', { cellar: FLAT }),
    q('waits', { status: 'answered', responded: true, myResponse: 'The back label says E. Pira.', createdAt: '2026-11-05T00:00:00.000Z' }),
    q('replied', { status: 'resolved', responded: true, myResponse: 'E. Pira', curatorReply: 'Thanks — fixed.', createdAt: '2026-11-03T00:00:00.000Z' }),
    q('closed', { status: 'resolved', responded: true, myResponse: 'Not sure', createdAt: '2026-11-04T00:00:00.000Z' }),
  ]);
  renderPage();

  const answered = (await screen.findByRole('heading', { name: 'Answered' })).closest('section');
  const items = within(answered).getAllByRole('listitem');
  expect(items).toHaveLength(3);
  // Newest first.
  expect(questionIds(answered)).toEqual(['waits', 'closed', 'replied']);
  expect(items[0]).toHaveTextContent('The back label says E. Pira.');
  expect(items[0]).toHaveTextContent('You answered this question. Thank you — the curators will take it from here.');
  expect(within(items[0]).queryByRole('heading')).toBeNull();
  expect(items[1]).toHaveTextContent('The curators have closed this question. Thank you for your answer.');
  expect(within(items[2]).getByRole('heading', { name: 'A curator replied about this wine' })).toBeInTheDocument();
  expect(items[2]).toHaveTextContent('Thanks — fixed.');

  const waiting = screen.getByRole('heading', { name: 'Waiting for your answer' }).closest('section');
  expect(questionIds(waiting)).toEqual(['open1']);
  // Waiting first, answered after.
  expect(waiting.compareDocumentPosition(answered) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test('nothing at all: said plainly, with a way back to the cellars', async () => {
  serveList([]);
  renderPage();
  expect(await screen.findByText('No questions from the curators right now.')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Go to your cellars' })).toHaveAttribute('href', '/cellars');
  expect(screen.queryByRole('heading', { name: 'Waiting for your answer' })).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Answered' })).toBeNull();
});

test('a failed load offers a retry that asks again', async () => {
  auth.apiFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    .mockResolvedValueOnce(reply(500, { error: 'Failed to load owner inquiries' }))
    .mockResolvedValueOnce(reply(200, { inquiries: [q('q1', { cellar: FLAT })] }));
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load your questions.');
  expect(screen.getByRole('alert')).toHaveClass('alert', 'alert-error');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByRole('heading', { name: 'apartment' })).toBeInTheDocument();
  expect(auth.apiFetch).toHaveBeenCalledTimes(3);
});

test('a late answer to an earlier request never replaces the newer one', async () => {
  let answerFirst;
  const first = vi.fn(() => new Promise((resolve) => { answerFirst = resolve; }));
  auth.apiFetch = first;
  const { rerender } = renderPage();

  // A new session's apiFetch asks again before the first request answers.
  auth.apiFetch = vi.fn().mockResolvedValue(reply(200, { inquiries: [q('newer', { cellar: FLAT })] }));
  rerender(<MemoryRouter><CuratorQuestions /></MemoryRouter>);
  expect(await screen.findByRole('heading', { name: 'apartment' })).toBeInTheDocument();

  await act(async () => { answerFirst(reply(200, { inquiries: [q('stale', { cellar: SUMMER })] })); });
  expect(screen.queryByRole('heading', { name: 'Summer house' })).toBeNull();
  expect(screen.getByText('Question newer?')).toBeInTheDocument();
});
