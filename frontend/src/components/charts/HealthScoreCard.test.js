import { render, screen, fireEvent } from '@testing-library/react';
import HealthScoreCard from './HealthScoreCard';

// The phase counts beside the health score lead to the Maturity Status
// section: one real button, reachable by keyboard, named by its counts and
// where it goes.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k, o) => (o?.section ? `Go to ${o.section}` : k) }),
}));

const MATURITY = { declining: 1, late: 2, peak: 5, early: 3, notReady: 0, noProfile: 4 };

test('the phase counts are one focusable button named by its counts and its destination', () => {
  const onShowMaturity = vi.fn();
  render(<HealthScoreCard healthScore={80} healthGrade="B" maturity={MATURITY} onShowMaturity={onShowMaturity} />);
  const button = screen.getByRole('button', { name: /Go to statistics\.sections\.maturityStatus/ });
  expect(screen.getAllByRole('button')).toHaveLength(1);
  expect(button).toHaveAccessibleName(/statistics\.maturityPhases\.peak\s*5/);
  expect(button).toHaveAccessibleName(/statistics\.maturityPhases\.declining\s*1/);
  expect(button).toHaveAttribute('type', 'button');
  button.focus();
  expect(button).toHaveFocus();
  fireEvent.click(button);
  expect(onShowMaturity).toHaveBeenCalledTimes(1);
});

test('without a destination the counts are plain text', () => {
  render(<HealthScoreCard healthScore={80} healthGrade="B" maturity={MATURITY} />);
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.getByText('statistics.maturityPhases.peak').closest('.health-row')).toHaveTextContent('5');
});

test('no score yet: the gauge says so through the translation', () => {
  render(<HealthScoreCard healthScore={null} healthGrade={null} maturity={{ ...MATURITY, declining: 0, late: 0, peak: 0, early: 0 }} />);
  expect(screen.getByText('statistics.healthNoScore')).toBeInTheDocument();
});
