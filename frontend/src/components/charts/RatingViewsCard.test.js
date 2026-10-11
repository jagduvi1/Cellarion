import { render, screen, fireEvent } from '@testing-library/react';

// The rating distribution three ways (support ticket 2026-10-11): "All" by
// default — someone who rates only when drinking sees their ratings at once
// — with "In the cellar" and "History" beside it. A band in either part opens
// the bottles behind it; "All" has no single list, so its bands are not links.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, a, b) => (typeof a === 'string' ? a : key) + (b?.count != null ? `:${b.count}` : (a && typeof a === 'object' && a.count != null ? `:${a.count}` : '')) }),
}));

const { default: RatingViewsCard } = await import('./RatingViewsCard');

const bands = (o) => ({ '0-20': 0, '21-40': 0, '41-60': 0, '61-80': 0, '81-100': 0, ...o });
const VIEWS = {
  all: { byRating: bands({ '61-80': 1, '81-100': 3 }), avg: 84, count: 4 },
  cellar: { byRating: bands({ '81-100': 1 }), avg: 90, count: 1 },
  history: { byRating: bands({ '61-80': 1, '81-100': 2 }), avg: 82, count: 3 },
};
const clickable = () => document.querySelectorAll('.rating-row--clickable');

test('"All" first: every rating at once, with each view\'s count, and no band links', () => {
  render(<RatingViewsCard views={VIEWS} targetScale="5" onBand={vi.fn()} />);
  const all = screen.getByRole('button', { name: /All/ });
  expect(all).toHaveAttribute('aria-pressed', 'true');
  expect(all).toHaveTextContent('4');
  expect(screen.getByRole('button', { name: /In the cellar/ })).toHaveTextContent('1');
  expect(screen.getByRole('button', { name: /History/ })).toHaveTextContent('3');
  expect(clickable()).toHaveLength(0);
  expect(document.querySelector('.rating-chart')).toHaveTextContent('statistics.rating.acrossBottles:4');
});

test('"History" and "In the cellar" show their part, and a band opens its bottles in that part', () => {
  const onBand = vi.fn();
  render(<RatingViewsCard views={VIEWS} targetScale="5" onBand={onBand} />);
  fireEvent.click(screen.getByRole('button', { name: /History/ }));
  expect(screen.getByRole('button', { name: /History/ })).toHaveAttribute('aria-pressed', 'true');
  expect(document.querySelector('.rating-chart')).toHaveTextContent('statistics.rating.acrossBottles:3');
  expect(clickable()).toHaveLength(2);
  fireEvent.click(clickable()[0]);
  expect(onBand).toHaveBeenLastCalledWith('history', expect.objectContaining({ key: expect.stringMatching(/^(61-80|81-100)$/) }));

  fireEvent.click(screen.getByRole('button', { name: /In the cellar/ }));
  expect(clickable()).toHaveLength(1);
  fireEvent.click(clickable()[0]);
  expect(onBand).toHaveBeenLastCalledWith('cellar', expect.objectContaining({ key: '81-100' }));
});

test('an answer from before the views: the cellar\'s distribution, no tabs', () => {
  render(<RatingViewsCard views={undefined} fallback={{ byRating: bands({ '41-60': 2 }), avg: 50 }} targetScale="5" onBand={vi.fn()} />);
  expect(screen.queryByRole('group')).toBeNull();
  expect(document.querySelector('.rating-chart')).toHaveTextContent('statistics.rating.acrossBottles:2');
  expect(clickable()).toHaveLength(1);
});
