import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

vi.mock('../../api/wineProposals', () => ({
  createWineProposal: vi.fn(),
  getMyWineProposals: vi.fn(),
}));

vi.mock('../../api/taxonomy', () => ({
  getGrapeNames: vi.fn(),
}));

vi.mock('../../api/registryData', () => ({
  getWinePublicData: vi.fn(),
  suggestWineValue: vi.fn(),
  proposeRegistryKey: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, vars) => {
      const s = typeof fallback === 'string' ? fallback : key;
      return vars ? s.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k]) : s;
    },
  }),
}));

const { createWineProposal, getMyWineProposals } = await import('../../api/wineProposals');
const { getWinePublicData, suggestWineValue } = await import('../../api/registryData');
const { getGrapeNames } = await import('../../api/taxonomy');
const { __resetGrapeNamesCache } = await import('../../hooks/useGrapeNames');
const WineRecordSection = (await import('./WineRecordSection')).default;

const WINE = {
  _id: 'w1',
  producer: 'Cloudy Bay',
  name: 'Te Koko',
  appellation: null,
  classification: null,
  type: 'white',
  grapes: [{ _id: 'g1', name: 'Sauvignon Blanc' }],
  country: { name: 'New Zealand' },
  region: { name: 'Marlborough' },
};

// What GET /api/taxonomy/grape-names answers with.
const GRAPES = [
  { name: 'Sauvignon Blanc', color: 'White', synonyms: ['Fumé Blanc'], wineCount: 400 },
  { name: 'Sémillon', color: 'White', synonyms: [], wineCount: 90 },
  { name: 'Syrah', color: 'Red', synonyms: ['Shiraz'], wineCount: 700 },
  { name: 'Sauvignon Gris', color: 'White', synonyms: [], wineCount: 6 },
];

const ok = (body) => ({ ok: true, json: async () => body });

beforeEach(() => {
  vi.clearAllMocks();
  getMyWineProposals.mockResolvedValue(ok({ proposals: [] }));
  getWinePublicData.mockResolvedValue(ok({ fields: [] }));
  getGrapeNames.mockResolvedValue(ok({ grapes: GRAPES }));
  __resetGrapeNamesCache();
});

const renderSection = (props = {}) =>
  render(<WineRecordSection wine={WINE} canSuggest apiFetch={vi.fn()} {...props} />);

// Per-row actions live behind ONE section-level toggle (Johan, 2026-08-17):
// most users never file a fix, so the default record must read clean.
const enterSuggestMode = () => fireEvent.click(screen.getByText('Suggest a fix'));

test('shows the full record with blanks rendered as "not recorded", never hidden', async () => {
  renderSection();
  expect(screen.getByText('Cloudy Bay')).toBeInTheDocument();
  expect(screen.getByText('Marlborough')).toBeInTheDocument();
  // appellation + classification are blank → two visible gaps
  expect(await screen.findAllByText('not recorded')).toHaveLength(2);
  expect(screen.getByText('Appellation')).toBeInTheDocument();
  expect(screen.getByText('Classification')).toBeInTheDocument();
});

test('per-row actions hide until the single section toggle is pressed, and hide again on Done', async () => {
  renderSection();
  await screen.findAllByText('not recorded');
  // Default: exactly ONE "Suggest a fix" (the toggle), no per-row buttons.
  expect(screen.getAllByText('Suggest a fix')).toHaveLength(1);
  expect(screen.queryByLabelText('Suggest a fix for Producer')).not.toBeInTheDocument();

  enterSuggestMode();
  expect(screen.getByLabelText('Suggest a fix for Producer')).toBeInTheDocument();
  expect(screen.getByText('+ Propose a new data field')).toBeInTheDocument();

  fireEvent.click(screen.getByText('Done'));
  expect(screen.queryByLabelText('Suggest a fix for Producer')).not.toBeInTheDocument();
});

