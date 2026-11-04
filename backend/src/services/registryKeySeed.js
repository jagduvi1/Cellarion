/**
 * The standard wine-record fields a new install starts with: ABV and Closure,
 * defined exactly as cellarion.app accepted them (name, type, unit, options,
 * translated names). Without them a fresh server's wine record had no ABV row
 * at all until its admin proposed the field and accepted it (discussion #1778).
 *
 * Seeded only on a registry with no fields at all — a fresh install, or the
 * first boot of this version on one that never had any — the classification
 * seed's rule. A registry that has fields keeps exactly what its admin chose:
 * nothing is added beside a field of the same meaning, and a field the admin
 * rejected is never brought back. A server on the Registry Bridge finds the
 * seeded field under the same name when the first wine carrying it arrives.
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

/** Create the standard fields on a registry that has none. Idempotent. */
async function ensureStandardKeys(now = new Date()) {
  if (await RegistryDataKey.estimatedDocumentCount() > 0) return { seeded: false, created: 0 };
  let created = 0;
  for (const def of STANDARD_KEYS) {
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
