import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import OpenNowStrip from './OpenNowStrip';

// "Open now" on the cellar page: the open bottles in view, each leading to
// its page (where it is finished and rated) with the way back to this list.
// Nothing at all while no bottle is open.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k, a, b) => {
      const vars = b && typeof b === 'object' ? b : (a && typeof a === 'object' ? a : undefined);
      return vars ? `${k}:${JSON.stringify(vars)}` : k;
    },
    i18n: { language: 'en-GB' },
  }),
}));

// The name helper's module (BottleUndoNotice) reaches the auth context.
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({}) }));

const DAY = 86400000;
const open = (over = {}) => ({
  _id: 'b1', cellar: 'c1', vintage: '2016', bottleSize: '750ml', preservationMethod: 'vacuum',
  openedAt: new Date(Date.now() - DAY).toISOString(), pours: [{ ml: 125 }, { ml: 125 }],
  wineDefinition: { _id: 'w1', name: 'Barolo' },
  ...over,
});

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname}|{JSON.stringify(loc.state)}</div>;
}
const renderStrip = (bottles) => render(
  <MemoryRouter initialEntries={['/cellars/c1']}>
    <Routes>
      <Route path="/cellars/:id" element={<OpenNowStrip bottles={bottles} />} />
      <Route path="/cellars/:id/bottles/:bottleId" element={<Where />} />
    </Routes>
  </MemoryRouter>,
);

test('no open bottle: nothing is shown', () => {
  const { container } = renderStrip([]);
  expect(container).toBeEmptyDOMElement();
});

test('each open bottle shows what is left and leads to its page, with the way back here', () => {
  renderStrip([open(), open({ _id: 'b2', cellar: 'c2', cellarName: 'Summer house', vintage: 'NV', wineDefinition: { name: 'Cava' } })]);
  expect(screen.getByRole('heading', { name: /openNow\.title/ })).toBeInTheDocument();

  const barolo = screen.getByRole('link', { name: /Barolo 2016/ });
  expect(barolo).toHaveTextContent('"glasses":4'); // 750 ml less two glasses ≈ 4
  // Opened yesterday with a vacuum stopper (4 days): 3 days left → "soon".
  expect(barolo).toHaveClass('open-now-item--soon');
  // A bottle of another cellar (an "all my cellars" view) says which.
  expect(screen.getByRole('link', { name: /Cava/ })).toHaveTextContent('Summer house');

  fireEvent.click(barolo);
  expect(screen.getByTestId('where').textContent).toBe('/cellars/c1/bottles/b1|{"backTo":"/cellars/c1","backFrom":"cellar"}');
});

test('a bottle past its window says to drink it now', () => {
  renderStrip([open({ preservationMethod: 'recorked', openedAt: new Date(Date.now() - 5 * DAY).toISOString() })]);
  const link = screen.getByRole('link', { name: /Barolo 2016/ });
  expect(link).toHaveClass('open-now-item--past');
  expect(link).toHaveTextContent('openBottle.pastWindow');
});
