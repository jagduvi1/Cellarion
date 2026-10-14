import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Cellars from './Cellars';

// A brand-new account lands on the cellar list with nothing in it. The create
// form is open with a name already filled in, so the first cellar is one tap —
// before, the way forward was an unlabelled + button and an empty required
// field. A list that could not be LOADED is not an empty account: it says so
// and offers Retry instead of "You have no cellars yet" (and no create form).

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k, fallback) => (typeof fallback === 'string' ? fallback : k) }),
}));

const navigateMock = vi.fn();
vi.mock('react-router-dom', async (orig) => ({ ...(await orig()), useNavigate: () => navigateMock }));

let auth;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

beforeEach(() => {
  navigateMock.mockReset();
  auth = {
    user: { id: 'u1', preferences: {} },
    updatePreferences: vi.fn(),
    apiFetch: vi.fn(async (url, init) => {
      if (init?.method === 'POST') return json(201, { cellar: { _id: 'c-new', name: JSON.parse(init.body).name, userRole: 'owner' } });
      return json(200, { cellars: [] });
    }),
  };
});

const renderList = () => render(<MemoryRouter><Cellars /></MemoryRouter>);

test('no cellars yet: the create form is open with a name filled in', async () => {
  renderList();
  expect(await screen.findByDisplayValue('My cellar')).toBeInTheDocument();
});

test('one tap on Create makes the first cellar and opens it', async () => {
  renderList();
  await screen.findByDisplayValue('My cellar');
  fireEvent.click(screen.getByText('cellars.createBtn'));

  await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/cellars/c-new', { replace: true }));
  const post = auth.apiFetch.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(JSON.parse(post[1].body)).toMatchObject({ name: 'My cellar' });
});

test('the header button says what it does: restore a backup', async () => {
  renderList();
  expect(await screen.findByText('Restore backup')).toBeInTheDocument();
});

test('a list that could not be loaded offers Retry, not an empty account', async () => {
  auth.apiFetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
  renderList();

  expect(await screen.findByRole('alert')).toHaveTextContent(/could not be loaded/);
  expect(screen.queryByText('cellars.emptyCellars')).not.toBeInTheDocument();
  expect(screen.queryByDisplayValue('My cellar')).not.toBeInTheDocument();

  auth.apiFetch.mockImplementation(async () => json(200, { cellars: [] }));
  fireEvent.click(screen.getByText('Retry'));
  expect(await screen.findByDisplayValue('My cellar')).toBeInTheDocument();
});
