import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, vars) => {
      const s = typeof fallback === 'string' ? fallback : key;
      return vars ? s.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k]) : s;
    },
  }),
}));

const { default: GrapeTokenInput, searchGrapes, buildGrapeIndex, foldGrapeName } = await import('./GrapeTokenInput');

const OPTIONS = [
  { name: 'Cabernet Sauvignon', color: 'Red', synonyms: [], wineCount: 900 },
  { name: 'Cabernet Franc', color: 'Red', synonyms: ['Bouchet'], wineCount: 300 },
  { name: 'Cabernet Cortis', color: 'Red', synonyms: [], wineCount: 2 },
  { name: 'Sauvignon Blanc', color: 'White', synonyms: ['Fumé Blanc'], wineCount: 400 },
  { name: 'Syrah', color: 'Red', synonyms: ['Shiraz'], wineCount: 700 },
  { name: 'Tempranillo', color: 'Red', synonyms: ['Tinta Roriz', 'Aragonez'], wineCount: 500 },
  { name: 'Müller-Thurgau', color: 'White', synonyms: ['Rivaner'], wineCount: 40 },
];

// A host that owns `value`, as the record's form does.
function Host({ initial = [], onValue, ...props }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <label htmlFor="g">Grapes</label>
      <GrapeTokenInput
        inputId="g"
        options={OPTIONS}
        value={value}
        onChange={(next) => { setValue(next); onValue?.(next); }}
        {...props}
      />
    </>
  );
}

const box = () => screen.getByLabelText('Grapes');
const type = (text) => fireEvent.change(box(), { target: { value: text } });
const optionNames = () => screen.queryAllByRole('option').map((o) => o.textContent);

describe('searchGrapes', () => {
  const index = buildGrapeIndex(OPTIONS);
  const names = (q, taken = new Set()) => searchGrapes(index, q, taken).map((h) => h.grape.name);

  test('within a tier, the variety more wines use comes first', () => {
    expect(names('cab')).toEqual(['Cabernet Sauvignon', 'Cabernet Franc', 'Cabernet Cortis']);
  });

  test('the start of the name beats a word inside another name', () => {
    // "sauv" starts Sauvignon Blanc; it is only the second word of Cabernet Sauvignon.
    expect(names('sauv')).toEqual(['Sauvignon Blanc', 'Cabernet Sauvignon']);
  });

  test('several typed words each match the start of a word, in any order', () => {
    expect(names('cab sauv')).toEqual(['Cabernet Sauvignon']);
    expect(names('blanc sauv')).toEqual(['Sauvignon Blanc']);
  });

  // The server's own normalisation DELETES a hyphen ("mullerthurgau"), so a
  // search that mirrored it missed the way people actually type the name.
  test('diacritics do not matter, and a hyphenated name is found spaced, hyphenated or run together', () => {
    for (const q of ['muller thurgau', 'Müller-Thurgau', 'mullerthurgau', 'muller-thu']) {
      expect(names(q)).toEqual(['Müller-Thurgau']);
    }
    expect(names('fume')).toEqual(['Sauvignon Blanc']);
  });

  test('foldGrapeName treats those spellings as one variety', () => {
    expect(foldGrapeName('Muller Thurgau')).toBe(foldGrapeName('Müller-Thurgau'));
    expect(foldGrapeName('Syrah')).not.toBe(foldGrapeName('Shiraz'));
  });

  test('a synonym match reports the name it matched on', () => {
    const [hit] = searchGrapes(index, 'tinta', new Set());
    expect(hit.grape.name).toBe('Tempranillo');
    expect(hit.via).toBe('Tinta Roriz');
  });

  test('already-chosen varieties are not offered again, and an empty query offers nothing', () => {
    expect(names('cab', new Set([foldGrapeName('Cabernet Franc')]))).toEqual(['Cabernet Sauvignon', 'Cabernet Cortis']);
    expect(names('   ')).toEqual([]);
  });
});

