/**
 * The list of every curator question addressed to the member: the ones
 * waiting for an answer grouped by the cellar their bottle is in (by name,
 * "not in a cellar" last, newest first inside a group), then the answered
 * ones; an empty state; a retry; and a late answer never replacing a newer one.
 */
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const auth = vi.hoisted(() => ({ apiFetch: null }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key) }),
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch: auth.apiFetch }) }));
// The card says which question it was handed and which intro line it got.
vi.mock('../components/bottle/OwnerInquiryCard', () => ({
  default: ({ inquiry, intro }) => <div data-testid="card">{inquiry._id}|{intro || 'default-intro'}</div>,
}));

const CuratorQuestions = (await import('./CuratorQuestions')).default;

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const WINE = { _id: 'w1', name: 'Barolo', producer: 'Pira' };
const SUMMER = { _id: 'c2', name: 'Summer house' };
const FLAT = { _id: 'c1', name: 'apartment' };
const q = (id, over = {}) => ({
  _id: id, status: 'open', question: `Question ${id}?`, wine: WINE, responded: false,
  myResponse: null, curatorReply: null, cellar: null, vintage: null, createdAt: '2026-11-01T00:00:00.000Z', ...over,
});

const renderPage = () => render(<MemoryRouter><CuratorQuestions /></MemoryRouter>);
const cardIds = (container) => within(container).getAllByRole('listitem')
  .map((li) => li.querySelector('[data-testid="card"]')?.textContent.split('|')[0] || li.querySelector('blockquote')?.textContent);

beforeEach(() => {
  auth.apiFetch = vi.fn();
});

test('waiting questions grouped by cellar, by name, with "not in a cellar" last and the newest first in each group', async () => {
  auth.apiFetch.mockResolvedValue(reply(200, { inquiries: [
    q('q4', { createdAt: '2026-11-15T00:00:00.000Z' }), // newest, but in no cellar
    q('q3', { cellar: SUMMER, vintage: 'NV', createdAt: '2026-11-10T00:00:00.000Z' }),
    q('q1', { cellar: SUMMER, vintage: '2016', createdAt: '2026-11-01T00:00:00.000Z' }),
    q('q2', { cellar: FLAT, status: 'answered', createdAt: '2026-10-01T00:00:00.000Z' }), // someone else answered: still waiting for this member
  ] }));
  renderPage();

  const waiting = (await screen.findByRole('heading', { name: 'Waiting for your answer' })).closest('section');
  expect(within(waiting).getAllByRole('heading', { level: 3 }).map((h) => h.textContent))
    .toEqual(['apartment', 'Summer house', 'Not in any of your cellars']);
  expect(cardIds(waiting)).toEqual(['q2', 'q3', 'q1', 'q4']);
  expect(auth.apiFetch).toHaveBeenCalledWith('/api/owner-inquiries/mine');

  // Wine, producer and the vintage when known.
  expect(screen.getByText('2016', { exact: false }).textContent).toBe('Pira — Barolo 2016');
  // Each one links to its bottle through the question's own page.
  const links = within(waiting).getAllByRole('link', { name: 'Open the bottle' });
  expect(links.map((a) => a.getAttribute('href'))).toEqual(['/questions/q2', '/questions/q3', '/questions/q1', '/questions/q4']);
  // A bottle in no cellar of theirs: the card does not say "you own a bottle of it".
  const cards = within(waiting).getAllByTestId('card').map((c) => c.textContent);
  expect(cards[0]).toBe('q2|default-intro');
  expect(cards[3]).toMatch(/^q4\|If you remember the label/);
  expect(screen.queryByRole('heading', { name: 'Answered' })).toBeNull();
});

test('answered questions follow: waiting for the curators, closed, or with the curator reply on the card', async () => {
  auth.apiFetch.mockResolvedValue(reply(200, { inquiries: [
    q('open1', { cellar: FLAT }),
    q('waits', { status: 'answered', responded: true, myResponse: 'The back label says E. Pira.', createdAt: '2026-11-05T00:00:00.000Z' }),
    q('replied', { status: 'resolved', responded: true, myResponse: 'E. Pira', curatorReply: 'Thanks — fixed.', createdAt: '2026-11-03T00:00:00.000Z' }),
    q('closed', { status: 'resolved', responded: true, myResponse: 'Not sure', createdAt: '2026-11-04T00:00:00.000Z' }),
  ] }));
  renderPage();

  const answered = (await screen.findByRole('heading', { name: 'Answered' })).closest('section');
  const items = within(answered).getAllByRole('listitem');
  expect(items).toHaveLength(3);
  // Newest first.
  expect(items[0]).toHaveTextContent('The back label says E. Pira.');
  expect(items[0]).toHaveTextContent('You answered this question. Thank you — the curators will take it from here.');
  expect(within(items[0]).queryByTestId('card')).toBeNull();
  expect(items[1]).toHaveTextContent('The curators have closed this question. Thank you for your answer.');
  expect(within(items[2]).getByTestId('card')).toHaveTextContent('replied|default-intro');

  const waiting = screen.getByRole('heading', { name: 'Waiting for your answer' }).closest('section');
  expect(cardIds(waiting)).toEqual(['open1']);
  // Waiting first, answered after.
  expect(waiting.compareDocumentPosition(answered) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test('nothing at all: said plainly, with a way back to the cellars', async () => {
  auth.apiFetch.mockResolvedValue(reply(200, { inquiries: [] }));
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
  expect(await screen.findByText('Could not load your questions.')).toBeInTheDocument();
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
  expect(screen.getByTestId('card')).toHaveTextContent('newer|');
});