test('suggest flow posts one changed field with reason and marks it pending', async () => {
  createWineProposal.mockResolvedValue(ok({ proposal: { _id: 'p1', status: 'pending' } }));
  renderSection();
  await screen.findAllByText('not recorded');
  enterSuggestMode();

  fireEvent.click(screen.getByLabelText('Suggest a fix for Appellation'));
  expect(await screen.findByText('Suggest a fix: Appellation')).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText('Should be'), { target: { value: 'Marlborough GI' } });
  fireEvent.change(screen.getByLabelText('How do you know?'), {
    target: { value: 'Printed on the back label.' },
  });
  fireEvent.click(screen.getByText('Send suggestion'));

  await waitFor(() => expect(createWineProposal).toHaveBeenCalledWith(expect.any(Function), {
    wineId: 'w1',
    fields: { appellation: 'Marlborough GI' },
    reason: 'Printed on the back label.',
  }));
  expect(await screen.findByText(/your suggestion is in the review queue/)).toBeInTheDocument();
  expect(screen.getByText('suggestion pending')).toBeInTheDocument();
});

test('a field with my pending proposal shows the pending marker instead of the button', async () => {
  getMyWineProposals.mockResolvedValue(ok({
    proposals: [{ status: 'pending', proposedFields: { producer: 'Cloudy Bay Vineyards' } }],
  }));
  renderSection();
  // Pending markers are STATUS, not affordance — visible without suggest mode.
  expect(await screen.findByText('suggestion pending')).toBeInTheDocument();
  enterSuggestMode();
  expect(screen.queryByLabelText('Suggest a fix for Producer')).not.toBeInTheDocument();
  // Other fields still suggestable
  expect(screen.getByLabelText('Suggest a fix for Country')).toBeInTheDocument();
});

test('demo/read-only mode renders the record without suggest actions', async () => {
  renderSection({ canSuggest: false });
  expect(screen.getByText('Cloudy Bay')).toBeInTheDocument();
  expect(screen.queryByText('Suggest a fix')).not.toBeInTheDocument();
  expect(getMyWineProposals).not.toHaveBeenCalled();
});

test('public data fields render with values and blanks — never with who contributed them; a blank invites Add value', async () => {
  getWinePublicData.mockResolvedValue(ok({
    fields: [
      { key: { _id: 'k1', name: 'ABV', type: 'decimal', unit: '%', enumOptions: null }, value: 13.5, contributedBy: 'Kurt', mySuggestion: null },
      { key: { _id: 'k2', name: 'Organic', type: 'boolean', unit: null, enumOptions: null }, value: null, contributedBy: null, mySuggestion: null },
    ],
  }));
  suggestWineValue.mockResolvedValue(ok({ value: { _id: 'v1', status: 'suggested' } }));
  renderSection();

  expect(await screen.findByText('More data')).toBeInTheDocument();
  expect(screen.getByText('13.5 %')).toBeInTheDocument();
  // The contributor is stored, never shown (Johan, 2026-09-18). The fixture
  // still carries a name on purpose: a server that sent one would not get it
  // rendered either.
  expect(screen.queryByText(/Kurt/)).not.toBeInTheDocument();

  enterSuggestMode();
  // Blank field offers "Add value" with the type-driven input (boolean → select)
  fireEvent.click(screen.getByLabelText('Suggest a value for Organic'));
  expect(await screen.findByText('Suggest a value: Organic')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'true' } });
  fireEvent.click(screen.getByText('Send suggestion'));
  await waitFor(() => expect(suggestWineValue).toHaveBeenCalledWith(expect.any(Function), 'w1', {
    keyId: 'k2', value: true,
  }));
});

