/**
 * The auto-mode grouping controls (support ticket 2026-09-12): up to three
 * nested levels picked one under the other, the collapse toggle that only
 * matters once there is a second level, the legacy groupBy kept in sync, and
 * the live preview rendering the nested headings from unsaved state.
 */
import { render, screen, fireEvent, act } from '@testing-library/react';

vi.mock('../api/wineLists', () => ({
  getWineList: vi.fn(),
  getCellarWines: vi.fn(),
  updateWineList: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
  publishWineList: vi.fn(),
  unpublishWineList: vi.fn(),
  uploadWineListLogo: vi.fn(),
  getWineListStats: vi.fn(),
  previewWineListPdf: vi.fn(),
}));
const { authState } = vi.hoisted(() => ({ authState: { apiFetch: vi.fn(), user: { _id: 'me' } } }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => authState }));
vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: 'c1', listId: 'l1' }),
  Link: ({ children, to }) => <a href={to}>{children}</a>,
}));
// Real English strings, so the assertions read like the screen does
vi.mock('react-i18next', async () => {
  const en = (await import('../locales/en/translation.json')).default;
  const t = (key) => key.split('.').reduce((o, k) => (o == null ? o : o[k]), en) ?? key;
  return { useTranslation: () => ({ t }) };
});

const api = await import('../api/wineLists');
const WineListEditor = (await import('./WineListEditor')).default;

const res = (body) => ({ ok: true, status: 200, json: async () => body });
const WINES = [
  { wine: { _id: 'w1', name: 'Barolo', producer: 'Conterno', type: 'red', country: { name: 'Italy' }, region: { name: 'Piedmont' }, grapes: [] }, vintage: '2018', bottleSize: '750ml', stock: 1, avgPrice: 40 },
  { wine: { _id: 'w2', name: 'Rioja', producer: 'Muga', type: 'red', country: { name: 'Spain' }, region: { name: 'Rioja' }, grapes: [] }, vintage: 'NV', bottleSize: '750ml', stock: 3, avgPrice: 20 },
];
const LIST = {
  _id: 'l1', name: 'Hemma', structureMode: 'auto', language: 'en',
  autoGrouping: { groupBy: 'type', withinGroup: 'name' },
  autoGroupEntries: [
    { wine: 'w1', vintage: '2018', bottleSize: '750ml', listPrice: 95, sortOrder: 0 },
    { wine: 'w2', vintage: 'NV', bottleSize: '750ml', listPrice: 30, sortOrder: 1 },
  ],
  sections: [], branding: {}, layout: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getWineList.mockResolvedValue(res({ ...LIST, resolvedWines: [] }));
  api.getCellarWines.mockResolvedValue(res(WINES));
});

describe('WineListEditor grouping levels', () => {
  test('a legacy single-level list shows "Group by" plus one empty "Then by"; picking a second level reveals the third and the collapse toggle', async () => {
    render(<WineListEditor />);
    const level0 = await screen.findByTestId('group-level-0');
    expect(level0).toHaveValue('type');
    expect(screen.getByTestId('group-level-1')).toHaveValue('');
    expect(screen.queryByTestId('group-level-2')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Skip a heading/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId('group-level-1'), { target: { value: 'country' } });
    expect(screen.getByTestId('group-level-2')).toHaveValue('');
    expect(screen.getByLabelText(/Skip a heading/)).toBeChecked();
    // The field already used above is not offered again below it
    const level2Options = [...screen.getByTestId('group-level-2').options].map(o => o.value);
    expect(level2Options).toEqual(['', 'region', 'appellation']);
  });

  test('clearing a middle level drops the one below it, and the preview renders the nested headings from unsaved state', async () => {
    render(<WineListEditor />);
    await screen.findByTestId('group-level-0');
    fireEvent.change(screen.getByTestId('group-level-1'), { target: { value: 'country' } });
    fireEvent.change(screen.getByTestId('group-level-2'), { target: { value: 'region' } });
    expect(screen.getByTestId('group-level-2')).toHaveValue('region');

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Preview' })); });
    // Red Wines › Italy / Spain; Piedmont and Rioja collapse under their single country
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Red Wines');
    expect(screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual(['Italy', 'Spain']);
    expect(screen.queryByRole('heading', { level: 4 })).not.toBeInTheDocument();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Wines/ })); });
    fireEvent.change(screen.getByTestId('group-level-1'), { target: { value: '' } });
    expect(screen.queryByTestId('group-level-2')).not.toBeInTheDocument();
    expect(screen.getByTestId('group-level-1')).toHaveValue('');
  });

  test('the layout tab carries the hide-prices and last-bottle toggles, and the preview honours them', async () => {
    render(<WineListEditor />);
    await screen.findByTestId('group-level-0');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Layout' })); });
    fireEvent.click(screen.getByLabelText(/Hide prices/));
    fireEvent.click(screen.getByLabelText(/only one bottle left/));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Preview' })); });
    expect(screen.queryByText('$95')).not.toBeInTheDocument();
    expect(screen.getAllByText('Last bottle')).toHaveLength(1); // Barolo has stock 1, Rioja 3
  });
});
