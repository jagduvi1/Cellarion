/**
 * The registry side of a contributed wine (POST /api/bridge/v1/contributions).
 *
 * WHY THIS TEST EXISTS:
 * A self-hosted install offers a wine it created, with the identity it holds
 * and the drink windows set there. What arrives must land as a REQUEST that a
 * person resolves, never as registry data: the identity as plain fields and
 * hints, the windows as proposals (proposedWindows) that only become
 * suggestions in the maturity queue once the request is resolved. A body the
 * install got wrong is refused with a reason, never half-stored, and a picture
 * path that names a file on the install's own server is refused rather than
 * stored as a dead link.
 */
jest.mock('../models/WineRequest', () => {
  const M = jest.fn(function WineRequest(doc) {
    Object.assign(this, doc);
    this._id = 'r1';
    this.save = jest.fn().mockResolvedValue(this);
  });
  M.findOne = jest.fn();
  return M;
});

const WineRequest = require('../models/WineRequest');
const { parseContribution, fileContribution, WINDOWS_MAX } = require('./registryContributionIntake');

const base = { name: 'Clos Example', producer: 'Domaine Example' };

describe('parseContribution', () => {
  test('identity fields, hints, grapes and windows in the stored shape', () => {
    const r = parseContribution({
      ...base,
      country: 'France', region: 'Burgundy', appellation: 'Gevrey-Chambertin', type: 'Red',
      grapes: ['Pinot Noir', 'pinot noir', ''],
      windows: [
        { vintage: '2019', early: { from: 2023, until: 2026 }, peak: { from: 2026, until: 2034 }, late: { from: 2034, until: 2040 } },
        { vintage: 2018, peak: { from: 2025, until: null } },
        { vintage: '2017' },
      ],
    });
    expect(r.error).toBeUndefined();
    expect(r.contribution).toEqual({
      name: 'Clos Example',
      producer: 'Domaine Example',
      hints: { country: 'France', region: 'Burgundy', appellation: 'Gevrey-Chambertin', type: 'red' },
      grapes: ['Pinot Noir'],
      image: null,
      windows: [
        { vintage: '2019', earlyFrom: 2023, earlyUntil: 2026, peakFrom: 2026, peakUntil: 2034, lateFrom: 2034, lateUntil: 2040 },
        { vintage: '2018', peakFrom: 2025 },
      ],
    });
  });

  test('name and producer are required', () => {
    expect(parseContribution({ producer: 'Domaine Example' }).error).toMatch(/name is required/);
    expect(parseContribution({ name: 'Clos Example', producer: '  ' }).error).toMatch(/producer is required/);
    expect(parseContribution(null).error).toMatch(/name is required/);
  });

  test('a window must be a year with phases in order and in range', () => {
    expect(parseContribution({ ...base, windows: [{ vintage: 'NV', peak: { from: 1, until: 3 } }] }).error).toMatch(/must be a year/);
    expect(parseContribution({ ...base, windows: [{ vintage: '2019', peak: { from: 2030, until: 2025 } }] }).error).toMatch(/peakUntil lies before peakFrom/);
    expect(parseContribution({ ...base, windows: [{ vintage: '2019', peak: { from: 1500, until: 2025 } }] }).error).toMatch(/outside/);
    expect(parseContribution({ ...base, windows: [{ vintage: '2019', peak: { from: 2025.5 } }] }).error).toMatch(/not a year/);
    expect(parseContribution({ ...base, windows: [{ vintage: '2019' }, { vintage: '2019' }] }).error).toMatch(/listed twice/);
    expect(parseContribution({ ...base, windows: 'soon' }).error).toMatch(/must be a list/);
    const many = Array.from({ length: WINDOWS_MAX + 1 }, (_, i) => ({ vintage: String(1990 + i), peak: { from: 2030 } }));
    expect(parseContribution({ ...base, windows: many }).error).toMatch(/At most 30/);
  });

  test('a picture is a link or an inline image, never a path on the install', () => {
    expect(parseContribution({ ...base, image: '/api/uploads/processed/x.webp' }).error).toMatch(/link or an inline image/);
    expect(parseContribution({ ...base, image: 42 }).error).toMatch(/link or an inline image/);
    expect(parseContribution({ ...base, image: 'data:image/webp;base64,AAAA' }).contribution.image).toBe('data:image/webp;base64,AAAA');
    expect(parseContribution({ ...base, image: 'https://cdn.example.org/clos.webp' }).contribution.image).toBe('https://cdn.example.org/clos.webp');
  });

  test('grapes must be a short list of names', () => {
    expect(parseContribution({ ...base, grapes: 'Pinot Noir' }).error).toMatch(/grapes must be a list/);
    expect(parseContribution({ ...base, grapes: [{ name: 'Pinot Noir' }] }).error).toMatch(/each name is text/);
  });
});

describe('fileContribution', () => {
  beforeEach(() => jest.clearAllMocks());

  test('a new wine becomes a pending new_wine request the install follows, with its origin and proposals', async () => {
    WineRequest.findOne.mockResolvedValue(null);
    const req = { bridge: { key: { id: 'k1', instanceHost: 'cellar.example.org' } } };
    const { contribution } = parseContribution({ ...base, country: 'France', grapes: ['Pinot Noir'], windows: [{ vintage: '2019', peak: { from: 2026, until: 2034 } }] });
    const { wineRequest, reused } = await fileContribution('u1', contribution, { via: 'bridge', req });
    expect(reused).toBe(false);
    expect(wineRequest.save).toHaveBeenCalled();
    expect(wineRequest).toMatchObject({
      requestType: 'new_wine', status: 'pending', user: 'u1',
      wineName: 'Clos Example', producer: 'Domaine Example',
      hints: { country: 'France' }, suggestedGrapes: ['Pinot Noir'], image: null,
      proposedWindows: [{ vintage: '2019', peakFrom: 2026, peakUntil: 2034 }],
      via: 'bridge', bridgeKey: 'k1', instanceHost: 'cellar.example.org',
    });
    expect(wineRequest.installFollowsAt).toBeInstanceOf(Date);
  });

  test('the same wine still pending from this account answers that request instead of filing a second', async () => {
    const existing = { _id: 'r0', status: 'pending', wineName: 'Clos Example' };
    WineRequest.findOne.mockResolvedValue(existing);
    const { contribution } = parseContribution(base);
    const r = await fileContribution('u1', contribution, { via: 'bridge', req: {} });
    expect(r).toEqual({ wineRequest: existing, reused: true });
    const filter = WineRequest.findOne.mock.calls[0][0];
    expect(filter).toMatchObject({ user: 'u1', via: 'bridge', requestType: 'new_wine', status: 'pending' });
    // Case-insensitive, whole-name match: a regex special in a name is literal.
    expect(filter.wineName.test('clos example')).toBe(true);
    expect(filter.wineName.test('Clos Example 2')).toBe(false);
    expect(WineRequest).not.toHaveBeenCalled();
  });
});
