import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useState } from 'react';

/**
 * Custom fields on the add-bottle form (user ticket 6ab05cca).
 *
 * The payload builder carries most of the risk: it decides what the bottle
 * POST writes, and a wrong level or a stale type silently files the number
 * in the wrong place — on one bottle instead of the vintage, or under a
 * second key with the same name, which is exactly the fragmentation this
 * feature exists to stop (seven users had minted their own "ABV" key).
 */

vi.mock('../../api/personalData', () => ({ getPersonalDataKeys: vi.fn() }));
vi.mock('../../api/registryData', () => ({
  getRegistryKeys: vi.fn(),
  getWinePublicData: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, vars) => {
      const s = typeof fallback === 'string' ? fallback : key;
      return vars ? s.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k]) : s;
    },
  }),
}));

const { getPersonalDataKeys } = await import('../../api/personalData');
const { getRegistryKeys, getWinePublicData } = await import('../../api/registryData');
const mod = await import('./AddBottleCustomFields');
const AddBottleCustomFields = mod.default;
const { buildPersonalDataPayload } = mod;

const ok = (body) => ({ ok: true, json: async () => body });

const ABV_KEY = { _id: 'rk1', name: 'ABV', type: 'decimal', unit: '%', enumOptions: null };
const SAVED_CORK = { _id: 'pk1', name: 'Cork', type: 'text', unit: null, enumOptions: null };

beforeEach(() => {
  vi.clearAllMocks();
  getPersonalDataKeys.mockResolvedValue(ok({ keys: [] }));
  getRegistryKeys.mockResolvedValue(ok({ keys: [] }));
  getWinePublicData.mockResolvedValue(ok({ fields: [] }));
});

describe('buildPersonalDataPayload', () => {
  test('a registry-named field goes out as a vintage-scoped WINE entry', () => {
    const rows = [{ keyName: 'ABV', keyType: 'decimal', unit: '%', value: '13.5', level: 'wine-vintage' }];

    expect(buildPersonalDataPayload(rows, [], { hasVintage: true })).toEqual([
      {
        level: 'wine',
        vintageScoped: true,
        value: '13.5',
        newKey: { name: 'ABV', type: 'decimal', unit: '%' },
      },
    ]);
  });

  test('without a vintage the scope degrades to the wine, rather than costing the field', () => {
    // The service rejects a vintage scope the bottle cannot satisfy, and
    // losing the number the user typed is the worse outcome.
    const rows = [{ keyName: 'ABV', keyType: 'decimal', unit: '%', value: '13.5', level: 'wine-vintage' }];
    const [out] = buildPersonalDataPayload(rows, [], { hasVintage: false });

    expect(out.level).toBe('wine');
    expect(out.vintageScoped).toBeUndefined();
  });

  test('a name the user already owns rides its key id, not a second definition', () => {
    const rows = [{ keyName: '  cork ', keyType: 'decimal', value: 'sound', level: 'bottle' }];
    const [out] = buildPersonalDataPayload(rows, [SAVED_CORK], { hasVintage: true });

    expect(out).toEqual({ level: 'bottle', value: 'sound', keyId: 'pk1' });
    // The stored type wins over whatever the row happens to carry.
    expect(out.newKey).toBeUndefined();
  });

  test('a blank name or a blank value is dropped, never sent half-built', () => {
    const rows = [
      { keyName: '', keyType: 'text', value: 'orphan', level: 'bottle' },
      { keyName: 'Cork', keyType: 'text', value: '   ', level: 'bottle' },
      { keyName: 'Provenance', keyType: 'text', value: 'ex-cellar', level: 'bottle' },
    ];

    expect(buildPersonalDataPayload(rows, [], { hasVintage: true })).toHaveLength(1);
  });

  test('a boolean row is coerced; enum options are split', () => {
    const rows = [
      { keyName: 'Opened', keyType: 'boolean', value: 'true', level: 'bottle' },
      { keyName: 'Fill', keyType: 'enum', enumOptions: 'high, mid , low', value: 'high', level: 'bottle' },
    ];
    const [bool, en] = buildPersonalDataPayload(rows, [], { hasVintage: true });

    expect(bool.value).toBe(true);
    expect(en.newKey.enumOptions).toEqual(['high', 'mid', 'low']);
  });
});

/** A host that owns the rows, as AddBottle does. */
function Host({ wineId, vintage }) {
  const [rows, setRows] = useState([]);
  return (
    <AddBottleCustomFields
      apiFetch={vi.fn()}
      wineId={wineId}
      vintage={vintage}
      rows={rows}
      onChange={setRows}
    />
  );
}

