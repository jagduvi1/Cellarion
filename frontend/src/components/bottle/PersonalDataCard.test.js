import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../api/personalData', () => ({
  getPersonalData: vi.fn(),
  addPersonalData: vi.fn(),
  updatePersonalDataEntry: vi.fn(),
  deletePersonalDataEntry: vi.fn(),
  getPersonalDataKeys: vi.fn(),
  updatePersonalDataKey: vi.fn(),
}));

vi.mock('../../api/registryData', () => ({
  getWinePublicData: vi.fn(),
  suggestWineValue: vi.fn(),
  proposeRegistryKey: vi.fn(),
}));

// The card passes English fallbacks inline — return those so assertions read
// like the real UI (the ConnectAi test convention). i18next interpolation is
// mimicked for the one {{name}} string.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, vars) => {
      const s = typeof fallback === 'string' ? fallback : key;
      return vars ? s.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k]) : s;
    },
  }),
}));

const {
  getPersonalData, addPersonalData, deletePersonalDataEntry, getPersonalDataKeys, updatePersonalDataKey,
} = await import('../../api/personalData');
const { getWinePublicData, suggestWineValue, proposeRegistryKey } = await import('../../api/registryData');
const PersonalDataCard = (await import('./PersonalDataCard')).default;

const ME = 'user-me';
const BOTTLE_ID = 'b1';

const entry = (over = {}) => ({
  _id: 'e1',
  level: 'bottle',
  key: { _id: 'k1', name: 'ABV', type: 'decimal', unit: '%', enumOptions: null },
  value: 13.5,
  author: { _id: ME, username: 'johan', displayName: 'Johan' },
  updatedAt: '2026-08-17T00:00:00.000Z',
  ...over,
});

const ok = (body) => ({ ok: true, json: async () => body });

beforeEach(() => {
  vi.clearAllMocks();
  getPersonalData.mockResolvedValue(ok({ bottleEntries: [], wineEntries: [] }));
  getPersonalDataKeys.mockResolvedValue(ok({ keys: [] }));
  getWinePublicData.mockResolvedValue(ok({ fields: [] }));
  suggestWineValue.mockResolvedValue(ok({ value: { _id: 'v1', status: 'suggested' } }));
});

const renderCard = () =>
  render(<PersonalDataCard apiFetch={vi.fn()} bottleId={BOTTLE_ID} currentUserId={ME} />);

test('renders the empty state and fetches this bottle’s data', async () => {
  renderCard();
  expect(await screen.findByText('Nothing recorded yet.')).toBeInTheDocument();
  expect(getPersonalData).toHaveBeenCalledWith(expect.any(Function), BOTTLE_ID);
});

test('shows entries with unit, and attribution ONLY for other people’s entries', async () => {
  getPersonalData.mockResolvedValue(ok({
    bottleEntries: [entry()],
    wineEntries: [entry({
      _id: 'e2',
      level: 'wine',
      key: { _id: 'k2', name: 'Serve at', type: 'integer', unit: '°C', enumOptions: null },
      value: 16,
      author: { _id: 'user-other', username: 'kurt', displayName: 'Kurt' },
    })],
  }));
  renderCard();

  expect(await screen.findByText('13.5 %')).toBeInTheDocument();
  expect(screen.getByText('This bottle')).toBeInTheDocument();
  expect(screen.getByText('This wine (all bottles of it)')).toBeInTheDocument();
  // The co-member's entry is attributed; my own is not.
  expect(screen.getByText('by Kurt')).toBeInTheDocument();
  expect(screen.queryByText('by Johan')).not.toBeInTheDocument();
  // Edit/Delete only on my own entry.
  expect(screen.getAllByText('Edit')).toHaveLength(1);
});

test('boolean values render as Yes/No, not raw true/false', async () => {
  getPersonalData.mockResolvedValue(ok({
    bottleEntries: [entry({ key: { _id: 'k3', name: 'Organic', type: 'boolean', unit: null, enumOptions: null }, value: true })],
    wineEntries: [],
  }));
  renderCard();
  expect(await screen.findByText('Yes')).toBeInTheDocument();
  expect(screen.queryByText('true')).not.toBeInTheDocument();
});

