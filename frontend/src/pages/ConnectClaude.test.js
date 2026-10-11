import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import ConnectClaude from './ConnectClaude';
import { track } from '../utils/track';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // The page passes English fallbacks inline — return those so assertions
    // read like the real UI.
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : key),
  }),
}));

vi.mock('../utils/track', () => ({ track: vi.fn() }));

const HOSTED = 'https://cellarion.app';

// jsdom's window.location is not writable, so swap in a URL object — it exposes
// `.origin`, which is the only part of location this page reads.
const setOrigin = (origin) => {
  Object.defineProperty(window, 'location', {
    value: new URL(origin),
    writable: true,
    configurable: true,
  });
};

const renderPage = () =>
  render(
    <HelmetProvider>
      <MemoryRouter>
        <ConnectClaude />
      </MemoryRouter>
    </HelmetProvider>,
  );

const originalLocation = window.location;

afterEach(() => {
  Object.defineProperty(window, 'location', {
    value: originalLocation,
    writable: true,
    configurable: true,
  });
  vi.clearAllMocks();
});

describe('ConnectClaude', () => {
  test('explains it for beginners: free Claude plan, one connector, four steps', () => {
    setOrigin(HOSTED);
    const { container } = renderPage();
    expect(screen.getByRole('heading', { level: 1, name: /Ask Claude about your wine cellar/ })).toBeInTheDocument();
    expect(screen.getByText(/The free plan works: it lets you add one connector/)).toBeInTheDocument();
    expect(screen.getByText(/You do not need to know anything about it/)).toBeInTheDocument();
    expect(container.querySelectorAll('.connect-claude-step')).toHaveLength(4);
  });

  test('on the hosted origin, the one-click button opens claude.ai prefilled and is counted', () => {
    setOrigin(HOSTED);
    renderPage();
    const link = screen.getByRole('link', { name: /Add Cellarion to Claude/ });
    const url = new URL(link.getAttribute('href'));
    expect(url.origin).toBe('https://claude.ai');
    expect(url.pathname).toBe('/customize/connectors');
    expect(url.searchParams.get('connectorUrl')).toBe('https://cellarion.app/api/mcp');

    fireEvent.click(link);
    expect(track).toHaveBeenCalledWith('ai-connect-started', { via: 'claude-guide' });
  });

  test('the manual address is always there as a fallback', () => {
    setOrigin(HOSTED);
    const { container } = renderPage();
    expect(screen.getByText(/Button not working\?/)).toBeInTheDocument();
    expect(container.querySelector('.connect-ai-snippet').textContent).toBe('https://cellarion.app/api/mcp');
  });

  test('self-hosted installs get manual steps with their own address and no claude.ai link', () => {
    setOrigin('https://wine.example.org');
    const { container } = renderPage();
    // claude.ai reaches the connector from its own servers — a one-click link
    // for a LAN address would make a connector that can never connect.
    expect(screen.queryByRole('link', { name: /Add Cellarion to Claude/ })).toBeNull();
    expect(screen.getByText(/open Customize → Connectors, click \+ Add/)).toBeInTheDocument();
    expect(container.querySelector('.connect-ai-snippet').textContent).toBe('https://wine.example.org/api/mcp');
    expect(screen.getByText(/can be reached from outside your home or office network/)).toBeInTheDocument();
  });

  test('answers the safety questions and links to the full guide for other apps', () => {
    setOrigin(HOSTED);
    renderPage();
    expect(screen.getByText(/Settings → Recent AI activity/)).toBeInTheDocument();
    expect(screen.getByText(/Settings → API tokens and click Revoke/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Set-up for other AI apps/ })).toHaveAttribute('href', '/connect-ai');
  });
});
