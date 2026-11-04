/**
 * The standard wine-record fields every install has: ABV and Closure, defined
 * exactly as cellarion.app accepted them (name, type, unit, options, translated
 * names). Without them a fresh server's wine record had no ABV row at all until
 * its admin proposed the field and accepted it (discussion #1778).
 *
 * Seeded BY NAME: each standard field the registry lacks is created, whether
 * the registry is empty (a fresh install) or already has fields of its own (an
 * install whose admin accepted a field before this version shipped). A name
 * the registry already knows is left exactly as its admin decided — accepted,
 * still proposed, or rejected: the seed never adds a second field beside one
 * of the same name and never brings back one the admin turned down. (An admin
 * who wants a standard definition after all proposes and accepts it.) A server
 * on the Registry Bridge finds the seeded field under the same name when the
 * first wine carrying it arrives.
 *
 * A seeded field has no proposer (proposedBy null): nobody proposed it.
 */
const RegistryDataKey = require('../models/RegistryDataKey');

const RATIONALE = 'A standard field: every Cellarion install starts with it.';

const STANDARD_KEYS = [
  {
    name: 'ABV',
    type: 'decimal',
    unit: '%',
    translations: { de: 'Alkoholgehalt', fr: "Degré d'alcool", sv: 'Alkoholhalt' },
  },
  {
    name: 'Closure',
    type: 'enum',
    enumOptions: ['Cork', 'Technical cork', 'Synthetic cork', 'Screw cap', 'Glass stopper', 'Crown cap'],
  },
];

/** Create each standard field the registry has no row for. Idempotent. */
async function ensureStandardKeys(now = new Date()) {
  let created = 0;
  for (const def of STANDARD_KEYS) {
    // Any row of that name, whatever its status, is the admin's decision (or
    // one waiting for them): the standard definition never overrides it.
    if (await RegistryDataKey.exists({ nameKey: def.name.toLowerCase() })) continue;
    try {
      await RegistryDataKey.create({
        ...def, rationale: RATIONALE, status: 'accepted', proposedBy: null, decidedBy: null, decidedAt: now,
      });
      created += 1;
    } catch (err) {
      // Another process (a second replica booting) created it first.
      if (err?.code !== 11000) throw err;
    }
  }
  if (created) require('./registryDataOps').invalidateVocabCache();
  return { seeded: created > 0, created };
}

module.exports = { ensureStandardKeys, STANDARD_KEYS };
