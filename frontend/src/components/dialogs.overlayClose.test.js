import { render, screen, fireEvent } from '@testing-library/react';

// The dialogs that draw their own overlay (the drink form, the bottle picker
// of "Drink one", the journal prompt) close on a click beside the box. A click
// whose press began inside the box is a text selection that ran past the
// edge: it must not close the dialog and lose what was typed.

vi.mock('react-i18next', () => {
  const t = (key, a) => (typeof a === 'string' ? a : key);
  return { useTranslation: () => ({ t, i18n: { language: 'en-GB' } }) };
});
vi.mock('./RatingInput', () => ({ default: () => <div data-testid="rating-input" /> }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch: vi.fn(), user: { id: 'u1', preferences: { ratingScale: '5' } } }) }));

const { ConsumeModal } = await import('./ConsumeModal');
const { default: DrinkOneModal } = await import('./DrinkOneModal');
const { default: JournalPrompt } = await import('./JournalPrompt');

const BOTTLES = [
  { _id: 'b1', status: 'active', vintage: '2015' },
  { _id: 'b2', status: 'active', vintage: '2015' },
];
const RACKS = new Map([
  ['b1', { rackId: 'r1', rackName: 'Left wall', position: 3 }],
  ['b2', { rackId: 'r1', rackName: 'Left wall', position: 4 }],
]);

// Each dialog, how it is rendered, and something inside its box to press on.
const DIALOGS = [
  ['the drink form', (onClose) => render(<ConsumeModal wineName="Rioja Reserva" onConfirm={vi.fn()} onCancel={onClose} />), () => screen.getAllByRole('textbox')[0]],
  ['the bottle picker of "Drink one"', (onClose) => render(<DrinkOneModal bottles={BOTTLES} rackMap={RACKS} wineName="Margaux 2015" onClose={onClose} onDone={vi.fn()} />), () => screen.getAllByRole('button')[0]],
  ['the journal prompt', (onClose) => render(<JournalPrompt bottle={{ _id: 'b1' }} onDone={onClose} />), () => screen.getByRole('heading')],
];

describe.each(DIALOGS)('%s', (name, open, somethingInside) => {
  test('a press that starts inside the box and ends on the overlay does not close it', () => {
    const onClose = vi.fn();
    const { container } = open(onClose);
    const overlay = container.querySelector('.modal-overlay');
    fireEvent.pointerDown(somethingInside());
    fireEvent.click(overlay);
    expect(onClose).not.toHaveBeenCalled();
  });

  test('a press that starts and ends on the overlay closes it', () => {
    const onClose = vi.fn();
    const { container } = open(onClose);
    const overlay = container.querySelector('.modal-overlay');
    fireEvent.pointerDown(overlay);
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('a click inside the box does not close it', () => {
    const onClose = vi.fn();
    open(onClose);
    fireEvent.pointerDown(somethingInside());
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
  });
});
