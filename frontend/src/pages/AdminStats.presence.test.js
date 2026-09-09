import { render, screen, waitFor } from '@testing-library/react';
import AdminStats from './AdminStats';

/**
 * Admin → global stats, the two presence measures.
 *
 * The page now shows each engagement window twice — people who changed a
 * cellar, and people who were merely here — and a second retention ladder
 * beside the bottle one. Both new blocks are optional in the payload, which
 * is the point of this file: an admin whose browser is holding the previous
 * page, or a payload served from the five-minute cache across a deploy, must
 * get a page rather than a crash. That failure would be silent in review and
 * loud in production.
 *
 * Also pinned: the presence ladder states its window. It sees only as far back
 * as the activity log is kept, while the ladder above it spans all history,
 * and two ladders with unstated windows read as a contradiction.
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, a, b) => {
      const opts = typeof a === 'object' && a !== null ? a : (typeof b === 'object' && b !== null ? b : null);
      if (opts && opts.days !== undefined) return `${key}:${opts.days}`;
      if (opts && opts.count !== undefined) return `${key}:${opts.count}`;
      return key;
    },
  }),
}));

const apiFetch = vi.fn();
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch }) }));

const getStats = vi.fn();
vi.mock('../api/admin', () => ({ adminGetGlobalStats: (...a) => getStats(...a) }));

// The smallest payload the page has to survive: every block it reads, none of
// the optional ones.
const BASE = {
  generatedAt: '2026-09-09T10:00:00.000Z',
  excludeAdmins: true,
  adminsExcludedCount: 2,
  overview: {
    totalUsers: 368, cellarUsers: 367, activationPct: 50, usersWithBottles: 183,
    totalCellars: 400, totalBottles: 9000, activeBottles: 8000, consumedBottles: 1000,
    drankBottles: 900, giftedBottles: 50, soldBottles: 30, otherBottles: 20,
    avgBottlesPerUser: 43, avgBottlesPerCellar: 20, totalWineDefinitions: 12000,
  },
  activity: { newUsers30: 10, newUsers90: 30, bottlesAdded30: 100, bottlesAdded90: 300, bottlesConsumed30: 20, bottlesConsumed90: 60 },
  engagement: { activeUsers24h: 7, activeUsers7d: 50, activeUsers30d: 112, activeUsers90d: 183 },
  retention: {
    returningUsers: 90, coreUsers: 40, singleSessionUsers: 30, usersWithActivity: 120,
    returningPct: 75, corePct: 33, activityTiers: [], signupCohorts: [],
    cohortWindowDays: 7, cohortSignups: 0, cohortReturned: 0, cohortReturnedPct: 0,
  },
  plans: { distribution: [] },
  // BarChart maps over these and slices the label, so they cannot be empty
  // stubs — a bare {} throws inside the chart before any assertion runs.
  trends: {
    bottlesAdded:    [{ month: '2026-08', count: 300 }, { month: '2026-09', count: 100 }],
    bottlesConsumed: [{ month: '2026-08', count: 60 }, { month: '2026-09', count: 20 }],
    newUsers:        [{ month: '2026-08', count: 30 }, { month: '2026-09', count: 10 }],
    newCellars:      [{ month: '2026-08', count: 12 }, { month: '2026-09', count: 4 }],
  },
  maturity: {
    bottlesWithProfile: 0, noProfile: 0, coveragePct: 0,
    peak: 0, early: 0, notReady: 0, late: 0,
  },
};

const withPresence = {
  ...BASE,
  engagement: {
    ...BASE.engagement,
    present24h: 38, present7d: 84, present30d: 166, present90d: 255, presenceWindowDays: 90,
  },
  retention: {
    ...BASE.retention,
    presence: {
      usersSeen: 255, returningUsers: 130, coreUsers: 85, returningPct: 51,
      tiers: [{ days: 2, users: 130, pct: 51 }, { days: 4, users: 85, pct: 33 }, { days: 7, users: 63, pct: 24 }],
      windowDays: 90,
    },
  },
};

// The page checks res.ok and awaits res.json(), so the mock has to be a
// Response, not the payload itself.
const jsonRes = (body) => ({ ok: true, status: 200, json: () => Promise.resolve(body) });

beforeEach(() => { getStats.mockReset(); });

describe('AdminStats presence measures', () => {
  it('shows both engagement measures, each labelled', async () => {
    getStats.mockResolvedValue(jsonRes(withPresence));
    render(<AdminStats />);
    await waitFor(() => expect(screen.getByText('adminStats.engagementChanged')).toBeInTheDocument());
    expect(screen.getByText('adminStats.engagementPresent')).toBeInTheDocument();
    // The narrow measure and the wide one, on the same 24h window.
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('38')).toBeInTheDocument();
  });

  it('renders the presence ladder with its window in the heading', async () => {
    // Without the window, 130 returning here next to 90 returning above reads
    // as a contradiction rather than as two different questions.
    getStats.mockResolvedValue(jsonRes(withPresence));
    render(<AdminStats />);
    await waitFor(() => expect(screen.getByText('adminStats.retentionByPresence:90')).toBeInTheDocument());
    expect(screen.getByText('130')).toBeInTheDocument();
    // 255 legitimately appears twice: the widest engagement window IS the
    // whole log, so it equals the "people seen at all" denominator below it.
    expect(screen.getAllByText('255')).toHaveLength(2);
  });

  it('renders the page unchanged when the payload has no presence data', async () => {
    // A payload from before this shipped — a cached response across a deploy,
    // or an older backend. The page must degrade, not throw.
    getStats.mockResolvedValue(jsonRes(BASE));
    render(<AdminStats />);
    await waitFor(() => expect(screen.getByText('adminStats.engagementChanged')).toBeInTheDocument());
    expect(screen.queryByText('adminStats.engagementPresent')).not.toBeInTheDocument();
    expect(screen.queryByText('adminStats.retentionByPresence:90')).not.toBeInTheDocument();
    // The bottle-based figures are still there.
    expect(screen.getByText('50')).toBeInTheDocument();
  });

  it('hides the presence ladder when nobody has been seen yet', async () => {
    // A fresh install: an empty ladder with 0% everywhere is noise, not data.
    getStats.mockResolvedValue(jsonRes({
      ...withPresence,
      retention: { ...withPresence.retention, presence: { usersSeen: 0, returningUsers: 0, coreUsers: 0, returningPct: 0, tiers: [], windowDays: 90 } },
    }));
    render(<AdminStats />);
    await waitFor(() => expect(screen.getByText('adminStats.engagementChanged')).toBeInTheDocument());
    expect(screen.queryByText('adminStats.retentionByPresence:90')).not.toBeInTheDocument();
  });
});
