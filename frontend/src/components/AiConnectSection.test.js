import { render, screen, fireEvent } from '@testing-library/react';
import AiConnectSection from './AiConnectSection';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Components pass English fallbacks inline — return those so assertions
    // read like the real UI.
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : key),
  }),
}));

const snippetTexts = (container) =>
  [...container.querySelectorAll('.ai-connect-snippet')].map((el) => el.textContent);

beforeEach(() => {
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.navigator.clipboard;
});

describe('AiConnectSection', () => {
  test('is labelled Beta and says plainly that it is used at your own risk', () => {
    render(<AiConnectSection />);
    // The badge rides in the heading, so the accessible name carries it too.
    expect(screen.getByRole('heading', { name: /Connect your AI\s+Beta/ })).toBeInTheDocument();
    expect(screen.getByText(/beta feature and you use it at your own risk/i)).toBeInTheDocument();
    // The reassurances that make the warning honest rather than just scary.
    expect(screen.getByText(/read-only token/i)).toBeInTheDocument();
    expect(screen.getByText(/revoking the token cuts it off instantly/i)).toBeInTheDocument();
  });

  test('renders all three configs with a placeholder token and, off-cellarion.app, a CELLARION_URL override', () => {
    const { container } = render(<AiConnectSection />);
    expect(screen.getByRole('heading', { name: /Connect your AI/ })).toBeInTheDocument();
    const texts = snippetTexts(container);
    expect(texts).toHaveLength(3);
    for (const t of texts) expect(t).toContain('cel_YOUR_TOKEN_HERE');
    // jsdom origin is http://localhost:3000 → self-hosted → URL override present
    expect(texts[0]).toContain('CELLARION_URL');
    expect(texts[1]).toContain('/api/mcp');
  });

  test('self-hosted installs get NO claude.ai one-click link', () => {
    // jsdom origin is http://localhost:3000, i.e. self-hosted. A claude.ai deep
    // link would point at a server claude.ai cannot reach.
    render(<AiConnectSection />);
    expect(screen.queryByRole('link', { name: /Add to Claude in one click/ })).toBeNull();
  });

  test('on cellarion.app, offers a prefilled claude.ai connector link for /api/mcp', () => {
    const original = window.location;
    Object.defineProperty(window, 'location', {
      value: new URL('https://cellarion.app'),
      writable: true,
      configurable: true,
    });
    try {
      render(<AiConnectSection />);
      const link = screen.getByRole('link', { name: /Add to Claude in one click/ });
      const url = new URL(link.getAttribute('href'));
      expect(url.origin).toBe('https://claude.ai');
      expect(url.searchParams.get('modal')).toBe('add-custom-connector');
      expect(url.searchParams.get('connectorUrl')).toBe('https://cellarion.app/api/mcp');
      // Opening claude.ai must not hand it a window handle back to us.
      expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    } finally {
      Object.defineProperty(window, 'location', {
        value: original,
        writable: true,
        configurable: true,
      });
    }
  });

  test('pasting a token fills it into every snippet (and never leaves the page)', () => {
    const { container } = render(<AiConnectSection />);
    fireEvent.change(screen.getByPlaceholderText(/paste your token/i), {
      target: { value: 'cel_abc123' },
    });
    for (const t of snippetTexts(container)) expect(t).toContain('cel_abc123');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('test connection sends the PASTED token to /api/auth/whoami and reports success', async () => {
    global.fetch.mockResolvedValue({ ok: true });
    render(<AiConnectSection />);
    const btn = screen.getByRole('button', { name: 'Test connection' });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/paste your token/i), { target: { value: ' cel_abc123 ' } });
    fireEvent.click(btn);
    expect(global.fetch).toHaveBeenCalledWith('/api/auth/whoami', {
      headers: { Authorization: 'Bearer cel_abc123' },
    });
    expect(await screen.findByText(/Connected — the token works/)).toBeInTheDocument();
  });

  test('a rejected token shows the failure alert', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 401 });
    render(<AiConnectSection />);
    fireEvent.change(screen.getByPlaceholderText(/paste your token/i), { target: { value: 'cel_bad' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(/That token was rejected/)).toBeInTheDocument();
  });

  test('copy button writes the exact snippet to the clipboard and flips its label', async () => {
    const { container } = render(<AiConnectSection />);
    const firstSnippet = snippetTexts(container)[0];
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy' })[0]);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(firstSnippet);
    expect(await screen.findByText('Copied!')).toBeInTheDocument();
  });
});
