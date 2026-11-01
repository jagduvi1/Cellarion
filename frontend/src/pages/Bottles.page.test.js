import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import Bottles from './Bottles';

// The page of "all bottles" is in the address, so Back from a bottle (and the
// bottle page's back link) returns to the same page instead of the first.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k) => k, i18n: { language: 'en' } }),
}));

let auth;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

const api = vi.fn(async (url) => {
  if (url.startsWith('/api/bottles')) {
    const offset = Number(new URLSearchParams(url.split('?')[1]).get('offset') || 0);
    const items = Array.from({ length: 30 }, (_, i) => ({
      _id: `b${offset + i}`, cellar: 'c1', status: 'active', vintage: '2019',
      wineDefinition: { _id: `w${offset + i}`, name: `Wine ${offset + i}` },
    }));
    return { ok: true, status: 200, json: async () => ({ bottles: { items, total: 95, count: 30 } }) };
  }
  return { ok: true, status: 200, json: async () => ({}) };
});

beforeEach(() => {
  api.mockClear();
  auth = { apiFetch: api, user: { id: 'u1', preferences: {} } };
});

let where;
function Where() { where = useLocation(); return null; }
const renderAt = (url) => render(
  <MemoryRouter initialEntries={[url]}>
    <Routes><Route path="/bottles" element={<><Bottles /><Where /></>} /></Routes>
  </MemoryRouter>,
);
const offsets = () => api.mock.calls.map(([u]) => u).filter((u) => u.startsWith('/api/bottles'))
  .map((u) => new URLSearchParams(u.split('?')[1]).get('offset'));

test('opening the list at ?page=2 loads the second page', async () => {
  renderAt('/bottles?type=red&page=2');
  await waitFor(() => expect(offsets().length).toBeGreaterThan(0));
  expect(offsets()[0]).toBe('30');
});

test('Next puts the page in the address', async () => {
  renderAt('/bottles?type=red');
  await waitFor(() => expect(offsets()).toEqual(['0']));
  fireEvent.click(await screen.findByText(/bottles\.next/));
  await waitFor(() => expect(where.search).toBe('?type=red&page=2'));
  await waitFor(() => expect(offsets()).toContain('30'));
});

test('a page that no longer exists (bottles drunk since) goes to the last one there is', async () => {
  renderAt('/bottles?type=red&page=9');
  // 95 bottles = 4 pages: page 9 is past the end.
  await waitFor(() => expect(where.search).toBe('?type=red&page=4'));
  await waitFor(() => expect(offsets()).toContain('90'));
});

// A search box on the page: the entry point to searching every cellar at once.
test('searching puts the query in the address, drops the page, and reloads the list', async () => {
  renderAt('/bottles?type=red&page=2');
  await waitFor(() => expect(offsets().length).toBeGreaterThan(0));
  api.mockClear();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '  Two Wolves ' } });
  fireEvent.submit(screen.getByRole('search'));
  await waitFor(() => expect(where.search).toBe('?type=red&search=Two+Wolves'));
  await waitFor(() => expect(offsets()).toEqual(['0']));
  const url = api.mock.calls.map(([u]) => u).find((u) => u.startsWith('/api/bottles'));
  expect(new URLSearchParams(url.split('?')[1]).get('search')).toBe('Two Wolves');
});

test('submitting an empty search removes the search filter', async () => {
  renderAt('/bottles?search=Barolo');
  expect(screen.getByRole('searchbox')).toHaveValue('Barolo');
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
  fireEvent.submit(screen.getByRole('search'));
  await waitFor(() => expect(where.search).toBe(''));
});

test('clearing the search chip also clears the box', async () => {
  renderAt('/bottles?search=Barolo');
  expect(screen.getByRole('searchbox')).toHaveValue('Barolo');
  fireEvent.click(await screen.findByLabelText('bottles.removeFilter'));
  await waitFor(() => expect(screen.getByRole('searchbox')).toHaveValue(''));
});

// Search defaults to bottles still in the cellar; the scope picker reaches
// bottles already drunk, so a wine you just finished can still be found.
test('the scope picker defaults to in-cellar', () => {
  renderAt('/bottles');
  expect(screen.getByRole('combobox')).toHaveValue('active');
});

test('the scope picker shows the status from the address', () => {
  renderAt('/bottles?status=all');
  expect(screen.getByRole('combobox')).toHaveValue('all');
});

test('choosing a wider scope puts the status in the address and reloads the list', async () => {
  renderAt('/bottles?search=Predappio&page=2');
  await waitFor(() => expect(offsets().length).toBeGreaterThan(0));
  api.mockClear();
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'all' } });
  await waitFor(() => expect(where.search).toBe('?search=Predappio&status=all'));
  const url = api.mock.calls.map(([u]) => u).find((u) => u.startsWith('/api/bottles'));
  expect(new URLSearchParams(url.split('?')[1]).get('status')).toBe('all');
});

test('text typed but not yet searched counts when the scope changes', async () => {
  renderAt('/bottles');
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: ' Barolo ' } });
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'consumed' } });
  await waitFor(() => expect(where.search).toBe('?status=consumed&search=Barolo'));
});

test('going back to in-cellar drops the status from the address', async () => {
  renderAt('/bottles?status=all');
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'active' } });
  await waitFor(() => expect(where.search).toBe(''));
});

// "/" jumps to the search box (the GitHub / YouTube convention), unless the
// person is already typing somewhere.
test('"/" focuses the search box', async () => {
  renderAt('/bottles');
  fireEvent.keyDown(document.body, { key: '/' });
  expect(screen.getByRole('searchbox')).toHaveFocus();
});

test('"/" typed into another field is left alone', async () => {
  renderAt('/bottles');
  const scope = screen.getByRole('combobox');
  scope.focus();
  fireEvent.keyDown(scope, { key: '/' });
  expect(screen.getByRole('searchbox')).not.toHaveFocus();
});

test('"/" with a modifier held is left alone', async () => {
  renderAt('/bottles');
  fireEvent.keyDown(document.body, { key: '/', ctrlKey: true });
  expect(screen.getByRole('searchbox')).not.toHaveFocus();
});

test('"/" while a dialog is open is left alone (the dialog keeps the keyboard)', async () => {
  renderAt('/bottles');
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  const button = document.createElement('button');
  dialog.appendChild(button);
  document.body.appendChild(dialog);
  try {
    button.focus();
    fireEvent.keyDown(button, { key: '/' });
    expect(screen.getByRole('searchbox')).not.toHaveFocus();
    expect(button).toHaveFocus();
  } finally {
    dialog.remove();
  }
});
