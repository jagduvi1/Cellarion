/**
 * WinePicker's "Smart Search" must never write to the shared registry.
 *
 * It used to call identify-text, which minted a WineDefinition for whatever the
 * model guessed — from free-text dinner notes, with no confirmation step, for a
 * wine the user often doesn't own, fired before the journal entry was even
 * saved. identify-text is now read-only, and these tests pin the three shapes
 * it can return plus the failure path, which previously produced no feedback at
 * all (`if (res.ok)` with no else, and `catch { }`).
 */

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('../api/wines', () => ({ identifyWineByText: vi.fn() }));

// The debounced registry search must resolve to an EMPTY result set: that is
// what renders the no-results block carrying the Smart Search button.
const apiFetch = vi.fn(async () => ({ ok: true, json: async () => ({ bottles: [], wines: [] }) }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch: (...a) => apiFetch(...a) }) }));

// Stable `t` identity across renders (components list it in useCallback deps).
// `(k, f) => f || k` so both bare and fallback-bearing calls render something.
vi.mock('react-i18next', () => {
  const t = (key, fallback) => (typeof fallback === 'string' ? fallback : key);
  return { useTranslation: () => ({ t }) };
});

const { identifyWineByText } = await import('../api/wines');
const WinePicker = (await import('./WinePicker')).default;

const jsonRes = (body, ok = true) => ({ ok, json: async () => body });

beforeEach(() => {
  vi.clearAllMocks();
  apiFetch.mockResolvedValue({ ok: true, json: async () => ({ bottles: [], wines: [] }) });
});

async function setup() {
  const onChange = vi.fn();
  render(<WinePicker value={{ bottle: null, wine: null, wineName: '' }} onChange={onChange} />);
  // Type enough to trip the >=2 char search, then let the 300ms debounce fire
  // so the empty-result dropdown (and its Smart Search button) renders.
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'chateau xyz' } });
  await act(() => new Promise(r => setTimeout(r, 350)));
  return { onChange };
}

const clickSmartSearch = async () => {
  const btn = await screen.findByRole('button', { name: /smart search/i });
  fireEvent.click(btn);
};

describe('WinePicker Smart Search — read-only', () => {
  test('an identified-but-unmatched wine fills the name and passes wine: null', async () => {
    identifyWineByText.mockResolvedValue(jsonRes({
      identified: { name: 'Cuvée X', producer: 'Chateau XYZ', country: 'France' },
      match: null,
      candidates: [],
      reason: null,
    }));

    const { onChange } = await setup();
    await clickSmartSearch();

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ wine: null, wineName: 'Chateau XYZ Cuvée X' })
      );
    });
    // and it says so, rather than implying the wine was added
    expect(screen.getByText(/not in the wine register/i)).toBeInTheDocument();
  });

  test('a matched registry wine still passes its _id', async () => {
    identifyWineByText.mockResolvedValue(jsonRes({
      identified: { name: 'Cuvée X', producer: 'Chateau XYZ' },
      match: { wine: { _id: 'w42', name: 'Cuvée X', producer: 'Chateau XYZ' } },
      candidates: [],
      reason: null,
    }));

    const { onChange } = await setup();
    await clickSmartSearch();

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ wine: 'w42', wineName: 'Cuvée X' })
      );
    });
  });

  test('candidates render as register options and picking one passes that _id', async () => {
    identifyWineByText.mockResolvedValue(jsonRes({
      identified: { name: 'Cuvée X', producer: 'Chateau XYZ' },
      match: null,
      candidates: [{ wine: { _id: 'w7', name: 'Cuvee X', producer: 'Ch. XYZ' }, score: 0.9 }],
      reason: null,
    }));

    const { onChange } = await setup();
    await clickSmartSearch();

    const option = await screen.findByText('Cuvee X');
    fireEvent.click(option.closest('button'));

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ wine: 'w7', wineName: 'Cuvee X' })
    );
  });

  test('a failed lookup shows an error instead of silently doing nothing', async () => {
    identifyWineByText.mockResolvedValue(jsonRes({ error: 'nope' }, false));

    const { onChange } = await setup();
    await clickSmartSearch();

    expect(await screen.findByText(/unavailable right now/i)).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalledWith(expect.objectContaining({ wine: expect.any(String) }));
  });

  test('a model that identifies nothing is reported, not swallowed', async () => {
    identifyWineByText.mockResolvedValue(jsonRes({
      identified: null, match: null, candidates: [], reason: 'ai_unknown: no idea',
    }));

    await setup();
    await clickSmartSearch();

    expect(await screen.findByText(/couldn't identify that wine/i)).toBeInTheDocument();
  });
});
