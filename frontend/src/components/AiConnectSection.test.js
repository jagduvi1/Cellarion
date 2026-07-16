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
  test('renders all three configs with a placeholder token and, off-cellarion.app, a CELLARION_URL override', () => {
    const { container } = render(<AiConnectSection />);
    expect(screen.getByRole('heading', { name: 'Connect your AI' })).toBeInTheDocument();
    const texts = snippetTexts(container);
    expect(texts).toHaveLength(3);
    for (const t of texts) expect(t).toContain('cel_YOUR_TOKEN_HERE');
    // jsdom origin is http://localhost:3000 → self-hosted → URL override present
    expect(texts[0]).toContain('CELLARION_URL');
    expect(texts[1]).toContain('/api/mcp');
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
