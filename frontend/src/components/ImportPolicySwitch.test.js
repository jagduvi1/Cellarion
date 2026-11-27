import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// The admin's two switches for how an import treats new wines, above the
// queue of wines waiting for a check. Each state must say plainly what it
// means, a change sends only the switch that was pressed, the buttons are
// offered only to whoever may press them, and a check that is switched on but
// does nothing (the server reviews no contributions) says so.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, vars) => {
      const s = typeof fallback === 'string' ? fallback : key;
      return vars ? s.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k]) : s;
    },
  }),
}));
// One stable apiFetch, as AuthContext provides.
vi.mock('../contexts/AuthContext', () => {
  const apiFetch = () => {};
  return { useAuth: () => ({ apiFetch }) };
});
vi.mock('../api/admin', () => ({ adminGetImportPolicy: vi.fn(), adminSaveImportPolicy: vi.fn() }));

const { adminGetImportPolicy, adminSaveImportPolicy } = await import('../api/admin');
const ImportPolicySwitch = (await import('./ImportPolicySwitch')).default;

const ok = (body) => ({ ok: true, json: async () => body });
const DEFAULTS = { aiLookup: true, checkNewWines: false, canChange: true, reviewOn: true, checking: false, waiting: 0 };

beforeEach(() => vi.clearAllMocks());

test('the defaults say the AI is asked and new wines are public at once', async () => {
  adminGetImportPolicy.mockResolvedValue(ok(DEFAULTS));
  render(<ImportPolicySwitch />);

  expect(await screen.findByText(/AI look-up: on\./)).toBeInTheDocument();
  expect(screen.getByText(/Check new wines: off\./)).toBeInTheDocument();
  expect(screen.queryByText(/waiting for a check/)).not.toBeInTheDocument();
});

test('turning the AI look-up off sends only that switch and says nothing goes to an AI provider', async () => {
  adminGetImportPolicy.mockResolvedValue(ok(DEFAULTS));
  adminSaveImportPolicy.mockResolvedValue(ok({ aiLookup: false, checkNewWines: false, updatedAt: '2026-11-27T12:00:00.000Z' }));
  const onChange = vi.fn();
  render(<ImportPolicySwitch onChange={onChange} />);

  fireEvent.click(await screen.findByText('Turn AI look-up off'));

  await waitFor(() => expect(adminSaveImportPolicy).toHaveBeenCalledWith(expect.any(Function), { aiLookup: false }));
  expect(await screen.findByText(/Nothing from a file is sent to an AI provider/)).toBeInTheDocument();
  expect(screen.getByText('Turn AI look-up on')).toBeInTheDocument();
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ aiLookup: false }));
});

test('switching the check on says new wines wait here, with how many do', async () => {
  adminGetImportPolicy.mockResolvedValue(ok({ ...DEFAULTS, waiting: 12 }));
  adminSaveImportPolicy.mockResolvedValue(ok({ aiLookup: true, checkNewWines: true }));
  render(<ImportPolicySwitch />);

  fireEvent.click(await screen.findByText('Check new wines before they are public'));

  await waitFor(() => expect(adminSaveImportPolicy).toHaveBeenCalledWith(expect.any(Function), { checkNewWines: true }));
  expect(await screen.findByText(/visible only to its owner until a curator has checked it here/)).toBeInTheDocument();
  expect(screen.getByText(/12 wine\(s\) are waiting for a check/)).toBeInTheDocument();
  expect(screen.getByText('Stop checking new wines')).toBeInTheDocument();
});

test('a check that is on where the server reviews no contributions says imported wines are public at once', async () => {
  adminGetImportPolicy.mockResolvedValue(ok({ ...DEFAULTS, checkNewWines: true, reviewOn: false }));
  render(<ImportPolicySwitch />);
  expect(await screen.findByText(/this server does not review contributions, so imported wines are public at once/)).toBeInTheDocument();
});

test('an admin who may not change them (a super admin is configured) sees the state without the buttons', async () => {
  adminGetImportPolicy.mockResolvedValue(ok({ ...DEFAULTS, canChange: false }));
  render(<ImportPolicySwitch />);
  expect(await screen.findByText('Only the super admin can change this on this server.')).toBeInTheDocument();
  expect(screen.queryByText('Turn AI look-up off')).not.toBeInTheDocument();
  expect(screen.queryByText('Check new wines before they are public')).not.toBeInTheDocument();
});

test('a refused change keeps the state and says why', async () => {
  adminGetImportPolicy.mockResolvedValue(ok(DEFAULTS));
  adminSaveImportPolicy.mockResolvedValue({ ok: false, json: async () => ({ error: 'Access denied' }) });
  render(<ImportPolicySwitch />);

  fireEvent.click(await screen.findByText('Turn AI look-up off'));

  expect(await screen.findByRole('alert')).toHaveTextContent('Access denied');
  expect(screen.getByText(/AI look-up: on\./)).toBeInTheDocument();
});

test('an older or unreachable server shows nothing', async () => {
  adminGetImportPolicy.mockResolvedValue({ ok: false, json: async () => ({}) });
  const { container } = render(<ImportPolicySwitch />);
  await waitFor(() => expect(adminGetImportPolicy).toHaveBeenCalled());
  expect(container).toBeEmptyDOMElement();
});
