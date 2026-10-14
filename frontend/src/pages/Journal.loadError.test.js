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

test('a failed load offers Retry instead of the empty journal message', async () => {
  getJournalEntries.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  render(<MemoryRouter><Journal /></MemoryRouter>);

  expect(await screen.findByText('common.loadFailed')).toBeInTheDocument();
  expect(screen.queryByText('journal.empty')).not.toBeInTheDocument();

  getJournalEntries.mockResolvedValue(ok({ items: [], total: 0 }));
  fireEvent.click(screen.getByText('common.retry'));
  await waitFor(() => expect(screen.getByText('journal.empty')).toBeInTheDocument());
});
