import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// The review queue with per-vintage slots (2026-09-04): each suggested value
// says which slot it lands in, a vintage row shows what the wine says
// wine-wide today (or that it says nothing yet), and the reviewer can widen a
// vintage suggestion into the wine-wide default in one click.

vi.mock('react-router-dom', () => ({
  Link: ({ children, to }) => <a href={to}>{children}</a>,
}));

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch }) }));

vi.mock('../api/registryData', () => ({
  getRegistryDataQueues: vi.fn(),
  decideRegistryKey: vi.fn(),
  decideRegistryValue: vi.fn(),
  getRegistryKeys: vi.fn(),
  setRegistryKeyTranslations: vi.fn(),
  updateRegistryKey: vi.fn(),
  removeRegistryKey: vi.fn(),
}));

const {
  getRegistryDataQueues, decideRegistryValue, getRegistryKeys, setRegistryKeyTranslations,
  updateRegistryKey, removeRegistryKey,
} = await import('../api/registryData');
const AdminRegistryData = (await import('./AdminRegistryData')).default;

const ok = (body) => ({ ok: true, json: async () => body });
const ABV = { _id: 'k1', name: 'ABV', unit: '%' };
const WINE = { _id: 'w1', name: 'Bannockburn Pinot Noir', producer: 'Valli', slug: 'valli-bannockburn' };

beforeEach(() => {
  vi.clearAllMocks();
  decideRegistryValue.mockResolvedValue(ok({ value: { _id: 'v1', status: 'published' } }));
  getRegistryKeys.mockResolvedValue(ok({ keys: [] }));
});

