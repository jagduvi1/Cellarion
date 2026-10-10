import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// "Drink one" from a grouped entry (support ticket 2026-10-09): pick WHICH
// bottle of the group leaves — by rack slot — then the ordinary consume form.
// One bottle, one request; the others are never touched.

vi.mock('react-i18next', () => {
  const t = (key, a, b) => {
    const vars = b && typeof b === 'object' ? b : (a && typeof a === 'object' ? a : undefined);
    return vars ? `${key}:${JSON.stringify(vars)}` : key;
  };
  return { useTranslation: () => ({ t, i18n: { language: 'en-GB' } }) };
});
vi.mock('./RatingInput', () => ({ default: () => <div data-testid="rating-input" /> }));

let api;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch: api, user: { id: 'u1', preferences: { ratingScale: '5' } } }) }));

const { default: DrinkOneModal } = await import('./DrinkOneModal');

const BOTTLES = [
  { _id: 'b1', status: 'active', vintage: '2015', price: 60, currency: 'EUR', purchaseDate: '2024-03-01' },
  { _id: 'b2', status: 'active', vintage: '2015', reservedFor: 'Anna' },
  { _id: 'b3', status: 'active', vintage: '2015' },
];
const RACKS = new Map([
  ['b1', { rackId: 'r1', rackName: 'Left wall', position: 3 }],
  ['b2', { rackId: 'r1', rackName: 'Left wall', position: 4 }],
]);

beforeEach(() => {
  api = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ bottle: { _id: 'b1' } }) }));
});

test('lists each bottle by its slot (unplaced ones say so), then logs exactly the picked one', async () => {
  const onDone = vi.fn();
  render(<DrinkOneModal bottles={BOTTLES} rackMap={RACKS} wineName="Margaux 2015" onClose={vi.fn()} onDone={onDone} />);

  expect(screen.getByText('drinkOne.slot:{"rack":"Left wall","position":3}')).toBeInTheDocument();
  expect(screen.getByText('drinkOne.slot:{"rack":"Left wall","position":4}')).toBeInTheDocument();
  expect(screen.getByText('drinkOne.unplaced')).toBeInTheDocument();
  expect(screen.getByText(/60 EUR/)).toBeInTheDocument();

  fireEvent.click(screen.getByText('drinkOne.slot:{"rack":"Left wall","position":4}'));
  // The ordinary consume form, warning about the reservation on this bottle.
  expect(screen.getByText('bottleDetail.removeBottleTitle')).toBeInTheDocument();
  expect(screen.getByRole('alert')).toBeInTheDocument();

  fireEvent.click(screen.getByText('common.confirm'));
  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  expect(api).toHaveBeenCalledTimes(1);
  expect(api.mock.calls[0][0]).toBe('/api/bottles/b2/consume');
  expect(JSON.parse(api.mock.calls[0][1].body)).toEqual(expect.objectContaining({ reason: 'drank' }));
  expect(onDone).toHaveBeenCalledWith(BOTTLES[1], 'drank');
});

test('a single bottle skips the picker; cancelling the form closes the whole thing', () => {
  const onClose = vi.fn();
  render(<DrinkOneModal bottles={[BOTTLES[0]]} rackMap={RACKS} wineName="Margaux 2015" onClose={onClose} onDone={vi.fn()} />);
  expect(screen.queryByText('drinkOne.title')).toBeNull();
  expect(screen.getByText('bottleDetail.removeBottleTitle')).toBeInTheDocument();
  fireEvent.click(screen.getByText('common.cancel'));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('a refused consume returns to the picker with the server\'s reason; nothing is marked done', async () => {
  api = vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ error: 'Already consumed' }) }));
  const onDone = vi.fn();
  render(<DrinkOneModal bottles={BOTTLES} rackMap={RACKS} wineName="Margaux 2015" onClose={vi.fn()} onDone={onDone} />);
  fireEvent.click(screen.getByText('drinkOne.unplaced'));
  fireEvent.click(screen.getByText('common.confirm'));
  expect(await screen.findByText('Already consumed')).toBeInTheDocument();
  expect(screen.getByText('drinkOne.title')).toBeInTheDocument();
  expect(onDone).not.toHaveBeenCalled();
});

test('a refused consume of a single bottle shows the reason too, with that bottle to try again', async () => {
  // A single entry in the cellar list carries "Drink one" with early access;
  // the consume form has no room for an error, so the picker shows it.
  api = vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ error: 'Already consumed' }) }));
  const onDone = vi.fn();
  render(<DrinkOneModal bottles={[BOTTLES[0]]} rackMap={RACKS} wineName="Margaux 2015" onClose={vi.fn()} onDone={onDone} />);
  fireEvent.click(screen.getByText('common.confirm'));
  expect(await screen.findByText('Already consumed')).toBeInTheDocument();
  expect(screen.getByText('drinkOne.slot:{"rack":"Left wall","position":3}')).toBeInTheDocument();
  expect(onDone).not.toHaveBeenCalled();
});