test('add flow: new decimal key with unit posts and reloads', async () => {
  addPersonalData.mockResolvedValue(ok({ entry: entry() }));
  renderCard();
  await screen.findByText('Nothing recorded yet.');

  fireEvent.click(screen.getByText('+ Add'));
  expect(await screen.findByText('Add wine data')).toBeInTheDocument();
  expect(getPersonalDataKeys).toHaveBeenCalled();

  fireEvent.change(screen.getByPlaceholderText('e.g. ABV, Provenance, Cork condition'), {
    target: { value: 'ABV' },
  });
  // A new key shows the type picker; choose decimal, set unit and value.
  fireEvent.change(screen.getByLabelText(/Value type/), { target: { value: 'decimal' } });
  fireEvent.change(screen.getByPlaceholderText('e.g. %, °C, kr'), { target: { value: '%' } });
  fireEvent.change(screen.getByLabelText(/^Value$/), { target: { value: '13.5' } });
  fireEvent.click(screen.getByText('Save'));

  await waitFor(() => expect(addPersonalData).toHaveBeenCalledWith(
    expect.any(Function),
    BOTTLE_ID,
    {
      level: 'bottle',
      value: '13.5',
      newKey: { name: 'ABV', type: 'decimal', unit: '%' },
    }
  ));
  // Reload after a successful save (initial load + reload).
  await waitFor(() => expect(getPersonalData).toHaveBeenCalledTimes(2));
});

test('typing a key that matches an existing one locks its stored type', async () => {
  getPersonalDataKeys.mockResolvedValue(ok({
    keys: [{ _id: 'k1', name: 'ABV', type: 'decimal', unit: '%', enumOptions: null }],
  }));
  addPersonalData.mockResolvedValue(ok({ entry: entry() }));
  renderCard();
  await screen.findByText('Nothing recorded yet.');

  fireEvent.click(screen.getByText('+ Add'));
  await screen.findByText('Add wine data');
  fireEvent.change(screen.getByPlaceholderText('e.g. ABV, Provenance, Cork condition'), {
    target: { value: 'abv' },
  });

  // Existing-key notice replaces the new-key fields; submit sends keyId.
  expect(await screen.findByText(/Existing key — type: decimal/)).toBeInTheDocument();
  expect(screen.queryByLabelText(/Value type/)).not.toBeInTheDocument();

  fireEvent.change(screen.getByLabelText(/^Value$/), { target: { value: '14' } });
  fireEvent.click(screen.getByText('Save'));
  await waitFor(() => expect(addPersonalData).toHaveBeenCalledWith(
    expect.any(Function), BOTTLE_ID, { level: 'bottle', value: '14', keyId: 'k1' }
  ));
});

