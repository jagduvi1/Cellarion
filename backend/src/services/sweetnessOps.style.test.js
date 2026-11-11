/**
 * The sweetness style as every wine read sends it (services/sweetnessOps).
 *
 * WHY THIS TEST EXISTS:
 * The style is stored as { term, source, url } and leaves the server as
 * { name, band, scale, regulated, source, sourceUrl } — on REST from a
 * document's toJSON, from a lean read and from the toObject() copy the read
 * surfaces send (utils/grapeDisplay.decorateGrapes), and on MCP with
 * `source_url`. Each path must give the same object, a read that did not
 * load the field must not claim "no style", and a term nothing can name is
 * never sent as a bare id.
 */
const mongoose = require('mongoose');
const ops = require('./sweetnessOps');
const WineDefinition = require('../models/WineDefinition');
const { decorateGrapes } = require('../utils/grapeDisplay');

const ID = (c) => c.repeat(24);
const FEINHERB = { _id: ID('5'), name: 'feinherb', scale: 'still', band: 'off-dry', regulated: false, country: null, synonyms: [] };
const URL = 'https://merchant.example/riesling';
const SHAPE = { name: 'feinherb', band: 'off-dry', scale: 'still', regulated: false, source: 'trade', sourceUrl: URL };
const POPULATED = { term: { name: 'feinherb', band: 'off-dry', scale: 'still', regulated: false }, source: 'trade', url: URL };

beforeEach(() => ops.primeSweetnessCache([FEINHERB]));
afterEach(() => ops.primeSweetnessCache(null));

describe('sweetnessStyleOut', () => {
  test('a populated style, an id the warm copy names, and an already shaped style all read the same', () => {
    expect(ops.sweetnessStyleOut({ sweetnessStyle: POPULATED })).toEqual(SHAPE);
    expect(ops.sweetnessStyleOut({ sweetnessStyle: { term: ID('5'), source: 'trade', url: URL } })).toEqual(SHAPE);
    expect(ops.sweetnessStyleOut({ sweetnessStyle: SHAPE })).toEqual(SHAPE);
  });

  test('none, a term nothing can name, and an incomplete value are null — never a bare id', () => {
    expect(ops.sweetnessStyleOut({ sweetnessStyle: null })).toBeNull();
    expect(ops.sweetnessStyleOut({})).toBeNull();
    expect(ops.sweetnessStyleOut(null)).toBeNull();
    expect(ops.sweetnessStyleOut({ sweetnessStyle: { term: ID('9'), source: 'trade', url: URL } })).toBeNull();
    expect(ops.sweetnessStyleOut({ sweetnessStyle: { ...POPULATED, url: '' } })).toBeNull();
    expect(ops.sweetnessStyleOut({ sweetnessStyle: { ...POPULATED, source: null } })).toBeNull();
    ops.primeSweetnessCache(null);
    expect(ops.sweetnessStyleOut({ sweetnessStyle: { term: ID('5'), source: 'trade', url: URL } })).toBeNull();
  });
});

describe('shapeSweetnessStyle', () => {
  test('a plain wine gets the outgoing shape; a wine without the key keeps no key', () => {
    expect(ops.shapeSweetnessStyle({ name: 'Riesling', sweetnessStyle: POPULATED })).toEqual({ name: 'Riesling', sweetnessStyle: SHAPE });
    expect(ops.shapeSweetnessStyle({ name: 'Riesling', sweetnessStyle: null })).toEqual({ name: 'Riesling', sweetnessStyle: null });
    expect(ops.shapeSweetnessStyle({ name: 'Riesling' })).toEqual({ name: 'Riesling' });
    expect(ops.shapeSweetnessStyle(null)).toBeNull();
  });

  test('a Mongoose document is left alone: a save must still see the stored subdocument', () => {
    const doc = new WineDefinition({ name: 'Riesling', producer: 'Weingut Beispiel', sweetnessStyle: { term: ID('5'), source: 'trade', url: URL } });
    expect(ops.shapeSweetnessStyle(doc)).toBe(doc);
    expect(String(doc.sweetnessStyle.term)).toBe(ID('5'));
    expect(doc.sweetnessStyle.url).toBe(URL);
  });

  test('the toObject() copy every REST wine read sends (decorateGrapes) carries the outgoing shape', () => {
    const doc = new WineDefinition({ name: 'Riesling', producer: 'Weingut Beispiel', sweetnessStyle: { term: ID('5'), source: 'trade', url: URL } });
    expect(decorateGrapes(doc).sweetnessStyle).toEqual(SHAPE);
    expect(doc.toObject().sweetnessStyle).toEqual({ term: new mongoose.Types.ObjectId(ID('5')), source: 'trade', url: URL });
    expect(decorateGrapes({ name: 'Riesling', grapes: [], sweetnessStyle: POPULATED }).sweetnessStyle).toEqual(SHAPE);
  });
});

describe('the MCP field', () => {
  test('loaded: the shape with source_url, or null for none and for a row that predates the field', () => {
    const { sourceUrl, ...rest } = SHAPE;
    expect(ops.sweetnessStyleFields({ sweetnessStyle: POPULATED }, { loaded: true })).toEqual({ sweetness_style: { ...rest, source_url: sourceUrl } });
    expect(ops.sweetnessStyleFields({ sweetnessStyle: SHAPE }, { loaded: true })).toEqual({ sweetness_style: { ...rest, source_url: sourceUrl } });
    expect(ops.sweetnessStyleFields({ sweetnessStyle: null }, { loaded: true })).toEqual({ sweetness_style: null });
    expect(ops.sweetnessStyleFields({ name: 'Riesling' }, { loaded: true })).toEqual({ sweetness_style: null });
  });

  test('not loaded, or a term nothing can name: no key, so a missing key never claims "no style"', () => {
    expect(ops.sweetnessStyleFields({ name: 'Riesling' })).toEqual({});
    expect(ops.sweetnessStyleFields({ sweetnessStyle: { term: ID('9'), source: 'trade', url: URL } }, { loaded: true })).toEqual({});
    expect(ops.sweetnessStyleFields(null, { loaded: true })).toEqual({});
  });
});