describe('AddBottleCustomFields', () => {
  test('a registry chip seeds a row with the canonical name, type and unit', async () => {
    getRegistryKeys.mockResolvedValue(ok({ keys: [ABV_KEY] }));
    render(<Host vintage="2019" />);

    const chip = await screen.findByRole('button', { name: '+ ABV' });
    fireEvent.click(chip);

    expect(screen.getByLabelText('Field name')).toHaveValue('ABV');
    // decimal → a number input, and the unit rides along from the registry.
    expect(screen.getByText('%')).toBeInTheDocument();
    // ABV is a fact about the bottling: the vintage is the default scope.
    expect(screen.getByLabelText('Applies to')).toHaveValue('wine-vintage');
  });

  test('with no vintage there is no vintage option to default to', async () => {
    getRegistryKeys.mockResolvedValue(ok({ keys: [ABV_KEY] }));
    render(<Host />);

    fireEvent.click(await screen.findByRole('button', { name: '+ ABV' }));

    expect(screen.getByLabelText('Applies to')).toHaveValue('wine');
    expect(screen.queryByRole('option', { name: /Every bottle of this vintage/ })).not.toBeInTheDocument();
  });

  test('a value the registry already publishes is shown, and its chip withdrawn', async () => {
    getRegistryKeys.mockResolvedValue(ok({ keys: [ABV_KEY] }));
    getWinePublicData.mockResolvedValue(ok({
      fields: [{ key: ABV_KEY, value: 13.5, resolvedFrom: 'vintage' }],
    }));

    render(<Host wineId="w1" vintage="2019" />);

    // Nobody should retype a figure the wine record already carries — and it
    // reads with the key's own casing, not the lower-cased lookup slug.
    await waitFor(() => expect(screen.getByText('ABV')).toBeInTheDocument());
    expect(screen.getByText('13.5 %')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ ABV' })).not.toBeInTheDocument();
  });

  test('a blank row never blocks the page form — the value input is not required', async () => {
    // These rows live inside AddBottle's <form>: a `required` on an empty one
    // stops the whole add behind a native bubble with no in-app error.
    render(<Host vintage="2019" />);

    fireEvent.click(await screen.findByRole('button', { name: '+ Add a field' }));

    expect(screen.getByLabelText('Field name')).not.toBeRequired();
    expect(screen.getByLabelText('Field name')).toBeValid();
  });

  test('a value with no name asks for the name instead of dropping it in silence', async () => {
    render(<Host vintage="2019" />);

    fireEvent.click(await screen.findByRole('button', { name: '+ Add a field' }));
    const name = screen.getByLabelText('Field name');
    expect(name).not.toBeRequired();

    // buildPersonalDataPayload drops a nameless row, so ask for the name here.
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: '13.5' } });
    await waitFor(() => expect(name).toBeRequired());
  });

  test('clearing the vintage reads as the wine-wide entry the payload will send', async () => {
    getRegistryKeys.mockResolvedValue(ok({ keys: [ABV_KEY] }));
    const { rerender } = render(<Host vintage="2019" />);

    fireEvent.click(await screen.findByRole('button', { name: '+ ABV' }));
    expect(screen.getByLabelText('Applies to')).toHaveValue('wine-vintage');

    // The select must not go blank on a scope the bottle can no longer
    // satisfy — it shows what will actually be sent.
    rerender(<Host vintage="" />);
    expect(screen.getByLabelText('Applies to')).toHaveValue('wine');
  });

  test('the mint-at-commit path reads no published data — there is no wine yet', async () => {
    render(<Host vintage="2019" />);

    await screen.findByRole('button', { name: '+ Add a field' });
    expect(getWinePublicData).not.toHaveBeenCalled();
  });

  test('a saved key offers a chip and locks the type it already has', async () => {
    getPersonalDataKeys.mockResolvedValue(ok({ keys: [SAVED_CORK] }));
    render(<Host vintage="2019" />);

    fireEvent.click(await screen.findByRole('button', { name: '+ Cork' }));

    // A matched key keeps its stored type, so no type selector is offered.
    expect(screen.queryByLabelText('Value type')).not.toBeInTheDocument();
  });

  test('a row can be removed', async () => {
    render(<Host vintage="2019" />);

    fireEvent.click(await screen.findByRole('button', { name: '+ Add a field' }));
    expect(screen.getByLabelText('Field name')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove field' }));
    expect(screen.queryByLabelText('Field name')).not.toBeInTheDocument();
  });

  test('a failed vocabulary load leaves the form usable by hand', async () => {
    getPersonalDataKeys.mockRejectedValue(new Error('offline'));
    getRegistryKeys.mockRejectedValue(new Error('offline'));

    render(<Host vintage="2019" />);

    fireEvent.click(await screen.findByRole('button', { name: '+ Add a field' }));
    fireEvent.change(screen.getByLabelText('Field name'), { target: { value: 'ABV' } });
    expect(screen.getByLabelText('Field name')).toHaveValue('ABV');
  });
});
