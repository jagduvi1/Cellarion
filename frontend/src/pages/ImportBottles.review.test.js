/**
 * The import page's review state: what a step change resets and what the
 * saved draft keeps.
 *
 * WHY THIS TEST EXISTS:
 * - "Back to upload" must forget a partial validation run along with its
 *   results, or the next Match resumes past batches that are no longer in the
 *   review and they never reach the import.
 * - A year typed into a vintage-missing row must reach the saved draft like
 *   any other review edit.
 * - "Import more" must not carry the last import's comment and occasion onto
 *   the next file's bottles.
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

const { scanReceipt, validateImport, confirmImport } = await import('../api/bottles');
const { createImportSession, updateImportSession } = await import('../api/importSessions');
const ImportBottles = (await import('./ImportBottles')).default;

const jsonRes = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

// A receipt scan is the quickest way to get rows onto the upload step.
const receiptOf = (items) => ({
  receipt: { documentType: 'receipt', store: 'Wine shop', purchaseDate: '2026-10-03', currency: 'SEK' },
  items,
  skipped: [],
  warnings: [],
});

const chooseReceipt = (container) => {
  const input = container.querySelector('#receipt-file-input');
  fireEvent.change(input, { target: { files: [new File(['x'], 'receipt.jpg', { type: 'image/jpeg' })] } });
};

// The server's answer for one batch: every row an exact match (so it is
// preselected and importable), or every row unmatched.
const validated = (items, status = 'exact') => jsonRes({
  results: items.map((item, index) => ({
    index,
    status,
    item,
    matches: status === 'exact'
      ? [{ wineId: 'w1', name: item.wineName, producer: item.producer || '', country: '', region: '', type: 'red', score: 1 }]
      : [],
  })),
  summary: { total: items.length, exact: status === 'exact' ? items.length : 0, noMatch: status === 'no_match' ? items.length : 0 },
});

beforeEach(() => {
  vi.clearAllMocks();
  validateImport.mockReset();
  globalThis.fetch = vi.fn(() => Promise.resolve({ ok: false, json: async () => ({}) }));
});

it('Back to upload forgets a partial validation, so the next Match starts again from the first row', async () => {
  // 30 bottles = two validate batches (25 + 5); the second one fails.
  scanReceipt.mockResolvedValue(jsonRes(receiptOf([
    { wineName: 'Chablis', producer: 'William Fèvre', vintage: '2022', quantity: 30, price: 189, currency: 'SEK' },
  ])));
  validateImport
    .mockImplementationOnce((_af, { items }) => Promise.resolve(validated(items)))
    .mockResolvedValueOnce(jsonRes({ error: 'validate failed' }, false, 400));

  const { container } = render(<ImportBottles />);
  chooseReceipt(container);
  fireEvent.click(await screen.findByText('importBottles.validate.matchButton:30'));

  // Batch 1 is kept and a resume is offered next to the way back to review.
  const returnToReview = await screen.findByText('importBottles.upload.returnToReview');
  expect(screen.getByText('importBottles.validate.resumeMatchButton')).toBeTruthy();
  fireEvent.click(returnToReview);
  fireEvent.click(await screen.findByText('importBottles.review.backToUpload'));

  // The results are gone, so the upload step offers a full Match, not a resume.
  await screen.findByText('importBottles.validate.matchButton:30');
  expect(screen.queryByText('importBottles.validate.resumeMatchButton')).toBeNull();
  expect(screen.queryByText('importBottles.upload.returnToReview')).toBeNull();

  validateImport.mockImplementation((_af, { items }) => Promise.resolve(validated(items)));
  fireEvent.click(screen.getByText('importBottles.validate.matchButton:30'));

  // Every bottle reaches the review again, starting from the first batch.
  await screen.findByText('importBottles.review.importButton:30');
  expect(validateImport).toHaveBeenCalledTimes(4);
  expect(validateImport.mock.calls[2][1].items).toHaveLength(25);
  expect(validateImport.mock.calls[3][1].items).toHaveLength(5);
});

it('a year typed into a vintage-missing row is saved to the draft', async () => {
  scanReceipt.mockResolvedValue(jsonRes(receiptOf([
    { wineName: 'Barolo', producer: 'Giacomo Conterno', quantity: 1 },
  ])));
  validateImport.mockImplementation((_af, { items }) => Promise.resolve(validated(items, 'no_match')));
  createImportSession.mockResolvedValue(jsonRes({ sessionId: 's1' }));
  updateImportSession.mockResolvedValue(jsonRes({}));

  const { container } = render(<ImportBottles />);
  chooseReceipt(container);
  fireEvent.click(await screen.findByText('importBottles.validate.matchButton:1'));

  // The review is saved once on arrival, before anything is typed.
  await waitFor(() => expect(screen.getByText('importBottles.review.saved')).toBeTruthy(), { timeout: 4000 });
  expect(createImportSession.mock.calls[0][1].results[0].item.vintage).toBe('NV');
  expect(updateImportSession).not.toHaveBeenCalled();

  fireEvent.change(screen.getByLabelText('importBottles.preview.vintageInputAria'), { target: { value: '2019' } });

  await waitFor(() => expect(updateImportSession).toHaveBeenCalled(), { timeout: 4000 });
  const [, sessionId, payload] = updateImportSession.mock.calls.at(-1);
  expect(sessionId).toBe('s1');
  expect(payload.results[0].item.vintage).toBe('2019');
}, 15000);

it('Import more starts the next file with an empty comment and occasion', async () => {
  scanReceipt.mockResolvedValue(jsonRes(receiptOf([
    { wineName: 'Chablis', producer: 'William Fèvre', vintage: '2022', quantity: 1 },
  ])));
  validateImport.mockImplementation((_af, { items }) => Promise.resolve(validated(items)));
  confirmImport.mockResolvedValue(jsonRes({ created: 1, total: 1, skipped: [], errors: [] }));

  const { container } = render(<ImportBottles />);
  chooseReceipt(container);
  fireEvent.change(await screen.findByPlaceholderText('importBottles.wholeImport.commentPlaceholder'), { target: { value: 'Birthday case' } });
  fireEvent.change(screen.getByPlaceholderText('importBottles.wholeImport.occasionPlaceholder'), { target: { value: 'Birthday' } });
  fireEvent.click(screen.getByText('importBottles.validate.matchButton:1'));
  fireEvent.click(await screen.findByText('importBottles.review.importButton:1'));

  fireEvent.click(await screen.findByText('importBottles.done.importMore'));
  expect(confirmImport.mock.calls[0][1]).toMatchObject({ importNotes: 'Birthday case', importOccasion: 'Birthday' });

  chooseReceipt(container);
  expect((await screen.findByPlaceholderText('importBottles.wholeImport.commentPlaceholder')).value).toBe('');
  expect(screen.getByPlaceholderText('importBottles.wholeImport.occasionPlaceholder').value).toBe('');
});
