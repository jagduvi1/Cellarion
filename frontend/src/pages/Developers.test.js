import { render, screen, waitFor, act } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';

let mockTheme = 'light';
vi.mock('../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: mockTheme }) }));

const { default: Developers, REDOC_SRC, SPEC_URL } = await import('./Developers');

const renderPage = () => render(<HelmetProvider><Developers /></HelmetProvider>);
const viewerScript = () => document.head.querySelector(`script[src="${REDOC_SRC}"]`);

afterEach(() => {
  delete window.Redoc;
  document.head.querySelectorAll('script[src*="/developers/redoc/"]').forEach((s) => s.remove());
  mockTheme = 'light';
});

describe('Developers', () => {
  test('loads the vendored viewer and renders the server\'s own OpenAPI document', async () => {
    window.Redoc = { init: vi.fn((spec, opts, el, done) => done()) };
    renderPage();
    await waitFor(() => expect(window.Redoc.init).toHaveBeenCalledTimes(1));
    const [spec, opts, el] = window.Redoc.init.mock.calls[0];
    expect(spec).toBe(SPEC_URL);
    expect(spec).toBe('/api/openapi.json');
    // The CSP blocks Redoc's blob: search worker; it stays off.
    expect(opts.disableSearch).toBe(true);
    expect(opts.scrollYOffset).toBe('.navbar');
    expect(el).toHaveClass('developers-redoc');
    // Ready: the loading notice gives way to the reference.
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  test('injects the viewer script once, from its versioned path, until it loads', async () => {
    renderPage();
    expect(screen.getByRole('status')).toHaveTextContent('Loading the guide and reference');
    const script = viewerScript();
    expect(script).not.toBeNull();
    expect(REDOC_SRC).toMatch(/^\/developers\/redoc\/\d+\.\d+\.\d+\/redoc\.standalone\.js$/);
    window.Redoc = { init: vi.fn((s, o, el, done) => done()) };
    await act(async () => { script.dispatchEvent(new Event('load')); });
    await waitFor(() => expect(window.Redoc.init).toHaveBeenCalled());
  });

  test('a viewer that fails to load leaves a way to the document itself', async () => {
    renderPage();
    const script = viewerScript();
    await act(async () => { script.dispatchEvent(new Event('error')); });
    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Download the OpenAPI 3.1 document/i })).toHaveAttribute('href', '/api/openapi.json');
    // A failed script is removed, so a later visit can try again.
    expect(viewerScript()).toBeNull();
  });

  test('re-renders the reference in the new colours when the theme changes', async () => {
    window.Redoc = { init: vi.fn((s, o, el, done) => done()) };
    const { rerender } = renderPage();
    await waitFor(() => expect(window.Redoc.init).toHaveBeenCalledTimes(1));
    mockTheme = 'dark';
    rerender(<HelmetProvider><Developers /></HelmetProvider>);
    await waitFor(() => expect(window.Redoc.init).toHaveBeenCalledTimes(2));
  });
});
