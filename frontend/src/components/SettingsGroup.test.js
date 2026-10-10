import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
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
// The group reads the hash from the router (a link followed inside the app
// fires no hashchange), so every render sits in one.
const at = (path, ui) => render(<MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>);
const details = (c) => c.querySelector('details');

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => vi.unstubAllGlobals());

it('shows the heading and summary, collapsed by default', () => {
  const { container } = at('/settings', group());
  expect(screen.getByText('AI & connections')).toBeInTheDocument();
  expect(screen.getByText('API tokens and more')).toBeInTheDocument();
  expect(details(container).open).toBe(false);
});

it('defaultOpen starts open', () => {
  const { container } = at('/settings', group({ defaultOpen: true }));
  expect(details(container).open).toBe(true);
});

it('remembers that the user opened it', () => {
  const { container, unmount } = at('/settings', group());
  const d = details(container);
  d.open = true;
  fireEvent(d, new Event('toggle'));
  unmount();
  const again = at('/settings', group());
  expect(details(again.container).open).toBe(true);
});

it('a link to /settings#mcp opens AI & connections and scrolls to it', async () => {
  const { container } = at('/settings#mcp', group());
  expect(details(container).open).toBe(true);
  await act(async () => { await new Promise((r) => requestAnimationFrame(r)); });
  expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
});

// Release audit 2026-09-27 (L): the group listened for `hashchange`, which
// React Router's own navigation never fires — a link followed inside the app
// to /settings#api-tokens left the group closed.
it('opens when the app navigates to one of its aliases', async () => {
  function Go() {
    const navigate = useNavigate();
    return <button type="button" onClick={() => navigate('/settings#api-tokens')}>go</button>;
  }
  const { container } = at('/settings', <><Go />{group()}</>);
  expect(details(container).open).toBe(false);
  await act(async () => { fireEvent.click(screen.getByText('go')); });
  expect(details(container).open).toBe(true);
});

it('forceOpen wins over a remembered "closed" (e.g. a scheduled account deletion)', () => {
  localStorage.setItem('cellarion-settings-open', JSON.stringify({ danger: false }));
  const { container } = at('/settings',
    <SettingsGroup id="danger" title="Delete account" danger forceOpen><p>x</p></SettingsGroup>,
  );
  expect(details(container).open).toBe(true);
  expect(container.querySelector('.settings-group--danger')).not.toBeNull();
});

it('every alias points at one of the six groups', () => {
  const groups = new Set(['account', 'preferences', 'early-access', 'connections', 'data', 'danger']);
  for (const g of Object.values(SETTINGS_HASH_GROUP)) expect(groups.has(g)).toBe(true);
});
