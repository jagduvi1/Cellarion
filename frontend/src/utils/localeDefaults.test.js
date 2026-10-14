import { guessCurrency } from './localeDefaults';

describe('guessCurrency', () => {
  test('the time zone decides first: an English (US) browser in Stockholm is SEK', () => {
    expect(guessCurrency({ timeZone: 'Europe/Stockholm', languages: ['en-US'] })).toBe('SEK');
  });

  test('an English (US) browser in Toronto is CAD, in New York USD', () => {
    expect(guessCurrency({ timeZone: 'America/Toronto', languages: ['en-US'] })).toBe('CAD');
    expect(guessCurrency({ timeZone: 'America/New_York', languages: ['sv-SE', 'en'] })).toBe('USD');
  });

  test('euro-area zones give EUR, including Bulgaria (euro since 2026)', () => {
    expect(guessCurrency({ timeZone: 'Europe/Paris', languages: ['fr-FR'] })).toBe('EUR');
    expect(guessCurrency({ timeZone: 'Europe/Sofia', languages: [] })).toBe('EUR');
  });

  test('the Channel Islands and any Australian zone', () => {
    expect(guessCurrency({ timeZone: 'Europe/Jersey', languages: [] })).toBe('GBP');
    expect(guessCurrency({ timeZone: 'Australia/Perth', languages: [] })).toBe('AUD');
  });

  test('a known country whose currency is not supported stops the guess', () => {
    // A Pole with an English (UK) browser is not a GBP collector.
    expect(guessCurrency({ timeZone: 'Europe/Warsaw', languages: ['en-GB'] })).toBeNull();
  });

  test('without a known zone, a tag that names its region wins over a bare one', () => {
    expect(guessCurrency({ timeZone: 'Etc/UTC', languages: ['en', 'sv-SE'] })).toBe('SEK');
    expect(guessCurrency({ timeZone: null, languages: ['pt-BR', 'en-GB'] })).toBe('GBP');
  });

  test('a bare language finds its likely region where the zone is European or unknown', () => {
    expect(guessCurrency({ timeZone: null, languages: ['sv'] })).toBe('SEK');
    expect(guessCurrency({ timeZone: 'Europe/Oslo', languages: ['nb'] })).toBe('NOK');
    expect(guessCurrency({ timeZone: 'UTC', languages: ['da'] })).toBe('DKK');
  });

  test('…but not elsewhere: a bare "es" in Mexico is not a euro collector', () => {
    expect(guessCurrency({ timeZone: 'America/Mexico_City', languages: ['es'] })).toBeNull();
  });

  test('answers null when nothing points at a supported currency', () => {
    expect(guessCurrency({ timeZone: 'America/Sao_Paulo', languages: ['pt-BR'] })).toBeNull();
    expect(guessCurrency({ timeZone: null, languages: ['not a tag!'] })).toBeNull();
    expect(guessCurrency({ timeZone: null, languages: [] })).toBeNull();
  });
});
