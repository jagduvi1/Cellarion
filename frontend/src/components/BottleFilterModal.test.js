import { render, screen, fireEvent } from '@testing-library/react';
import BottleFilterModal from './BottleFilterModal';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, vars) => {
      const s = typeof fallback === 'string' ? fallback : key;
      return typeof vars === 'object' && vars ? s.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k]) : s;
    },
  }),
}));

const baseFilters = () => ({
  search: '', type: [], country: [], region: [], appellation: [], grapes: [], vintage: [],
  minRating: '', maxRating: '', maturity: [], unplaced: '', reserved: '', storage: '', sort: '-createdAt',
});

function renderModal(overrides = {}, props = {}) {
  const onApply = vi.fn();
  const filters = { ...baseFilters(), ...overrides };
  render(
    <BottleFilterModal
      filters={filters}
      onApply={onApply}
      onClose={() => {}}
      facets={{}}
      baseFacets={{}}
      facetMeta={{}}
      bottlesTotal={0}
      {...props}
    />
  );
  return { onApply, filters };
}

describe('BottleFilterModal — maturity multi-select', () => {
  test('renders one pill per bucket plus the "Needs attention" preset', () => {
    renderModal();
    for (const label of ['maturity.peak', 'maturity.early', 'maturity.late', 'maturity.declining', 'maturity.notReady', 'maturity.noData']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: /Needs attention/ })).toBeInTheDocument();
  });

  test('clicking a bucket ADDS it to the selection (OR), it does not replace the current one', () => {
    const { onApply } = renderModal({ maturity: ['late'] });
    fireEvent.click(screen.getByRole('button', { name: 'maturity.declining' }));
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ maturity: ['late', 'declining'] }));
  });

  test('clicking a selected bucket removes only that bucket', () => {
    const { onApply } = renderModal({ maturity: ['late', 'declining'] });
    fireEvent.click(screen.getByRole('button', { name: 'maturity.late' }));
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ maturity: ['declining'] }));
  });

  test('"Needs attention" selects late + declining together, and clears both when both are on', () => {
    const { onApply } = renderModal({ maturity: ['peak'] });
    fireEvent.click(screen.getByRole('button', { name: /Needs attention/ }));
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ maturity: ['peak', 'late', 'declining'] }));

    const second = renderModal({ maturity: ['peak', 'late', 'declining'] });
    fireEvent.click(screen.getAllByRole('button', { name: /Needs attention/ })[1]);
    expect(second.onApply).toHaveBeenCalledWith(expect.objectContaining({ maturity: ['peak'] }));
  });

  test('a legacy single-string maturity filter is treated as a one-bucket selection', () => {
    const { onApply } = renderModal({ maturity: 'late' });
    fireEvent.click(screen.getByRole('button', { name: 'maturity.declining' }));
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ maturity: ['late', 'declining'] }));
  });

  test('bucket counts from the cellar statistics render beside each pill, zeros included', () => {
    renderModal({}, { maturityCounts: { peak: 57, early: 86, late: 4, declining: 0, notReady: 12, noProfile: 0 } });
    expect(screen.getByRole('button', { name: 'maturity.late 4' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'maturity.declining 0' })).toBeInTheDocument();
    // The preset shows late + declining combined.
    expect(screen.getByRole('button', { name: /Needs attention.*4$/ })).toBeInTheDocument();
  });

  test('without statistics (cross-cellar scope) no counts are shown', () => {
    renderModal({}, { maturityCounts: null });
    expect(screen.getByRole('button', { name: 'maturity.late' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /maturity\.late \d/ })).not.toBeInTheDocument();
  });

  test('showRatingMaturity=false hides both the maturity and the rating controls', () => {
    renderModal({}, { showRatingMaturity: false });
    expect(screen.queryByRole('button', { name: /Needs attention/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('From')).not.toBeInTheDocument();
  });
});

