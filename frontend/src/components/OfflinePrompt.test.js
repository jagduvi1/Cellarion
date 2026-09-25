import { render, screen, fireEvent, act } from '@testing-library/react';
import OfflinePrompt from './OfflinePrompt';

const auth = vi.hoisted(() => ({ value: {} }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth.value }));
vi.mock('../utils/offlineSnapshot', () => ({ refreshSnapshot: vi.fn(async () => true), clearOfflineData: vi.fn(async () => {}) }));
vi.mock('../utils/offlineMode', async (orig) => {
  const real = await orig();
  return { ...real, syncOfflineShell: vi.fn(async () => true) };
});

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

const USER = { id: 'u1', username: 'anna', requiresPolicyReconsent: false };
let mm;
beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  mm = window.matchMedia;
  window.matchMedia = (q) => ({ matches: q === '(display-mode: standalone)' }); // the installed app
  auth.value = { user: USER, offlineSession: false, apiFetch: vi.fn() };
});
afterEach(() => { window.matchMedia = mm; vi.unstubAllGlobals(); });

it('the installed app asks once; "yes" switches offline mode on', async () => {
  render(<OfflinePrompt />);
  expect(screen.getByText('Use Cellarion without a signal?')).toBeInTheDocument();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Yes, keep it offline' })); });
  expect(localStorage.getItem('cellarion-offline')).toBe('on');
  expect(screen.queryByText('Use Cellarion without a signal?')).toBeNull();
});

it('"no thanks" is remembered — never asked again', async () => {
  const { unmount } = render(<OfflinePrompt />);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'No thanks' })); });
  expect(localStorage.getItem('cellarion-offline')).toBe('off');
  unmount();
  render(<OfflinePrompt />);
  expect(screen.queryByText('Use Cellarion without a signal?')).toBeNull();
});

it('not in a browser tab, not signed out, not on top of the privacy-policy dialog', () => {
  auth.value = { ...auth.value, user: { ...USER, requiresPolicyReconsent: true } };
  const { unmount } = render(<OfflinePrompt />);
  expect(screen.queryByText('Use Cellarion without a signal?')).toBeNull();
  unmount();
  auth.value = { ...auth.value, user: null };
  const r2 = render(<OfflinePrompt />);
  expect(screen.queryByText('Use Cellarion without a signal?')).toBeNull();
  r2.unmount();
  window.matchMedia = () => ({ matches: false });
  auth.value = { ...auth.value, user: USER };
  render(<OfflinePrompt />);
  expect(screen.queryByText('Use Cellarion without a signal?')).toBeNull();
});