test('my pending public suggestion shows the pending marker', async () => {
  getWinePublicData.mockResolvedValue(ok({
    fields: [
      { key: { _id: 'k1', name: 'ABV', type: 'decimal', unit: '%', enumOptions: null }, value: null, contributedBy: null, mySuggestion: { value: 13.5, status: 'suggested' } },
    ],
  }));
  renderSection();
  expect(await screen.findByText('More data')).toBeInTheDocument();
  // one pending marker for the public field, none for identity fields
  expect(screen.getByText('suggestion pending')).toBeInTheDocument();
  expect(screen.queryByLabelText('Suggest a value for ABV')).not.toBeInTheDocument();
});

test('server rejection (e.g. daily limit) surfaces in the modal', async () => {
  createWineProposal.mockResolvedValue({ ok: false, json: async () => ({ error: "You have reached today's suggestion limit (3)." }) });
  renderSection();
  await screen.findAllByText('not recorded');
  enterSuggestMode();
  fireEvent.click(screen.getByLabelText('Suggest a fix for Country'));
  await screen.findByText('Suggest a fix: Country');
  fireEvent.change(screen.getByLabelText('Should be'), { target: { value: 'France' } });
  fireEvent.change(screen.getByLabelText('How do you know?'), { target: { value: 'Long enough reason here.' } });
  fireEvent.click(screen.getByText('Send suggestion'));
  expect(await screen.findByText(/suggestion limit/)).toBeInTheDocument();
});

// Display names (2026-09-09). The day after the vocabulary got its first
// German-speaking contributor, "Alkoholgehalt" was proposed as a new key: it
// is ABV, and he could not have known, because the only key on his bottle
// page was named in a language he was not reading in. A key now carries the
// reader's name in `displayName`; `name` stays the identifier.
describe('key display names', () => {
  test('a translated key is labelled in the reader\'s language, and the suggest action uses that label', async () => {
    getWinePublicData.mockResolvedValue(ok({
      fields: [
        { key: { _id: 'k1', name: 'ABV', displayName: 'Alkoholgehalt', type: 'decimal', unit: '%', enumOptions: null }, value: null, contributedBy: null, mySuggestion: null },
      ],
    }));
    renderSection();
    expect(await screen.findByText('Alkoholgehalt')).toBeInTheDocument();
    expect(screen.queryByText('ABV')).not.toBeInTheDocument();
    enterSuggestMode();
    expect(screen.getByLabelText('Suggest a value for Alkoholgehalt')).toBeInTheDocument();
  });

  test('a key without a translation reads exactly as before', async () => {
    // An older payload has no displayName at all; a translated payload for a
    // language with no entry carries the English name in it. Both show "ABV".
    getWinePublicData.mockResolvedValue(ok({
      fields: [
        { key: { _id: 'k1', name: 'ABV', type: 'decimal', unit: '%', enumOptions: null }, value: 13.5, contributedBy: 'Kurt', mySuggestion: null },
        { key: { _id: 'k2', name: 'Organic', displayName: 'Organic', type: 'boolean', unit: null, enumOptions: null }, value: null, contributedBy: null, mySuggestion: null },
      ],
    }));
    renderSection();
    expect(await screen.findByText('ABV')).toBeInTheDocument();
    expect(screen.getByText('Organic')).toBeInTheDocument();
  });
});

