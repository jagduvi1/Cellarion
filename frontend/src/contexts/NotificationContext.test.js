import { render, screen, act, waitFor } from '@testing-library/react';
import { NotificationProvider, useNotifications, POLL_MS, MIN_CHECK_GAP_MS } from './NotificationContext';

// The bell used to refetch the whole list (30 notifications) every time the
// window got focus, and every alt-tab back to the browser fires focus. It now
// asks a probe (the unread count plus the newest notification's id) and
// fetches the list only when that differs from what is shown (scaling audit
// 2026-09-25, item 12).

// Stable across renders, like the real context: a new user object would
// restart polling on every render.
const USER = { id: 'u1' };
const apiFetch = vi.fn();
vi.mock('./AuthContext', () => ({ useAuth: () => ({ user: USER, apiFetch }) }));

const ok = (body) => ({ ok: true, json: async () => body });
const note = (id, read = false) => ({ _id: id, title: `note ${id}`, read });

// What the server holds; the stub answers the list and the probe from it.
let server;
const LIST = '/api/notifications';
const PROBE = '/api/notifications/unread-count';
const calls = (url) => apiFetch.mock.calls.filter(([u]) => u === url).length;

let ctx;
function Bell() {
  ctx = useNotifications();
  return (
    <ul>
      <li>unread:{ctx.unreadCount}</li>
      {ctx.notifications.map((n) => <li key={n._id}>{n.title}{n.read ? ' (read)' : ''}</li>)}
    </ul>
  );
}

// jsdom's visibility is fixed to visible; tests flip it through own
// properties that shadow the prototype getters.
let hidden = false;
const setHidden = (value) => {
  hidden = value;
  document.dispatchEvent(new Event('visibilitychange'));
};

const renderBell = async () => {
  render(<NotificationProvider><Bell /></NotificationProvider>);
  await waitFor(() => expect(calls(LIST)).toBe(1));
  await screen.findByText(`unread:${server.list.filter((n) => !n.read).length}`);
};
const advance = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
// Returning to the window fires both events; the provider coalesces them.
const wake = async () => {
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await advance(300);
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
  server = { list: [note('n2'), note('n1', true)] };
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (url, init = {}) => {
    const unreadCount = server.list.filter((n) => !n.read).length;
    if (url === LIST) return ok({ notifications: server.list, unreadCount });
    if (url === PROBE) return ok({ unreadCount, newestId: server.list[0]?._id ?? null });
    const m = url.match(/^\/api\/notifications\/(\w+)\/read$/);
    if (m && init.method === 'PUT') {
      server.list = server.list.map((n) => (n._id === m[1] ? { ...n, read: true } : n));
      return ok({});
    }
    return { ok: false, json: async () => ({}) };
  });
});

afterEach(() => {
  vi.useRealTimers();
  delete document.hidden;
  delete document.visibilityState;
});

test('returning to the window asks the probe, not the whole list, when nothing changed', async () => {
  await renderBell();
  await advance(MIN_CHECK_GAP_MS);

  await wake();

  expect(calls(PROBE)).toBe(1);
  expect(calls(LIST)).toBe(1); // only the one on mount
});

test('a new notification while another was read elsewhere (count unchanged) still refetches the list', async () => {
  await renderBell();
  expect(screen.getByText('unread:1')).toBeInTheDocument();

  // Net zero: n2 read on another device, n3 arrives. The count alone can't see it.
  server.list = [note('n3'), note('n2', true), note('n1', true)];
  await advance(MIN_CHECK_GAP_MS);
  await wake();

  expect(await screen.findByText('note n3')).toBeInTheDocument();
  expect(screen.getByText('note n2 (read)')).toBeInTheDocument();
  expect(calls(LIST)).toBe(2);
});

test('a changed count refetches the list', async () => {
  await renderBell();

  server.list = [note('n2', true), note('n1', true)]; // n2 read elsewhere
  await advance(POLL_MS);

  expect(await screen.findByText('note n2 (read)')).toBeInTheDocument();
  expect(screen.getByText('unread:0')).toBeInTheDocument();
  expect(calls(LIST)).toBe(2);
});

test('a visible tab probes on the interval; a hidden one never asks, and asks once on return', async () => {
  await renderBell();

  await advance(POLL_MS);
  expect(calls(PROBE)).toBe(1);

  await act(async () => { setHidden(true); });
  await advance(POLL_MS * 5);
  expect(calls(PROBE)).toBe(1);
  expect(calls(LIST)).toBe(1);

  await act(async () => { setHidden(false); });
  await advance(300);
  expect(calls(PROBE)).toBe(2);
  expect(calls(LIST)).toBe(1);
});

test('flicking between windows asks at most once a minute', async () => {
  await renderBell();
  await advance(MIN_CHECK_GAP_MS);

  for (let i = 0; i < 5; i += 1) {
    await wake();
    await advance(5000);
  }
  expect(calls(PROBE)).toBe(1);
  expect(calls(LIST)).toBe(1);

  await advance(MIN_CHECK_GAP_MS);
  await wake();
  expect(calls(PROBE)).toBe(2);
  expect(calls(LIST)).toBe(1);
});

test('marking one read locally does not make the next probe refetch the list', async () => {
  await renderBell();

  await act(async () => { await ctx.markRead('n2'); });
  expect(screen.getByText('unread:0')).toBeInTheDocument();

  await advance(POLL_MS);
  expect(calls(PROBE)).toBe(1);
  expect(calls(LIST)).toBe(1);
});

test('a server that does not send newestId yet (mid-deploy) refetches rather than risk a stale list', async () => {
  await renderBell();
  const serve = apiFetch.getMockImplementation();
  apiFetch.mockImplementation(async (url, init) => (
    url === PROBE ? ok({ unreadCount: 1 }) : serve(url, init)
  ));

  await advance(POLL_MS);

  await waitFor(() => expect(calls(LIST)).toBe(2));
});
