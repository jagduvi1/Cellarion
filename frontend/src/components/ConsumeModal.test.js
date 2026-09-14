import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => {
  const t = (key, a, b) => {
    const vars = b && typeof b === 'object' ? b : (a && typeof a === 'object' ? a : undefined);
    return vars ? `${key}:${JSON.stringify(vars)}` : key;
  };
  return { useTranslation: () => ({ t }) };
});
vi.mock('./RatingInput', () => ({ default: () => <div data-testid="rating-input" /> }));

const { ConsumeModal } = await import('./ConsumeModal');

const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

describe('ConsumeModal — the day the bottle was drunk (support ticket 2026-09-13)', () => {
  test('offers a date field that defaults to today and cannot be set in the future', () => {
    render(<ConsumeModal wineName="Rioja Reserva" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    const date = screen.getByLabelText('bulk.consumeDate');
    expect(date).toHaveAttribute('type', 'date');
    expect(date).toHaveValue(localToday());
    expect(date).toHaveAttribute('max', localToday());
  });

  test('passes the chosen date to onConfirm as the fifth argument', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<ConsumeModal wineName="Rioja Reserva" defaultRatingScale="5" onConfirm={onConfirm} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('bulk.consumeDate'), { target: { value: '2026-09-06' } });
    fireEvent.click(screen.getByText('common.confirm'));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onConfirm).toHaveBeenCalledWith('drank', undefined, undefined, '5', '2026-09-06');
  });

  test('a cleared date sends undefined so the server stamps "now", as before', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<ConsumeModal onConfirm={onConfirm} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('bulk.consumeDate'), { target: { value: '' } });
    fireEvent.click(screen.getByText('common.confirm'));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onConfirm.mock.calls[0][4]).toBeUndefined();
  });
});
