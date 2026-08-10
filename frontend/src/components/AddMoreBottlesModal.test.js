import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../api/bottles', () => ({
  createBottle: vi.fn(),
}));

// `t` must keep a stable identity across renders, as react-i18next's real one
// does (see WineLowConfidenceModal.test.js). Three-arg aware: the component
// uses both t(key, defaultValue) and t(key, vars) — vars, wherever they sit,
// are appended so plural/interpolation calls stay observable.
vi.mock('react-i18next', () => {
  const t = (key, a, b) => {
    const vars = b && typeof b === 'object' ? b : (a && typeof a === 'object' ? a : undefined);
    return vars ? `${key}:${JSON.stringify(vars)}` : key;
  };
  return { useTranslation: () => ({ t }) };
});

// Hoisted so the AuthContext mock factory may reference it safely.
const { apiFetch } = vi.hoisted(() => ({ apiFetch: () => {} }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ apiFetch }),
}));

const { createBottle } = await import('../api/bottles');
const AddMoreBottlesModal = (await import('./AddMoreBottlesModal')).default;

// A populated bottle as GET /api/bottles/:id returns it — including fields
// that must NOT be copied (rating, drinkFrom/To), so the exact-payload
// assertions below prove they stay behind.
const BOTTLE = {
  _id: 'b1',
  cellar: 'c1',
  wineDefinition: { _id: 'w1', name: 'Barolo Monfortino' },
  vintage: '2016',
  bottleSize: '750ml',
  price: 120,
  currency: 'EUR',
  purchaseDate: '2026-05-01T00:00:00.000Z',
  purchaseLocation: 'Systembolaget',
  purchaseUrl: 'https://example.com/monfortino',
  notes: 'Case of six from the release',
  occasion: 'Anniversary case',
  rating: 5,
  ratingScale: '5',
  drinkFrom: 2030,
  drinkTo: 2045,
};

const COPIED_PAYLOAD = {
  cellar: 'c1',
  wineDefinition: 'w1',
  vintage: '2016',
  bottleSize: '750ml',
  price: 120,
  currency: 'EUR',
  purchaseDate: '2026-05-01T00:00:00.000Z',
  purchaseLocation: 'Systembolaget',
  purchaseUrl: 'https://example.com/monfortino',
  notes: 'Case of six from the release',
  occasion: 'Anniversary case',
};

const ok = () => ({ ok: true, json: async () => ({ bottle: { _id: 'new' } }) });
const fail = (error) => ({ ok: false, json: async () => ({ error }) });

const countInput = () => screen.getByLabelText('bottleDetail.addMore.countLabel');
const submitBtn = (n) => screen.getByText(`bottleDetail.addMore.submit:{"count":${n}}`);

const renderModal = (props = {}) =>
  render(
    <AddMoreBottlesModal bottle={BOTTLE} onClose={() => {}} onAdded={() => {}} {...props} />
  );

beforeEach(() => {
  vi.clearAllMocks();
});

test('renders the count input (default 1), a ticked copy checkbox and the unplaced note', () => {
  renderModal();
  expect(countInput()).toHaveValue(1);
  expect(screen.getByRole('checkbox')).toBeChecked();
  expect(screen.getByText('bottleDetail.addMore.unplacedNote')).toBeInTheDocument();
  expect(screen.getByText('Barolo Monfortino · 2016')).toBeInTheDocument();
});

test('the count input clamps to 1–24', () => {
  renderModal();
  fireEvent.change(countInput(), { target: { value: '99' } });
  expect(countInput()).toHaveValue(24);
  fireEvent.change(countInput(), { target: { value: '0' } });
  expect(countInput()).toHaveValue(1);
  fireEvent.change(countInput(), { target: { value: '' } });
  expect(countInput()).toHaveValue(1);
});

test('submit fires one create per bottle with the copied payload and reports the count', async () => {
  createBottle.mockResolvedValue(ok());
  const onAdded = vi.fn();
  renderModal({ onAdded });

  fireEvent.change(countInput(), { target: { value: '3' } });
  fireEvent.click(submitBtn(3));

  await waitFor(() => expect(onAdded).toHaveBeenCalledWith(3));
  expect(createBottle).toHaveBeenCalledTimes(3);
  // Exact match — proves rating / drink window / dateAdded never travel.
  expect(createBottle).toHaveBeenLastCalledWith(apiFetch, COPIED_PAYLOAD);
});

test('unticking "copy details" sends only wine, cellar, vintage, size and currency', async () => {
  createBottle.mockResolvedValue(ok());
  const onAdded = vi.fn();
  renderModal({ onAdded });

  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(submitBtn(1));

  await waitFor(() => expect(onAdded).toHaveBeenCalledWith(1));
  // Currency still travels — a blank copy must not fall back to the backend's
  // USD default for a non-USD user.
  expect(createBottle).toHaveBeenCalledWith(apiFetch, {
    cellar: 'c1',
    wineDefinition: 'w1',
    vintage: '2016',
    bottleSize: '750ml',
    currency: 'EUR',
  });
});

test('a mid-batch failure reports created/total, locks the batch shape, and a retry adds only the remainder', async () => {
  createBottle
    .mockResolvedValueOnce(ok())
    .mockResolvedValueOnce(ok())
    .mockResolvedValueOnce(fail('boom'));
  const onAdded = vi.fn();
  renderModal({ onAdded });

  fireEvent.change(countInput(), { target: { value: '4' } });
  fireEvent.click(submitBtn(4));

  // AddBottle's partial-failure message, with the created/total/remaining split.
  expect(
    await screen.findByText('addBottle.partialAdded:{"msg":"boom","count":2,"total":4,"remaining":2}')
  ).toBeInTheDocument();
  expect(onAdded).not.toHaveBeenCalled();
  expect(createBottle).toHaveBeenCalledTimes(3);
  // Batch parameters freeze once part of the batch exists — a retry must
  // finish the SAME batch, not a differently-shaped one.
  expect(countInput()).toBeDisabled();
  expect(screen.getByRole('checkbox')).toBeDisabled();

  createBottle.mockResolvedValue(ok());
  fireEvent.click(submitBtn(4));

  await waitFor(() => expect(onAdded).toHaveBeenCalledWith(4));
  // 3 calls before + only the 2 missing bottles on retry, never 4 again.
  expect(createBottle).toHaveBeenCalledTimes(5);
});

test('everything is disabled and the modal cannot be closed while the batch runs', async () => {
  let release;
  createBottle.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
  const onAdded = vi.fn();
  const onClose = vi.fn();
  const { container } = renderModal({ onAdded, onClose });

  fireEvent.click(submitBtn(1));

  expect(screen.getByText('common.saving')).toBeDisabled();
  expect(screen.getByText('common.cancel')).toBeDisabled();
  expect(countInput()).toBeDisabled();
  expect(screen.getByRole('checkbox')).toBeDisabled();
  // Overlay click and Escape route through the same guarded close.
  fireEvent.click(container.querySelector('.modal-overlay'));
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).not.toHaveBeenCalled();

  release(ok());
  await waitFor(() => expect(onAdded).toHaveBeenCalledWith(1));
});
