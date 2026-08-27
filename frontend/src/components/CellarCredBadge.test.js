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
      name: 'cellarCred.contributor · cellarCred.photographer. ' +
        'cellarCred.explain_contributor cellarCred.explain_photographer',
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
    const chip = screen.getByRole('button', {
      name: `cellarCred.plan_${plan}. cellarCred.explain_plan_${plan}`,
    });
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

  test('tap opens a popover explaining what the badge means', () => {
    const { container } = render(<CellarCredBadge plan="patron" />);
    expect(container.querySelector('.cred-badge__pop')).toBeNull(); // closed at rest
    fireEvent.click(screen.getByRole('button'));
    const pop = container.querySelector('.cred-badge__pop');
    expect(pop).toHaveTextContent('cellarCred.explain_plan_patron');
    expect(pop.querySelector('.cred-badge__pop-title')).toHaveTextContent('cellarCred.plan_patron');
  });

  test('the cred popover explains the tier AND the specialty — photographer included', () => {
    const { container } = render(
      <CellarCredBadge tier="contributor" specialty="photographer" />
    );
    fireEvent.click(screen.getByRole('button'));
    const pop = container.querySelector('.cred-badge__pop');
    expect(pop).toHaveTextContent('cellarCred.explain_contributor');
    expect(pop).toHaveTextContent('cellarCred.explain_photographer');
  });

  test('the explanation always rides the accessible name, popover open or not', () => {
    render(<CellarCredBadge plan="benefactor" />);
    expect(
      screen.getByRole('button', {
        name: 'cellarCred.plan_benefactor. cellarCred.explain_plan_benefactor',
      })
    ).toBeInTheDocument();
  });

  test('showSpecialty=false keeps the tier label alone', () => {
    render(<CellarCredBadge tier="connoisseur" specialty="critic" showSpecialty={false} />);
    expect(screen.getByRole('button', {
      name: 'cellarCred.connoisseur. cellarCred.explain_connoisseur',
    })).toBeInTheDocument();
  });
});

describe('popover viewport clamp', () => {
  afterEach(() => vi.restoreAllMocks());

  test('a popover overflowing the right edge slides back into view', () => {
    // A chip at the end of the author row on a 400px phone: the unshifted
    // popover box hangs past the right edge. dx = (400 - 8) - 508 = -116.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function () {
      return this.classList?.contains('cred-badge__pop')
        ? { left: 260, right: 508, width: 248 }
        : { left: 0, right: 0, width: 0 };
    });
    Object.defineProperty(window, 'innerWidth', { value: 400, configurable: true });
    const { container } = render(<CellarCredBadge plan="supporter" />);
    fireEvent.click(screen.getByRole('button'));
    expect(container.querySelector('.cred-badge__pop').style.transform)
      .toBe('translateX(-116px)');
  });

  test('a popover that fits stays where it is', () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function () {
      return this.classList?.contains('cred-badge__pop')
        ? { left: 20, right: 260, width: 240 }
        : { left: 0, right: 0, width: 0 };
    });
    Object.defineProperty(window, 'innerWidth', { value: 400, configurable: true });
    const { container } = render(<CellarCredBadge plan="patron" />);
    fireEvent.click(screen.getByRole('button'));
    expect(container.querySelector('.cred-badge__pop').style.transform).toBe('');
  });

  test('zero-size rects (jsdom default) leave the popover unshifted', () => {
    const { container } = render(<CellarCredBadge plan="benefactor" />);
    fireEvent.click(screen.getByRole('button'));
    const pop = container.querySelector('.cred-badge__pop');
    expect(pop.style.transform).toBe('');
  });
});