describe('BottleFilterModal — rating range in the user scale', () => {
  test('typing 3.8 stars commits the NORMALISED bound on blur (one decimal survives)', () => {
    const { onApply } = renderModal({}, { ratingScale: '5' });
    const from = screen.getByLabelText('From');
    fireEvent.change(from, { target: { value: '3.8' } });
    expect(onApply).not.toHaveBeenCalled(); // local until blur
    fireEvent.blur(from);
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ minRating: '70' }));
  });

  test('Enter commits too, and the upper bound goes to maxRating', () => {
    const { onApply } = renderModal({}, { ratingScale: '5' });
    const to = screen.getByLabelText('To');
    fireEvent.change(to, { target: { value: '4' } });
    fireEvent.keyDown(to, { key: 'Enter' });
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ maxRating: '75' }));
  });

  test('a 100-point user types Parker points and the bound is normalised the same way', () => {
    const { onApply } = renderModal({}, { ratingScale: '100' });
    const from = screen.getByLabelText('From');
    fireEvent.change(from, { target: { value: '91' } });
    fireEvent.blur(from);
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ minRating: '75' }));
  });

  test('existing normalised bounds display back in the user scale', () => {
    renderModal({ minRating: '50', maxRating: '87.5' }, { ratingScale: '5' });
    expect(screen.getByLabelText('From')).toHaveValue(3);
    expect(screen.getByLabelText('To')).toHaveValue(4.5);
  });

  test('clearing a field removes that bound only', () => {
    const { onApply } = renderModal({ minRating: '50', maxRating: '75' }, { ratingScale: '5' });
    const from = screen.getByLabelText('From');
    fireEvent.change(from, { target: { value: '' } });
    fireEvent.blur(from);
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ minRating: '', maxRating: '75' }));
  });

  test('out-of-range input is clamped to the scale', () => {
    const { onApply } = renderModal({}, { ratingScale: '5' });
    const to = screen.getByLabelText('To');
    fireEvent.change(to, { target: { value: '9' } });
    fireEvent.blur(to);
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ maxRating: '100' }));
  });

  test('"Clear all" resets the range and the maturity selection', () => {
    const { onApply } = renderModal({ minRating: '50', maturity: ['late'] });
    fireEvent.click(screen.getByRole('button', { name: 'cellarDetail.clearAllFilters' }));
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ minRating: '', maxRating: '', maturity: [] }));
  });
});

// Support report 2026-10-16: with Red chosen, picking France showed France's
// whole-cellar count again, as if Red were off. A chosen field shows the
// server's counts (every OTHER filter applied); the whole cellar only lists
// the pills, so another country can still be added.
describe('BottleFilterModal — counts of a field with a choice made', () => {
  const pill = (label) => screen.getByRole('button', { name: new RegExp(`^${label}`) });

  test('a chosen country keeps counting under the other filters, and every country stays listed', () => {
    renderModal({ type: ['red'], country: ['fr'] }, {
      facets: { type: { red: 32, white: 9 }, countryName: { France: 32, Italy: 5 } },
      baseFacets: { type: { red: 70, white: 30 }, countryName: { France: 92, Italy: 40, Spain: 12 } },
      facetMeta: { countries: { France: 'fr', Italy: 'it', Spain: 'es' } },
    });
    expect(pill('France')).toHaveTextContent('France32');
    expect(pill('Italy')).toHaveTextContent('Italy5');
    // Listed from the whole cellar, with no red bottles: dimmed, no count.
    expect(pill('Spain')).toHaveClass('filter-pill--dimmed');
    expect(pill('Spain')).not.toHaveTextContent('12');
    // The type row counts under the country choice, not the whole cellar.
    expect(pill('Red')).toHaveTextContent('Red32');
  });
});

