/**
 * The sweetness style as every wine read sends it (services/sweetnessOps and
 * utils/sweetnessStyle).
 *
 * WHY THIS TEST EXISTS:
 * The style is stored as { term, source, url } and leaves the server as
 * { name, band, scale, regulated, source, sourceUrl } — from a document's
 * toJSON, a lean read and the toObject() copy the read surfaces send
 * (utils/grapeDisplay.decorateGrapes), and on MCP with `source_url`. Each
 * path gives the same object, through one pure shape that never reads the
 * term cache, so a warm and a cold server answer alike. null means "this wine
 * has no style"; a style this read cannot vouch for — its term not populated,
 * its term row gone, a source or link the rules refuse — is left out, never
 * sent as null, as a bare id or in the stored shape.
 */
const mongoose = require('mongoose');
const ops = require('./sweetnessOps');
const WineDefinition = require('../models/WineDefinition');
const { decorateGrapes } = require('../utils/grapeDisplay');
const { styleShape } = require('../utils/sweetnessStyle');

const ID = (c) => c.repeat(24);
const FEINHERB = { _id: ID('5'), name: 'feinherb', scale: 'still', band: 'off-dry', regulated: false, country: null, synonyms: [] };
const URL = 'https://merchant.example/riesling';
const SHAPE = { name: 'feinherb', band: 'off-dry', scale: 'still', regulated: false, source: 'trade', sourceUrl: URL };
const POPULATED = { term: { _id: ID('5'), name: 'feinherb', band: 'off-dry', scale: 'still', regulated: false }, source: 'trade', url: URL };
const UNPOPULATED = { term: ID('5'), source: 'trade', url: URL };

afterEach(() => ops.primeSweetnessCache(null));

describe('the one shape', () => {
  test('a populated style and an already shaped style read the same; none is null', () => {
    expect(styleShape(POPULATED)).toEqual({ state: 'shaped', value: SHAPE });
    expect(styleShape(SHAPE)).toEqual({ state: 'shaped', value: SHAPE });
    expect(styleShape(null)).toEqual({ state: 'none' });
    expect(styleShape(undefined)).toEqual({ state: 'none' });
  });

  test('an unpopulated term is unresolved even when the term cache could name it — warm and cold answer alike', () => {
    ops.primeSweetnessCache([FEINHERB]);
    expect(styleShape(UNPOPULATED)).toEqual({ state: 'unresolved' });
    ops.primeSweetnessCache(null);
    expect(styleShape(UNPOPULATED)).toEqual({ state: 'unresolved' });
  });

  test('a source or a link the rules refuse is never sent, whatever wrote it', () => {
    for (const bad of [
      { ...POPULATED, source: 'critic' },
      { ...POPULATED, source: 'constructor' },
      { ...POPULATED, url: 'javascript:alert(1)' },
      { ...POPULATED, url: 'https://merchant.example/x\ny' },
      { ...POPULATED, url: '' },
      { ...SHAPE, sourceUrl: 'data:text/html,x' },
      'feinherb',
    ]) expect(styleShape(bad)).toEqual({ state: 'unresolved' });
  });
});

describe('sweetnessStyleOut', () => {
  test('the shape, null for none, undefined (no key) for a style this read cannot vouch for', () => {
    expect(ops.sweetnessStyleOut({ sweetnessStyle: POPULATED })).toEqual(SHAPE);
    expect(ops.sweetnessStyleOut({ sweetnessStyle: null })).toBeNull();
    expect(ops.sweetnessStyleOut({})).toBeNull();
    expect(ops.sweetnessStyleOut(null)).toBeNull();
    expect(ops.sweetnessStyleOut({ sweetnessStyle: UNPOPULATED })).toBeUndefined();
  });
});

describe('shapeSweetnessStyle', () => {
  test('a plain wine gets the outgoing shape; an unvouched style loses its key; a wine without the key keeps none', () => {
    expect(ops.shapeSweetnessStyle({ name: 'Riesling', sweetnessStyle: POPULATED })).toEqual({ name: 'Riesling', sweetnessStyle: SHAPE });
    expect(ops.shapeSweetnessStyle({ name: 'Riesling', sweetnessStyle: null })).toEqual({ name: 'Riesling', sweetnessStyle: null });
    expect(ops.shapeSweetnessStyle({ name: 'Riesling', sweetnessStyle: UNPOPULATED })).toEqual({ name: 'Riesling' });
    expect(ops.shapeSweetnessStyle({ name: 'Riesling' })).toEqual({ name: 'Riesling' });
    expect(ops.shapeSweetnessStyle(null)).toBeNull();
  });

  test('a Mongoose document is left alone: a save must still see the stored subdocument', () => {
    const doc = new WineDefinition({ name: 'Riesling', producer: 'Weingut Beispiel', sweetnessStyle: UNPOPULATED });
    expect(ops.shapeSweetnessStyle(doc)).toBe(doc);
    expect(String(doc.sweetnessStyle.term)).toBe(ID('5'));
    expect(doc.sweetnessStyle.url).toBe(URL);
  });

  test('the toObject() copy the read surfaces send (decorateGrapes) carries the outgoing shape, or no key', () => {
    const unpopulated = new WineDefinition({ name: 'Riesling', producer: 'Weingut Beispiel', sweetnessStyle: UNPOPULATED });
    expect(decorateGrapes(unpopulated)).not.toHaveProperty('sweetnessStyle');
    expect(unpopulated.toObject().sweetnessStyle).toEqual({ term: new mongoose.Types.ObjectId(ID('5')), source: 'trade', url: URL });
    expect(decorateGrapes({ name: 'Riesling', grapes: [], sweetnessStyle: POPULATED }).sweetnessStyle).toEqual(SHAPE);
    expect(decorateGrapes({ name: 'Riesling', grapes: [], sweetnessStyle: null }).sweetnessStyle).toBeNull();
  });
});

describe('the MCP field', () => {
  const { sourceUrl, ...rest } = SHAPE;
  test('asked for: the shape with source_url, or null for none and for a row that predates the field', () => {
    expect(ops.sweetnessStyleFields({ sweetnessStyle: POPULATED }, { loaded: true })).toEqual({ sweetness_style: { ...rest, source_url: sourceUrl } });
    expect(ops.sweetnessStyleFields({ sweetnessStyle: SHAPE }, { loaded: true })).toEqual({ sweetness_style: { ...rest, source_url: sourceUrl } });
    expect(ops.sweetnessStyleFields({ sweetnessStyle: null }, { loaded: true })).toEqual({ sweetness_style: null });
    expect(ops.sweetnessStyleFields({ name: 'Riesling' }, { loaded: true })).toEqual({ sweetness_style: null });
  });

  test('not asked for, a document that was not loaded with it, or a style this read cannot vouch for: no key', () => {
    expect(ops.sweetnessStyleFields({ sweetnessStyle: POPULATED })).toEqual({});
    expect(ops.sweetnessStyleFields({ sweetnessStyle: UNPOPULATED }, { loaded: true })).toEqual({});
    const partial = WineDefinition.hydrate({ _id: ID('9'), name: 'Riesling', producer: 'Weingut Beispiel' }, { name: 1, producer: 1 });
    expect(ops.sweetnessStyleFields(partial, { loaded: true })).toEqual({});
    expect(ops.sweetnessStyleFields(null, { loaded: true })).toEqual({});
  });
});
