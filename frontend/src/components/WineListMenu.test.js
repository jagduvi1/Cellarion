import { render, screen } from '@testing-library/react';
import WineListMenu from './WineListMenu';

const wine = (over = {}) => ({
  key: 'k1', name: 'Barolo Riserva', producer: 'Conterno', vintage: '2018', bottleSize: '750ml',
  region: 'Piedmont', grapes: ['Nebbiolo'], price: 95, glassPrice: null, byGlass: false, lastBottle: false,
  ...over,
});

describe('WineListMenu', () => {
  test('nested headings render as h2 › h3 › h4; wines sit under the deepest one', () => {
    render(<WineListMenu sections={[
      { title: 'Red Wines', level: 0, wines: [] },
      { title: 'Italy', level: 1, wines: [] },
      { title: 'Piedmont', level: 2, wines: [wine()] },
    ]} />);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Red Wines');
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('Italy');
    expect(screen.getByRole('heading', { level: 4 })).toHaveTextContent('Piedmont');
    expect(screen.getByText('$95')).toBeInTheDocument();
    // Headings without wines of their own render no list
    expect(screen.getAllByRole('list')).toHaveLength(1);
  });

  test('hidePrices drops every figure but keeps the by-the-glass word, in the list language', () => {
    render(<WineListMenu
      layout={{ hidePrices: true, currencySymbol: '€' }}
      language="fr"
      sections={[{ title: 'Blancs', level: 0, wines: [
        wine({ key: 'a', price: 40, byGlass: true, glassPrice: 9 }),
        wine({ key: 'b', name: 'Meursault', price: 80 }),
      ] }]}
    />);
    expect(screen.queryByText(/€/)).not.toBeInTheDocument();
    expect(screen.getByText('verre')).toBeInTheDocument();
  });

  test('the last-bottle badge follows the list language and only marked wines carry it', () => {
    render(<WineListMenu language="sv" sections={[{ title: 'Röda', level: 0, wines: [
      wine({ key: 'a', lastBottle: true }),
      wine({ key: 'b', name: 'Rioja' }),
    ] }]} />);
    expect(screen.getAllByText('Sista flaskan')).toHaveLength(1);
  });
});

describe('WineListMenu price symbol spacing (support ticket 2026-09-12)', () => {
  test('a lettered currency gets a space, a sign does not', () => {
    const { unmount } = render(<WineListMenu layout={{ currencySymbol: 'CHF' }} sections={[{ title: 'R', level: 0, wines: [wine({ price: 16, byGlass: true, glassPrice: 9 })] }]} />);
    expect(screen.getByText('CHF 16 / CHF 9 glass')).toBeInTheDocument();
    unmount();
    render(<WineListMenu layout={{ currencySymbol: '€' }} sections={[{ title: 'R', level: 0, wines: [wine({ price: 16 })] }]} />);
    expect(screen.getByText('€16')).toBeInTheDocument();
  });
});
