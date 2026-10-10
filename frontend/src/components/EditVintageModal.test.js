import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// "Edit vintage" (early access): the window, peak and note a wine and vintage
// share, written to every bottle of it in one bulk request. A field the
// bottles disagree on opens empty and is only written when filled in, and
// only what the user changed is sent — a bottle's own note is never
// overwritten by accident.

vi.mock('react-i18next', () => {
  const t = (key, a) => (a && typeof a === 'object' && a.count !== undefined ? `${key}:${a.count}` : key);
  return { useTranslation: () => ({ t }) };
});
let api;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch: api }) }));

const { default: EditVintageModal } = await import('./EditVintageModal');

const b = (id, over = {}) => ({ _id: id, notes: 'Bought en primeur', drinkFrom: 2025, drinkTo: 2045, peakFrom: null, peakUntil: null, ...over });
const sent = () => JSON.parse(api.mock.calls[0][1].body);
const year = (label) => screen.getByLabelText(label);

beforeEach(() => {
  api = vi.fn(async () => ({ ok: true, json: async () => ({ done: 3, doneIds: ['b1', 'b2', 'b3'], skipped: [] }) }));
});

test('opens with what the bottles share and sends only the changed field, to every bottle', async () => {
  const onDone = vi.fn();
  render(<EditVintageModal bottles={[b('b1'), b('b2'), b('b3')]} title="Margaux 2015" onClose={vi.fn()} onDone={onDone} />);
  expect(screen.getByText('editVintage.intro:3')).toBeInTheDocument();
  expect(year('addBottle.drinkFrom')).toHaveValue(2025);
  expect(screen.getByLabelText('common.notes')).toHaveValue('Bought en primeur');

  fireEvent.change(year('addBottle.peakFrom'), { target: { value: '2030' } });
  fireEvent.click(screen.getByText('editVintage.submit'));

  await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
  expect(api.mock.calls[0][0]).toBe('/api/bottles/bulk');
  expect(sent()).toEqual({ action: 'update', bottleIds: ['b1', 'b2', 'b3'], fields: { peakFrom: 2030 } });
  fireEvent.click(await screen.findByText('bulk.close'));
  expect(onDone).toHaveBeenCalled();
});

test('notes that differ open empty, say so, and stay untouched unless a note is written', async () => {
  const bottles = [b('b1', { notes: 'Gift from Anna' }), b('b2', { notes: 'From the auction' }), b('b3', { notes: '' })];
  render(<EditVintageModal bottles={bottles} onClose={vi.fn()} onDone={vi.fn()} />);
  const notes = screen.getByLabelText('common.notes');
  expect(notes).toHaveValue('');
  expect(screen.getAllByText('editVintage.differs').length).toBeGreaterThan(0);

  fireEvent.change(year('addBottle.drinkTo'), { target: { value: '2040' } });
  fireEvent.click(screen.getByText('editVintage.submit'));
  await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
  expect(sent().fields).toEqual({ drinkTo: 2040 });
});

test('a written note replaces the differing ones; clearing a shared value clears it on all', async () => {
  const bottles = [b('b1', { notes: 'Gift from Anna' }), b('b2', { notes: 'From the auction' })];
  render(<EditVintageModal bottles={bottles} onClose={vi.fn()} onDone={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('common.notes'), { target: { value: '  Case of six from the merchant  ' } });
  fireEvent.change(year('addBottle.drinkFrom'), { target: { value: '' } });
  fireEvent.click(screen.getByText('editVintage.submit'));
  await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
  expect(sent().fields).toEqual({ notes: 'Case of six from the merchant', drinkFrom: null });
});

test('nothing changed closes without a request; a window the wrong way round is refused before sending', async () => {
  const onClose = vi.fn();
  const { unmount } = render(<EditVintageModal bottles={[b('b1')]} onClose={onClose} onDone={vi.fn()} />);
  fireEvent.click(screen.getByText('editVintage.submit'));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(api).not.toHaveBeenCalled();
  unmount();

  render(<EditVintageModal bottles={[b('b1')]} onClose={vi.fn()} onDone={vi.fn()} />);
  fireEvent.change(year('addBottle.drinkTo'), { target: { value: '2020' } });
  fireEvent.click(screen.getByText('editVintage.submit'));
  expect(await screen.findByRole('alert')).toHaveTextContent('addBottle.drinkWindowOrder');
  expect(api).not.toHaveBeenCalled();
});

test('a bottle whose own years clash is counted as skipped in the outcome', async () => {
  api = vi.fn(async () => ({ ok: true, json: async () => ({ done: 2, doneIds: ['b1', 'b2'], skipped: [{ id: 'b3', reason: 'invalid' }] }) }));
  render(<EditVintageModal bottles={[b('b1'), b('b2'), b('b3', { peakFrom: 2026 })]} onClose={vi.fn()} onDone={vi.fn()} />);
  fireEvent.change(year('addBottle.drinkFrom'), { target: { value: '2028' } });
  fireEvent.click(screen.getByText('editVintage.submit'));
  expect(await screen.findByText('bulk.windowSkippedInfo:1')).toBeInTheDocument();
});