// Type and grapes are part of the record (support ticket 2026-09-17). Grapes
// used to be a section of their own whose only action — a free-text "suggest
// grapes" box — appeared while the list was EMPTY, so a wrong or incomplete
// list could not be corrected at all.
describe('type and grapes', () => {
  const openGrapesForm = async () => {
    enterSuggestMode();
    fireEvent.click(screen.getByLabelText('Suggest a fix for Grapes'));
    await screen.findByText('Suggest a fix: Grapes');
    // The list arrives when the form opens, not with the page.
    await waitFor(() => expect(screen.getByLabelText('The grapes in this wine')).not.toBeDisabled());
  };
  const typeGrape = (text) =>
    fireEvent.change(screen.getByLabelText('The grapes in this wine'), { target: { value: text } });

  test('both are rows of the record, and a regional grape name is what the page shows', async () => {
    renderSection({ wine: { ...WINE, grapes: [{ _id: 'g9', name: 'Tempranillo', displayName: 'Tinta Roriz' }] } });
    await screen.findAllByText('not recorded');
    expect(screen.getByText('Type')).toBeInTheDocument();
    expect(screen.getByText('White')).toBeInTheDocument();
    expect(screen.getByText('Grapes')).toBeInTheDocument();
    expect(screen.getByText('Tinta Roriz')).toBeInTheDocument();
    expect(getGrapeNames).not.toHaveBeenCalled();
  });

  test('a filled field offers Fix and a blank one Add', async () => {
    renderSection();
    await screen.findAllByText('not recorded');
    enterSuggestMode();
    expect(screen.getByLabelText('Suggest a fix for Grapes')).toHaveTextContent('Fix');
    expect(screen.getByLabelText('Suggest a fix for Appellation')).toHaveTextContent('Add');
  });

  test('the grape form starts from the current list and sends the COMPLETE corrected one', async () => {
    createWineProposal.mockResolvedValue(ok({
      proposal: { _id: 'p1', status: 'pending', proposedFields: { grapes: ['Sauvignon Blanc', 'Sémillon'] } },
    }));
    renderSection();
    await screen.findAllByText('not recorded');
    await openGrapesForm();

    // Unchanged list + a reason is still nothing to send.
    fireEvent.change(screen.getByLabelText('How do you know?'), { target: { value: 'The back label lists both.' } });
    expect(screen.getByText('Send suggestion')).toBeDisabled();

    typeGrape('semil');
    fireEvent.click(await screen.findByRole('option', { name: /Sémillon/ }));
    expect(screen.getByLabelText('Remove Sémillon')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Send suggestion'));

    await waitFor(() => expect(createWineProposal).toHaveBeenCalledWith(expect.any(Function), {
      wineId: 'w1',
      fields: { grapes: ['Sauvignon Blanc', 'Sémillon'] },
      reason: 'The back label lists both.',
    }));
    // "See the grapes even while they are in review": the suggester's own
    // pending list shows under the recorded one.
    expect(await screen.findByText('Sauvignon Blanc, Sémillon')).toBeInTheDocument();
    expect(screen.getByText('suggestion pending')).toBeInTheDocument();
  });

  test('a synonym finds the canonical variety and says which name matched', async () => {
    renderSection();
    await screen.findAllByText('not recorded');
    await openGrapesForm();
    typeGrape('shiraz');
    const option = await screen.findByRole('option', { name: /Syrah/ });
    expect(option).toHaveTextContent('also Shiraz');
  });

  test('a variety the list lacks can be added deliberately, and is declared as new', async () => {
    createWineProposal.mockResolvedValue(ok({ proposal: { _id: 'p1', status: 'pending' } }));
    renderSection();
    await screen.findAllByText('not recorded');
    await openGrapesForm();

    typeGrape('Souvignier Gris');
    fireEvent.click(await screen.findByRole('option', { name: /as a new variety/ }));
    expect(screen.getByText(/Not in our grape list yet: “Souvignier Gris”/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('How do you know?'), { target: { value: 'Named on the producer tech sheet.' } });
    fireEvent.click(screen.getByText('Send suggestion'));

    await waitFor(() => expect(createWineProposal).toHaveBeenCalledWith(expect.any(Function), {
      wineId: 'w1',
      fields: { grapes: ['Sauvignon Blanc', 'Souvignier Gris'], newGrapes: ['Souvignier Gris'] },
      reason: 'Named on the producer tech sheet.',
    }));
  });

  test('a grape list that fails to load says so and can be retried', async () => {
    getGrapeNames.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    renderSection();
    await screen.findAllByText('not recorded');
    enterSuggestMode();
    fireEvent.click(screen.getByLabelText('Suggest a fix for Grapes'));
    expect(await screen.findByText('Couldn’t load the grape list.')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Try again'));
    await waitFor(() => expect(screen.getByLabelText('The grapes in this wine')).not.toBeDisabled());
  });

  test('type is picked from the other types, never typed', async () => {
    createWineProposal.mockResolvedValue(ok({ proposal: { _id: 'p1', status: 'pending' } }));
    renderSection();
    await screen.findAllByText('not recorded');
    enterSuggestMode();
    fireEvent.click(screen.getByLabelText('Suggest a fix for Type'));
    await screen.findByText('Suggest a fix: Type');
    // The recorded type is not a choice.
    expect(screen.queryByRole('radio', { name: 'White' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Sparkling' }));
    fireEvent.change(screen.getByLabelText('How do you know?'), { target: { value: 'It is a traditional-method fizz.' } });
    fireEvent.click(screen.getByText('Send suggestion'));
    await waitFor(() => expect(createWineProposal).toHaveBeenCalledWith(expect.any(Function), {
      wineId: 'w1',
      fields: { type: 'sparkling' },
      reason: 'It is a traditional-method fizz.',
    }));
    expect(await screen.findByText('Sparkling')).toBeInTheDocument();
  });

  test('the missing-grapes invitation opens the grape form directly', async () => {
    renderSection({ wine: { ...WINE, _id: 'w-nograpes', grapes: [] }, promptMissingGrapes: true });
    await screen.findAllByText('not recorded');
    fireEvent.click(screen.getByText(/Suggest grapes/));
    expect(await screen.findByText('Suggest a fix: Grapes')).toBeInTheDocument();
  });

  test('no invitation once my grape suggestion is already pending', async () => {
    getMyWineProposals.mockResolvedValue(ok({
      proposals: [{ status: 'pending', proposedFields: { grapes: ['Sauvignon Blanc'] } }],
      pending: { mine: true, fields: ['grapes'] },
    }));
    renderSection({ wine: { ...WINE, _id: 'w-nograpes2', grapes: [] }, promptMissingGrapes: true });
    expect(await screen.findByText('suggestion pending')).toBeInTheDocument();
    expect(screen.queryByText(/Suggest grapes/)).not.toBeInTheDocument();
  });
});

test('a text field opens pre-filled, and an unchanged value cannot be sent', async () => {
  renderSection();
  await screen.findAllByText('not recorded');
  enterSuggestMode();
  fireEvent.click(screen.getByLabelText('Suggest a fix for Producer'));
  await screen.findByText('Suggest a fix: Producer');
  expect(screen.getByLabelText('Should be')).toHaveValue('Cloudy Bay');
  fireEvent.change(screen.getByLabelText('How do you know?'), { target: { value: 'Long enough reason here.' } });
  expect(screen.getByText('Send suggestion')).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Should be'), { target: { value: 'Cloudy Bay Vineyards' } });
  expect(screen.getByText('Send suggestion')).not.toBeDisabled();
});

test('a too-short reason explains itself instead of leaving Send silently greyed out', async () => {
  renderSection();
  await screen.findAllByText('not recorded');
  enterSuggestMode();
  fireEvent.click(screen.getByLabelText('Suggest a fix for Producer'));
  await screen.findByText('Suggest a fix: Producer');
  fireEvent.change(screen.getByLabelText('How do you know?'), { target: { value: 'label' } });
  expect(screen.getByText(/A few more words, please/)).toBeInTheDocument();
});

// One pending suggestion per wine across ALL users: the page says so before a
// correction is typed, instead of answering a finished form with a 409.
test('somebody else holding the review slot is said up front, and no field offers a fix', async () => {
  getMyWineProposals.mockResolvedValue(ok({ proposals: [], pending: { mine: false, fields: ['producer'] } }));
  renderSection();
  await screen.findAllByText('not recorded');
  enterSuggestMode();
  expect(await screen.findByText(/Another member’s suggestion for this wine is waiting/)).toBeInTheDocument();
  expect(screen.queryByLabelText('Suggest a fix for Producer')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Suggest a fix for Grapes')).not.toBeInTheDocument();
});

test('a second filing merges into my pending suggestion instead of replacing it', async () => {
  getMyWineProposals.mockResolvedValue(ok({
    proposals: [{ status: 'pending', proposedFields: { producer: 'Cloudy Bay Vineyards' } }],
    pending: { mine: true, fields: ['producer'] },
  }));
  createWineProposal.mockResolvedValue(ok({
    amended: true,
    proposal: { _id: 'p1', status: 'pending', proposedFields: { producer: 'Cloudy Bay Vineyards', appellation: 'Marlborough' } },
  }));
  renderSection();
  await screen.findByText('Cloudy Bay Vineyards');
  enterSuggestMode();
  fireEvent.click(screen.getByLabelText('Suggest a fix for Appellation'));
  await screen.findByText('Suggest a fix: Appellation');
  fireEvent.change(screen.getByLabelText('Should be'), { target: { value: 'Marlborough' } });
  fireEvent.change(screen.getByLabelText('How do you know?'), { target: { value: 'Printed on the back label.' } });
  fireEvent.click(screen.getByText('Send suggestion'));
  await waitFor(() => expect(screen.getAllByText('suggestion pending')).toHaveLength(2));
  expect(screen.getByText('Cloudy Bay Vineyards')).toBeInTheDocument();
});

test('another surface can send the reader here in suggest mode', async () => {
  const { rerender } = renderSection();
  await screen.findAllByText('not recorded');
  expect(screen.queryByLabelText('Suggest a fix for Producer')).not.toBeInTheDocument();
  rerender(<WineRecordSection wine={WINE} canSuggest apiFetch={vi.fn()} suggestSignal={1} />);
  expect(await screen.findByLabelText('Suggest a fix for Producer')).toBeInTheDocument();
});

// ── Pre-deploy audit 2026-09-18 ─────────────────────────────────────────────
describe('audit 2026-09-18', () => {
  // The page keeps the counter for the whole visit and this section remounts
  // whenever the edit form has been shown: acting on the MOUNTED value re-opened
  // suggest mode and scrolled the page after every later edit.
  test('the hand-off signal is an event: a value already set at mount does nothing, a change acts', async () => {
    const { rerender } = renderSection({ suggestSignal: 1 });
    await screen.findAllByText('not recorded');
    expect(screen.queryByLabelText('Suggest a fix for Producer')).not.toBeInTheDocument();
    expect(screen.getByText('Suggest a fix')).toBeInTheDocument();

    rerender(<WineRecordSection wine={WINE} canSuggest apiFetch={vi.fn()} suggestSignal={2} />);
    expect(await screen.findByLabelText('Suggest a fix for Producer')).toBeInTheDocument();
  });

  // The bottle page stays mounted from bottle to bottle. A failed refetch used
  // to leave wine A's pending lines — and A's review slot — on wine B.
  test('nothing that belongs to one wine survives a change of wine, even when the refetch fails', async () => {
    getMyWineProposals.mockResolvedValueOnce(ok({
      proposals: [{ status: 'pending', proposedFields: { producer: 'Cloudy Bay Vineyards' } }],
      pending: { mine: true, fields: ['producer'] },
    }));
    const apiFetch = vi.fn();
    const { rerender } = render(<WineRecordSection wine={WINE} canSuggest apiFetch={apiFetch} />);
    expect(await screen.findByText('Cloudy Bay Vineyards')).toBeInTheDocument();

    getMyWineProposals.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    rerender(<WineRecordSection wine={{ ...WINE, _id: 'w2', producer: 'Dog Point' }} canSuggest apiFetch={apiFetch} />);
    expect(await screen.findByText('Dog Point')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Cloudy Bay Vineyards')).not.toBeInTheDocument());
    expect(screen.queryByText('suggestion pending')).not.toBeInTheDocument();
  });

  // My earlier suggestion was decided while this page was open, so the next
  // filing is a FRESH proposal. Merging the stale local fields back in kept
  // showing the decided one as pending.
  test('a fresh filing replaces my stale pending fields instead of inheriting them', async () => {
    getMyWineProposals.mockResolvedValue(ok({
      proposals: [{ status: 'pending', proposedFields: { producer: 'Cloudy Bay Vineyards' } }],
      pending: { mine: true, fields: ['producer'] },
    }));
    createWineProposal.mockResolvedValue(ok({
      amended: false,
      proposal: { _id: 'p2', status: 'pending', proposedFields: { appellation: 'Marlborough' } },
    }));
    renderSection();
    await screen.findByText('Cloudy Bay Vineyards');
    enterSuggestMode();
    fireEvent.click(screen.getByLabelText('Suggest a fix for Appellation'));
    await screen.findByText('Suggest a fix: Appellation');
    fireEvent.change(screen.getByLabelText('Should be'), { target: { value: 'Marlborough' } });
    fireEvent.change(screen.getByLabelText('How do you know?'), { target: { value: 'Printed on the back label.' } });
    fireEvent.click(screen.getByText('Send suggestion'));
    await waitFor(() => expect(screen.queryByText('Cloudy Bay Vineyards')).not.toBeInTheDocument());
    expect(screen.getAllByText('suggestion pending')).toHaveLength(1);
  });

  test('the type chooser is one tab stop, and the arrow keys move within it', async () => {
    renderSection();
    await screen.findAllByText('not recorded');
    enterSuggestMode();
    fireEvent.click(screen.getByLabelText('Suggest a fix for Type'));
    await screen.findByText('Suggest a fix: Type');
    // Nothing chosen yet: the first choice is the group's tab stop.
    expect(screen.getAllByRole('radio').map((r) => r.tabIndex)).toEqual([0, -1, -1, -1, -1]);

    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'ArrowRight' });
    expect(screen.getByRole('radio', { name: 'Red' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'ArrowLeft' });
    // Wraps to the last choice, which becomes the TYPE group's only tab stop
    // (Fortified is a style, so the colour group opens with a stop of its own).
    const typeGroup = screen.getByRole('radiogroup', { name: 'Should be' });
    expect(within(typeGroup).getByRole('radio', { name: 'Fortified' })).toHaveAttribute('aria-checked', 'true');
    expect(within(typeGroup).getAllByRole('radio').filter((r) => r.tabIndex === 0)).toHaveLength(1);
    expect(within(typeGroup).getByRole('radio', { name: 'Fortified' })).toHaveFocus();
  });
});

// Support ticket 2026-09-17 ("Colour Sparkling/Rosè"): sparkling, dessert and
// fortified say nothing about colour, so the record carries one for them.
describe('colour of a sparkling, dessert or fortified wine', () => {
  const SPARKLING = { ...WINE, _id: 'w-mm', producer: 'Maso Martis', name: 'Rosé Extra Brut', type: 'sparkling', colour: null };

  test('the Type row reads as one phrase when a colour is recorded', async () => {
    renderSection({ wine: { ...SPARKLING, colour: 'rosé' } });
    await screen.findAllByText('not recorded');
    expect(screen.getByText('Sparkling rosé')).toBeInTheDocument();
  });

  test('a colour on a red/white/rosé wine is ignored — the type already is the colour', async () => {
    renderSection({ wine: { ...WINE, colour: 'rosé' } });
    await screen.findAllByText('not recorded');
    expect(screen.getByText('White')).toBeInTheDocument();
    expect(screen.queryByText(/Sparkling/)).not.toBeInTheDocument();
  });

  test('fixing only the colour of a sparkling wine is one tap, and sends only the colour', async () => {
    createWineProposal.mockResolvedValue(ok({ proposal: { _id: 'p1', status: 'pending' } }));
    renderSection({ wine: SPARKLING });
    await screen.findAllByText('not recorded');
    enterSuggestMode();
    fireEvent.click(screen.getByLabelText('Suggest a fix for Type'));
    await screen.findByText('Suggest a fix: Type');
    // Opens on its own type, with the colour question already showing.
    expect(screen.getByRole('radio', { name: 'Sparkling' })).toHaveAttribute('aria-checked', 'true');
    const colourGroup = screen.getByRole('radiogroup', { name: 'Colour' });
    // Nothing changed yet → nothing to send.
    fireEvent.change(screen.getByLabelText('How do you know?'), { target: { value: 'The label says Rosé Extra Brut.' } });
    expect(screen.getByText('Send suggestion')).toBeDisabled();

    fireEvent.click(within(colourGroup).getByRole('radio', { name: 'Rosé' }));
    fireEvent.click(screen.getByText('Send suggestion'));
    await waitFor(() => expect(createWineProposal).toHaveBeenCalledWith(expect.any(Function), {
      wineId: 'w-mm',
      fields: { colour: 'rosé' },
      reason: 'The label says Rosé Extra Brut.',
    }));
    // Pending on the Type row, in the words the reader will see once approved.
    expect(await screen.findByText('Sparkling rosé')).toBeInTheDocument();
    expect(screen.getByText('suggestion pending')).toBeInTheDocument();
  });

  test('retyping a still rosé as sparkling can carry its colour in the same suggestion', async () => {
    createWineProposal.mockResolvedValue(ok({ proposal: { _id: 'p2', status: 'pending' } }));
    renderSection({ wine: { ...WINE, type: 'rosé' } });
    await screen.findAllByText('not recorded');
    enterSuggestMode();
    fireEvent.click(screen.getByLabelText('Suggest a fix for Type'));
    await screen.findByText('Suggest a fix: Type');
    // A still type opens with nothing chosen and no colour question.
    expect(screen.queryByRole('radiogroup', { name: 'Colour' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Sparkling' }));
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Colour' })).getByRole('radio', { name: 'Rosé' }));
    fireEvent.change(screen.getByLabelText('How do you know?'), { target: { value: 'Metodo classico, Trento DOC.' } });
    fireEvent.click(screen.getByText('Send suggestion'));
    await waitFor(() => expect(createWineProposal).toHaveBeenCalledWith(expect.any(Function), {
      wineId: 'w1',
      fields: { type: 'sparkling', colour: 'rosé' },
      reason: 'Metodo classico, Trento DOC.',
    }));
  });

  test('choosing a type that is itself a colour drops the colour question and any choice in it', async () => {
    createWineProposal.mockResolvedValue(ok({ proposal: { _id: 'p3', status: 'pending' } }));
    renderSection({ wine: { ...SPARKLING, colour: 'rosé' } });
    await screen.findAllByText('not recorded');
    enterSuggestMode();
    fireEvent.click(screen.getByLabelText('Suggest a fix for Type'));
    await screen.findByText('Suggest a fix: Type');
    // "Rosé" is both a type and a colour here — the TYPE one.
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Should be' })).getByRole('radio', { name: 'Rosé' }));
    expect(screen.queryByRole('radiogroup', { name: 'Colour' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('How do you know?'), { target: { value: 'It is a still rosé, not a fizz.' } });
    fireEvent.click(screen.getByText('Send suggestion'));
    await waitFor(() => expect(createWineProposal).toHaveBeenCalledWith(expect.any(Function), {
      wineId: 'w-mm',
      fields: { type: 'rosé' },
      reason: 'It is a still rosé, not a fizz.',
    }));
  });

  test('my pending colour-only suggestion shows on the Type row', async () => {
    getMyWineProposals.mockResolvedValue(ok({
      proposals: [{ status: 'pending', proposedFields: { colour: 'rosé' } }],
      pending: { mine: true, fields: ['colour'] },
    }));
    renderSection({ wine: SPARKLING });
    expect(await screen.findByText('Sparkling rosé')).toBeInTheDocument();
    expect(screen.getByText('suggestion pending')).toBeInTheDocument();
  });
});
