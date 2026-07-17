/**
 * Supporter awareness — HOSTED cellarion.app only (Johan's ask: the AI should
 * know everything is free and supporters get nothing extra, and may gently
 * mention supporting at a natural moment; self-hosted instances pay their own
 * bills and must serve NONE of this).
 *
 * Pins: the FRONTEND_URL gate; the instructions carrying the pitch + its
 * bounds (once, never required, thank existing supporters) on hosted and
 * carrying NOTHING off it; the get_source_info funding block and the
 * cellarion://about line flipping per-call on the same gate; and the
 * boolean-only supporter flag on get_profile that lets an AI thank instead
 * of pitch.
 */

jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../models/McpActionLog', () => ({ create: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../services/bottleOps', () => ({
  consumeBottle: jest.fn(), restoreBottle: jest.fn(), removeFromRacks: jest.fn(),
  RESTORE_WINDOW_MS: 2 * 24 * 60 * 60 * 1000,
  addBottle: jest.fn(), updateBottleFields: jest.fn(), removeBottleCascade: jest.fn(),
  UPDATABLE_FIELDS: ['price', 'currency', 'notes', 'occasion', 'rating', 'ratingScale', 'drinkFrom', 'drinkTo'],
}));

const User = require('../models/User');
const { isHostedCellarion } = require('../config/hostedInstance');
const { allTools, allResources } = require('./registry');
require('./tools');
require('./resources');

const ORIG_FRONTEND_URL = process.env.FRONTEND_URL;
const setHosted = () => { process.env.FRONTEND_URL = 'https://cellarion.app'; };
const setSelfHosted = () => { process.env.FRONTEND_URL = 'https://wine.example.org'; };
afterEach(() => {
  if (ORIG_FRONTEND_URL === undefined) delete process.env.FRONTEND_URL;
  else process.env.FRONTEND_URL = ORIG_FRONTEND_URL;
});

const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);

describe('the hosted gate (config/hostedInstance.js)', () => {
  test('true only for the exact cellarion.app origin (trailing slash tolerated)', () => {
    setHosted();
    expect(isHostedCellarion()).toBe(true);
    process.env.FRONTEND_URL = 'https://cellarion.app/';
    expect(isHostedCellarion()).toBe(true);
    setSelfHosted();
    expect(isHostedCellarion()).toBe(false);
    process.env.FRONTEND_URL = 'http://localhost';
    expect(isHostedCellarion()).toBe(false);
    delete process.env.FRONTEND_URL;
    expect(isHostedCellarion()).toBe(false);
  });
});

describe('instructions (require-time gate)', () => {
  const freshInstructions = () => {
    let mod;
    jest.isolateModules(() => { mod = require('./instructions'); });
    return mod;
  };

  test('hosted: both surfaces carry the pitch, with its bounds baked in', () => {
    setHosted();
    const { INSTRUCTIONS, PUBLIC_INSTRUCTIONS } = freshInstructions();
    expect(INSTRUCTIONS).toContain('https://cellarion.app/supporter');
    expect(INSTRUCTIONS).toContain('NOTHING extra');
    // The behavioral bounds are the point — once, never required, thank
    // existing supporters (via the get_profile flag).
    expect(INSTRUCTIONS).toMatch(/mention ONCE/);
    expect(INSTRUCTIONS).toMatch(/Never present it as required/);
    expect(INSTRUCTIONS).toMatch(/supporter: true, thank them/);
    expect(PUBLIC_INSTRUCTIONS).toContain('https://cellarion.app/supporter');
    expect(PUBLIC_INSTRUCTIONS).toContain('nothing extra');
  });

  test('self-hosted: NO supporter messaging anywhere in either surface', () => {
    setSelfHosted();
    const { INSTRUCTIONS, PUBLIC_INSTRUCTIONS } = freshInstructions();
    expect(INSTRUCTIONS).not.toMatch(/supporter/i);
    expect(PUBLIC_INSTRUCTIONS).not.toMatch(/supporter/i);
  });
});

describe('get_source_info funding block (call-time gate)', () => {
  test('hosted: funding block present, honest, and the URL is the supporter page', async () => {
    setHosted();
    const info = parse(await tool('get_source_info').handler({}, {}));
    expect(info.funding.supporter_url).toBe('https://cellarion.app/supporter');
    expect(info.funding.model).toMatch(/nothing extra/i);
    expect(info.funding.model).toMatch(/voluntary/i);
  });

  test('self-hosted: no funding key at all', async () => {
    setSelfHosted();
    const info = parse(await tool('get_source_info').handler({}, {}));
    expect(info.funding).toBeUndefined();
  });
});

describe('cellarion://about (call-time gate)', () => {
  const about = () => allResources().find((r) => r.name === 'about');

  test('hosted: the markdown carries the supporter line', async () => {
    setHosted();
    const res = await about().handler('cellarion://about', {}, {});
    expect(res.contents[0].text).toContain('https://cellarion.app/supporter');
    expect(res.contents[0].text).toMatch(/nothing extra/);
  });

  test('self-hosted: no supporter mention', async () => {
    setSelfHosted();
    const res = await about().handler('cellarion://about', {}, {});
    expect(res.contents[0].text).not.toMatch(/supporter/i);
  });
});

describe('get_profile supporter flag (the thank-not-pitch signal)', () => {
  const CTX = { user: { id: 'a'.repeat(24) }, scopes: ['read'], req: { headers: {} } };
  const profileFor = (plan) => {
    User.findById.mockReturnValue({ lean: () => Promise.resolve({ username: 'johan', plan }) });
    return tool('get_profile').handler({}, CTX);
  };

  test('boolean only — true for supporter/patron, false for free, never the tier itself', async () => {
    expect(parse(await profileFor('free')).data.supporter).toBe(false);
    const sup = parse(await profileFor('supporter')).data;
    expect(sup.supporter).toBe(true);
    const pat = parse(await profileFor('patron')).data;
    expect(pat.supporter).toBe(true);
    // Data minimisation: the flag never leaks the tier or billing fields.
    for (const view of [sup, pat]) {
      expect(view.plan).toBeUndefined();
      expect(JSON.stringify(view)).not.toMatch(/patron|stripe|price/i);
    }
  });
});
