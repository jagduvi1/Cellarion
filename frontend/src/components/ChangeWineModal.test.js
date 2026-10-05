import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ChangeWineModal from './ChangeWineModal';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k, opts) => (opts && opts.count !== undefined ? `${k}:${opts.count}` : k) }),
}));

let api;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch: api }) }));
// The registry search itself is WineSearchPicker's business: stand in with a
// button that picks one wine.
vi.mock('./WineSearchPicker', () => ({
  default: ({ selected, onSelect }) => (selected
    ? <span>picked {selected.name}</span>
    : <button type="button" onClick={() => onSelect({ _id: 'w-red', name: 'Châteauneuf-du-Pape', producer: 'Domaine du Vieux Lazaret' })}>pick</button>),
}));

const ok = (body) => ({ ok: true, status: 200, json: async () => body });

beforeEach(() => {
  api = vi.fn(async () => ok({ bottle: {}, alsoMoved: 0 }));
});

test('nothing can be confirmed before a wine is picked; then ONE request moves the bottle', async () => {
  const onChanged = vi.fn();
  render(<ChangeWineModal bottleId="b1" currentLabel="Domaine du Vieux Lazaret — Châteauneuf-du-Pape Blanc" onClose={() => {}} onChanged={onChanged} />);
  expect(screen.getByText('changeWine.confirm')).toBeDisabled();
  fireEvent.click(screen.getByText('pick'));
  fireEvent.click(screen.getByText('changeWine.confirm'));
  await waitFor(() => expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ alsoMoved: 0 })));
  const [url, init] = api.mock.calls[0];
  expect(url).toBe('/api/bottles/b1/change-wine');
  expect(JSON.parse(init.body)).toEqual({ wineDefinitionId: 'w-red' });
});

test('with a lot, the box moves the other bottles of the wine and vintage too', async () => {
  api = vi.fn(async () => ok({ bottle: {}, alsoMoved: 2 }));
  const onChanged = vi.fn();
  render(<ChangeWineModal bottleId="b1" lotCount={2} onClose={() => {}} onChanged={onChanged} />);
  fireEvent.click(screen.getByText('pick'));
  fireEvent.click(screen.getByLabelText(/changeWine.alsoLot:2/));
  fireEvent.click(screen.getByText('changeWine.confirm'));
  await waitFor(() => expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ alsoMoved: 2 })));
  expect(JSON.parse(api.mock.calls[0][1].body)).toEqual({ wineDefinitionId: 'w-red', applyToLot: true });
});

test('a refusal is shown and nothing is reported as changed', async () => {
  api = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: 'The bottle is already this wine', code: 'same_wine' }) }));
  const onChanged = vi.fn();
  render(<ChangeWineModal bottleId="b1" onClose={() => {}} onChanged={onChanged} />);
  fireEvent.click(screen.getByText('pick'));
  fireEvent.click(screen.getByText('changeWine.confirm'));
  expect(await screen.findByRole('alert')).toHaveTextContent('The bottle is already this wine');
  expect(onChanged).not.toHaveBeenCalled();
});
