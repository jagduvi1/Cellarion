/**
 * CellarChat — the pointer to Cellarion in Claude.
 *
 * WHY THIS TEST EXISTS:
 * Cellar Chat points people who enjoy it at the beginner's guide for Claude,
 * in exactly two quiet places: under the starter tips while questions are
 * left, and in place of it once the limit is reached. Never both at once, and
 * each click is counted with where it came from.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { apiFetchMock, usage } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  usage: { current: null },
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ apiFetch: apiFetchMock, user: { preferences: {} } }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key) }),
  Trans: ({ i18nKey }) => <span>{i18nKey}</span>,
}));
vi.mock('../utils/track', () => ({ track: vi.fn() }));

const { track } = await import('../utils/track');
const CellarChat = (await import('./CellarChat')).default;

const jsonRes = (body) => ({ ok: true, status: 200, json: async () => body });

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom has no layout, so no scrollIntoView.
  Element.prototype.scrollIntoView = vi.fn();
  apiFetchMock.mockImplementation(async (url) => {
    if (url === '/api/chat/usage') return jsonRes(usage.current);
    return jsonRes({ cellars: [] });
  });
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
});
