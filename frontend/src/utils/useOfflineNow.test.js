import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { isOfflineCapablePage, useOfflineNow } from './useOfflineNow';
import OfflinePageNotice from '../components/OfflinePageNotice';

vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ offlineSession: false }) }));

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

const C = 'c00000000000000000000001';
const B = 'b00000000000000000000001';

describe('isOfflineCapablePage', () => {
  it('the cellar list, a cellar, its racks, a bottle and Settings work offline', () => {
    for (const p of ['/cellars', `/cellars/${C}`, `/cellars/${C}/racks`, `/cellars/${C}/bottles/${B}`, '/settings']) {
      expect(isOfflineCapablePage(p)).toBe(true);
    }
  });
  it('everything else needs the network', () => {
    for (const p of ['/dashboard', '/statistics', '/community', '/community/discussions/abc', `/cellars/${C}/history`, `/cellars/${C}/room`, '/wishlist', '/journal', '/cellar-chat', '/wines/x']) {
      expect(isOfflineCapablePage(p)).toBe(false);
    }
  });
});

function Page() {
  const { offline, modeOn } = useOfflineNow();
  return offline ? <OfflinePageNotice modeOn={modeOn} /> : <p>the page</p>;
}

describe('offline page notice', () => {
  let onLine;
  beforeEach(() => {
    onLine = true;
    vi.stubGlobal('localStorage', memoryStorage());
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => onLine });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('replaces the page while offline and brings it back when the connection returns', async () => {
    render(<MemoryRouter><Page /></MemoryRouter>);
    expect(screen.getByText('the page')).toBeInTheDocument();
    onLine = false;
    await act(async () => { window.dispatchEvent(new Event('offline')); });
    expect(screen.getByText("You're offline")).toBeInTheDocument();
    onLine = true;
    await act(async () => { window.dispatchEvent(new Event('online')); });
    expect(screen.getByText('the page')).toBeInTheDocument();
  });

  it('with offline mode on it points to the cellars; off (unreleased) it makes no promise', () => {
    render(<MemoryRouter><OfflinePageNotice modeOn /></MemoryRouter>);
    expect(screen.getByRole('link', { name: 'Go to my cellars' })).toHaveAttribute('href', '/cellars');
    const { container } = render(<MemoryRouter><OfflinePageNotice modeOn={false} /></MemoryRouter>);
    expect(container.textContent).not.toMatch(/Turn on offline mode/);
  });
});
