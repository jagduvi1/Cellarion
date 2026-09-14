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
      // The stored text fallback is producer-first, like the AI-identified label.
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ wine: 'w42', wineName: 'Chateau XYZ Cuvée X' })
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
      expect.objectContaining({ wine: 'w7', wineName: 'Ch. XYZ Cuvee X' })
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

describe('drunk bottles are pickable, and the stored text carries the producer, not the vintage (chfish ticket 6aa6c200)', () => {
  const JERMANN = { _id: 'w1', name: 'Sauvignon', producer: 'Jermann', type: 'white' };

  test('the dropdown shows a "Recently drunk" section and picking from it passes the bottle + wine ids', async () => {
    apiFetch.mockResolvedValue(jsonRes({
      bottles: [],
      consumed: [{ _id: 'b-drunk', vintage: '2024', status: 'drank', consumedAt: '2026-09-06T00:00:00.000Z', wine: JERMANN }],
      wines: [JERMANN],
    }));
    const { onChange } = await setup();

    expect(screen.getByText('Recently drunk')).toBeInTheDocument();
    fireEvent.click(screen.getAllByText('Sauvignon')[0].closest('button'));

    // The vintage rides beside the reference so the entry keeps its year if the bottle is later deleted.
    expect(onChange).toHaveBeenLastCalledWith({ bottle: 'b-drunk', wine: 'w1', wineName: 'Jermann Sauvignon', vintage: '2024' });
    // The input shows name + vintage; the stored fallback text never embeds the year.
    expect(screen.getByRole('textbox')).toHaveValue('Sauvignon 2024');
  });

  test('an active bottle stores the same producer-first fallback, and a register wine too', async () => {
    apiFetch.mockResolvedValue(jsonRes({
      bottles: [{ _id: 'b-active', vintage: '2021', wine: { _id: 'w2', name: 'Fabelhaft Tinto', producer: 'Niepoort' } }],
      wines: [{ _id: 'w3', name: 'Brut', producer: 'Nicolas Feuillatte' }],
    }));
    const { onChange } = await setup();

    fireEvent.click(screen.getByText('Fabelhaft Tinto').closest('button'));
    expect(onChange).toHaveBeenLastCalledWith({ bottle: 'b-active', wine: 'w2', wineName: 'Niepoort Fabelhaft Tinto', vintage: '2021' });
  });

  test('a response without a consumed list (older server) still renders', async () => {
    apiFetch.mockResolvedValue(jsonRes({ bottles: [], wines: [JERMANN] }));
    await setup();
    expect(screen.getByText('Wine register')).toBeInTheDocument();
    expect(screen.queryByText('Recently drunk')).not.toBeInTheDocument();
  });
});
