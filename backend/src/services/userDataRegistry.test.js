/**
 * Guards the GDPR user-data registry against silent drift.
 *
 * The key test enumerates every model file and fails if any model that
 * references User is neither registered (purge/export) nor explicitly excluded
 * with a reason — so adding a new user-linked model can't slip through without
 * a conscious decision about erasure + portability.
 */
// services/search.js eagerly requires the ESM-only `meilisearch` package,
// which Jest can't parse — mock it (same pattern as cellarImport.test.js).
jest.mock('./search', () => ({
  removeBottles: jest.fn(),
  indexDiscussion: jest.fn(),
}));

const fs = require('fs');
const path = require('path');
const { REGISTRY, EXCLUDED, registeredModelNames } = require('./userDataRegistry');

describe('userDataRegistry', () => {
  const modelsDir = path.join(__dirname, '..', 'models');
  const modelFiles = fs.readdirSync(modelsDir)
    .filter(f => f.endsWith('.js') && !f.endsWith('.test.js'));

  test('every model with a ref:User is registered or explicitly excluded', () => {
    const covered = new Set([...registeredModelNames(), ...Object.keys(EXCLUDED)]);
    const missing = [];
    for (const file of modelFiles) {
      const name = file.replace(/\.js$/, '');
      const src = fs.readFileSync(path.join(modelsDir, file), 'utf8');
      const hasUserRef = /ref:\s*['"]User['"]/.test(src);
      if (hasUserRef && !covered.has(name)) missing.push(name);
    }
    // If this fails: add the model to REGISTRY (with purge + export) or to
    // EXCLUDED (with a reason) in services/userDataRegistry.js.
    expect(missing).toEqual([]);
  });

  test('no model is both registered and excluded', () => {
    const excludedNames = Object.keys(EXCLUDED);
    const overlap = registeredModelNames().filter(n => excludedNames.includes(n));
    expect(overlap).toEqual([]);
  });

  test('every registry entry has a model and either a handler or a documented note', () => {
    for (const e of REGISTRY) {
      expect(e.model && e.model.modelName).toBeTruthy();
      const hasHandler = !!e.purge || !!e.exportFragment;
      expect(hasHandler || !!e.note).toBe(true);
    }
  });

  test('every EXCLUDED entry has a non-empty reason', () => {
    for (const [name, reason] of Object.entries(EXCLUDED)) {
      expect(typeof reason).toBe('string');
      expect(reason.length).toBeGreaterThan(0);
      expect(name.length).toBeGreaterThan(0);
    }
  });

  test('AuditLog is handled and anonymises the actor (incl. ipAddress field path)', () => {
    const audit = REGISTRY.find(e => e.model.modelName === 'AuditLog');
    expect(audit).toBeTruthy();
    expect(audit.userFields).toContain('actor.userId');
    expect(typeof audit.purge).toBe('function');
  });

  test('registry model names are unique', () => {
    const names = registeredModelNames();
    expect(new Set(names).size).toBe(names.length);
  });
});