describe('GrapeTokenInput', () => {
  test('nothing is listed until something is typed; the placeholder says how big the list is', () => {
    render(<Host />);
    expect(box()).toHaveAttribute('placeholder', 'Search 7 grape varieties…');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  test('clicking a match adds a chip and clears the search', () => {
    const onValue = vi.fn();
    render(<Host onValue={onValue} />);
    type('syr');
    fireEvent.click(screen.getByRole('option', { name: /Syrah/ }));
    expect(onValue).toHaveBeenLastCalledWith([{ name: 'Syrah' }]);
    expect(screen.getByLabelText('Remove Syrah')).toBeInTheDocument();
    expect(box()).toHaveValue('');
    expect(box()).toHaveAttribute('placeholder', 'Add another grape…');
  });

  test('arrow keys move the highlight and Enter picks it — without submitting the form around it', () => {
    const onSubmit = vi.fn((e) => e.preventDefault());
    const onValue = vi.fn();
    render(<form onSubmit={onSubmit}><Host onValue={onValue} /></form>);
    type('cab');
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: /Cabernet Franc/ })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onValue).toHaveBeenLastCalledWith([{ name: 'Cabernet Franc' }]);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('Backspace in an empty box removes the last chip; the × removes its own', () => {
    const onValue = vi.fn();
    render(<Host initial={[{ name: 'Syrah' }, { name: 'Tempranillo' }]} onValue={onValue} />);
    fireEvent.keyDown(box(), { key: 'Backspace' });
    expect(onValue).toHaveBeenLastCalledWith([{ name: 'Syrah' }]);
    fireEvent.click(screen.getByLabelText('Remove Syrah'));
    expect(onValue).toHaveBeenLastCalledWith([]);
  });

  test('the first Escape clears the search instead of reaching a modal behind it', () => {
    const onDocKey = vi.fn();
    document.addEventListener('keydown', onDocKey);
    render(<Host />);
    type('syr');
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(box()).toHaveValue('');
    expect(onDocKey).not.toHaveBeenCalled();
    // An empty box lets Escape through.
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(onDocKey).toHaveBeenCalledTimes(1);
    document.removeEventListener('keydown', onDocKey);
  });

  describe('a variety the list does not have', () => {
    test('is offered only with allowNew, and is marked as new when picked', () => {
      const onValue = vi.fn();
      const { unmount } = render(<Host onValue={onValue} />);
      type('Souvignier Gris');
      expect(optionNames()).toEqual([]);
      expect(screen.getByText('No variety matches “Souvignier Gris”.')).toBeInTheDocument();
      unmount();

      render(<Host allowNew onValue={onValue} />);
      type('  Souvignier   Gris ');
      fireEvent.click(screen.getByRole('option', { name: /Add “Souvignier Gris” as a new variety/ }));
      expect(onValue).toHaveBeenLastCalledWith([{ name: 'Souvignier Gris', isNew: true }]);
      expect(screen.getByText('new')).toBeInTheDocument();
    });

    test('is never offered for a name or synonym the list already has', () => {
      render(<Host allowNew />);
      type('shiraz');
      expect(optionNames().some((n) => /new variety/.test(n))).toBe(false);
      type('syrah');
      expect(optionNames().some((n) => /new variety/.test(n))).toBe(false);
    });

    test('is never offered for something that is not a name: a percentage, a sentence fragment, two letters', () => {
      render(<Host allowNew />);
      for (const junk of ['60% Merlot', 'Merlot & Cabernet', 'Xy']) {
        type(junk);
        expect(optionNames().some((n) => /new variety/.test(n))).toBe(false);
      }
    });

    // Next to real matches it is noise that invites junk: "sauv" is the start
    // of two varieties, not a third one (seen in the first visual smoke).
    test('is offered only when nothing matches at all', () => {
      render(<Host allowNew />);
      type('Cabernet');
      expect(optionNames().length).toBeGreaterThan(0);
      expect(optionNames().some((n) => /new variety/.test(n))).toBe(false);
      type('Cabernet Blanc');
      expect(optionNames()).toHaveLength(1);
      expect(optionNames()[0]).toMatch(/Add “Cabernet Blanc” as a new variety/);
    });
  });

  test('typing a synonym of a chosen variety explains itself instead of saying "no match"', () => {
    render(<Host allowNew initial={[{ name: 'Syrah' }]} />);
    type('Shiraz');
    expect(screen.getByText('“Shiraz” is Syrah, which is already in the list.')).toBeInTheDocument();
    expect(optionNames()).toEqual([]);
  });

  test('at the maximum the box closes and says why', () => {
    render(<Host max={2} initial={[{ name: 'Syrah' }, { name: 'Tempranillo' }]} />);
    expect(box()).toBeDisabled();
    expect(box()).toHaveAttribute('placeholder', 'That’s the maximum (2)');
  });

  test('while the list loads the box waits; a failed load offers a retry', () => {
    const onRetry = vi.fn();
    const { rerender } = render(<GrapeTokenInput inputId="g" options={null} value={[]} onChange={() => {}} />);
    expect(screen.getByRole('combobox')).toBeDisabled();
    expect(screen.getByRole('combobox')).toHaveAttribute('placeholder', 'Loading the grape list…');
    rerender(<GrapeTokenInput inputId="g" options={null} value={[]} onChange={() => {}} error onRetry={onRetry} />);
    fireEvent.click(screen.getByText('Try again'));
    expect(onRetry).toHaveBeenCalled();
  });
});

// ── Pre-deploy audit 2026-09-18 ─────────────────────────────────────────────
describe('audit 2026-09-18', () => {
  // `hits` leaves out what is already chosen, so with Syrah picked, "Syr" had no
  // hits — and was offered as a brand-new variety that would have passed the
  // server's name guard and reached the admin queue.
  test('a query matching only an already-chosen variety is not a new variety — and says which one', () => {
    render(<Host allowNew initial={[{ name: 'Syrah' }]} />);
    type('Syr');
    expect(optionNames()).toEqual([]);
    expect(screen.getByText('“Syrah” is already in the list.')).toBeInTheDocument();
  });

  // Holding Backspace to clear a typo keeps firing once the box is empty. In a
  // form whose list REPLACES the wine's, that took one recorded grape per repeat.
  test('a held Backspace stops at the empty box; a fresh press removes one chip', () => {
    const onValue = vi.fn();
    render(<Host initial={[{ name: 'Syrah' }, { name: 'Tempranillo' }]} onValue={onValue} />);
    fireEvent.keyDown(box(), { key: 'Backspace', repeat: true });
    fireEvent.keyDown(box(), { key: 'Backspace', repeat: true });
    expect(onValue).not.toHaveBeenCalled();
    fireEvent.keyDown(box(), { key: 'Backspace' });
    expect(onValue).toHaveBeenLastCalledWith([{ name: 'Syrah' }]);
  });

  test('"nothing to offer" is a status line a screen reader hears, and the box does not claim an open list', () => {
    render(<Host />);
    type('Xyzzy');
    expect(screen.getByRole('status')).toHaveTextContent('No variety matches “Xyzzy”.');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(box()).toHaveAttribute('aria-expanded', 'false');
    type('syr');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(box()).toHaveAttribute('aria-expanded', 'true');
  });
});