// Discussion #1778: a self-hoster made ABV a text field and had no way to
// change it or take it away. The vocabulary (and a proposal, before it is
// accepted) can now be redefined, and an accepted field removed — the server
// says when values stand in the way, and removing them takes a second yes.
describe('changing and removing a field', () => {
  const TEXT_ABV = { _id: 'k1', name: 'ABV', type: 'text', unit: null, enumOptions: null, translations: null };
  const fail = (status, error) => ({ ok: false, status, json: async () => ({ error }) });
  afterEach(() => vi.restoreAllMocks());

  test('ABV made as text becomes decimal %: the definition is sent and the card says what changed', async () => {
    getRegistryDataQueues.mockResolvedValue(ok({ keys: [], values: [] }));
    getRegistryKeys.mockResolvedValue(ok({ keys: [TEXT_ABV] }));
    updateRegistryKey.mockResolvedValue(ok({ key: { ...TEXT_ABV, type: 'decimal', unit: '%' }, converted: 2 }));
    render(<AdminRegistryData />);
    await screen.findByText('Vocabulary (1)');
    fireEvent.click(screen.getByText('Change type'));
    fireEvent.change(screen.getByLabelText('Type of ABV'), { target: { value: 'decimal' } });
    fireEvent.change(screen.getByLabelText('Unit of ABV'), { target: { value: ' % ' } });
    fireEvent.click(screen.getByText('Save field'));

    await waitFor(() => expect(updateRegistryKey).toHaveBeenCalledWith(apiFetch, 'k1', { type: 'decimal', unit: '%' }));
    expect(await screen.findByText('Field saved — 2 values converted')).toBeInTheDocument();
    expect(screen.getByText('decimal (%)')).toBeInTheDocument();
    expect(screen.queryByLabelText('Type of ABV')).not.toBeInTheDocument();
  });

  test('a value that does not fit: the server says which, and the editor stays open', async () => {
    getRegistryDataQueues.mockResolvedValue(ok({ keys: [], values: [] }));
    getRegistryKeys.mockResolvedValue(ok({ keys: [TEXT_ABV] }));
    updateRegistryKey.mockResolvedValue(fail(409, '1 value of "ABV" does not fit a decimal field: "about 13" on Valli — Bannockburn.'));
    render(<AdminRegistryData />);
    await screen.findByText('Vocabulary (1)');
    fireEvent.click(screen.getByText('Change type'));
    fireEvent.change(screen.getByLabelText('Type of ABV'), { target: { value: 'decimal' } });
    fireEvent.click(screen.getByText('Save field'));
    expect(await screen.findByRole('alert')).toHaveTextContent('"about 13" on Valli — Bannockburn');
    expect(screen.getByLabelText('Type of ABV')).toBeInTheDocument();
  });

  test('a list field sends its allowed values, one per line', async () => {
    getRegistryDataQueues.mockResolvedValue(ok({ keys: [], values: [] }));
    getRegistryKeys.mockResolvedValue(ok({ keys: [{ ...TEXT_ABV, _id: 'k2', name: 'Closure' }] }));
    updateRegistryKey.mockResolvedValue(ok({ key: { _id: 'k2', name: 'Closure', type: 'enum', enumOptions: ['Cork', 'Screw cap'] }, converted: 0 }));
    render(<AdminRegistryData />);
    await screen.findByText('Vocabulary (1)');
    fireEvent.click(screen.getByText('Change type'));
    fireEvent.change(screen.getByLabelText('Type of Closure'), { target: { value: 'enum' } });
    fireEvent.change(screen.getByLabelText('Allowed values of Closure'), { target: { value: 'Cork\n\n Screw cap \n' } });
    fireEvent.click(screen.getByText('Save field'));
    await waitFor(() => expect(updateRegistryKey).toHaveBeenCalledWith(apiFetch, 'k2', { type: 'enum', enumOptions: ['Cork', 'Screw cap'] }));
    expect(await screen.findByText('Field saved')).toBeInTheDocument();
  });

  test('a proposed field can be put right before it is accepted', async () => {
    getRegistryDataQueues.mockResolvedValue(ok({ keys: [
      { ...TEXT_ABV, status: 'proposed', rationale: 'Alcohol strength matters.', proposedBy: { username: 'sebastian' } },
    ], values: [] }));
    render(<AdminRegistryData />);
    await screen.findByText('Proposed keys (1)');
    expect(screen.getByText('Change type')).toBeInTheDocument();
    // Removing is for the vocabulary; a proposal is rejected.
    expect(screen.queryByText('Remove field')).not.toBeInTheDocument();
  });

  test('removing an empty field asks once and takes the card away', async () => {
    getRegistryDataQueues.mockResolvedValue(ok({ keys: [], values: [] }));
    getRegistryKeys.mockResolvedValue(ok({ keys: [TEXT_ABV] }));
    removeRegistryKey.mockResolvedValue(ok({ key: { ...TEXT_ABV, status: 'rejected' }, removed: { published: 0, suggested: 0 } }));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<AdminRegistryData />);
    await screen.findByText('Vocabulary (1)');
    fireEvent.click(screen.getByText('Remove field'));
    expect(await screen.findByText('Vocabulary (0)')).toBeInTheDocument();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(removeRegistryKey).toHaveBeenCalledWith(apiFetch, 'k1');
  });

  test('a field holding values: the server says how many, and only a second yes removes them with it', async () => {
    getRegistryDataQueues.mockResolvedValue(ok({ keys: [], values: [] }));
    getRegistryKeys.mockResolvedValue(ok({ keys: [TEXT_ABV] }));
    const HELD = '"ABV" holds 3 published values. Removing the field takes them off the wine records too.';
    removeRegistryKey
      .mockResolvedValueOnce(fail(409, HELD))
      .mockResolvedValueOnce(fail(409, HELD))
      .mockResolvedValueOnce(ok({ key: { ...TEXT_ABV, status: 'rejected' }, removed: { published: 3, suggested: 0 } }));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(true).mockReturnValueOnce(false);
    render(<AdminRegistryData />);
    await screen.findByText('Vocabulary (1)');

    // Second question declined: nothing removed.
    fireEvent.click(screen.getByText('Remove field'));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
    expect(confirm.mock.calls[1][0]).toContain(HELD);
    expect(removeRegistryKey).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Vocabulary (1)')).toBeInTheDocument();

    // Both answered yes: removed with its values.
    confirm.mockReturnValue(true);
    await waitFor(() => expect(screen.getByText('Remove field')).not.toBeDisabled());
    fireEvent.click(screen.getByText('Remove field'));
    expect(await screen.findByText('Vocabulary (0)')).toBeInTheDocument();
    expect(removeRegistryKey).toHaveBeenLastCalledWith(apiFetch, 'k1', { removeValues: true });
  });
});

