import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// "Add barcode" for a bottle already in the cellar (the bottle page's ⋮):
// until now only Add Bottle could read a barcode. A code the camera reads is
// saved at once; a typed one is checked first (the same rules the server
// applies); a bottle that has one can lose it; and a camera that cannot open
// still leaves typing.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, a, b) => (typeof a === 'string' ? a : key) + (b ? `:${JSON.stringify(b)}` : (a && typeof a === 'object' ? `:${JSON.stringify(a)}` : '')) }),
}));
let api;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch: api }) }));
// The reader itself (BarcodeDetector / ZXing) has its own tests; here the
// hook hands over a code when the test says so.
let detect = null;
let watchActive = false;
vi.mock('../hooks/useBarcodeWatch', () => ({
  default: (_ref, { active, onDetect }) => { watchActive = active; detect = onDetect; },
}));

const { default: BarcodeScanModal } = await import('./BarcodeScanModal');

const stream = { getTracks: () => [{ stop: vi.fn() }] };
const ok = (bottle) => ({ ok: true, json: async () => ({ bottle }) });
const sentBody = () => JSON.parse(api.mock.calls[0][1].body);

beforeEach(() => {
  detect = null;
  watchActive = false;
  api = vi.fn(async (_url, opts) => ok({ _id: 'b1', barcode: JSON.parse(opts.body).barcode || null }));
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: vi.fn(async () => stream) }, configurable: true,
  });
});

test('a code the camera reads is saved to the bottle at once', async () => {
  const onSaved = vi.fn();
  render(<BarcodeScanModal bottle={{ _id: 'b1' }} onClose={vi.fn()} onSaved={onSaved} />);
  expect(screen.getByText('Add barcode')).toBeInTheDocument();
  await waitFor(() => expect(watchActive).toBe(true));
  await act(async () => { await detect('7310070000002'); });
  expect(api).toHaveBeenCalledWith('/api/bottles/b1', expect.objectContaining({ method: 'PUT' }));
  expect(sentBody()).toEqual({ barcode: '7310070000002' });
  expect(onSaved).toHaveBeenCalledWith('7310070000002', { done: 1, total: 1 });
});

test('typed numbers are checked before anything is sent; a UPC-A is saved in its EAN-13 form', async () => {
  const onSaved = vi.fn();
  render(<BarcodeScanModal bottle={{ _id: 'b1' }} onClose={vi.fn()} onSaved={onSaved} />);
  const input = screen.getByLabelText('Or type the numbers under the stripes');
  fireEvent.change(input, { target: { value: '7310070000001' } }); // wrong check digit
  fireEvent.click(screen.getByText('Save'));
  expect(await screen.findByRole('alert')).toHaveTextContent('That is not a valid barcode');
  expect(api).not.toHaveBeenCalled();

  fireEvent.change(input, { target: { value: '0 12345 67890 5' } });
  fireEvent.click(screen.getByText('Save'));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith('0012345678905', { done: 1, total: 1 }));
  expect(sentBody()).toEqual({ barcode: '0012345678905' });
});

test('the server\'s refusal is shown and nothing is reported saved', async () => {
  api = vi.fn(async () => ({ ok: false, json: async () => ({ error: 'Demo accounts cannot add barcodes' }) }));
  const onSaved = vi.fn();
  render(<BarcodeScanModal bottle={{ _id: 'b1' }} onClose={vi.fn()} onSaved={onSaved} />);
  await waitFor(() => expect(watchActive).toBe(true));
  await act(async () => { await detect('7310070000002'); });
  expect(await screen.findByRole('alert')).toHaveTextContent('Demo accounts cannot add barcodes');
  expect(onSaved).not.toHaveBeenCalled();
});

test('a bottle with a barcode shows it, says "Change", and can lose it', async () => {
  const onSaved = vi.fn();
  render(<BarcodeScanModal bottle={{ _id: 'b1', barcode: '7310070000002' }} onClose={vi.fn()} onSaved={onSaved} />);
  expect(screen.getByText('Change barcode')).toBeInTheDocument();
  expect(screen.getByText(/Saved now: \{\{code\}\}:\{"code":"7310070000002"\}/)).toBeInTheDocument();
  fireEvent.click(screen.getByText('Remove barcode'));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(null, { done: 1, total: 1 }));
  expect(sentBody()).toEqual({ barcode: '' });
});

