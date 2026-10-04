/**
 * The import page's receipt scan.
 *
 * WHY THIS TEST EXISTS:
 * A receipt must land in the same review as a file — one row per bottle, the
 * shop/date summary, the lines left out — and nothing may be created by the
 * scan itself. A failed scan must say why (budget, not a receipt) instead of
 * failing silently, and a prepayment receipt must warn before the same
 * bottles are imported twice.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../api/bottles', () => ({
  validateImport: vi.fn(),
  confirmImport: vi.fn(),
  scanReceipt: vi.fn(),
}));
vi.mock('../api/aiBudget', () => ({
  getAiBudgetStatus: vi.fn(() => Promise.resolve({ ok: false })),
  requestAiBudgetIncrease: vi.fn(),
}));
vi.mock('../api/wines', () => ({ searchWines: vi.fn() }));
vi.mock('../api/racks', () => ({ getRacks: vi.fn(() => Promise.resolve({ ok: true, json: async () => ({ racks: [] }) })) }));
vi.mock('../api/importSessions', () => ({
  listImportSessions: vi.fn(() => Promise.resolve({ ok: true, json: async () => ({ sessions: [] }) })),
  createImportSession: vi.fn(),
  getImportSession: vi.fn(),
  updateImportSession: vi.fn(),
  deleteImportSession: vi.fn(),
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ apiFetch: vi.fn(), user: { preferences: { currency: 'USD' } } }),
}));
vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: 'cellar1' }),
  useNavigate: () => vi.fn(),
  Link: ({ children }) => <a href="/">{children}</a>,
}));
vi.mock('react-i18next', () => {
  const t = (key, opts) => (opts && opts.count != null ? `${key}:${opts.count}` : key);
  const Trans = ({ i18nKey }) => <span>{i18nKey}</span>;
  return { useTranslation: () => ({ t }), Trans };
});

const { scanReceipt, validateImport } = await import('../api/bottles');
const ImportBottles = (await import('./ImportBottles')).default;

const jsonRes = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

const RECEIPT = {
  receipt: { documentType: 'receipt', store: 'Systembolaget Hötorget', purchaseDate: '2026-10-03', currency: 'SEK' },
  items: [
    { wineName: 'Chablis', producer: 'William Fèvre', vintage: '2022', quantity: 2, price: 189, currency: 'SEK', purchaseLocation: 'Systembolaget Hötorget', receiptLine: 'FEVRE CHABLIS 22 75CL' },
    { wineName: 'Barolo', quantity: 1, price: 399, currency: 'SEK', receiptLine: 'BAROLO 75CL' },
  ],
  skipped: [{ line: 'PANT', reason: 'deposit' }, { line: 'LAGER 33CL', reason: 'beer' }],
  warnings: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.fetch = vi.fn(() => Promise.resolve({ ok: false, json: async () => ({}) }));
});

const chooseReceipt = (container, files = [new File(['x'], 'receipt.jpg', { type: 'image/jpeg' })]) => {
  const input = container.querySelector('#receipt-file-input');
  fireEvent.change(input, { target: { files } });
};

it('reads a receipt into one row per bottle with the shop, date and skipped lines', async () => {
  scanReceipt.mockResolvedValue(jsonRes(RECEIPT));
  const { container } = render(<ImportBottles />);

  chooseReceipt(container);

  await waitFor(() => expect(screen.getByText('importBottles.receipt.summary:3')).toBeTruthy());
  expect(scanReceipt).toHaveBeenCalledTimes(1);
  expect(scanReceipt.mock.calls[0][1]).toHaveLength(1);
  expect(screen.getByText('Systembolaget Hötorget · 2026-10-03')).toBeTruthy();
  expect(screen.getByText('importBottles.upload.bottlesFound:3')).toBeTruthy();
  expect(screen.getByText('importBottles.receipt.skippedTitle:2')).toBeTruthy();
  // The Barolo line had no vintage: the usual "type the year in review" notice.
  expect(screen.getByText('importBottles.warnings.vintageMissing:1')).toBeTruthy();
  // The picker follows the receipt's currency, not the profile default.
  expect(container.querySelector('.import-currency-block select').value).toBe('SEK');
  // Reading a receipt creates nothing — matching only starts on request.
  expect(validateImport).not.toHaveBeenCalled();
});

it('warns that a prepayment receipt and the sales receipt list the same bottles', async () => {
  scanReceipt.mockResolvedValue(jsonRes({ ...RECEIPT, receipt: { ...RECEIPT.receipt, documentType: 'prepayment' } }));
  const { container } = render(<ImportBottles />);
  chooseReceipt(container);
  await waitFor(() => expect(screen.getByText('importBottles.receipt.prepaymentNote')).toBeTruthy());
});

it('explains a refused scan', async () => {
  scanReceipt.mockResolvedValue(jsonRes({ code: 'ai_budget_exhausted' }, false, 429));
  const { container } = render(<ImportBottles />);
  chooseReceipt(container);
  await waitFor(() => expect(screen.getByText('importBottles.receipt.errors.budget')).toBeTruthy());
});

it('says so when the receipt has no wine', async () => {
  scanReceipt.mockResolvedValue(jsonRes({ ...RECEIPT, items: [] }));
  const { container } = render(<ImportBottles />);
  chooseReceipt(container);
  await waitFor(() => expect(screen.getByText('importBottles.receipt.errors.noWine')).toBeTruthy());
  expect(screen.queryByText(/importBottles.upload.bottlesFound/)).toBeNull();
});
