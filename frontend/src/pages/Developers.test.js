import { render, screen, waitFor, act } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';

let mockTheme = 'light';
vi.mock('../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: mockTheme }) }));

const { default: Developers, REDOC_SRC, SPEC_URL, leaveDevelopers } = await import('./Developers');

const page = () => <HelmetProvider><Developers /></HelmetProvider>;
const viewerScript = () => document.head.querySelector(`script[src="${REDOC_SRC}"]`);

// jsdom's location is not writable by default; swap in a recorder.
const realLocation = Object.getOwnPropertyDescriptor(window, 'location');
const fakeLocation = (pathname = '/developers') => {
  const loc = { pathname, href: `https://cellar.example.org${pathname}`, replace: vi.fn(), reload: vi.fn() };
  Object.defineProperty(window, 'location', { value: loc, writable: true, configurable: true });
  return loc;
};

afterEach(() => {
  delete window.Redoc;
  document.head.querySelectorAll('script[src*="/developers/redoc/"]').forEach((s) => s.remove());
  mockTheme = 'light';
  if (realLocation) Object.defineProperty(window, 'location', realLocation);
});

describe('Developers', () => {
  test('loads the vendored viewer and renders the server\'s own OpenAPI document', async () => {
    window.Redoc = { init: vi.fn((spec, opts, el, done) => done()) };
    render(page());
    await waitFor(() => expect(window.Redoc.init).toHaveBeenCalledTimes(1));
    const [spec, opts, el] = window.Redoc.init.mock.calls[0];
    expect(spec).toBe(SPEC_URL);
    expect(spec).toBe('/api/openapi.json');
    // The CSP blocks Redoc's blob: search worker; it stays off.
    expect(opts.disableSearch).toBe(true);
    expect(typeof opts.scrollYOffset).toBe('function');
    expect(el).toHaveClass('developers-redoc');
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  test('injects the viewer script once, from its versioned path, until it loads', async () => {
    render(page());
    expect(screen.getByRole('status')).toHaveTextContent('Loading the guide and reference');
    const script = viewerScript();
    expect(script).not.toBeNull();
    expect(REDOC_SRC).toMatch(/^\/developers\/redoc\/\d+\.\d+\.\d+\/redoc\.standalone\.js$/);
    window.Redoc = { init: vi.fn((s, o, el, done) => done()) };
    await act(async () => { script.dispatchEvent(new Event('load')); });
    await waitFor(() => expect(window.Redoc.init).toHaveBeenCalled());
  });

  test('a viewer that fails to load leaves a way to the document itself', async () => {
    render(page());
    const script = viewerScript();
    await act(async () => { script.dispatchEvent(new Event('error')); });
    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Download the OpenAPI 3.1 document/i })).toHaveAttribute('href', '/api/openapi.json');
    // A failed script is removed, so a later visit can try again.
    expect(viewerScript()).toBeNull();
  });

  test('a document that fails to load is shown as an error, not as ready', async () => {
    window.Redoc = { init: vi.fn((s, o, el, done) => done(new Error('502'))) };
    render(page());
    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument();
  });

  test('a theme switch reloads the page in the new colours instead of a second viewer', async () => {
    const loc = fakeLocation();
    window.Redoc = { init: vi.fn((s, o, el, done) => done()) };
    const { rerender } = render(page());
    await waitFor(() => expect(window.Redoc.init).toHaveBeenCalledTimes(1));
    mockTheme = 'dark';
    rerender(page());
    await waitFor(() => expect(loc.reload).toHaveBeenCalledTimes(1));
    expect(window.Redoc.init).toHaveBeenCalledTimes(1);
  });

  test('leaving for another page loads it fresh; staying (a dev double-mount) does not', () => {
    const away = fakeLocation('/cellars');
    leaveDevelopers(away);
    expect(away.replace).toHaveBeenCalledWith('https://cellar.example.org/cellars');
    const here = fakeLocation('/developers');
    leaveDevelopers(here);
    expect(here.replace).not.toHaveBeenCalled();
  });
});
