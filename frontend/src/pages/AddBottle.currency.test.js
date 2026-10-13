/**
 * AddBottle — the currency picker survives browser page translation
 * (2026-10-13: bottles were stored as "EURO").
 *
 * Chrome's translator rewrites the TEXT of a page, option labels included:
 * "EUR" became "EURO" for members using the English interface in Italian. An
 * <option> without a value attribute submits its text, so the form posted
 * "EURO". Locked here: every option carries its code as value, the picker is
 * marked translate="no", and a translated label still posts the code.
 *
 * Harness cloned from AddBottle.customFields.test.js.
 */

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

const { apiFetchMock, navigateMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  navigateMock: vi.fn(),
}));

vi.mock('../api/wines', () => ({
  searchWines: vi.fn(),
  resolveWine: vi.fn(),
  identifyWineByText: vi.fn(),
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ apiFetch: apiFetchMock, user: { preferences: { currency: 'USD' } } }),
}));
vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: 'cellar1' }),
  useNavigate: () => navigateMock,
  Link: ({ children }) => <a href="/">{children}</a>,
}));
vi.mock('../hooks/useLabelScanner', () => ({
  default: () => ({
    labelCam: { open: false }, labelScanning: false, labelFacing: 'environment',
    setLabelFacing: vi.fn(), labelVideoRef: { current: null }, labelCanvasRef: { current: null },
    startCamera: vi.fn(), stopCamera: vi.fn(), capturePhoto: vi.fn(),
  }),
}));
vi.mock('../components/ImageUpload', () => ({ default: () => <div /> }));
vi.mock('../components/RatingInput', () => ({ default: () => <div /> }));
vi.mock('../components/bottle/AddBottleCustomFields', async () => {
  const actual = await vi.importActual('../components/bottle/AddBottleCustomFields');
  return { buildPersonalDataPayload: actual.buildPersonalDataPayload, default: () => null };
});
vi.mock('react-i18next', () => {
  const t = (key) => key;
  const Trans = ({ i18nKey }) => <span>{i18nKey}</span>;
  return { useTranslation: () => ({ t }), Trans };
});

const { searchWines, resolveWine, identifyWineByText } = await import('../api/wines');
const AddBottle = (await import('./AddBottle')).default;
const { CURRENCIES } = await import('../config/currencies');

const jsonRes = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

beforeEach(() => {
  vi.clearAllMocks();
  searchWines.mockResolvedValue(jsonRes({ wines: [] }));
  identifyWineByText.mockResolvedValue(jsonRes({
    identified: { name: 'Soave Classico', producer: 'Pieropan', country: 'Italy', region: 'Veneto', type: 'white', grapes: ['Garganega'], confidence: 0.8 },
    match: null, candidates: [], reason: null,
  }));
  resolveWine.mockResolvedValue(jsonRes({ wine: null, created: false, noMatch: true }));
  apiFetchMock.mockImplementation(async (url) => {
    if (url.startsWith('/api/racks?cellar=')) return jsonRes({ racks: [] });
    return jsonRes({ bottle: { _id: 'b1', wineDefinition: { _id: 'w-new' }, vintage: '2024' }, priceWarnings: [] }, true, 201);
  });
});

async function reachForm() {
  render(<AddBottle />);
  fireEvent.click(screen.getByText('addBottle.searchManuallyInstead'));
  fireEvent.change(screen.getByPlaceholderText('addBottle.searchPlaceholder'), { target: { value: 'soave classico pieropan' } });
  await act(async () => { fireEvent.click(screen.getByText('addBottle.searchBtn')); });
  await act(async () => { fireEvent.click(screen.getByText('addBottle.cantFindAiTitle')); });
  await act(async () => { fireEvent.click(screen.getByText('addBottle.aiAddAndUse')); });
  await waitFor(() => expect(screen.getByText('addBottle.addBottleBtn')).toBeInTheDocument());
  // Two bottles open the details panel, where price and currency live.
  fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '2' } });
  return waitFor(() => {
    const select = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.textContent === 'GBP'));
    expect(select).toBeTruthy();
    return select;
  });
}

const postedCurrencies = () => apiFetchMock.mock.calls
  .filter(([url, opts]) => url === '/api/bottles' && opts?.method === 'POST')
  .map(([, opts]) => JSON.parse(opts.body).currency);

describe('AddBottle — currency picker', () => {
  test('every option carries its code as value, and the picker is not translated', async () => {
    const select = await reachForm();
    expect(select.getAttribute('translate')).toBe('no');
    expect([...select.options].map((o) => o.getAttribute('value'))).toEqual(CURRENCIES);
  });

  test('an option whose label a translator rewrote still posts its code', async () => {
    const select = await reachForm();
    const eur = [...select.options].find((o) => o.textContent === 'EUR');
    eur.textContent = 'EURO'; // what Chrome's Italian translation did to the label
    eur.selected = true;
    fireEvent.change(select);
    fireEvent.change(screen.getByPlaceholderText('addBottle.vintagePlaceholder'), { target: { value: '2024' } });
    await act(async () => { fireEvent.click(screen.getByText('addBottle.addBottleBtn')); });
    await waitFor(() => expect(postedCurrencies().length).toBeGreaterThan(0));
    expect(new Set(postedCurrencies())).toEqual(new Set(['EUR']));
  });
});
