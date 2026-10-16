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

// One drink dialog (usability plan 2026-10-14, D2): the rack page and the 3D
// room use this dialog too, with "Just a glass" on top; the bottle page has
// its own "Open bottle…" button and does not pass it.
describe('ConsumeModal — "Just a glass" and the reservation warning', () => {
  test('without onJustAGlass there is no "Just a glass" choice (the bottle page)', () => {
    render(<ConsumeModal wineName="Rioja Reserva" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('dialog')).toHaveAccessibleName('bottleDetail.removeBottleTitle');
    expect(screen.queryByText(/openBottle\.partialOption/)).not.toBeInTheDocument();
    expect(screen.queryByText('openBottle.partialOr')).not.toBeInTheDocument();
  });

  test('with onJustAGlass the choice comes first, and taking it never takes the bottle out', () => {
    const onJustAGlass = vi.fn();
    const onConfirm = vi.fn();
    render(<ConsumeModal wineName="Rioja Reserva" onConfirm={onConfirm} onCancel={vi.fn()} onJustAGlass={onJustAGlass} />);

    expect(screen.getByText('openBottle.partialOr')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /openBottle\.partialOption/ }));

    expect(onJustAGlass).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test('"Just a glass" cannot be tapped while the bottle is being taken out', async () => {
    let finish;
    const onConfirm = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    render(<ConsumeModal onConfirm={onConfirm} onCancel={vi.fn()} onJustAGlass={vi.fn()} />);

    fireEvent.click(screen.getByText('common.confirm'));
    await waitFor(() => expect(screen.getByRole('button', { name: /openBottle\.partialOption/ })).toBeDisabled());
    finish();
    await waitFor(() => expect(screen.getByRole('button', { name: /openBottle\.partialOption/ })).toBeEnabled());
  });

  test('a reserved bottle shows the warning above the form', () => {
    render(<ConsumeModal wineName="Rioja Reserva" reservationText="for Anna until 2030" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'bottleDetail.consumeReservedWarning:{"reservation":"for Anna until 2030"}',
    );
  });

  test('an unreserved bottle shows no warning', () => {
    render(<ConsumeModal wineName="Rioja Reserva" onConfirm={vi.fn()} onCancel={vi.fn()} onJustAGlass={vi.fn()} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
