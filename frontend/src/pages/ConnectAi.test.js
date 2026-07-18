import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import ConnectAi from './ConnectAi';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // The page passes English fallbacks inline — return those so assertions
    // read like the real UI.
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : key),
  }),
}));

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
        <ConnectAi />
      </MemoryRouter>
    </HelmetProvider>,
  );

const snippets = (container) =>
  [...container.querySelectorAll('.connect-ai-snippet')].map((el) => el.textContent);

const originalLocation = window.location;

beforeEach(() => {
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

afterEach(() => {
  Object.defineProperty(window, 'location', {
    value: originalLocation,
    writable: true,
    configurable: true,
  });
  delete window.navigator.clipboard;
  vi.restoreAllMocks();
});

describe('ConnectAi', () => {
  test('renders the page and is honest that the connector is in beta', () => {
    setOrigin(HOSTED);
    renderPage();
    expect(
      screen.getByRole('heading', { name: /Connect your AI to your wine cellar/ }),
    ).toBeInTheDocument();
    expect(screen.getByText(/in beta/i)).toBeInTheDocument();
    expect(screen.getByText(/can be undone/i)).toBeInTheDocument();
  });

  test('on the hosted origin, shows a prefilled claude.ai connector link pointing at /api/mcp', () => {
    setOrigin(HOSTED);
    renderPage();
    const link = screen.getByRole('link', { name: /Add Cellarion to Claude/ });
    const url = new URL(link.getAttribute('href'));
    expect(url.origin).toBe('https://claude.ai');
    expect(url.pathname).toBe('/customize/connectors');
    expect(url.searchParams.get('modal')).toBe('add-custom-connector');
    expect(url.searchParams.get('connectorName')).toBe('Cellarion');
    // The connector URL must be the personal endpoint, not the public one.
    expect(url.searchParams.get('connectorUrl')).toBe('https://cellarion.app/api/mcp');
  });

  test('self-hosted installs get their own URLs and NO claude.ai one-click link', () => {
    setOrigin('https://wine.example.org');
    const { container } = renderPage();

    // A claude.ai deep link would point at a server claude.ai cannot reach.
    expect(screen.queryByRole('link', { name: /Add Cellarion to Claude/ })).toBeNull();

    const texts = snippets(container).join('\n');
    expect(texts).toContain('https://wine.example.org/api/mcp');
    expect(texts).not.toContain('https://cellarion.app');
    // The stdio bridge needs CELLARION_URL only when self-hosted.
    expect(texts).toContain('"CELLARION_URL": "https://wine.example.org"');
    expect(screen.getByText(/derived from FRONTEND_URL/i)).toBeInTheDocument();
  });

  test('hosted snippets omit CELLARION_URL and use the placeholder token', () => {
    setOrigin(HOSTED);
    const { container } = renderPage();
    const texts = snippets(container).join('\n');
    expect(texts).toContain('cel_YOUR_TOKEN_HERE');
    expect(texts).not.toContain('CELLARION_URL');
  });

  test('documents both endpoints, and the public one as the no-account option', () => {
    setOrigin(HOSTED);
    const { container } = renderPage();
    const texts = snippets(container).join('\n');
    expect(texts).toContain('https://cellarion.app/api/mcp/public');
    expect(screen.getByRole('heading', { name: /no account needed/i })).toBeInTheDocument();
    expect(screen.getByText(/holds no personal data/i)).toBeInTheDocument();
  });

  test('copy button writes the snippet to the clipboard and confirms', async () => {
    setOrigin(HOSTED);
    const { container } = renderPage();
    const firstBlock = container.querySelector('.connect-ai-snippet-block');
    const button = firstBlock.querySelector('.connect-ai-copy');
    const text = firstBlock.querySelector('.connect-ai-snippet').textContent;

    fireEvent.click(button);

    expect(window.navigator.clipboard.writeText).toHaveBeenCalledWith(text);
    await waitFor(() => expect(button).toHaveTextContent('Copied'));
  });
});
