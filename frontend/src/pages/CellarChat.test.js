/**
 * CellarChat — the pointer to Cellarion in Claude.
 *
 * WHY THIS TEST EXISTS:
 * Cellar Chat points people who enjoy it at the beginner's guide for Claude,
 * in exactly two quiet places: under the starter tips while questions are
 * left, and in place of it once the limit is reached. Never both at once, and
 * each click is counted with where it came from. It waits for the usage count
 * (so someone at the limit never gets the starter version first), and it is
 * never shown where it cannot work: in the demo, whose accounts the consent
 * screen refuses, or on a self-hosted install claude.ai usually cannot reach.
 */
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { apiFetchMock, usage, authUser } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  usage: { current: null },
  authUser: { current: { preferences: {} } },
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ apiFetch: apiFetchMock, user: authUser.current }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key) }),
  Trans: ({ i18nKey }) => <span>{i18nKey}</span>,
}));
vi.mock('../utils/track', () => ({ track: vi.fn() }));

const { track } = await import('../utils/track');
const CellarChat = (await import('./CellarChat')).default;

const jsonRes = (body) => ({ ok: true, status: 200, json: async () => body });

// jsdom's window.location is not writable, so swap in a URL object — the page
// reads only `.origin` from it.
const setOrigin = (origin) => {
  Object.defineProperty(window, 'location', { value: new URL(origin), writable: true, configurable: true });
};
const originalLocation = window.location;
// jsdom has no layout, so no scrollIntoView; put back whatever was there.
const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeEach(() => {
  vi.clearAllMocks();
  setOrigin('https://cellarion.app');
  authUser.current = { preferences: {} };
  Element.prototype.scrollIntoView = vi.fn();
  apiFetchMock.mockImplementation(async (url) => {
    if (url === '/api/chat/usage') return jsonRes(usage.current);
    return jsonRes({ cellars: [] });
  });
});

afterEach(() => {
  Object.defineProperty(window, 'location', { value: originalLocation, writable: true, configurable: true });
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

const renderChat = () => render(<MemoryRouter><CellarChat /></MemoryRouter>);

describe('CellarChat → Claude guide', () => {
  test('under the starter tips while questions are left', async () => {
    usage.current = { used: 3, limit: 50, period: 'daily' };
    renderChat();
    await screen.findByText(/3 \/ 50/);

    expect(screen.getByText(/Enjoying Cellar Chat\?/)).toBeInTheDocument();
    expect(screen.queryByText(/Want to keep asking\?/)).toBeNull();

    const link = screen.getByRole('link', { name: /Connect Cellarion to Claude/ });
    expect(link).toHaveAttribute('href', '/connect-ai/claude');
    fireEvent.click(link);
    expect(track).toHaveBeenCalledWith('claude-guide-opened', { via: 'chat-start' });
  });

  test('at the limit, the limit version replaces it', async () => {
    usage.current = { used: 50, limit: 50, period: 'daily' };
    renderChat();
    await screen.findByText(/Want to keep asking\?/);

    expect(screen.queryByText(/Enjoying Cellar Chat\?/)).toBeNull();
    const links = screen.getAllByRole('link', { name: /Connect Cellarion to Claude/ });
    expect(links).toHaveLength(1);
    fireEvent.click(links[0]);
    expect(track).toHaveBeenCalledWith('claude-guide-opened', { via: 'chat-limit' });
  });

  test('nothing is shown until the usage count is known', async () => {
    let answerUsage;
    apiFetchMock.mockImplementation((url) => {
      if (url === '/api/chat/usage') return new Promise((resolve) => { answerUsage = resolve; });
      return Promise.resolve(jsonRes({ cellars: [] }));
    });
    renderChat();
    await screen.findByText('cellarChat.tryAsking');
    expect(screen.queryByRole('link', { name: /Connect Cellarion to Claude/ })).toBeNull();

    // At the limit the first thing shown is the limit version.
    await act(async () => answerUsage(jsonRes({ used: 50, limit: 50, period: 'daily' })));
    expect(screen.getByText(/Want to keep asking\?/)).toBeInTheDocument();
    expect(screen.queryByText(/Enjoying Cellar Chat\?/)).toBeNull();
  });

  test('never in the demo, at the limit or not', async () => {
    authUser.current = { preferences: {}, isDemo: true };
    usage.current = { used: 50, limit: 50, period: 'daily' };
    renderChat();
    await screen.findByText(/50 \/ 50/);
    expect(screen.queryByRole('link', { name: /Connect Cellarion to Claude/ })).toBeNull();
  });

  test('never on a self-hosted install', async () => {
    setOrigin('https://wine.example.org');
    usage.current = { used: 3, limit: 50, period: 'daily' };
    renderChat();
    await screen.findByText(/3 \/ 50/);
    expect(screen.queryByRole('link', { name: /Connect Cellarion to Claude/ })).toBeNull();
  });
});

// Release audit 2026-10-28: the wine card called t() without declaring it, so
// every answer that carried bottles threw during render and the whole app fell
// to the error boundary. The card renders the real component with wines.
describe('CellarChat → wine cards', () => {
  test('an answer that carries wine cards renders them, vintage through the display helper', async () => {
    usage.current = { used: 0, limit: 10, period: 'daily' };
    apiFetchMock.mockImplementation(async (url) => {
      if (url === '/api/chat/usage') return jsonRes(usage.current);
      if (url === '/api/chat') {
        return jsonRes({ answer: 'Try the Barolo.', wines: [{ name: 'Barolo Bussia', vintage: 'NV', producer: 'Prunotto', cellarId: 'c1', bottleId: 'b1' }] });
      }
      return jsonRes({ cellars: [] });
    });
    renderChat();
    const box = await screen.findByPlaceholderText('cellarChat.placeholder');
    fireEvent.change(box, { target: { value: 'what should I open tonight?' } });
    await act(async () => { fireEvent.submit(box.closest('form')); });
    expect(await screen.findByText('Barolo Bussia')).toBeInTheDocument();
    expect(screen.getByText(/NV · Prunotto/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Barolo Bussia/ })).toHaveAttribute('href', '/cellars/c1/bottles/b1');
  });
});
