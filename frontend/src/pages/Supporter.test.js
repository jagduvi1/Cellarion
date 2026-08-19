import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import Supporter from './Supporter';
import { PLANS, PAID_PLAN_NAMES } from '../config/plans';

// i18n: identity stub, so assertions read against KEYS rather than prose that
// is expected to be reworded. The exception is interpolation, which the stub
// resolves so the amount-bearing strings can still be checked.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k, opts) => (opts?.amount ? `${k}:${opts.amount}` : k),
    i18n: { language: 'en' },
  }),
}));

let mockUser;
const apiFetch = vi.fn();
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: mockUser, apiFetch }),
}));

const createCheckout = vi.fn();
const createPortal = vi.fn();
const getAvailability = vi.fn();
vi.mock('../api/stripe', () => ({
  createCheckout: (...a) => createCheckout(...a),
  createPortal: (...a) => createPortal(...a),
  getAvailability: (...a) => getAvailability(...a),
}));

const allAvailable = () => ({
  json: async () => ({
    configured: true,
    tiers: Object.fromEntries(
      PAID_PLAN_NAMES.map((p) => [p, { month: true, year: true }])
    ),
  }),
});

beforeEach(() => {
  vi.clearAllMocks();
  mockUser = { plan: 'free', hasStripeSubscription: false };
  getAvailability.mockResolvedValue(allAvailable());
  createCheckout.mockResolvedValue({ json: async () => ({ url: 'https://checkout.test/x' }) });
  delete window.location;
  window.location = { href: '' };
});

/** The three tier CTAs, in the order the page renders them. */
const tierButtons = () => screen.getAllByRole('button', { name: 'supporter.chooseCta' });

describe('Supporter page — tiers', () => {
  test('renders one CTA per paid tier', async () => {
    render(<Supporter />);
    await waitFor(() => expect(getAvailability).toHaveBeenCalled());
    expect(tierButtons()).toHaveLength(PAID_PLAN_NAMES.length);
  });

  test('shows each tier label', async () => {
    render(<Supporter />);
    for (const tier of PAID_PLAN_NAMES) {
      expect(screen.getByText(PLANS[tier].label)).toBeInTheDocument();
    }
  });

  test('flags exactly one tier as suggested, and it is the middle one', async () => {
    const { container } = render(<Supporter />);
    const flagged = container.querySelectorAll('.tier-card--suggested');
    expect(flagged).toHaveLength(1);
    // The middle card must be the flagged one — that positioning is the whole
    // point of a three-tier ladder, so a config reorder should fail here.
    const cards = [...container.querySelectorAll('.tier-card')];
    expect(cards.indexOf(flagged[0])).toBe(Math.floor(cards.length / 2));
  });
});

describe('Supporter page — billing cadence', () => {
  test('defaults to YEARLY', async () => {
    // The default is the steer. If this flips to monthly, the page quietly
    // costs ~$2/subscriber/year in extra card fees and loses the retention.
    render(<Supporter />);
    const yearly = screen.getByRole('button', { name: 'supporter.billingYearly' });
    expect(yearly).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'supporter.billingMonthly' }))
      .toHaveAttribute('aria-pressed', 'false');
  });

  test('shows annual amounts while yearly is selected', async () => {
    render(<Supporter />);
    for (const tier of PAID_PLAN_NAMES) {
      expect(screen.getByText(`$${PLANS[tier].annualPrice}`)).toBeInTheDocument();
    }
  });

  test('switches to monthly amounts when monthly is chosen', async () => {
    render(<Supporter />);
    fireEvent.click(screen.getByRole('button', { name: 'supporter.billingMonthly' }));
    for (const tier of PAID_PLAN_NAMES) {
      expect(screen.getByText(`$${PLANS[tier].price}`)).toBeInTheDocument();
    }
  });

  test('checks out with the selected interval', async () => {
    render(<Supporter />);
    await waitFor(() => expect(getAvailability).toHaveBeenCalled());

    fireEvent.click(tierButtons()[1]); // the suggested tier
    await waitFor(() => expect(createCheckout).toHaveBeenCalled());
    expect(createCheckout).toHaveBeenCalledWith(apiFetch, PAID_PLAN_NAMES[1], 'year');
  });

  test('checks out monthly after switching cadence', async () => {
    render(<Supporter />);
    await waitFor(() => expect(getAvailability).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'supporter.billingMonthly' }));
    fireEvent.click(tierButtons()[0]);
    await waitFor(() => expect(createCheckout).toHaveBeenCalled());
    expect(createCheckout).toHaveBeenCalledWith(apiFetch, PAID_PLAN_NAMES[0], 'month');
  });
});

