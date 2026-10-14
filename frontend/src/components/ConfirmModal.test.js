import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ConfirmModal from './ConfirmModal';

// A confirm whose action fails used to leave its button disabled for good and
// say nothing. Now it stays open, says why, and can be tried again.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k, fallback) => (typeof fallback === 'string' ? fallback : k) }),
}));

test('a failed action is said, and the button works again', async () => {
  const onConfirm = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce();
  render(<ConfirmModal message="Delete this entry?" onConfirm={onConfirm} onCancel={() => {}} />);

  fireEvent.click(screen.getByText('Delete'));
  expect(await screen.findByRole('alert')).toHaveTextContent(/could not be reached/);
  expect(screen.getByText('Delete')).not.toBeDisabled();

  fireEvent.click(screen.getByText('Delete'));
  await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
});

test('a refused action keeps the server reason', async () => {
  const err = Object.assign(new Error('Entry is locked'), { status: 409, body: { error: 'Entry is locked' } });
  render(<ConfirmModal message="Delete?" onConfirm={vi.fn().mockRejectedValue(err)} onCancel={() => {}} />);

  fireEvent.click(screen.getByText('Delete'));
  expect(await screen.findByRole('alert')).toHaveTextContent('Entry is locked');
});
