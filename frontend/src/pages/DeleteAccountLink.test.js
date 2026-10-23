import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

vi.mock('react-i18next', () => {
  const t = (key, opts) => (opts && typeof opts === 'object' && 'count' in opts ? `${key}:${opts.count}` : key);
  return { useTranslation: () => ({ t }), Trans: ({ i18nKey }) => i18nKey };
});
vi.mock('../components/CellarionLogo', () => ({ default: () => null }));

const DeleteAccountLink = (await import('./DeleteAccountLink')).default;

// Shows the address bar's query so a test can see the token was dropped.
function Search() {
  return <div data-testid="search">{useLocation().search}</div>;
}
const at = (url) => render(
  <MemoryRouter initialEntries={[url]}>
    <Routes><Route path="/delete-account" element={<><DeleteAccountLink /><Search /></>} /></Routes>
  </MemoryRouter>
);
const answer = (status, body) => Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(body) });

let fetchMock;
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

// Mail scanners open links on their own: opening the page may only ASK which
// account the link is for, never delete it.
test('opening the link only previews the account, with the token in the body and gone from the address bar', async () => {
  fetchMock.mockReturnValueOnce(answer(200, { username: 'newbie', bottles: 23, supporter: false, deletionScheduledFor: null }));
  at('/delete-account?token=abc123');

  expect(await screen.findByText('deleteAccountLink.intro')).toBeInTheDocument();
  expect(screen.getByText('deleteAccountLink.bottles:23')).toBeInTheDocument();
  expect(screen.getByText('deleteAccountLink.confirm')).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe('/api/users/delete-account/preview');
  expect(JSON.parse(init.body)).toEqual({ token: 'abc123' });
  expect(screen.getByTestId('search').textContent).toBe('');
});

test('the button schedules the deletion and says when it happens and how to undo it', async () => {
  fetchMock
    .mockReturnValueOnce(answer(200, { username: 'newbie', bottles: 0, supporter: false, deletionScheduledFor: null }))
    .mockReturnValueOnce(answer(200, { deletionScheduledFor: '2026-10-30T12:00:00.000Z' }));
  at('/delete-account?token=abc123');

  expect(await screen.findByText('deleteAccountLink.noBottles')).toBeInTheDocument();
  fireEvent.click(screen.getByText('deleteAccountLink.confirm'));

  expect(await screen.findByText('deleteAccountLink.scheduled')).toBeInTheDocument();
  expect(screen.getByText('deleteAccountLink.changeMind')).toBeInTheDocument();
  const [url, init] = fetchMock.mock.calls[1];
  expect(url).toBe('/api/users/delete-account');
  expect(JSON.parse(init.body)).toEqual({ token: 'abc123' });
});

test('a supporter is told the subscription ends too', async () => {
  fetchMock.mockReturnValueOnce(answer(200, { username: 'patron', bottles: 5, supporter: true, deletionScheduledFor: null }));
  at('/delete-account?token=abc123');
  expect(await screen.findByText('deleteAccountLink.supporter')).toBeInTheDocument();
});

test('an account already set to be deleted shows the date, with no delete button', async () => {
  fetchMock.mockReturnValueOnce(answer(200, { username: 'newbie', bottles: 0, supporter: false, deletionScheduledFor: '2026-10-30T12:00:00.000Z' }));
  at('/delete-account?token=abc123');

  expect(await screen.findByText('deleteAccountLink.scheduled')).toBeInTheDocument();
  expect(screen.queryByText('deleteAccountLink.confirm')).toBeNull();
});

test('an expired or bad link says so and points to Settings', async () => {
  fetchMock.mockReturnValueOnce(answer(400, { code: 'LINK_INVALID' }));
  at('/delete-account?token=old');

  expect(await screen.findByText('deleteAccountLink.invalid')).toBeInTheDocument();
  expect(screen.getByText('deleteAccountLink.useSettings')).toBeInTheDocument();
  expect(screen.queryByText('deleteAccountLink.confirm')).toBeNull();
});

test('no token at all asks nothing of the server', () => {
  at('/delete-account');
  expect(screen.getByText('deleteAccountLink.invalid')).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
});

test('a failed press keeps the button so the person can try again', async () => {
  fetchMock
    .mockReturnValueOnce(answer(200, { username: 'newbie', bottles: 0, supporter: false, deletionScheduledFor: null }))
    .mockReturnValueOnce(answer(500, { error: 'boom' }));
  at('/delete-account?token=abc123');

  fireEvent.click(await screen.findByText('deleteAccountLink.confirm'));

  expect(await screen.findByText('deleteAccountLink.failed')).toBeInTheDocument();
  await waitFor(() => expect(screen.getByText('deleteAccountLink.confirm')).not.toBeDisabled());
});
