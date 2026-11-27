/**
 * Ma Cave à Vins import — one flat ";" file whose column names follow the
 * app's language (German here), "-" in every empty cell, litre sizes with a
 * decimal comma, day-first dates, one row per wine with its bottle count.
 *
 * The header row is the app's own; the wines are invented. The file is built
 * the way the app writes it: CR CR LF between rows, a comment with a line
 * break inside quotes.
 */
import { describe, it, expect } from 'vitest';
import { parseAndMap, detectFormat, detectMaCaveFile } from './importMappers';

const HEADER = 'Name;Kategorie;Jahrgang;Land;Region;Unterregion;Appellation;Winzer / Weingut;Standort;Kaufpreis;Marktwert;Währung;Menge;Kaufpreis gesamt;Marktwert gesamt;Kapazität;Konsumiert;Bewertung (/5);Lagerung;Alkoholgehalt;Rebsorten;Speise- und Weinpaarungen;Kommentar;Hinzufügedatum;Foto';
const PHOTO = 'https://firebasestorage.googleapis.com/v0/b/ma-cave-a-vins-app.appspot.com/o/wines%2Fexample%2Fphoto-1?alt=media&token=example';

const ROWS = [
  `Beispiel Riesling Kabinett;Weiß;2022;Deutschland;Mosel;Bernkastel;-;Beispiel;Keller links;8,5;-;EUR;3;25,5;-;0,75;-;4;-;10,5;100% Riesling;Fisch;-;24-09-2026;${PHOTO}`,
  'Spätburgunder Alte Reben;Rot;2019;Deutschland;Baden;-;Kaiserstuhl;Weingut Muster;-;14;-;EUR;1;14;-;1,5;-;;-;13;Spätburgunder;-;;01-10-2026;',
  'Brut Rosé;Schaumwein;-;Frankreich;Champagne;-;Champagne;Maison Exemple;-;-;-;EUR;2;-;-;0,75;-;;-;12;60% Pinot Noir, 40% Chardonnay;-;"Für Silvester.\r\nZweite Zeile";15-08-2026;',
  'Leer getrunken;Rot;2018;Spanien;Rioja;-;Rioja;Bodega Ejemplo;-;9;-;EUR;0;0;-;0,75;-;;-;13,5;Tempranillo;-;-;02-02-2026;',
];

const fileText = (rows = ROWS) => [HEADER, ...rows].join('\r\r\n') + '\r\r\n';

describe('Ma Cave à Vins: recognising the file', () => {
  it('reads the German export as its own format', () => {
    expect(detectMaCaveFile(HEADER.split(';'))).toBe(true);
    expect(detectFormat(HEADER.split(';'))).toBe('macave');
    expect(parseAndMap(fileText()).format).toBe('macave');
  });

  it('reads headers whose accents are written as combining marks', () => {
    expect(detectMaCaveFile(HEADER.normalize('NFD').split(';'))).toBe(true);
  });

  it('leaves a German file without the app\'s columns to the generic reader', () => {
    expect(detectFormat(['Name', 'Jahrgang', 'Winzer / Weingut', 'Menge'])).toBe('generic');
  });
});