// A rack / storage filter: the server sends no counts. No numbers then, and
// nothing dimmed — never the previous request's counts.
test('without counts (null) the pills show no numbers and none is dimmed', () => {
  renderModal({ country: ['fr'] }, {
    facets: null,
    baseFacets: { countryName: { France: 92, Italy: 40 } },
    facetMeta: { countries: { France: 'fr', Italy: 'it' } },
  });
  const italy = screen.getByRole('button', { name: /^Italy/ });
  expect(italy).toHaveTextContent(/^Italy$/);
  expect(italy).not.toHaveClass('filter-pill--dimmed');
});

// The Sweetness section: the category each wine reads as, on one scale for
// still and sparkling wines. The server counts it like every other field.
describe('BottleFilterModal — sweetness', () => {
  const section = () => screen.getByRole('button', { name: /Sweetness/ });
  const pill = (label) => screen.getByRole('button', { name: new RegExp(`^${label}`) });
  const HELD = { dry: 40, sweet: 6, 'not-stated': 12, 'off-dry': 3 };

  test('the section lists the values the cellar holds, in scale order, the unstated ones last', () => {
    renderModal({}, { facets: { sweetnessCategory: HELD }, baseFacets: { sweetnessCategory: HELD } });
    // Closed until a value is chosen, like the other longer sections.
    expect(screen.queryByRole('button', { name: /^dry/ })).not.toBeInTheDocument();
    fireEvent.click(section());
    const labels = Array.from(section().closest('.bfm-section').querySelectorAll('.filter-pill')).map((b) => b.textContent);
    expect(labels).toEqual(['dry40', 'off-dry3', 'sweet6', 'Not stated12']);
  });

  test('a cellar that sends no sweetness counts has no section', () => {
    renderModal({}, { facets: { type: { red: 3 } }, baseFacets: { type: { red: 3 } } });
    expect(screen.queryByRole('button', { name: /Sweetness/ })).not.toBeInTheDocument();
  });

  test('a cellar where no wine reads as a category has no section: "Not stated" alone would list every wine', () => {
    const only = { 'not-stated': 12 };
    renderModal({}, { facets: { sweetnessCategory: only }, baseFacets: { sweetnessCategory: only } });
    expect(screen.queryByRole('button', { name: /Sweetness/ })).not.toBeInTheDocument();
  });

  test('choosing a value adds it to the ones already chosen', () => {
    const { onApply } = renderModal({ sweetnessCategory: ['dry'] }, { facets: { sweetnessCategory: HELD }, baseFacets: { sweetnessCategory: HELD } });
    fireEvent.click(pill('sweet'));
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ sweetnessCategory: ['dry', 'sweet'] }));
  });

  test('a chosen value shows from the start, counts under the other filters, and comes off again', () => {
    const { onApply } = renderModal({ sweetnessCategory: ['dry'], type: ['white'] }, {
      facets: { sweetnessCategory: { dry: 9, 'not-stated': 2 } }, baseFacets: { sweetnessCategory: HELD },
    });
    expect(pill('dry')).toHaveClass('filter-pill--selected');
    expect(pill('dry')).toHaveTextContent('dry9');
    // Held by the cellar, none under the other filter: dimmed, no number.
    expect(pill('sweet')).toHaveClass('filter-pill--dimmed');
    fireEvent.click(pill('dry'));
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ sweetnessCategory: [] }));
  });

  test('a value chosen on another page stays listed where this scope holds none of it, so it can be taken off', () => {
    renderModal({ sweetnessCategory: ['sweet'] }, { facets: { sweetnessCategory: {} }, baseFacets: { sweetnessCategory: { dry: 4 } } });
    expect(pill('sweet')).toHaveClass('filter-pill--selected');
  });

  test('"Clear all" clears it, and it counts as an active filter', () => {
    const { onApply } = renderModal({ sweetnessCategory: ['dry', 'sweet'] }, { baseFacets: { sweetnessCategory: HELD }, facets: { sweetnessCategory: HELD } });
    fireEvent.click(screen.getByRole('button', { name: 'cellarDetail.clearAllFilters' }));
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ sweetnessCategory: [] }));
  });
});
