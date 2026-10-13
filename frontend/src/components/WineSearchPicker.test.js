import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../api/wines', () => ({ searchWines: vi.fn() }));
// apiFetch keeps one identity, as the real context's does — the search effect
// lists it in its deps, so a fresh one per render would search forever.
const apiFetch = vi.fn();
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch }) }));
vi.mock('react-i18next', () => {
  const t = (key) => key;
  return { useTranslation: () => ({ t }) };
});

const { searchWines } = await import('../api/wines');
const WineSearchPicker = (await import('./WineSearchPicker')).default;

const jsonRes = (body) => ({ ok: true, status: 200, json: async () => body });
const BEER = { _id: 'b1', name: 'Pale Lager', producer: 'Example Brewery', type: 'sparkling', nonWine: true };

beforeEach(() => {
  vi.clearAllMocks();
  searchWines.mockResolvedValue(jsonRes({ wines: [BEER] }));
});

const type = (q) => fireEvent.change(screen.getByRole('combobox'), { target: { value: q } });

// 2026-10-13: the member's own hidden drinks are asked for only where a bottle
// goes onto the pick (Change wine) — never by a forum wine tag.
test('includeOwnHidden asks for them and labels one', async () => {
  render(<WineSearchPicker selected={null} onSelect={() => {}} includeOwnHidden />);
  type('lager');
  await waitFor(() => expect(searchWines).toHaveBeenCalled());
  expect(searchWines.mock.calls[0][1]).toBe('search=lager&limit=8&ownHidden=1');
  expect(await screen.findByText('wineSearchPicker.onlyInYourCellar')).toBeInTheDocument();
});

test('by default it does not ask', async () => {
  searchWines.mockResolvedValue(jsonRes({ wines: [] }));
  render(<WineSearchPicker selected={null} onSelect={() => {}} />);
  type('lager');
  await waitFor(() => expect(searchWines).toHaveBeenCalled());
  expect(searchWines.mock.calls[0][1]).toBe('search=lager&limit=8');
});