// The vocabulary editor (2026-09-09): every accepted key gets a display name
// per language, and the English name is never one of the boxes — it IS the
// key. The body sent is the WHOLE map, so an emptied box is a removal.
describe('display-name translations', () => {
  test('an accepted key shows one box per non-English language, prefilled from the server', async () => {
    getRegistryDataQueues.mockResolvedValue(ok({ keys: [], values: [] }));
    getRegistryKeys.mockResolvedValue(ok({ keys: [
      { _id: 'k1', name: 'ABV', type: 'decimal', unit: '%', enumOptions: null, translations: { de: 'Alkoholgehalt' } },
    ] }));
    render(<AdminRegistryData />);
    expect(await screen.findByText('Vocabulary (1)')).toBeInTheDocument();
    const de = screen.getByLabelText(/ABV in .*(German|Deutsch)/);
    expect(de).toHaveValue('Alkoholgehalt');
    expect(screen.queryByLabelText(/ABV in English/)).not.toBeInTheDocument();
    // Nothing to save until something is typed.
    expect(screen.getByText('Save names')).toBeDisabled();
  });

  test('saving sends the whole map, trimmed, with emptied boxes dropped', async () => {
    getRegistryDataQueues.mockResolvedValue(ok({ keys: [], values: [] }));
    getRegistryKeys.mockResolvedValue(ok({ keys: [
      { _id: 'k1', name: 'ABV', type: 'decimal', unit: '%', enumOptions: null, translations: { de: 'Alkoholgehalt', fr: 'Alcool' } },
    ] }));
    setRegistryKeyTranslations.mockResolvedValue(ok({ key: { _id: 'k1', name: 'ABV', translations: { de: 'Alkoholgehalt', sv: 'Alkoholhalt' } } }));
    render(<AdminRegistryData />);
    await screen.findByText('Vocabulary (1)');
    fireEvent.change(screen.getByLabelText(/ABV in .*(Swedish|Svenska)/), { target: { value: '  Alkoholhalt ' } });
    fireEvent.change(screen.getByLabelText(/ABV in .*(French|Français)/), { target: { value: '' } });
    fireEvent.click(screen.getByText('Save names'));
    await waitFor(() => expect(setRegistryKeyTranslations).toHaveBeenCalledWith(
      apiFetch, 'k1', { de: 'Alkoholgehalt', sv: 'Alkoholhalt' },
    ));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  test('a failed vocabulary read leaves the review queues intact', async () => {
    getRegistryDataQueues.mockResolvedValue(ok({ keys: [], values: [
      { _id: 'v1', key: ABV, value: 13.5, vintage: null, wineDefinition: WINE, suggestedBy: { username: 'kurt' } },
    ] }));
    getRegistryKeys.mockRejectedValue(new Error('down'));
    render(<AdminRegistryData />);
    expect(await screen.findByText('Suggested values (1)')).toBeInTheDocument();
    expect(screen.getByText('Vocabulary (0)')).toBeInTheDocument();
  });
});

test('a vintage row shows its slot and the wine-wide value it diverges from', async () => {
  getRegistryDataQueues.mockResolvedValue(ok({
    keys: [],
    values: [{ _id: 'v1', key: ABV, value: 14, vintage: '2023', wineDefault: 13.5, wineDefinition: WINE, suggestedBy: { username: 'akki' } }],
  }));
  render(<AdminRegistryData />);
  expect(await screen.findByText(/for the/)).toHaveTextContent('for the 2023 vintage · wine-wide today: 13.5 %');
  expect(screen.getByText('Publish for 2023')).toBeInTheDocument();
  expect(screen.getByText('Publish as wine default')).toBeInTheDocument();
});

test('a vintage row on a wine with no default yet says so, and a wine-wide row has no widen button', async () => {
  getRegistryDataQueues.mockResolvedValue(ok({
    keys: [],
    values: [
      { _id: 'v1', key: ABV, value: 14, vintage: '2023', wineDefault: null, wineDefinition: WINE, suggestedBy: { username: 'akki' } },
      { _id: 'v2', key: ABV, value: 13, vintage: null, wineDefinition: WINE, suggestedBy: { username: 'james' } },
    ],
  }));
  render(<AdminRegistryData />);
  expect(await screen.findByText('no wine-wide value yet')).toBeInTheDocument();
  expect(screen.getByText('all vintages')).toBeInTheDocument();
  expect(screen.getAllByText('Publish as wine default')).toHaveLength(1);
  expect(screen.getByText('Publish')).toBeInTheDocument(); // the wine-wide row's plain button
});

test('"Publish as wine default" sends asWineDefault; plain publish does not', async () => {
  getRegistryDataQueues.mockResolvedValue(ok({
    keys: [],
    values: [{ _id: 'v1', key: ABV, value: 14, vintage: '2023', wineDefault: null, wineDefinition: WINE, suggestedBy: { username: 'akki' } }],
  }));
  render(<AdminRegistryData />);
  fireEvent.click(await screen.findByText('Publish as wine default'));
  await waitFor(() => expect(decideRegistryValue).toHaveBeenCalledWith(apiFetch, 'v1', 'publish', undefined, { asWineDefault: true }));
  // The decided row leaves the queue without a refetch
  await waitFor(() => expect(screen.queryByText('Publish as wine default')).not.toBeInTheDocument());

  getRegistryDataQueues.mockResolvedValue(ok({
    keys: [],
    values: [{ _id: 'v2', key: ABV, value: 14, vintage: '2023', wineDefault: null, wineDefinition: WINE, suggestedBy: { username: 'akki' } }],
  }));
  render(<AdminRegistryData />);
  fireEvent.click(await screen.findByText('Publish for 2023'));
  await waitFor(() => expect(decideRegistryValue).toHaveBeenLastCalledWith(apiFetch, 'v2', 'publish', undefined, {}));
});
