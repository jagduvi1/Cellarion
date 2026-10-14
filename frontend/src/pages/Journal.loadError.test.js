import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// A journal that could not be loaded is not an empty journal: it says so and
// offers Retry, instead of "No journal entries yet".

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k) => k, i18n: { language: 'en' } }),
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch: vi.fn() }) }));
vi.mock('../api/journal', () => ({ getJournalEntries: vi.fn(), deleteJournalEntry: vi.fn() }));

const { getJournalEntries } = await import('../api/journal');
const Journal = (await import('./Journal')).default;

const ok = (body) => ({ ok: true, status: 200, json: async () => body });

beforeEach(() => getJournalEntries.mockReset());

test('a failed load offers Retry instead of the empty journal message', async () => {
  getJournalEntries.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  render(<MemoryRouter><Journal /></MemoryRouter>);

  expect(await screen.findByText('common.couldNotLoad')).toBeInTheDocument();
  expect(screen.queryByText('journal.empty')).not.toBeInTheDocument();

  getJournalEntries.mockResolvedValue(ok({ items: [], total: 0 }));
  fireEvent.click(screen.getByText('common.retry'));
  await waitFor(() => expect(screen.getByText('journal.empty')).toBeInTheDocument());
});

test('a failed refresh keeps the entries on screen', async () => {
  getJournalEntries.mockResolvedValueOnce(ok({ items: [{ _id: 'e1', date: '2026-10-01', title: 'Birthday dinner', bottles: [] }], total: 1 }));
  render(<MemoryRouter><Journal /></MemoryRouter>);
  expect(await screen.findByText('Birthday dinner')).toBeInTheDocument();

  getJournalEntries.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  fireEvent.change(screen.getByPlaceholderText('journal.searchPlaceholder'), { target: { value: 'x' } });
  await waitFor(() => expect(getJournalEntries).toHaveBeenCalledTimes(2), { timeout: 2000 });
  await waitFor(() => expect(screen.getByText('Birthday dinner')).toBeInTheDocument());
});
