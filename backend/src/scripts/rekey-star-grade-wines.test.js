const { keyFor, legacyNormalize } = require('./rekey-star-grade-wines');
const { normalizeString } = require('../utils/normalize');

describe('rekey-star-grade-wines keyFor', () => {
  const wine = (extra) => ({ name: 'Zeltinger Sonnenuhr Riesling Auslese** Goldkapsel', producer: 'Markus Molitor', appellation: 'Mosel', ...extra });

  it('builds the star-stripped key the registry stored before, and the graded key now', () => {
    const w = wine({ normalizedKey: 'markus molitor:zeltinger sonnenuhr riesling auslese goldkapsel:mosel' });
    expect(keyFor(w, legacyNormalize)).toBe(w.normalizedKey);
    expect(keyFor(w, normalizeString)).toBe('markus molitor:zeltinger sonnenuhr riesling auslese 2star goldkapsel:mosel');
  });

  it('keeps the pending and draft namespaces', () => {
    const pending = wine({ normalizedKey: 'pending~u1:zeltinger sonnenuhr riesling auslese goldkapsel:mosel' });
    expect(keyFor(pending, normalizeString)).toBe('pending~u1:zeltinger sonnenuhr riesling auslese 2star goldkapsel:mosel');
    const draft = wine({ normalizedKey: 'draft~u1:markus molitor:zeltinger sonnenuhr riesling auslese goldkapsel:mosel' });
    expect(keyFor(draft, normalizeString)).toBe('draft~u1:markus molitor:zeltinger sonnenuhr riesling auslese 2star goldkapsel:mosel');
  });
});
