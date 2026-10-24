/**
 * AddBottle — the demo's AI refusal reads in the member's language.
 *
 * In the demo the identify call answers 403 with code `demo_ai_disabled` and a
 * fixed English server string. The page recognises the code and shows its own
 * translated sign-up line (as AddToWishlist does); any other refusal still
 * shows the server's message.
 */

import { render, screen, fireEvent, act } from '@testing-library/react';

vi.mock('../api/wines', () => ({
  searchWines: vi.fn(),
  resolveWine: vi.fn(),
  identifyWineByText: vi.fn(),
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ apiFetch: vi.fn(), user: { preferences: { currency: 'USD' } } }),
}));
vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: 'cellar1' }),
  useNavigate: () => vi.fn(),
  Link: ({ children }) => <a href="/">{children}</a>,
}));
// The camera hook owns getUserMedia; keep it inert.
vi.mock('../hooks/useLabelScanner', () => ({
  default: () => ({
    labelCam: { open: false }, labelScanning: false, labelFacing: 'environment',
    setLabelFacing: vi.fn(), labelVideoRef: { current: null }, labelCanvasRef: { current: null },
    startCamera: vi.fn(), stopCamera: vi.fn(), capturePhoto: vi.fn(),
  }),
}));
vi.mock('../components/ImageUpload', () => ({ default: () => <div /> }));
vi.mock('../components/RatingInput', () => ({ default: () => <div /> }));

// Key-only so assertions target keys, never copy.
vi.mock('react-i18next', () => {
  const t = (key) => key;
  const Trans = ({ i18nKey }) => <span>{i18nKey}</span>;
  return { useTranslation: () => ({ t }), Trans };
});

const { searchWines, identifyWineByText } = await import('../api/wines');
const AddBottle = (await import('./AddBottle')).default;

const jsonRes = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

const DEMO_SERVER_TEXT = 'AI features are not available in the demo. Create a free account to use them.';

async function searchThenAskAi() {
  render(<AddBottle />);
  fireEvent.click(screen.getByText('addBottle.searchManuallyInstead'));
  fireEvent.change(screen.getByPlaceholderText('addBottle.searchPlaceholder'), { target: { value: 'vacheron les romains' } });
  await act(async () => { fireEvent.click(screen.getByText('addBottle.searchBtn')); });
  await act(async () => { fireEvent.click(screen.getByText('addBottle.cantFindAiTitle')); });
}

beforeEach(() => {
  vi.clearAllMocks();
  searchWines.mockResolvedValue(jsonRes({ wines: [] }));
});

test('the demo refusal shows the translated sign-up line, not the server string', async () => {
  identifyWineByText.mockResolvedValue(jsonRes({ error: DEMO_SERVER_TEXT, code: 'demo_ai_disabled' }, false, 403));

  await searchThenAskAi();

  expect(screen.getByText('addBottle.demoAiBlocked')).toBeInTheDocument();
  expect(screen.queryByText(DEMO_SERVER_TEXT)).not.toBeInTheDocument();
});

test('any other refusal still shows the server message', async () => {
  identifyWineByText.mockResolvedValue(jsonRes({ error: 'Daily AI budget reached.', code: 'ai_budget_exhausted' }, false, 429));

  await searchThenAskAi();

  expect(screen.getByText('Daily AI budget reached.')).toBeInTheDocument();
  expect(screen.queryByText('addBottle.demoAiBlocked')).not.toBeInTheDocument();
});
