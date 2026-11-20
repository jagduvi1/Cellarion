import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CellarMaturityTable from './CellarMaturityTable';

// Maturity per cellar, side by side, so a cellar with many bottles past their
// best is easy to spot. Most in need first; a count opens that cellar's
// bottles in that phase, a zero is plain text.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k, o) => (o?.cellar ? `${o.phase} in ${o.cellar}: ${o.count}` : k) }),
}));

const phases = (o = {}) => ({ declining: 0, late: 0, peak: 0, early: 0, notReady: 0, noProfile: 0, ...o });
const cellar = (id, name, maturity, regretIndex = 0) => ({ id, name, bottleCount: 10, value: 0, uniqueWines: 5, maturity, regretIndex });

const HOUSE = cellar('cA', 'House', phases({ peak: 6, early: 3, noProfile: 1 }));
const STORE = cellar('cB', 'Storage unit', phases({ declining: 4, late: 2, notReady: 1, noProfile: 3 }), 57);

const renderTable = (cellars) => render(<MemoryRouter><CellarMaturityTable cellars={cellars} /></MemoryRouter>);
const bodyRows = () => within(screen.getByRole('table')).getAllByRole('row').slice(1);
const rowNames = () => bodyRows().map((r) => within(r).getByRole('rowheader').textContent);

test('hidden with one cellar: the Maturity Status chart already covers it', () => {
  const { container } = renderTable([HOUSE]);
  expect(container).toBeEmptyDOMElement();
});

test('hidden when the cellars carry no maturity (an answer from an older server)', () => {
  const { container } = renderTable([{ id: 'cA', name: 'House', bottleCount: 3 }, { id: 'cB', name: 'Storage unit', bottleCount: 2 }]);
  expect(container).toBeEmptyDOMElement();
});

test('shown with two cellars: one row each, a column per phase and the Regret Index', () => {
  renderTable([HOUSE, STORE]);
  expect(screen.getByRole('heading', { name: /statistics\.sections\.maturityByCellar/ })).toBeInTheDocument();
  const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
  expect(headers).toEqual([
    'statistics.maturityByCellar.cellar',
    'statistics.maturityPhases.declining',
    'statistics.maturityPhases.late',
    'statistics.maturityPhases.peak',
    'statistics.maturityPhases.early',
    'statistics.maturityPhases.notReady',
    'statistics.maturityPhases.noProfile',
    'statistics.sections.regretIndex',
  ]);
  expect(bodyRows()).toHaveLength(2);
  const store = bodyRows().find((r) => within(r).queryByText('Storage unit'));
  expect(within(store).getAllByRole('cell').map((c) => c.textContent)).toEqual(['4', '2', '0', '0', '1', '3', '57%']);
});

test('most declining first, then most late; ties keep the given order (most bottles first)', () => {
  renderTable([
    cellar('c1', 'Late only', phases({ late: 5 })),
    cellar('c2', 'Two declining', phases({ declining: 2 })),
    cellar('c3', 'Two declining, three late', phases({ declining: 2, late: 3 })),
    cellar('c4', 'Late only too', phases({ late: 5 })),
    cellar('c5', 'All fine', phases({ peak: 9 })),
  ]);
  expect(rowNames()).toEqual(['Two declining, three late', 'Two declining', 'Late only', 'Late only too', 'All fine']);
});

test('the cellar name links to the cellar', () => {
  renderTable([HOUSE, STORE]);
  expect(screen.getByRole('link', { name: 'Storage unit' })).toHaveAttribute('href', '/cellars/cB');
  expect(screen.getByRole('link', { name: 'House' })).toHaveAttribute('href', '/cellars/cA');
});

test("a count links to that cellar's bottles in that phase, through the cellar page's maturity filter", () => {
  renderTable([HOUSE, STORE]);
  const link = (name) => screen.getByRole('link', { name });
  expect(link('statistics.maturityPhases.declining in Storage unit: 4')).toHaveAttribute('href', '/cellars/cB?maturity=declining');
  expect(link('statistics.maturityPhases.late in Storage unit: 2')).toHaveAttribute('href', '/cellars/cB?maturity=late');
  expect(link('statistics.maturityPhases.notReady in Storage unit: 1')).toHaveAttribute('href', '/cellars/cB?maturity=not-ready');
  expect(link('statistics.maturityPhases.noProfile in Storage unit: 3')).toHaveAttribute('href', '/cellars/cB?maturity=none');
  expect(link('statistics.maturityPhases.peak in House: 6')).toHaveAttribute('href', '/cellars/cA?maturity=peak');
  // A cellar's own list, not every owned cellar: no ?scope=owned.
  for (const a of screen.getAllByRole('link')) expect(a.getAttribute('href')).not.toContain('scope');
});

test('zero counts are plain text, never links', () => {
  renderTable([HOUSE, STORE]);
  const house = bodyRows().find((r) => within(r).queryByText('House'));
  // The name plus the three non-zero phases: peak, early, no data.
  expect(within(house).getAllByRole('link')).toHaveLength(4);
  const zeros = within(house).getAllByRole('cell').filter((c) => c.textContent === '0');
  expect(zeros).toHaveLength(3);
  for (const z of zeros) expect(within(z).queryByRole('link')).toBeNull();
  expect(within(house).getAllByRole('cell').at(-1)).toHaveTextContent('0%');
});

test('a cellar without an id renders as text, never a link to undefined', () => {
  const { container } = renderTable([HOUSE, { ...STORE, id: undefined }]);
  const store = bodyRows().find((r) => within(r).queryByText('Storage unit'));
  expect(within(store).queryByRole('link')).toBeNull();
  expect(container.innerHTML).not.toContain('undefined');
});
