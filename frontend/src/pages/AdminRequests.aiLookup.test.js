import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import AdminRequests from './AdminRequests';
import { adminResolveWineRequest, adminGetRegions, adminGetAppellations } from '../api/admin';
import { getAiWineInfo } from '../api/wines';

// "Look up" asks the AI about a requested wine and fills in the create form.
// The answer takes seconds. The form the lookup wrote back was the one from the
// moment of the click, so a name corrected, a note written or a photo box
// unticked while it ran was put back. Only the fields the lookup answers are
// merged now, into the form as it is when the answer lands.
//
// Harness from AdminRequests.test.js.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, opts) => (opts && opts.count !== undefined ? `${key}:${opts.count}` : key),
  }),
}));

const apiFetch = vi.fn();
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch }) }));

const jsonRes = (body, ok = true) => ({ ok, json: () => Promise.resolve(body) });

vi.mock('../api/admin', () => ({
  adminGetWineRequests: vi.fn(),
  adminResolveWineRequest: vi.fn(),
  adminRejectWineRequest: vi.fn(),
  adminGetCountries: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ countries: [{ _id: 'c-it', name: 'Italy' }] }) }),
  adminGetGrapes: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ grapes: [{ _id: 'g-neb', name: 'Nebbiolo' }] }) }),
  adminGetRegions: vi.fn(),
  adminGetAppellations: vi.fn(),
}));

vi.mock('../api/wines', () => ({
  searchWines: vi.fn(),
  getAiWineInfo: vi.fn(),
}));

const { adminGetWineRequests } = await import('../api/admin');

const REQUEST = {
  _id: 'req-1',
  wineName: 'Canubi',
  producer: 'Example Estate',
  status: 'pending',
  requestType: 'new_wine',
  image: 'data:image/png;base64,iVBORw0KGgo=',
  user: { username: 'user1' },
  createdAt: '2026-08-01T00:00:00.000Z',
};
const FOUND = { type: 'red', country: 'Italy', region: 'Piedmont', appellation: 'Barolo', grapes: ['Nebbiolo'] };

// The lookup answers when the test says so.
let answerLookup;
const duplicateChecks = () => apiFetch.mock.calls.map(([url]) => url).filter((url) => url.startsWith('/api/admin/wines/duplicates'));

beforeEach(() => {
  vi.clearAllMocks();
  apiFetch.mockResolvedValue(jsonRes({ candidates: [] }));
  adminGetWineRequests.mockResolvedValue(jsonRes({ count: 1, total: 1, requests: [REQUEST] }));
  adminGetRegions.mockResolvedValue(jsonRes({ regions: [{ _id: 'r-pie', name: 'Piedmont' }] }));
  adminGetAppellations.mockResolvedValue(jsonRes({ appellations: [{ _id: 'a-bar', name: 'Barolo' }] }));
  adminResolveWineRequest.mockResolvedValue(jsonRes({ wineRequest: {} }));
  getAiWineInfo.mockImplementation(() => new Promise((resolve) => { answerLookup = () => resolve(jsonRes({ wine: FOUND })); }));
});

const openRequestAndStartLookup = async () => {
  render(<AdminRequests />);
  fireEvent.click(await screen.findByText('Canubi'));
  fireEvent.click(await screen.findByRole('button', { name: 'Look up' }));
  await waitFor(() => expect(getAiWineInfo).toHaveBeenCalledWith(apiFetch, 'Canubi Example Estate'));
};
const lookupLanded = () => waitFor(() => expect(screen.getByDisplayValue('Barolo')).toBeInTheDocument());
const sentWine = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'admin.requests.resolve' }));
  await waitFor(() => expect(adminResolveWineRequest).toHaveBeenCalledTimes(1));
  return adminResolveWineRequest.mock.calls[0][2];
};

test('what the admin typed while the lookup ran is still there when it lands', async () => {
  await openRequestAndStartLookup();

  fireEvent.change(screen.getByDisplayValue('Canubi'), { target: { value: 'Cannubi' } });
  fireEvent.change(screen.getByDisplayValue('Example Estate'), { target: { value: 'Example Estate & Figli' } });
  fireEvent.click(screen.getByTestId('use-request-photo'));
  fireEvent.change(screen.getByPlaceholderText('admin.requests.adminNotesPlaceholder'), { target: { value: 'Spelling corrected' } });

  answerLookup();
  await lookupLanded();

  expect(screen.getByDisplayValue('Cannubi')).toBeInTheDocument();
  expect(screen.getByDisplayValue('Example Estate & Figli')).toBeInTheDocument();
  expect(screen.getByTestId('use-request-photo')).not.toBeChecked();

  const body = await sentWine();
  expect(body.adminNotes).toBe('Spelling corrected');
  expect(body.wineData).toMatchObject({
    name: 'Cannubi', producer: 'Example Estate & Figli', useRequestPhoto: false,
    // and what the lookup found is in the same form
    type: 'red', country: 'c-it', region: 'r-pie', appellation: 'Barolo', grapes: ['g-neb'],
  });
});

test('the duplicate check after the lookup asks about the name as it is now', async () => {
  await openRequestAndStartLookup();
  fireEvent.change(screen.getByDisplayValue('Canubi'), { target: { value: 'Cannubi' } });

  answerLookup();
  await lookupLanded();

  await waitFor(() => expect(duplicateChecks().length).toBeGreaterThan(0));
  // The check waits for a pause in the typing; give a late one the time to show up.
  await new Promise((r) => setTimeout(r, 500));
  expect(duplicateChecks().at(-1)).toContain('name=Cannubi&producer=Example%20Estate');
});

test('a form nobody touched gets the lookup\'s fields and keeps the request\'s name and producer', async () => {
  await openRequestAndStartLookup();
  answerLookup();
  await lookupLanded();

  const body = await sentWine();
  expect(body.wineData).toMatchObject({
    name: 'Canubi', producer: 'Example Estate', useRequestPhoto: true,
    type: 'red', country: 'c-it', region: 'r-pie', appellation: 'Barolo', grapes: ['g-neb'],
  });
});

test('a lookup that names no type leaves the type the admin chose', async () => {
  getAiWineInfo.mockImplementation(() => new Promise((resolve) => { answerLookup = () => resolve(jsonRes({ wine: { ...FOUND, type: undefined } })); }));
  await openRequestAndStartLookup();
  fireEvent.change(screen.getByDisplayValue('red'), { target: { value: 'white' } });

  answerLookup();
  await lookupLanded();

  expect((await sentWine()).wineData.type).toBe('white');
});
