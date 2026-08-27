import { render, screen, fireEvent } from '@testing-library/react';
import CellarCredBadge from './CellarCredBadge';

// Identity stub: labels render as their keys, keeping assertions locale-free.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k) => k, i18n: { language: 'en' } }),
}));

describe('CellarCredBadge', () => {
  test('newcomer on the free plan renders nothing', () => {
    const { container } = render(<CellarCredBadge tier="newcomer" plan="free" />);
    expect(container).toBeEmptyDOMElement();
  });

  test('cred chip carries tier and specialty in one accessible label', () => {
    render(<CellarCredBadge tier="contributor" specialty="photographer" />);
    const chip = screen.getByRole('button', {
      name: 'cellarCred.contributor · cellarCred.photographer',
    });
    expect(chip).toBeInTheDocument();
    // Both icons render; the visible text is decorative (aria-hidden) because
    // the button's aria-label already says everything.
    expect(chip.querySelectorAll('.cred-badge__icon')).toHaveLength(2);
    expect(chip.querySelector('.cred-badge__label')).toHaveAttribute('aria-hidden', 'true');
  });

  test.each([
    ['supporter', '❤️'],
    ['patron', '🥂'],
    ['benefactor', '🍾'],
  ])('paid plan %s renders its own chip with the %s icon', (plan, icon) => {
    render(<CellarCredBadge plan={plan} />);
    const chip = screen.getByRole('button', { name: `cellarCred.plan_${plan}` });
    expect(chip).toHaveTextContent(icon);
  });

  test('an unknown or free plan adds no supporter chip next to the cred chip', () => {
    render(<CellarCredBadge tier="ambassador" plan="free" />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  test('cred and supporter chips render side by side', () => {
    render(<CellarCredBadge tier="enthusiast" plan="patron" />);
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  test('tap toggles the label open and closed; blur closes it', () => {
    render(<CellarCredBadge plan="supporter" />);
    const chip = screen.getByRole('button');
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    expect(chip.className).toContain('is-open');
    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(chip);
    fireEvent.blur(chip);
    expect(chip).toHaveAttribute('aria-expanded', 'false');
  });

  test('showSpecialty=false keeps the tier label alone', () => {
    render(<CellarCredBadge tier="connoisseur" specialty="critic" showSpecialty={false} />);
    expect(screen.getByRole('button', { name: 'cellarCred.connoisseur' })).toBeInTheDocument();
  });
});
