/**
 * The pre-validate hook's COLOUR rules (support ticket 2026-09-17, "Colour
 * Sparkling/Rosè"):
 *   - only a sparkling/dessert/fortified wine keeps a colour — any other type
 *     (or none) drops it, so a retype can never leave a contradiction behind;
 *   - a style-typed wine with no colour gets one from a rosé NAME, but only on
 *     create or retype — afterwards the stored value is a curator's.
 * No DB needed: doc.validate() runs the middleware.
 */
const mongoose = require('mongoose');
const WineDefinition = require('./WineDefinition');

const oid = () => new mongoose.Types.ObjectId();

const newWine = (overrides = {}) => new WineDefinition({
  name: 'Rosé Extra Brut',
  producer: 'Maso Martis',
  appellation: 'Trento',
  country: oid(),
  createdBy: oid(),
  normalizedKey: 'raw:key:x',
  type: 'sparkling',
  ...overrides,
});

/** A doc as a later save sees it: not new, nothing modified yet. */
const savedWine = async (overrides = {}) => {
  const doc = newWine(overrides);
  await doc.validate();
  doc.$isNew = false;
  for (const path of Object.keys(doc.toObject())) doc.unmarkModified(path);
  return doc;
};

describe('on create', () => {
  test('a sparkling wine with a rosé name is recorded as a sparkling rosé', async () => {
    const doc = newWine();
    await doc.validate();
    expect(doc.colour).toBe('rosé');
  });

  test('a stated colour wins over the name', async () => {
    const doc = newWine({ name: 'Rosé de Saignée', colour: 'red' });
    await doc.validate();
    expect(doc.colour).toBe('red');
  });

  test('no rosé word, no colour — a Blanc de Blancs stays uncoloured', async () => {
    const doc = newWine({ name: 'Blanc de Blancs Brut' });
    await doc.validate();
    expect(doc.colour).toBeNull();
  });

  test('dessert and fortified infer too', async () => {
    const port = newWine({ name: 'Porto Rosé', producer: 'Croft', type: 'fortified' });
    await port.validate();
    expect(port.colour).toBe('rosé');
  });

  test('a still wine never keeps a colour — its type already is one', async () => {
    const doc = newWine({ type: 'rosé', colour: 'rosé' });
    await doc.validate();
    expect(doc.colour).toBeNull();
    const red = newWine({ name: 'Cuvée X', type: 'red', colour: 'white' });
    await red.validate();
    expect(red.colour).toBeNull();
  });

  test('an untyped wine keeps none either', async () => {
    const doc = newWine({ type: undefined, colour: 'rosé' });
    await doc.validate();
    expect(doc.colour).toBeNull();
  });

  test('the enum refuses anything but red, white, rosé', async () => {
    const doc = newWine({ colour: 'orange' });
    await expect(doc.validate()).rejects.toThrow(/colour/);
  });
});

describe('on a later save', () => {
  test('an unrelated edit never re-infers over a colour someone cleared', async () => {
    const doc = await savedWine({ colour: null });
    doc.colour = null; // cleared by a curator on an earlier save
    doc.appellation = 'Trento DOC';
    await doc.validate();
    expect(doc.colour).toBeNull();
  });

  test('retyping a still rosé to sparkling picks the colour up from the name', async () => {
    const doc = await savedWine({ type: 'rosé' });
    expect(doc.colour).toBeNull();
    doc.type = 'sparkling';
    await doc.validate();
    expect(doc.colour).toBe('rosé');
  });

  test('retyping a sparkling rosé to still drops the colour', async () => {
    const doc = await savedWine({ colour: 'rosé' });
    doc.type = 'white';
    await doc.validate();
    expect(doc.colour).toBeNull();
  });

  test('a colour set explicitly on a style type stays', async () => {
    const doc = await savedWine({ name: 'Cuvée Speciale', colour: null });
    doc.colour = 'rosé';
    await doc.validate();
    expect(doc.colour).toBe('rosé');
  });
});