describe('Supporter page — unconfigured prices', () => {
  test('hides the CTA for a (tier, interval) with no Stripe price', async () => {
    getAvailability.mockResolvedValue({
      json: async () => ({
        configured: true,
        tiers: {
          ...Object.fromEntries(PAID_PLAN_NAMES.map((p) => [p, { month: true, year: true }])),
          [PAID_PLAN_NAMES[2]]: { month: true, year: false },
        },
      }),
    });
    render(<Supporter />);

    // Yearly is the default, and the top tier has no yearly price — so it must
    // offer no button rather than one that dies at checkout.
    await waitFor(() => expect(tierButtons()).toHaveLength(2));
    expect(screen.getByText('supporter.tierUnavailable')).toBeInTheDocument();
  });

  test('re-enables that tier once the cadence it does support is selected', async () => {
    getAvailability.mockResolvedValue({
      json: async () => ({
        configured: true,
        tiers: {
          ...Object.fromEntries(PAID_PLAN_NAMES.map((p) => [p, { month: true, year: true }])),
          [PAID_PLAN_NAMES[2]]: { month: true, year: false },
        },
      }),
    });
    render(<Supporter />);
    await waitFor(() => expect(tierButtons()).toHaveLength(2));

    fireEvent.click(screen.getByRole('button', { name: 'supporter.billingMonthly' }));
    expect(tierButtons()).toHaveLength(3);
  });

  test('hides a tier the backend does not price at all', async () => {
    // A tier present in the frontend plan config but missing from the backend's
    // PRICE_ENV must not render a button — checkout would reject it as an
    // "Invalid plan" only after the user committed to giving money.
    getAvailability.mockResolvedValue({
      json: async () => ({
        configured: true,
        tiers: Object.fromEntries(
          PAID_PLAN_NAMES.slice(0, 2).map((p) => [p, { month: true, year: true }])
        ),
      }),
    });
    render(<Supporter />);
    await waitFor(() => expect(tierButtons()).toHaveLength(2));
  });

  test('stays optimistic when the availability lookup fails', async () => {
    getAvailability.mockRejectedValue(new Error('offline'));
    render(<Supporter />);
    // A failed probe must not disable giving on a perfectly healthy install.
    await waitFor(() => expect(tierButtons()).toHaveLength(PAID_PLAN_NAMES.length));
  });
});

describe('Supporter page — existing subscribers', () => {
  test('offers the portal instead of the tier ladder', async () => {
    mockUser = { plan: 'patron', hasStripeSubscription: true };
    render(<Supporter />);

    expect(screen.getByText('supporter.alreadySupporting')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'supporter.chooseCta' })).not.toBeInTheDocument();
    expect(getAvailability).not.toHaveBeenCalled();
  });

  test('routes a duplicate checkout to the portal rather than double-billing', async () => {
    createCheckout.mockResolvedValue({ json: async () => ({ code: 'subscription_exists' }) });
    createPortal.mockResolvedValue({ json: async () => ({ url: 'https://portal.test/y' }) });
    render(<Supporter />);
    await waitFor(() => expect(getAvailability).toHaveBeenCalled());

    fireEvent.click(tierButtons()[0]);
    await waitFor(() => expect(createPortal).toHaveBeenCalled());
  });
});

describe('Supporter page — custom amount', () => {
  test('links to GitHub Sponsors safely', async () => {
    render(<Supporter />);
    const link = screen.getByRole('link', { name: /supporter.customTitle/ });
    expect(link).toHaveAttribute('href', 'https://github.com/sponsors/jagduvi1');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });
});