test('a camera that cannot open says why, and typing still works', async () => {
  navigator.mediaDevices.getUserMedia = vi.fn(async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); });
  render(<BarcodeScanModal bottle={{ _id: 'b1' }} onClose={vi.fn()} onSaved={vi.fn()} />);
  expect(await screen.findByText('camera.accessDenied')).toBeInTheDocument();
  expect(watchActive).toBe(false);
  expect(screen.getByLabelText('Or type the numbers under the stripes')).toBeEnabled();
});

test('on the vintage page the code goes on every bottle of the vintage in one bulk request', async () => {
  api = vi.fn(async () => ({ ok: true, json: async () => ({ done: 3, doneIds: ['b1', 'b2', 'b3'], skipped: [] }) }));
  const onSaved = vi.fn();
  render(<BarcodeScanModal bottles={[{ _id: 'b1' }, { _id: 'b2' }, { _id: 'b3' }]} onClose={vi.fn()} onSaved={onSaved} />);
  expect(screen.getByText(/barcodeScan.allBottles/)).toBeInTheDocument();
  await waitFor(() => expect(watchActive).toBe(true));
  await act(async () => { await detect('7310070000002'); });
  expect(api).toHaveBeenCalledWith('/api/bottles/bulk', expect.objectContaining({ method: 'POST' }));
  expect(sentBody()).toEqual({ action: 'update', bottleIds: ['b1', 'b2', 'b3'], fields: { barcode: '7310070000002' } });
  expect(onSaved).toHaveBeenCalledWith('7310070000002', { done: 3, total: 3 });
});

test('some bottles not changed: the window closes and says how many were; none changed is an error', async () => {
  // The bulk request answers 200 with the bottles it could not change as
  // "skipped" — that must not read as "saved on all of them".
  api = vi.fn(async () => ({ ok: true, json: async () => ({ done: 2, doneIds: ['b1', 'b2'], skipped: [{ id: 'b3', reason: 'error' }] }) }));
  const onSaved = vi.fn();
  const { unmount } = render(<BarcodeScanModal bottles={[{ _id: 'b1' }, { _id: 'b2' }, { _id: 'b3' }]} onClose={vi.fn()} onSaved={onSaved} />);
  await waitFor(() => expect(watchActive).toBe(true));
  await act(async () => { await detect('7310070000002'); });
  expect(onSaved).toHaveBeenCalledWith('7310070000002', { done: 2, total: 3 });
  unmount();

  api = vi.fn(async () => ({ ok: true, json: async () => ({ done: 0, doneIds: [], skipped: [{ id: 'b1', reason: 'error' }, { id: 'b2', reason: 'error' }] }) }));
  const onSaved2 = vi.fn();
  render(<BarcodeScanModal bottles={[{ _id: 'b1' }, { _id: 'b2' }]} onClose={vi.fn()} onSaved={onSaved2} />);
  await waitFor(() => expect(watchActive).toBe(true));
  await act(async () => { await detect('7310070000002'); });
  expect(onSaved2).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('Could not save the barcode');
});

test('bottles of the vintage it leaves alone are named, so "all" never overstates it', () => {
  render(<BarcodeScanModal bottles={[{ _id: 'b1' }, { _id: 'b2' }]} otherCount={1} onClose={vi.fn()} onSaved={vi.fn()} />);
  expect(screen.getByText(/barcodeScan.someBottles/)).toHaveTextContent('barcodeScan.othersKeep:{"count":1}');
  expect(screen.queryByText(/barcodeScan.allBottles/)).toBeNull();
});

test('bottles with one code between them show it and offer "Change"; bottles whose codes differ start from nothing', () => {
  // A bottle without a code does not count against the shared one: saving
  // goes to all of them, so it gets the same.
  const { unmount } = render(<BarcodeScanModal bottles={[{ _id: 'b1', barcode: '7310070000002' }, { _id: 'b2' }]} onClose={vi.fn()} onSaved={vi.fn()} />);
  expect(screen.getByText('Change barcode')).toBeInTheDocument();
  unmount();
  render(<BarcodeScanModal bottles={[{ _id: 'b1', barcode: '7310070000002' }, { _id: 'b2', barcode: '0012345678905' }]} onClose={vi.fn()} onSaved={vi.fn()} />);
  expect(screen.getByText('Add barcode')).toBeInTheDocument();
  expect(screen.queryByText('Remove barcode')).toBeNull();
});
