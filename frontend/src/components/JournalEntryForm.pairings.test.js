/**
 * Removing a pairing row must leave every remaining row showing its OWN wine.
 *
 * WinePicker copies its `value` into local state once, at mount. Rows keyed by
 * their position would hand the removed row's picker to the next row, which
 * then showed the removed row's wine (and whose Clear wiped the wrong row).
 * The real WinePicker is rendered on purpose: that is where the state lives.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../api/journal', () => ({ createJournalEntry: vi.fn(), updateJournalEntry: vi.fn() }));
vi.mock('../api/recommendations', () => ({ searchFriends: vi.fn() }));
vi.mock('../api/wines', () => ({ identifyWineByText: vi.fn() }));

// WinePicker's debounced registry search: always an empty result set.
const apiFetch = vi.fn(async () => ({ ok: true, json: async () => ({ bottles: [], wines: [] }) }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch: (...a) => apiFetch(...a), user: { _id: 'u1' } }) }));

vi.mock('react-i18next', () => {
  const t = (key, fallback) => (typeof fallback === 'string' ? fallback : key);
  return { useTranslation: () => ({ t }) };
});

const { createJournalEntry, updateJournalEntry } = await import('../api/journal');
const JournalEntryForm = (await import('./JournalEntryForm')).default;

const EXISTING = {
  _id: 'e1',
  date: '2026-10-01T00:00:00.000Z',
  title: 'Dinner',
  occasion: 'dinner',
  pairings: [
    { _id: 'p1', dish: 'Osso buco', bottle: null, wine: 'w1', wineName: 'Barolo', vintage: '', notes: 'first' },
    { _id: 'p2', dish: 'Oysters', bottle: null, wine: 'w2', wineName: 'Chablis', vintage: '', notes: 'second' },
    { _id: 'p3', dish: 'Lamb', bottle: null, wine: 'w3', wineName: 'Rioja', vintage: '', notes: 'third' },
  ],
};

const wineInputs = () => screen.getAllByPlaceholderText('Search wine...').map(el => el.value);
const dishInputs = () => screen.getAllByPlaceholderText('Dish (e.g. Osso buco)').map(el => el.value);
const removeButtons = () => document.querySelectorAll('.journal-form__pairing-remove');

beforeEach(() => {
  vi.clearAllMocks();
  const ok = { ok: true, json: async () => ({ entry: { _id: 'e1' } }) };
  createJournalEntry.mockResolvedValue(ok);
  updateJournalEntry.mockResolvedValue(ok);
});

test('removing the middle pairing of an existing entry keeps each remaining row\'s own wine', () => {
  render(<JournalEntryForm existing={EXISTING} onClose={() => {}} onSaved={() => {}} />);
  expect(wineInputs()).toEqual(['Barolo', 'Chablis', 'Rioja']);

  fireEvent.click(removeButtons()[1]);

  expect(dishInputs()).toEqual(['Osso buco', 'Lamb']);
  expect(wineInputs()).toEqual(['Barolo', 'Rioja']);
});

test('saving after the removal sends the two surviving pairings and no client-only key', async () => {
  render(<JournalEntryForm existing={EXISTING} onClose={() => {}} onSaved={() => {}} />);
  fireEvent.click(removeButtons()[1]);
  fireEvent.click(screen.getByText('Update'));

  await waitFor(() => expect(updateJournalEntry).toHaveBeenCalledTimes(1));
  const payload = updateJournalEntry.mock.calls[0][2];
  expect(payload.pairings).toEqual([
    { dish: 'Osso buco', bottle: null, wine: 'w1', wineName: 'Barolo', vintage: '', notes: 'first' },
    { dish: 'Lamb', bottle: null, wine: 'w3', wineName: 'Rioja', vintage: '', notes: 'third' },
  ]);
  for (const p of payload.pairings) expect(p).not.toHaveProperty('_key');
});

test('removing the middle of three newly added pairings keeps each remaining row\'s typed wine', async () => {
  render(<JournalEntryForm onClose={() => {}} onSaved={() => {}} />);
  fireEvent.click(screen.getByText(/Add pairing/));
  fireEvent.click(screen.getByText(/Add pairing/));

  const inputs = screen.getAllByPlaceholderText('Search wine...');
  fireEvent.change(inputs[0], { target: { value: 'Barolo' } });
  fireEvent.change(inputs[1], { target: { value: 'Chablis' } });
  fireEvent.change(inputs[2], { target: { value: 'Rioja' } });

  fireEvent.click(removeButtons()[1]);
  expect(wineInputs()).toEqual(['Barolo', 'Rioja']);

  fireEvent.click(screen.getByText('Save Entry'));
  await waitFor(() => expect(createJournalEntry).toHaveBeenCalledTimes(1));
  const payload = createJournalEntry.mock.calls[0][1];
  expect(payload.pairings.map(p => p.wineName)).toEqual(['Barolo', 'Rioja']);
  for (const p of payload.pairings) expect(p).not.toHaveProperty('_key');
});
