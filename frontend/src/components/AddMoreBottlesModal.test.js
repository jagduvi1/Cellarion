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
const vintageInput = () => screen.getByLabelText('bottleDetail.addMore.vintageLabel');
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
  expect(screen.getByText('Barolo Monfortino')).toBeInTheDocument();
  expect(vintageInput()).toHaveValue('2016');
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

  await waitFor(() => expect(onAdded).toHaveBeenCalledWith(3, '2016'));
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

  await waitFor(() => expect(onAdded).toHaveBeenCalledWith(1, '2016'));
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

// "Add again" of a drunk bottle (history card, its own page) is a new
// purchase: the old date, price, shop, notes and occasion stay behind unless
// the member ticks the box.
test('copyDetailsDefault={false} starts unticked and sends a blank copy; ticking it copies as usual', async () => {
  createBottle.mockResolvedValue(ok());
  const onAdded = vi.fn();
  renderModal({ onAdded, copyDetailsDefault: false });

  expect(screen.getByRole('checkbox')).not.toBeChecked();
  fireEvent.click(submitBtn(1));
  await waitFor(() => expect(onAdded).toHaveBeenCalledWith(1, '2016'));
  expect(createBottle).toHaveBeenCalledWith(apiFetch, {
    cellar: 'c1', wineDefinition: 'w1', vintage: '2016', bottleSize: '750ml', currency: 'EUR',
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
  expect(vintageInput()).toBeDisabled();

  createBottle.mockResolvedValue(ok());
  fireEvent.click(submitBtn(4));

  await waitFor(() => expect(onAdded).toHaveBeenCalledWith(4, '2016'));
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
  await waitFor(() => expect(onAdded).toHaveBeenCalledWith(1, '2016'));
});

// Another year of the same wine, without searching the wine again in Add Bottle.
test('a changed vintage adds bottles of that year, and says which year it added', async () => {
  createBottle.mockResolvedValue(ok());
  const onAdded = vi.fn();
  renderModal({ onAdded, copyDetailsDefault: false });

  fireEvent.change(vintageInput(), { target: { value: '2019' } });
  fireEvent.click(submitBtn(1));

  await waitFor(() => expect(onAdded).toHaveBeenCalledWith(1, '2019'));
  expect(createBottle).toHaveBeenCalledWith(apiFetch, {
    cellar: 'c1',
    wineDefinition: 'w1',
    vintage: '2019',
    bottleSize: '750ml',
    currency: 'EUR',
  });
});

test('non-vintage typed as a word is stored as NV', async () => {
  createBottle.mockResolvedValue(ok());
  const onAdded = vi.fn();
  renderModal({ onAdded, copyDetailsDefault: false });

  fireEvent.change(vintageInput(), { target: { value: 'nv' } });
  fireEvent.click(submitBtn(1));

  await waitFor(() => expect(onAdded).toHaveBeenCalledWith(1, 'NV'));
  expect(createBottle.mock.calls[0][1].vintage).toBe('NV');
});

// Another year is another purchase: the old price, date, shop, link, notes and
// occasion stay behind unless the member ticks the box themselves.
test('another vintage unticks "copy details"; back to the bottle\'s own vintage it is ticked again', async () => {
  createBottle.mockResolvedValue(ok());
  const onAdded = vi.fn();
  renderModal({ onAdded });

  fireEvent.change(vintageInput(), { target: { value: '2019' } });
  expect(screen.getByRole('checkbox')).not.toBeChecked();
  fireEvent.change(vintageInput(), { target: { value: '2016' } });
  expect(screen.getByRole('checkbox')).toBeChecked();

  fireEvent.change(vintageInput(), { target: { value: '2019' } });
  fireEvent.click(submitBtn(1));
  await waitFor(() => expect(onAdded).toHaveBeenCalledWith(1, '2019'));
  expect(createBottle).toHaveBeenCalledWith(apiFetch, {
    cellar: 'c1', wineDefinition: 'w1', vintage: '2019', bottleSize: '750ml', currency: 'EUR',
  });
});

test('a box the member ticked for another vintage stays ticked and copies the details', async () => {
  createBottle.mockResolvedValue(ok());
  const onAdded = vi.fn();
  renderModal({ onAdded });

  fireEvent.change(vintageInput(), { target: { value: '2019' } });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.change(vintageInput(), { target: { value: '2020' } });
  expect(screen.getByRole('checkbox')).toBeChecked();

  fireEvent.click(submitBtn(1));
  await waitFor(() => expect(onAdded).toHaveBeenCalledWith(1, '2020'));
  expect(createBottle).toHaveBeenCalledWith(apiFetch, { ...COPIED_PAYLOAD, vintage: '2020' });
});

// The server stores NV for a blank vintage; the required field must not stop
// such a bottle from adding more of itself.
test.each([[''], [null]])('a bottle stored without a vintage (%j) starts at NV and adds NV bottles', async (stored) => {
  createBottle.mockResolvedValue(ok());
  const onAdded = vi.fn();
  renderModal({ onAdded, bottle: { ...BOTTLE, vintage: stored } });

  expect(screen.getByRole('checkbox')).toBeChecked();
  fireEvent.click(submitBtn(1));

  await waitFor(() => expect(onAdded).toHaveBeenCalledWith(1, 'NV'));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(createBottle).toHaveBeenCalledWith(apiFetch, { ...COPIED_PAYLOAD, vintage: 'NV' });
});

test('a year the field cannot take creates nothing and says why', async () => {
  const onAdded = vi.fn();
  renderModal({ onAdded });

  fireEvent.change(vintageInput(), { target: { value: '19' } });
  fireEvent.click(submitBtn(1));

  expect(await screen.findByRole('alert')).toHaveTextContent('bottleDetail.vintagePattern');
  expect(createBottle).not.toHaveBeenCalled();
  expect(onAdded).not.toHaveBeenCalled();
});