test('saved keys render as chips; clicking one selects it and offers its enum values', async () => {
  getPersonalDataKeys.mockResolvedValue(ok({
    keys: [{ _id: 'k9', name: 'Betyg', type: 'enum', unit: null, enumOptions: ['god', 'godare', 'godast'] }],
  }));
  addPersonalData.mockResolvedValue(ok({ entry: entry() }));
  renderCard();
  await screen.findByText('Nothing recorded yet.');

  fireEvent.click(screen.getByText('+ Add'));
  await screen.findByText('Add wine data');

  // The saved key is visible up front, not hidden behind type-ahead.
  expect(await screen.findByText('Your saved keys:')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Betyg' }));

  // Chip click selects the key: stored type locks, its value list appears.
  expect(await screen.findByText(/Existing key — type: enum/)).toBeInTheDocument();
  const valueSelect = screen.getByLabelText(/^Value$/);
  fireEvent.change(valueSelect, { target: { value: 'godast' } });
  fireEvent.click(screen.getByText('Save'));

  await waitFor(() => expect(addPersonalData).toHaveBeenCalledWith(
    expect.any(Function), BOTTLE_ID, { level: 'bottle', value: 'godast', keyId: 'k9' }
  ));
});

test('a rejected value surfaces the backend message and keeps the modal open', async () => {
  addPersonalData.mockResolvedValue({ ok: false, json: async () => ({ error: 'Expected a whole number' }) });
  renderCard();
  await screen.findByText('Nothing recorded yet.');

  fireEvent.click(screen.getByText('+ Add'));
  await screen.findByText('Add wine data');
  fireEvent.change(screen.getByPlaceholderText('e.g. ABV, Provenance, Cork condition'), {
    target: { value: 'Shelf' },
  });
  fireEvent.change(screen.getByLabelText(/Value type/), { target: { value: 'integer' } });
  fireEvent.change(screen.getByLabelText(/^Value$/), { target: { value: '3' } });
  fireEvent.click(screen.getByText('Save'));

  expect(await screen.findByText('Expected a whole number')).toBeInTheDocument();
  expect(screen.getByText('Add wine data')).toBeInTheDocument();
});

// The vintage page (beta feedback 2026-10-10): the card reaches the data
// through one bottle of the vintage, so "This bottle only" means nothing
// there. Add offers this vintage (preselected) or every vintage; one bottle's
// own entries stay on that bottle's page.
test('on the vintage page: add on this vintage or all vintages, never "this bottle"; one bottle\'s entries are not shown', async () => {
  getPersonalData.mockResolvedValue(ok({
    bottleEntries: [entry()],
    wineEntries: [entry({ _id: 'e2', level: 'wine', vintage: '2015', key: { _id: 'k2', name: 'Lot', type: 'text', unit: null, enumOptions: null }, value: 'L123' })],
  }));
  addPersonalData.mockResolvedValue(ok({ entry: entry() }));
  render(<PersonalDataCard apiFetch={vi.fn()} bottleId={BOTTLE_ID} currentUserId={ME} wineId="w1" vintage="2015" scope="vintage" />);

  expect(await screen.findByText('L123')).toBeInTheDocument();
  expect(screen.queryByText('This bottle')).toBeNull();
  expect(screen.queryByText('13.5 %')).toBeNull();

  fireEvent.click(screen.getByText('+ Add'));
  await screen.findByText('Add wine data');
  const options = [...screen.getByLabelText('Applies to').querySelectorAll('option')].map((o) => o.value);
  expect(options).toEqual(['wine-vintage', 'wine']);
  expect(screen.getByLabelText('Applies to')).toHaveValue('wine-vintage');

  fireEvent.change(screen.getByPlaceholderText('e.g. ABV, Provenance, Cork condition'), { target: { value: 'Critic score' } });
  fireEvent.change(screen.getByLabelText(/^Value$/), { target: { value: '96' } });
  fireEvent.click(screen.getByText('Save'));
  await waitFor(() => expect(addPersonalData).toHaveBeenCalledWith(
    expect.any(Function), BOTTLE_ID, expect.objectContaining({ level: 'wine', vintageScoped: true, value: '96' }),
  ));
});

test('on the vintage page with no vintage to scope to (an NV group of empty vintages), every vintage is the one choice', async () => {
  render(<PersonalDataCard apiFetch={vi.fn()} bottleId={BOTTLE_ID} currentUserId={ME} vintage="NV" scope="vintage" vintageScopable={false} />);
  await screen.findByText('Nothing recorded yet.');
  fireEvent.click(screen.getByText('+ Add'));
  await screen.findByText('Add wine data');
  const options = [...screen.getByLabelText('Applies to').querySelectorAll('option')].map((o) => o.value);
  expect(options).toEqual(['wine']);
  expect(screen.getByLabelText('Applies to')).toHaveValue('wine');
});

test('on the bottle page "This bottle only" stays the default', async () => {
  render(<PersonalDataCard apiFetch={vi.fn()} bottleId={BOTTLE_ID} currentUserId={ME} vintage="2015" />);
  await screen.findByText('Nothing recorded yet.');
  fireEvent.click(screen.getByText('+ Add'));
  await screen.findByText('Add wine data');
  const options = [...screen.getByLabelText('Applies to').querySelectorAll('option')].map((o) => o.value);
  expect(options).toEqual(['bottle', 'wine-vintage', 'wine']);
  expect(screen.getByLabelText('Applies to')).toHaveValue('bottle');
});

test('delete removes own entry and reloads', async () => {
  getPersonalData.mockResolvedValue(ok({ bottleEntries: [entry()], wineEntries: [] }));
  deletePersonalDataEntry.mockResolvedValue(ok({ deleted: true }));
  renderCard();
  await screen.findByText('13.5 %');

  fireEvent.click(screen.getByText('Delete'));
  await waitFor(() => expect(deletePersonalDataEntry).toHaveBeenCalledWith(expect.any(Function), 'e1'));
  await waitFor(() => expect(getPersonalData).toHaveBeenCalledTimes(2));
});

// A list key could never grow after its creation (user ticket 2026-10-27):
// under the select, "Add a new value to the list" extends the key first, then
// saves the entry with the new value.
const LIST_KEY = { _id: 'k9', name: 'Closure', type: 'enum', unit: null, enumOptions: ['cork', 'screwcap'] };

const openListKey = async () => {
  renderCard();
  await screen.findByText('Nothing recorded yet.');
  fireEvent.click(screen.getByText('+ Add'));
  await screen.findByText('Add wine data');
  fireEvent.click(await screen.findByRole('button', { name: 'Closure' }));
  await screen.findByText(/Existing key — type: enum/);
};

test('an existing list key takes a new value: the list is extended first, then the entry saved with it', async () => {
  getPersonalDataKeys.mockResolvedValue(ok({ keys: [LIST_KEY] }));
  updatePersonalDataKey.mockResolvedValue(ok({ key: { ...LIST_KEY, enumOptions: ['cork', 'screwcap', 'crown'] } }));
  addPersonalData.mockResolvedValue(ok({ entry: entry() }));
  await openListKey();

  fireEvent.click(screen.getByText('+ Add a new value to the list'));
  fireEvent.change(screen.getByLabelText(/^Value$/), { target: { value: ' crown ' } });
  fireEvent.click(screen.getByText('Save'));

  await waitFor(() => expect(updatePersonalDataKey).toHaveBeenCalledWith(
    expect.any(Function), 'k9', { enumOptions: ['cork', 'screwcap', 'crown'] }
  ));
  await waitFor(() => expect(addPersonalData).toHaveBeenCalledWith(
    expect.any(Function), BOTTLE_ID, { level: 'bottle', value: 'crown', keyId: 'k9' }
  ));
});

test('a new value that only differs in case from a listed one reuses it; the key is left alone', async () => {
  getPersonalDataKeys.mockResolvedValue(ok({ keys: [LIST_KEY] }));
  addPersonalData.mockResolvedValue(ok({ entry: entry() }));
  await openListKey();

  fireEvent.click(screen.getByText('+ Add a new value to the list'));
  fireEvent.change(screen.getByLabelText(/^Value$/), { target: { value: 'Cork' } });
  fireEvent.click(screen.getByText('Save'));

  await waitFor(() => expect(addPersonalData).toHaveBeenCalledWith(
    expect.any(Function), BOTTLE_ID, { level: 'bottle', value: 'cork', keyId: 'k9' }
  ));
  expect(updatePersonalDataKey).not.toHaveBeenCalled();
});

test('a refused list change surfaces the server message and saves no entry', async () => {
  getPersonalDataKeys.mockResolvedValue(ok({ keys: [LIST_KEY] }));
  updatePersonalDataKey.mockResolvedValue({ ok: false, json: async () => ({ error: 'Too many enum options (max 20)' }) });
  await openListKey();

  fireEvent.click(screen.getByText('+ Add a new value to the list'));
  fireEvent.change(screen.getByLabelText(/^Value$/), { target: { value: 'wax' } });
  fireEvent.click(screen.getByText('Save'));

  expect(await screen.findByText('Too many enum options (max 20)')).toBeInTheDocument();
  expect(addPersonalData).not.toHaveBeenCalled();
});

// Facts about the wine belong in the shared wine record, where every owner
// sees them. Members kept recording ABV here instead — the card's own intro
// told them to — so the card now steers a public name toward the record, by
// the same name rule the server resolves by (translations included).
describe('steering public facts toward the wine record', () => {
  const PUBLIC_ABV = {
    _id: 'pk1', name: 'ABV', displayName: 'ABV', type: 'decimal', unit: '%', enumOptions: null,
    translations: { sv: 'Alkoholhalt', fr: 'Degré d’alcool' },
  };
  const publicField = (extra) => ({
    key: PUBLIC_ABV, value: null, resolvedFrom: null, resolvedVintage: null, wineValue: null,
    overrides: [], hasPendingSuggestion: false, hasPendingWineSuggestion: false, mySuggestion: null, ...extra,
  });
  const renderWine = (props = {}) =>
    render(<PersonalDataCard apiFetch={vi.fn()} bottleId={BOTTLE_ID} currentUserId={ME} wineId="w1" vintage="2019" {...props} />);
  const openAddAndType = async (name) => {
    fireEvent.click(screen.getByText('+ Add'));
    await screen.findByText('Add wine data');
    await waitFor(() => expect(getWinePublicData).toHaveBeenCalled());
    fireEvent.change(screen.getByPlaceholderText('e.g. ABV, Provenance, Cork condition'), { target: { value: name } });
  };

  test('the intro no longer files ABV under personal data', async () => {
    renderCard();
    expect(await screen.findByText(/Facts about the wine itself, like ABV, belong in the wine record/)).toBeInTheDocument();
    expect(screen.queryByText(/Anything the record doesn’t cover — ABV/)).toBeNull();
  });

  test('a public name the record lacks: "Add to the wine record" files it under the canonical key for this vintage, and saves nothing privately', async () => {
    getWinePublicData.mockResolvedValue(ok({ fields: [publicField()] }));
    renderWine();
    await screen.findByText('Nothing recorded yet.');
    await openAddAndType('alkoholhalt');

    expect(getWinePublicData).toHaveBeenCalledWith(expect.any(Function), 'w1', '2019', null);
    expect(await screen.findByText(/ABV is part of the shared wine record — add it there/)).toBeInTheDocument();
    // The public key's type and unit are the new key's: no type picker.
    expect(screen.queryByLabelText(/Value type/)).toBeNull();
    expect(screen.getByText('Keep it private')).toBeInTheDocument();
    expect(screen.queryByText('Save')).toBeNull();
    // A bottle with a real year defaults to that vintage.
    expect(screen.getByLabelText(/applies to 2019 only/)).toBeChecked();

    fireEvent.change(screen.getByLabelText(/^Value$/), { target: { value: '13.5' } });
    fireEvent.click(screen.getByText('Add to the wine record'));

    await waitFor(() => expect(suggestWineValue).toHaveBeenCalledWith(
      expect.any(Function), 'w1', { keyId: 'pk1', value: '13.5', vintage: '2019' }
    ));
    expect(addPersonalData).not.toHaveBeenCalled();
    expect(await screen.findByText('Thank you — your value is in the registry review queue.')).toBeInTheDocument();
    expect(screen.queryByText('Add wine data')).toBeNull();
  });

  test('the producer’s general spec goes wine-wide; an NV bottle has no year to ask about', async () => {
    getWinePublicData.mockResolvedValue(ok({ fields: [publicField()] }));
    const { unmount } = renderWine();
    await screen.findByText('Nothing recorded yet.');
    await openAddAndType('ABV');
    fireEvent.click(await screen.findByLabelText(/applies to all vintages/));
    fireEvent.change(screen.getByLabelText(/^Value$/), { target: { value: '13' } });
    fireEvent.click(screen.getByText('Add to the wine record'));
    await waitFor(() => expect(suggestWineValue).toHaveBeenCalledWith(
      expect.any(Function), 'w1', { keyId: 'pk1', value: '13' }
    ));
    unmount();

    suggestWineValue.mockClear();
    renderWine({ vintage: 'NV' });
    await screen.findByText('Nothing recorded yet.');
    await openAddAndType('ABV');
    await screen.findByText(/ABV is part of the shared wine record/);
    expect(screen.queryByText('Where does this figure come from?')).toBeNull();
    fireEvent.change(screen.getByLabelText(/^Value$/), { target: { value: '12' } });
    fireEvent.click(screen.getByText('Add to the wine record'));
    await waitFor(() => expect(suggestWineValue).toHaveBeenCalledWith(
      expect.any(Function), 'w1', { keyId: 'pk1', value: '12' }
    ));
  });

  test('"Keep it private" saves the entry as ever, typed like the public key, and files nothing', async () => {
    getWinePublicData.mockResolvedValue(ok({ fields: [publicField()] }));
    addPersonalData.mockResolvedValue(ok({ entry: entry() }));
    renderWine();
    await screen.findByText('Nothing recorded yet.');
    await openAddAndType('degré d’alcool');
    await screen.findByText(/ABV is part of the shared wine record/);
    fireEvent.change(screen.getByLabelText(/^Value$/), { target: { value: '13.5' } });
    fireEvent.click(screen.getByText('Keep it private'));

    await waitFor(() => expect(addPersonalData).toHaveBeenCalledWith(expect.any(Function), BOTTLE_ID, {
      level: 'bottle', value: '13.5', newKey: { name: 'degré d’alcool', type: 'decimal', unit: '%' },
    }));
    expect(suggestWineValue).not.toHaveBeenCalled();
  });

  test('a public name the record already holds says what it holds; saving privately stays the plain Save', async () => {
    getWinePublicData.mockResolvedValue(ok({ fields: [publicField({ value: 13.5, resolvedFrom: 'wine', wineValue: 13.5 })] }));
    renderWine();
    await screen.findByText('Nothing recorded yet.');
    await openAddAndType('ABV');
    expect(await screen.findByText('The wine record already has ABV: 13.5 %.')).toBeInTheDocument();
    expect(screen.getByText('Save')).toBeInTheDocument();
    expect(screen.queryByText('Add to the wine record')).toBeNull();
  });

  test('a new name the vocabulary lacks gets one quiet line, not a question', async () => {
    getWinePublicData.mockResolvedValue(ok({ fields: [publicField()] }));
    renderWine();
    await screen.findByText('Nothing recorded yet.');
    await openAddAndType('Cork condition');
    expect(await screen.findByText(/You can offer it to the shared registry after saving/)).toBeInTheDocument();
    expect(screen.getByText('Save')).toBeInTheDocument();
    expect(screen.queryByText(/is part of the shared wine record/)).toBeNull();
  });

  test('without a wine record (no wine id) nothing is fetched or steered', async () => {
    renderCard();
    await screen.findByText('Nothing recorded yet.');
    fireEvent.click(screen.getByText('+ Add'));
    await screen.findByText('Add wine data');
    fireEvent.change(screen.getByPlaceholderText('e.g. ABV, Provenance, Cork condition'), { target: { value: 'ABV' } });
    expect(getWinePublicData).not.toHaveBeenCalled();
    expect(screen.queryByText(/shared wine record/)).toBeNull();
    expect(screen.queryByText(/after saving/)).toBeNull();
  });

  describe('own entries under a public key', () => {
    const own = (over = {}) => entry({ key: { _id: 'k1', name: 'Alkoholhalt', type: 'decimal', unit: '%', enumOptions: null }, ...over });

    test('the record lacks it: "Share with the wine record" files the canonical key, asking the vintage', async () => {
      getPersonalData.mockResolvedValue(ok({ bottleEntries: [own()], wineEntries: [] }));
      getWinePublicData.mockResolvedValue(ok({ fields: [publicField()] }));
      renderWine();
      fireEvent.click(await screen.findByText('Share with the wine record'));

      expect(await screen.findByText(/Offer “13.5 %” to the wine record as ABV/)).toBeInTheDocument();
      expect(screen.getByLabelText(/applies to 2019 only/)).toBeChecked();
      // Only the value is offered: the reason is optional.
      expect(screen.getByLabelText('How do you know? (optional)')).not.toBeRequired();
      fireEvent.click(screen.getByText('Send suggestion'));

      await waitFor(() => expect(suggestWineValue).toHaveBeenCalledWith(
        expect.any(Function), 'w1', { keyId: 'pk1', value: 13.5, vintage: '2019' }
      ));
      expect(proposeRegistryKey).not.toHaveBeenCalled();
      expect(await screen.findByText('Thank you — your value is in the registry review queue.')).toBeInTheDocument();
    });

    test('the record says the same: a quiet note instead of any button', async () => {
      getPersonalData.mockResolvedValue(ok({ bottleEntries: [own()], wineEntries: [] }));
      getWinePublicData.mockResolvedValue(ok({ fields: [publicField({ value: 13.5, resolvedFrom: 'wine', wineValue: 13.5 })] }));
      renderWine();
      expect(await screen.findByText('matches the wine record')).toBeInTheDocument();
      expect(screen.queryByText('Share with the wine record')).toBeNull();
      expect(screen.queryByText('Suggest to registry')).toBeNull();
    });

    test('the record says something else: "Suggest to registry" as before, filed under the canonical key', async () => {
      getPersonalData.mockResolvedValue(ok({ bottleEntries: [own()], wineEntries: [] }));
      getWinePublicData.mockResolvedValue(ok({ fields: [publicField({ value: 14, resolvedFrom: 'wine', wineValue: 14 })] }));
      renderWine();
      fireEvent.click(await screen.findByText('Suggest to registry'));
      fireEvent.click(await screen.findByLabelText(/applies to all vintages/));
      fireEvent.click(screen.getByText('Send suggestion'));
      await waitFor(() => expect(suggestWineValue).toHaveBeenCalledWith(
        expect.any(Function), 'w1', { keyId: 'pk1', value: 13.5 }
      ));
    });

    test('a suggestion already waiting: status, not a button that can only be refused', async () => {
      getPersonalData.mockResolvedValue(ok({ bottleEntries: [own()], wineEntries: [] }));
      getWinePublicData.mockResolvedValue(ok({ fields: [publicField({ hasPendingSuggestion: true })] }));
      renderWine();
      expect(await screen.findByText('suggestion pending')).toBeInTheDocument();
      expect(screen.queryByText('Share with the wine record')).toBeNull();
    });

    test('a key the vocabulary lacks keeps today’s flow: by name, with the reason required', async () => {
      getPersonalData.mockResolvedValue(ok({
        bottleEntries: [entry({ key: { _id: 'k2', name: 'Lot', type: 'text', unit: null, enumOptions: null }, value: 'L123' })],
        wineEntries: [],
      }));
      getWinePublicData.mockResolvedValue(ok({ fields: [publicField()] }));
      renderWine();
      fireEvent.click(await screen.findByText('Suggest to registry'));
      expect(screen.getByLabelText('How do you know?')).toBeRequired();
      fireEvent.change(screen.getByLabelText('How do you know?'), { target: { value: 'Printed on the back label.' } });
      fireEvent.click(screen.getByText('Send suggestion'));
      await waitFor(() => expect(suggestWineValue).toHaveBeenCalledWith(
        expect.any(Function), 'w1', { keyName: 'Lot', value: 'L123', reason: 'Printed on the back label.' }
      ));
    });
  });
});