describe('Ma Cave à Vins: the columns', () => {
  const { items } = parseAndMap(fileText());
  const byName = (name) => items.filter((it) => it.wineName === name);

  it('reads producer, vintage, place, type, grapes, price, size, rating and the date added', () => {
    const [riesling] = byName('Riesling Kabinett');
    expect(riesling).toMatchObject({
      producer: 'Beispiel',
      vintage: '2022',
      country: 'Deutschland',
      region: 'Mosel',
      // An empty appellation falls back to the sub-region.
      appellation: 'Bernkastel',
      type: 'white',
      grapes: ['Riesling'],
      price: 8.5,
      currency: 'EUR',
      bottleSize: '750ml',
      location: 'Keller links',
      rating: 4,
      ratingScale: '5',
      dateAdded: '2026-09-24',
    });
    expect(riesling.vintageMissing).toBeUndefined();
  });

  it('expands the bottle count, and a wine with nothing left becomes no bottle', () => {
    expect(byName('Riesling Kabinett')).toHaveLength(3);
    expect(byName('Brut Rosé')).toHaveLength(2);
    expect(byName('Leer getrunken')).toHaveLength(0);
    expect(items).toHaveLength(6);
  });

  it('reads "-" as an empty cell', () => {
    const [pinot] = byName('Spätburgunder Alte Reben');
    expect(pinot.location).toBe('');
    expect(pinot.notes).toBe('');
    const [sekt] = byName('Brut Rosé');
    expect(sekt.price).toBeUndefined();
    expect(sekt).toMatchObject({ vintage: 'NV', vintageMissing: true });
  });

  it('reads the German categories and a size in litres', () => {
    expect(byName('Spätburgunder Alte Reben')[0]).toMatchObject({ type: 'red', bottleSize: '1500ml' });
    expect(byName('Brut Rosé')[0].type).toBe('sparkling');
  });

  it('keeps a comment with a line break, and the pairings under the file\'s own header', () => {
    expect(byName('Brut Rosé')[0].notes).toBe('Für Silvester.\r\nZweite Zeile');
    expect(byName('Riesling Kabinett')[0].notes).toBe('Speise- und Weinpaarungen: Fisch');
  });

  it('strips the blend shares from the grapes', () => {
    expect(byName('Brut Rosé')[0].grapes).toEqual(['Pinot Noir', 'Chardonnay']);
  });

  it('warns only about the bottles that really have no vintage', () => {
    const { warnings } = parseAndMap(fileText());
    expect(warnings).toEqual([{ code: 'vintage-missing', count: 2 }]);
  });
});

describe('Ma Cave à Vins: an appellation that is the producer', () => {
  it('uses the sub-region instead', () => {
    const row = 'Cuvée;Rot;2020;Deutschland;Mosel;Piesport;Weingut Muster;Weingut Muster;-;-;-;EUR;1;-;-;0,75;-;;-;-;-;-;-;01-01-2026;';
    expect(parseAndMap(fileText([row])).items[0].appellation).toBe('Piesport');
  });
});

describe('Ma Cave à Vins: the producer in the name', () => {
  const row = (name, producer) => `${name};Rot;2020;Deutschland;Pfalz;-;-;${producer};-;-;-;EUR;1;-;-;0,75;-;;-;-;-;-;-;01-01-2026;`;

  it('takes the producer off the front of the name', () => {
    const { items } = parseAndMap(fileText([row('Beispiel Riesling Sekt trocken', 'Beispiel')]));
    expect(items[0].wineName).toBe('Riesling Sekt trocken');
  });

  it('leaves a name that only starts with the same letters', () => {
    const { items } = parseAndMap(fileText([row('Beispielhof Cuvée', 'Beispiel')]));
    expect(items[0].wineName).toBe('Beispielhof Cuvée');
  });
});

describe('Ma Cave à Vins: what is not imported is said', () => {
  it('names the consumed column when a row has a count in it', () => {
    const drunk = ROWS[3].replace(';0,75;-;', ';0,75;4;');
    const { warnings } = parseAndMap(fileText([ROWS[0], drunk]));
    expect(warnings).toContainEqual({ code: 'macave-consumed-not-imported', count: 1, column: 'Konsumiert' });
  });

  it('says nothing about the consumed column when it only holds "-"', () => {
    const { warnings = [] } = parseAndMap(fileText());
    expect(warnings.map((w) => w.code)).not.toContain('macave-consumed-not-imported');
  });

  it('does not call a price column of "-" unread', () => {
    const { warnings = [] } = parseAndMap(fileText([ROWS[2]]));
    expect(warnings.map((w) => w.code)).not.toContain('price-not-read');
  });
});
