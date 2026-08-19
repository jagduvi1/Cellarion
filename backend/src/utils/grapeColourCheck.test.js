const { findGrapeColourConflict } = require('./grapeColourCheck');

const RED = (name) => ({ name, color: 'Red' });
const WHITE = (name) => ({ name, color: 'White' });

describe('findGrapeColourConflict', () => {
  describe('red (or rosé) from only white grapes — always a conflict', () => {
    // Every one of these is a real prod row from the 2026-08-19 scan.
    it('flags a red stored on a single white grape', () => {
      expect(findGrapeColourConflict({
        type: 'red', name: 'Sauvignon Blanc', producer: 'Screaming Eagle', grapes: [WHITE('Sauvignon Blanc')],
      })).toMatch(/every grape is white/);
    });

    it('flags a red stored on an all-white blend', () => {
      expect(findGrapeColourConflict({
        type: 'red', name: 'Séguret', producer: 'Domaine des Bosquets',
        grapes: [WHITE('Viognier'), WHITE('Roussanne'), WHITE('Marsanne')],
      })).toMatch(/every grape is white/);
    });

    it('flags the two rows that arrived from a live import after v1.139.0', () => {
      expect(findGrapeColourConflict({
        type: 'red', name: 'Conte di Valle Veronese', producer: 'Palazzo Maffei', grapes: [WHITE('Sauvignon Blanc')],
      })).toBeTruthy();
      expect(findGrapeColourConflict({
        type: 'red', name: 'Almodi Petit', producer: 'Altavins Viticultors', grapes: [WHITE('Grenache Blanc')],
      })).toBeTruthy();
    });

    it('does NOT flag a red whose grapes are red', () => {
      expect(findGrapeColourConflict({
        type: 'red', name: 'Barolo', producer: 'Whoever', grapes: [RED('Nebbiolo')],
      })).toBeNull();
    });

    it('does NOT flag a mixed blend — one dark grape is enough to make a red', () => {
      expect(findGrapeColourConflict({
        type: 'red', name: 'Côte-Rôtie', producer: 'Whoever', grapes: [RED('Syrah'), WHITE('Viognier')],
      })).toBeNull();
    });
  });

  describe('white from only red grapes — a real style, so the name decides', () => {
    it('exempts an explicit blanc de noirs', () => {
      expect(findGrapeColourConflict({
        type: 'white', name: 'Blanc de Noir Spätburgunder', producer: 'Weingut Burggarten', grapes: [RED('Pinot Noir')],
      })).toBeNull();
    });

    it('exempts "Bianco" and "Blanc" claims in other languages', () => {
      expect(findGrapeColourConflict({
        type: 'white', name: 'Bianco di Morgante', producer: 'Morgante', grapes: [RED("Nero d'Avola")],
      })).toBeNull();
      expect(findGrapeColourConflict({
        type: 'white', name: 'Pinotage Blanc', producer: 'Aaldering', grapes: [RED('Pinotage')],
      })).toBeNull();
    });

    it('flags a white on red grapes when the name makes no white claim', () => {
      expect(findGrapeColourConflict({
        type: 'white', name: "Director's Reserve", producer: 'Tokara',
        grapes: [RED('Cabernet Sauvignon'), RED('Merlot'), RED('Cabernet Franc'), RED('Petit Verdot')],
      })).toMatch(/no white claim/);
    });

    it('does not accept a colour word that belongs to the PRODUCER', () => {
      // "Mas Blanc" is the estate; the wine claims nothing.
      expect(findGrapeColourConflict({
        type: 'white', name: 'Tradition', producer: 'Mas Blanc', grapes: [RED('Grenache')],
      })).toMatch(/no white claim/);
    });

    it('does not treat "Rosato" as a white claim — that row is a mis-typed rosé', () => {
      expect(findGrapeColourConflict({
        type: 'white', name: 'Ancestor Vine Rosato 1850', producer: 'Cirillo Estate', grapes: [RED('Grenache')],
      })).toBeTruthy();
    });
  });

  describe('silence is the safe direction', () => {
    it('says nothing when a grape has no curated colour', () => {
      expect(findGrapeColourConflict({
        type: 'red', name: 'X', producer: 'Y', grapes: [WHITE('Sauvignon Blanc'), { name: 'Cabernet', color: null }],
      })).toBeNull();
    });

    it('says nothing for types that make no colour claim', () => {
      for (const type of ['sparkling', 'dessert', 'fortified']) {
        expect(findGrapeColourConflict({
          type, name: 'Blanc de Noirs', producer: 'A House', grapes: [RED('Pinot Noir')],
        })).toBeNull();
      }
    });

    // Rosé is deliberately unjudged. These four are REAL prod rows an earlier
    // draft flagged: two pink-skinned varieties our Red/White taxonomy stores
    // as White, and two skin-contact orange wines with no type of their own.
    it('never judges rosé, whichever way the grapes point', () => {
      const rosés = [
        { name: 'Rosato', producer: 'Canaletto', grapes: [WHITE('Pinot Gris')] },
        { name: 'Muscat Beaumes de Venise Rosé', producer: 'Alain Ignace', grapes: [WHITE('Muscat Blanc à Petits Grains')] },
        { name: 'Nanit Orange Wine', producer: 'Hammeken Cellars', grapes: [WHITE('Macabeo')] },
        { name: 'Macération', producer: 'Charles Frey', grapes: [WHITE('Gewürztraminer'), WHITE('Muscat')] },
        { name: 'Anything', producer: 'Whoever', grapes: [RED('Grenache')] },
      ];
      for (const w of rosés) expect(findGrapeColourConflict({ ...w, type: 'rosé' })).toBeNull();
    });

    it('says nothing with no grapes, no type, or an unpopulated grape array', () => {
      expect(findGrapeColourConflict({ type: 'red', name: 'X', producer: 'Y', grapes: [] })).toBeNull();
      expect(findGrapeColourConflict({ type: null, name: 'X', producer: 'Y', grapes: [WHITE('Riesling')] })).toBeNull();
      expect(findGrapeColourConflict({ type: 'red', name: 'X', producer: 'Y', grapes: ['64f0a1b2c3d4e5f6a7b8c9d0'] })).toBeNull();
      expect(findGrapeColourConflict({})).toBeNull();
      expect(findGrapeColourConflict(null)).toBeNull();
    });
  });

  it('names the offending grapes so a curator can act without opening the row', () => {
    expect(findGrapeColourConflict({
      type: 'red', name: 'Autoctona', producer: 'Barranco Oscuro', grapes: [WHITE('Vigiriega')],
    })).toContain('Vigiriega');
  });
});
