/**
 * A production method is not an appellation (GitHub discussion #1696). Only a
 * value that is NOTHING BUT a method counts — the same words end real
 * appellation names — and it keys as no appellation in every identity key, so
 * a lookup lands on the row the model hook stores without one.
 */
const { isProductionMethodOnly, generateWineKey, pendingWineKey, draftWineKey } = require('./normalize');
const { computeCanonicalKey } = require('./wineIdentity');

describe('isProductionMethodOnly', () => {
  test('a method and nothing else, in the spellings labels and prompts use', () => {
    for (const v of [
      'Méthode Traditionnelle', 'methode traditionnelle', 'Méthode Traditionelle', 'Méthode Champenoise',
      'Méthode Cap Classique', 'Cap Classique', 'MCC', 'Metodo Classico', 'Método Tradicional',
      'Traditional Method', 'Klassische Flaschengärung', '  Metodo  Classico ',
    ]) expect([v, isProductionMethodOnly(v)]).toEqual([v, true]);
  });

  test('a place, or a legal name that ends in the method, is not', () => {
    for (const v of [
      'Western Cape', 'Chianti Classico', 'Valpolicella Classico', 'Oltrepò Pavese Metodo Classico',
      'Asti DOCG Metodo Classico', 'Touraine AOP – Méthode Traditionnelle', 'Blanquette méthode ancestrale',
      'Clairette de Die Méthode Dioise Ancestrale', 'Classico', '', null, undefined, 42,
    ]) expect([v, isProductionMethodOnly(v)]).toEqual([v, false]);
  });
});

describe('the identity keys read a method alone as no appellation', () => {
  test('generateWineKey, pendingWineKey and draftWineKey', () => {
    expect(generateWineKey('Brut Rosé', 'Scacciadiavoli', 'Metodo Classico')).toBe(generateWineKey('Brut Rosé', 'Scacciadiavoli', ''));
    expect(pendingWineKey('Brut Rosé', 'u1', 'Méthode Traditionnelle')).toBe(pendingWineKey('Brut Rosé', 'u1', ''));
    expect(draftWineKey('Brut Rosé', 'Scacciadiavoli', 'u1', 'Cap Classique')).toBe(draftWineKey('Brut Rosé', 'Scacciadiavoli', 'u1', ''));
    // The sweetness suffix still rides along.
    expect(generateWineKey('Blanc de Blancs', 'Pongrácz', 'Méthode Cap Classique', { sweetness: 'Brut' }))
      .toBe(generateWineKey('Blanc de Blancs', 'Pongrácz', '', { sweetness: 'Brut' }));
  });

  test('computeCanonicalKey', () => {
    expect(computeCanonicalKey('Blanc de Blancs', 'Pongrácz', 'Méthode Cap Classique')).toBe(computeCanonicalKey('Blanc de Blancs', 'Pongrácz', ''));
  });

  test('a real appellation keys exactly as before', () => {
    expect(generateWineKey('Cruasé', 'Frecciarossa', 'Oltrepò Pavese Metodo Classico')).toMatch(/:oltrepo pavese metodo classico$/);
    expect(computeCanonicalKey('Cruasé', 'Frecciarossa', 'Oltrepò Pavese Metodo Classico')).toMatch(/:oltrepo pavese metodo classico$/);
    expect(computeCanonicalKey('Riserva', 'Azelia', 'Barolo DOCG')).toBe(computeCanonicalKey('Riserva', 'Azelia', 'Barolo'));
    expect(generateWineKey('Riserva', 'Azelia', 'Barolo')).toMatch(/:barolo$/);
  });
});
