/**
 * What the owner sees when a save does not go through (support ticket
 * 2026-10-09: a refused save showed as "check your connection", and the
 * reason the server gave was never displayed).
 *
 *   - the server answered with a reason → that reason, under the header
 *   - the server answered without one → "Failed to save", no banner
 *   - the request never got through → "check your connection", no banner
 */
import { render, screen, fireEvent, act } from '@testing-library/react';

vi.mock('../api/wineLists', () => ({
  getWineList: vi.fn(),
  getCellarWines: vi.fn(),
  updateWineList: vi.fn(),
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
// Real English strings with {{interpolation}}, so the assertions read like the screen does
vi.mock('react-i18next', async () => {
  const en = (await import('../locales/en/translation.json')).default;
  const t = (key, vars = {}) => {
    const raw = key.split('.').reduce((o, k) => (o == null ? o : o[k]), en) ?? key;
    return String(raw).replace(/{{(\w+)}}/g, (m, name) => (name in vars ? vars[name] : m));
  };
  return { useTranslation: () => ({ t }) };
});

const api = await import('../api/wineLists');
const WineListEditor = (await import('./WineListEditor')).default;

const res = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });
const LIST = {
  _id: 'l1', name: 'Stock', structureMode: 'auto', language: 'en',
  autoGrouping: { groupBy: 'type', withinGroup: 'name' },
  autoGroupEntries: [], sections: [], branding: {}, layout: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getWineList.mockResolvedValue(res({ ...LIST, resolvedWines: [] }));
  api.getCellarWines.mockResolvedValue(res([]));
});

async function editTitleAndSave() {
  render(<WineListEditor />);
  const title = await screen.findByDisplayValue('Stock');
  fireEvent.change(title, { target: { value: 'Stock 2' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
}

describe('WineListEditor save failures', () => {
  test('a refused save shows the reason the server gave', async () => {
    api.updateWineList.mockResolvedValue(res({ error: 'Invalid wine list data' }, false, 400));

    await editTitleAndSave();

    expect(await screen.findByRole('alert')).toHaveTextContent('Not saved: Invalid wine list data');
    expect(screen.getByText('Failed to save')).toBeInTheDocument();
    expect(screen.queryByText(/check your connection/)).not.toBeInTheDocument();
  });

  test('a server answer without a reason is still not a connection problem', async () => {
    api.updateWineList.mockResolvedValue(res({}, false, 500));

    await editTitleAndSave();

    expect(await screen.findByText('Failed to save')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('a request that never got through is the connection message, and a later success clears everything', async () => {
    api.updateWineList.mockRejectedValueOnce(new Error('offline'));

    await editTitleAndSave();

    expect(await screen.findByText('Autosave failed — check your connection')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    api.updateWineList.mockResolvedValue(res({}));
    fireEvent.change(screen.getByDisplayValue('Stock 2'), { target: { value: 'Stock 3' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });

    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
