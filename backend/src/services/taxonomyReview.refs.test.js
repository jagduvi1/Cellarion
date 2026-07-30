/**
 * appellationRefsError — the shared ref guard for every Appellation write
 * surface (code audit 2026-07-30: "appellation region not checked against
 * country").
 *
 * WHY THIS TEST EXISTS: the Appellation schema declares country and region
 * refs but enforces neither existence nor that the region belongs to the
 * country. Three surfaces (REST create, REST update, MCP promote_appellation)
 * accepted any valid ObjectId — the MCP schema even *documented* "must belong
 * to the same country" without checking it. The guard is the invariant; this
 * pins its behaviour for every input class.
 */

jest.mock('../models/WineDefinition', () => ({ aggregate: jest.fn() }));
jest.mock('../models/Region', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../models/Country', () => ({ find: jest.fn(), exists: jest.fn() }));
jest.mock('../models/Appellation', () => ({ find: jest.fn() }));

const mongoose = require('mongoose');
const Country = require('../models/Country');
const Region = require('../models/Region');
const { appellationRefsError } = require('./taxonomyReview');

const oid = (c) => c.repeat(24);
// Region.findById(id).select('name country').lean()
const regionChain = (doc) => ({ select: jest.fn(() => ({ lean: jest.fn(() => Promise.resolve(doc)) })) });

beforeEach(() => jest.clearAllMocks());

describe('country ref', () => {
  test('missing or malformed country id fails before any query', async () => {
    for (const bad of [undefined, null, '', 'not-an-id', { $ne: null }, 42]) {
      expect(await appellationRefsError(bad, undefined)).toMatch(/valid country id/i);
    }
    expect(Country.exists).not.toHaveBeenCalled();
  });

  test('a well-formed id that matches no country is rejected — no dangling refs', async () => {
    Country.exists.mockResolvedValue(null);
    expect(await appellationRefsError(oid('c'), undefined)).toMatch(/No country/i);
  });

  test('an ObjectId (not just a string) is accepted — the PUT path passes doc.country', async () => {
    Country.exists.mockResolvedValue({ _id: oid('c') });
    expect(await appellationRefsError(new mongoose.Types.ObjectId(oid('c')), undefined)).toBeNull();
  });
});

describe('region ref', () => {
  beforeEach(() => Country.exists.mockResolvedValue({ _id: oid('c') }));

  test('no region is always fine — region is optional on the schema', async () => {
    for (const empty of [undefined, null, '']) {
      expect(await appellationRefsError(oid('c'), empty)).toBeNull();
    }
    expect(Region.findById).not.toHaveBeenCalled();
  });

  test('malformed region id fails before any query', async () => {
    expect(await appellationRefsError(oid('c'), 'nope')).toMatch(/Invalid region id/);
    expect(Region.findById).not.toHaveBeenCalled();
  });

  test('a well-formed id that matches no region is rejected', async () => {
    Region.findById.mockReturnValue(regionChain(null));
    expect(await appellationRefsError(oid('c'), oid('d'))).toMatch(/No region/i);
  });

  test('THE AUDIT FINDING: a region from another country is rejected, by name', async () => {
    Region.findById.mockReturnValue(regionChain({ _id: oid('d'), name: 'Rioja', country: oid('e') }));
    const error = await appellationRefsError(oid('c'), oid('d'));
    expect(error).toMatch(/"Rioja"/);
    expect(error).toMatch(/different country/i);
  });

  test('a region of the same country passes', async () => {
    Region.findById.mockReturnValue(regionChain({ _id: oid('d'), name: 'Pfalz', country: oid('c') }));
    expect(await appellationRefsError(oid('c'), oid('d'))).toBeNull();
  });

  test('ObjectId-vs-string country comparison is normalized, not ===', async () => {
    // The PUT path compares the doc's ObjectId country against a lean region's
    // ObjectId country; the POST path compares two strings. Both must pass.
    Region.findById.mockReturnValue(regionChain({
      _id: oid('d'), name: 'Pfalz', country: new mongoose.Types.ObjectId(oid('c')),
    }));
    expect(await appellationRefsError(new mongoose.Types.ObjectId(oid('c')), oid('d'))).toBeNull();
  });
});
