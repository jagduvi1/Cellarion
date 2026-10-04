import { render, screen } from '@testing-library/react';
import BottleJourney from './BottleJourney';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, opts) => {
      if (key === 'history.journey.title') return 'History';
      if (key === 'history.journey.added') return `Added to ${opts.cellar}`;
      if (key === 'history.journey.moved') return `Moved to ${opts.cellar}`;
      if (key === 'history.reasonDrank') return 'Drank';
      return key;
    },
  }),
}));

describe('BottleJourney', () => {
  test('renders the added → moved timeline from cellarHistory', () => {
    const bottle = {
      status: 'active',
      cellarHistory: [
        { cellarName: 'Cellar A', enteredAt: '2026-01-02' },
        { cellarName: 'Cellar B', enteredAt: '2026-03-05' },
      ],
    };
    render(<BottleJourney bottle={bottle} />);
    expect(screen.getByText('Added to Cellar A')).toBeInTheDocument();
    expect(screen.getByText('Moved to Cellar B')).toBeInTheDocument();
  });

  test('appends a consumed entry for history bottles', () => {
    const bottle = {
      status: 'drank', consumedReason: 'drank', consumedAt: '2026-06-01',
      cellarHistory: [{ cellarName: 'Cellar A', enteredAt: '2026-01-02' }],
    };
    render(<BottleJourney bottle={bottle} />);
    expect(screen.getByText('Added to Cellar A')).toBeInTheDocument();
    expect(screen.getByText('Drank')).toBeInTheDocument();
  });

  test('falls back to a single added entry when history is empty', () => {
    const bottle = { status: 'active', cellarHistory: [], createdAt: '2026-01-02', cellar: { name: 'Cellar X' } };
    render(<BottleJourney bottle={bottle} />);
    expect(screen.getByText('Added to Cellar X')).toBeInTheDocument();
  });

  test('renders nothing without a bottle', () => {
    const { container } = render(<BottleJourney bottle={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  test('a bottle still on order ends with an "on order" step, not a consumed one', () => {
    render(<BottleJourney bottle={{
      status: 'ordered', expectedArrival: null,
      cellarHistory: [{ cellarName: 'Cellar A', enteredAt: '2026-01-02' }],
    }} />);
    expect(screen.getByText('history.journey.onOrder')).toBeInTheDocument();
    expect(screen.queryByText('Drank')).toBeNull();
  });

  test('an arrived bottle shows the arrival in date order with its moves', () => {
    render(<BottleJourney bottle={{
      status: 'active', arrivedAt: '2026-04-01',
      cellarHistory: [
        { cellarName: 'Cellar A', enteredAt: '2026-01-02' },
        { cellarName: 'Cellar B', enteredAt: '2026-05-05' },
      ],
    }} />);
    const texts = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(texts[0]).toMatch(/Added to Cellar A/);
    expect(texts[1]).toMatch(/history.journey.arrived/);
    expect(texts[2]).toMatch(/Moved to Cellar B/);
  });
});
