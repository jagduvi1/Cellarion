import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// The review queue with per-vintage slots (2026-09-04): each suggested value
// says which slot it lands in, a vintage row shows what the wine says
// wine-wide today (or that it says nothing yet), and the reviewer can widen a
// vintage suggestion into the wine-wide default in one click.

vi.mock('react-router-dom', () => ({
  Link: ({ children, to }) => <a href={to}>{children}</a>,
}));

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch }) }));

vi.mock('../api/registryData', () => ({
  getRegistryDataQueues: vi.fn(),
  decideRegistryKey: vi.fn(),
  decideRegistryValue: vi.fn(),
}));

const { getRegistryDataQueues, decideRegistryValue } = await import('../api/registryData');
const AdminRegistryData = (await import('./AdminRegistryData')).default;

const ok = (body) => ({ ok: true, json: async () => body });
const ABV = { _id: 'k1', name: 'ABV', unit: '%' };
const WINE = { _id: 'w1', name: 'Bannockburn Pinot Noir', producer: 'Valli', slug: 'valli-bannockburn' };

beforeEach(() => {
  vi.clearAllMocks();
  decideRegistryValue.mockResolvedValue(ok({ value: { _id: 'v1', status: 'published' } }));
});

test('a vintage row shows its slot and the wine-wide value it diverges from', async () => {
  getRegistryDataQueues.mockResolvedValue(ok({
    keys: [],
    values: [{ _id: 'v1', key: ABV, value: 14, vintage: '2023', wineDefault: 13.5, wineDefinition: WINE, suggestedBy: { username: 'akki' } }],
  }));
  render(<AdminRegistryData />);
  expect(await screen.findByText(/for the/)).toHaveTextContent('for the 2023 vintage · wine-wide today: 13.5 %');
  expect(screen.getByText('Publish for 2023')).toBeInTheDocument();
  expect(screen.getByText('Publish as wine default')).toBeInTheDocument();
});

test('a vintage row on a wine with no default yet says so, and a wine-wide row has no widen button', async () => {
  getRegistryDataQueues.mockResolvedValue(ok({
    keys: [],
    values: [
      { _id: 'v1', key: ABV, value: 14, vintage: '2023', wineDefault: null, wineDefinition: WINE, suggestedBy: { username: 'akki' } },
      { _id: 'v2', key: ABV, value: 13, vintage: null, wineDefinition: WINE, suggestedBy: { username: 'james' } },
    ],
  }));
  render(<AdminRegistryData />);
  expect(await screen.findByText('no wine-wide value yet')).toBeInTheDocument();
  expect(screen.getByText('all vintages')).toBeInTheDocument();
  expect(screen.getAllByText('Publish as wine default')).toHaveLength(1);
  expect(screen.getByText('Publish')).toBeInTheDocument(); // the wine-wide row's plain button
});

test('"Publish as wine default" sends asWineDefault; plain publish does not', async () => {
  getRegistryDataQueues.mockResolvedValue(ok({
    keys: [],
    values: [{ _id: 'v1', key: ABV, value: 14, vintage: '2023', wineDefault: null, wineDefinition: WINE, suggestedBy: { username: 'akki' } }],
  }));
  render(<AdminRegistryData />);
  fireEvent.click(await screen.findByText('Publish as wine default'));
  await waitFor(() => expect(decideRegistryValue).toHaveBeenCalledWith(apiFetch, 'v1', 'publish', undefined, { asWineDefault: true }));
  // The decided row leaves the queue without a refetch
  await waitFor(() => expect(screen.queryByText('Publish as wine default')).not.toBeInTheDocument());

  getRegistryDataQueues.mockResolvedValue(ok({
    keys: [],
    values: [{ _id: 'v2', key: ABV, value: 14, vintage: '2023', wineDefault: null, wineDefinition: WINE, suggestedBy: { username: 'akki' } }],
  }));
  render(<AdminRegistryData />);
  fireEvent.click(await screen.findByText('Publish for 2023'));
  await waitFor(() => expect(decideRegistryValue).toHaveBeenLastCalledWith(apiFetch, 'v2', 'publish', undefined, {}));
});
