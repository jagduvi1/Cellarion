/**
 * Guards the list of models that reference a wine against silent drift.
 *
 * A wine merge must move or drop every reference to the wine it deletes. This
 * reads every model file and fails if one that references WineDefinition is in
 * neither list of utils/wineRefs — so a new model with a wine reference can't
 * be added without deciding what a merge does with it. That reassignWineRefs
 * really touches each handled model is checked in
 * routes/admin/wines.merge.test.js.
 */
const fs = require('fs');
const path = require('path');
const { WINE_REF_HANDLED, WINE_REF_EXEMPT } = require('./wineRefs');

const modelsDir = path.join(__dirname, '..', 'models');
const modelsWithWineRef = fs.readdirSync(modelsDir)
  .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
  .filter((f) => /ref:\s*['"]WineDefinition['"]/.test(fs.readFileSync(path.join(modelsDir, f), 'utf8')))
  .map((f) => f.replace(/\.js$/, ''));

test('every model that references a wine is handled by the merge or exempt with a reason', () => {
  const covered = new Set([...WINE_REF_HANDLED, ...Object.keys(WINE_REF_EXEMPT)]);
  // If this fails: re-point or drop the model in reassignWineRefs
  // (routes/admin/wines.js) and list it in WINE_REF_HANDLED, or list it in
  // WINE_REF_EXEMPT with the service that moves it.
  expect(modelsWithWineRef.filter((name) => !covered.has(name))).toEqual([]);
});

test('the reading found the models it should', () => {
  expect(modelsWithWineRef).toEqual(expect.arrayContaining(['Bottle', 'PersonalDataEntry', 'RegistryDataValue', 'WineOwnerInquiry']));
});

test('no model is both handled and exempt, and each list names real models', () => {
  const exempt = Object.keys(WINE_REF_EXEMPT);
  expect(WINE_REF_HANDLED.filter((name) => exempt.includes(name))).toEqual([]);
  expect([...WINE_REF_HANDLED, ...exempt].filter((name) => !modelsWithWineRef.includes(name))).toEqual([]);
  expect(new Set(WINE_REF_HANDLED).size).toBe(WINE_REF_HANDLED.length);
});

test('every exempt model names what moves it', () => {
  for (const reason of Object.values(WINE_REF_EXEMPT)) {
    expect(typeof reason).toBe('string');
    expect(reason.length).toBeGreaterThan(0);
  }
});
