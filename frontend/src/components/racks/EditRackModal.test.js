import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => {
  const t = (key, fallback) => (typeof fallback === 'string' ? fallback : key);
  return { useTranslation: () => ({ t }) };
});
vi.mock('../../utils/featureFlags', () => ({ useFeature: () => true }));
vi.mock('../BetaBadge', () => ({ default: () => null }));

const EditRackModal = (await import('./EditRackModal')).default;

const cabinet = (typeConfig) => ({ _id: 'r1', name: 'Fridge', type: 'cabinet', rows: 3, cols: 5, typeConfig, slots: [] });
const twoDeepBox = () => screen.getByLabelText('Two deep (neck to neck)');

// Release audit 2026-10-14: on a stacked one-deep shelf with a bottle across
// the front, two deep decides how many bottles the levels above hold — the
// box stays as created, like on a cabinet whose rows alternate.
test('Two deep is locked where a stacked shelf has a bottle across the front, and says why', () => {
  render(<EditRackModal rack={cabinet({ shelfRows: [2, 1, 1], twoDeep: false, shelfSideways: ['front', '', ''] })} onSave={vi.fn()} onClose={vi.fn()} />);
  expect(twoDeepBox()).toBeDisabled();
  expect(screen.getByText(/with a bottle lying across the front of a stacked shelf/)).toBeInTheDocument();
});

test('a bottle across a one-row shelf leaves Two deep free', () => {
  render(<EditRackModal rack={cabinet({ shelfRows: [1, 1, 1], twoDeep: false, shelfSideways: ['front', '', ''] })} onSave={vi.fn()} onClose={vi.fn()} />);
  expect(twoDeepBox()).not.toBeDisabled();
  expect(screen.queryByText(/with a bottle lying across the front of a stacked shelf/)).toBeNull();
});
