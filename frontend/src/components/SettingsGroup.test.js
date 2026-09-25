import { render, screen, fireEvent, act } from '@testing-library/react';
import SettingsGroup, { SETTINGS_HASH_GROUP } from './SettingsGroup';

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

const group = (props = {}) => (
  <SettingsGroup id="connections" title="AI & connections" summary="API tokens and more" {...props}>
    <p>inside</p>
  </SettingsGroup>
);
const details = (c) => c.querySelector('details');

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  window.history.replaceState(null, '', '/settings');
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => vi.unstubAllGlobals());

it('shows the heading and summary, collapsed by default', () => {
  const { container } = render(group());
  expect(screen.getByText('AI & connections')).toBeInTheDocument();
  expect(screen.getByText('API tokens and more')).toBeInTheDocument();
  expect(details(container).open).toBe(false);
});

it('defaultOpen starts open', () => {
  const { container } = render(group({ defaultOpen: true }));
  expect(details(container).open).toBe(true);
});

it('remembers that the user opened it', () => {
  const { container, unmount } = render(group());
  const d = details(container);
  d.open = true;
  fireEvent(d, new Event('toggle'));
  unmount();
  const again = render(group());
  expect(details(again.container).open).toBe(true);
});

it('a link to /settings#mcp opens AI & connections and scrolls to it', async () => {
  window.history.replaceState(null, '', '/settings#mcp');
  const { container } = render(group());
  expect(details(container).open).toBe(true);
  await act(async () => { await new Promise((r) => requestAnimationFrame(r)); });
  expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
});

it('opens when the hash changes to one of its aliases', async () => {
  const { container } = render(group());
  window.history.replaceState(null, '', '/settings#api-tokens');
  await act(async () => { window.dispatchEvent(new HashChangeEvent('hashchange')); });
  expect(details(container).open).toBe(true);
});

it('forceOpen wins over a remembered "closed" (e.g. a scheduled account deletion)', () => {
  localStorage.setItem('cellarion-settings-open', JSON.stringify({ danger: false }));
  const { container } = render(
    <SettingsGroup id="danger" title="Delete account" danger forceOpen><p>x</p></SettingsGroup>,
  );
  expect(details(container).open).toBe(true);
  expect(container.querySelector('.settings-group--danger')).not.toBeNull();
});

it('every alias points at one of the five groups', () => {
  const groups = new Set(['account', 'preferences', 'connections', 'data', 'danger']);
  for (const g of Object.values(SETTINGS_HASH_GROUP)) expect(groups.has(g)).toBe(true);
});
