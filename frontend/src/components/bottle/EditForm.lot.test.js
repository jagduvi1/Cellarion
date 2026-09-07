import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// "Also apply the drink window and price to the other N bottles of this wine
// and vintage" (support ticket 2026-09-06). The checkbox only appears when the
// bottle response listed siblings; ticked, the CHANGED lot-level fields go to
// them through the bulk route after the single save; the outcome travels to
// the page through onSaved.

vi.mock('react-i18next', () => {
  const t = (key, a, b) => {
    const vars = b && typeof b === 'object' ? b : (a && typeof a === 'object' ? a : undefined);
    return vars ? `${key}:${JSON.stringify(vars)}` : key;
  };
  return { useTranslation: () => ({ t }) };
});
vi.mock('../../api/bottles', () => ({ updateBottle: vi.fn(), setBottleDefaultImage: vi.fn(), bulkUpdateBottles: vi.fn() }));
vi.mock('../ImageUpload', () => ({ default: () => null }));
vi.mock('../ImageGallery', () => ({ default: () => null }));
vi.mock('../RatingInput', () => ({ default: () => null }));
const { apiFetch } = vi.hoisted(() => ({ apiFetch: () => {} }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ apiFetch, user: { preferences: { currency: 'SEK' } } }),
}));

const { updateBottle, bulkUpdateBottles } = await import('../../api/bottles');
const { default: EditForm, changedLotFields } = await import('./EditForm');

const okRes = (body) => ({ ok: true, json: async () => body });
const BOTTLE = {
  _id: 'b1', vintage: '2019', bottleSize: '750ml', price: 25, currency: 'EUR',
  drinkFrom: 2026, drinkTo: 2035, peakFrom: null, peakUntil: null, notes: '', ratingScale: '5',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('changedLotFields', () => {
  test('only the lot-level fields that changed; a changed price carries its currency', () => {
    expect(changedLotFields(BOTTLE, { ...BOTTLE, drinkTo: 2040, notes: 'x', rating: 4 })).toEqual({ drinkFrom: 2026, drinkTo: 2040, peakFrom: null, peakUntil: null });
    expect(changedLotFields(BOTTLE, { ...BOTTLE, price: 30 })).toEqual({ price: 30, currency: 'EUR' });
    expect(changedLotFields(BOTTLE, { ...BOTTLE, currency: 'SEK' })).toEqual({ currency: 'SEK' });
    expect(changedLotFields(BOTTLE, { ...BOTTLE })).toEqual({});
  });
  test('a currency without a price is not a change (the form defaults it from preferences)', () => {
    expect(changedLotFields({ ...BOTTLE, price: null, currency: null }, { ...BOTTLE, price: null, currency: 'SEK' })).toEqual({});
  });
  test('clearing a year propagates the clear', () => {
    expect(changedLotFields(BOTTLE, { ...BOTTLE, drinkFrom: null })).toEqual({ drinkFrom: null, drinkTo: 2035, peakFrom: null, peakUntil: null });
  });
});

describe('EditForm lot checkbox', () => {
  test('no siblings: no checkbox; siblings: checkbox with the count', () => {
    const { rerender } = render(<EditForm bottle={BOTTLE} onSaved={() => {}} onCancel={() => {}} />);
    expect(screen.queryByRole('checkbox')).toBeNull();
    rerender(<EditForm bottle={BOTTLE} lotSiblingIds={['b2', 'b3']} onSaved={() => {}} onCancel={() => {}} />);
    expect(screen.getByText('bottleDetail.applyToLot:{"count":2}')).toBeTruthy();
  });

  test('ticked: the changed window goes to the siblings after the save, and the outcome reaches onSaved', async () => {
    updateBottle.mockResolvedValue(okRes({ bottle: { ...BOTTLE, drinkTo: 2040 } }));
    bulkUpdateBottles.mockResolvedValue(okRes({ done: 2, skipped: [] }));
    const onSaved = vi.fn();
    const { container } = render(<EditForm bottle={BOTTLE} lotSiblingIds={['b2', 'b3']} onSaved={onSaved} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(container.querySelector('input[value="2035"]'), { target: { value: '2040' } });
    fireEvent.click(screen.getByText('bottleDetail.saveChanges'));
    await waitFor(() => expect(bulkUpdateBottles).toHaveBeenCalledWith(apiFetch, ['b2', 'b3'], { drinkFrom: 2026, drinkTo: 2040, peakFrom: null, peakUntil: null }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({ drinkTo: 2040 }), { done: 2, skipped: 0, fields: ['drinkFrom', 'drinkTo', 'peakFrom', 'peakUntil'] }));
  });

  test('ticked but nothing lot-level changed: the siblings are left alone and the page is told', async () => {
    updateBottle.mockResolvedValue(okRes({ bottle: { ...BOTTLE, notes: 'corked?' } }));
    const onSaved = vi.fn();
    render(<EditForm bottle={BOTTLE} lotSiblingIds={['b2']} onSaved={onSaved} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByPlaceholderText('addBottle.notesPlaceholder'), { target: { value: 'corked?' } });
    fireEvent.click(screen.getByText('bottleDetail.saveChanges'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.anything(), { nothing: true }));
    expect(bulkUpdateBottles).not.toHaveBeenCalled();
  });

  test('unticked: siblings are never touched', async () => {
    updateBottle.mockResolvedValue(okRes({ bottle: BOTTLE }));
    const onSaved = vi.fn();
    const { container } = render(<EditForm bottle={BOTTLE} lotSiblingIds={['b2']} onSaved={onSaved} onCancel={() => {}} />);
    fireEvent.change(container.querySelector('input[value="2035"]'), { target: { value: '2040' } });
    fireEvent.click(screen.getByText('bottleDetail.saveChanges'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(BOTTLE, null));
    expect(bulkUpdateBottles).not.toHaveBeenCalled();
  });
});
