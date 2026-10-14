import { guessCurrency } from './localeDefaults';

describe('guessCurrency', () => {
  test('the time zone decides first: an English (US) browser in Stockholm is SEK', () => {
    expect(guessCurrency({ timeZone: 'Europe/Stockholm', languages: ['en-US'] })).toBe('SEK');
  });

  test('euro-area zones give EUR, including Bulgaria (euro since 2026)', () => {
    expect(guessCurrency({ timeZone: 'Europe/Paris', languages: ['fr-FR'] })).toBe('EUR');
    expect(guessCurrency({ timeZone: 'Europe/Sofia', languages: [] })).toBe('EUR');
  });

  test('any Australian zone gives AUD', () => {
    expect(guessCurrency({ timeZone: 'Australia/Perth', languages: [] })).toBe('AUD');
  });

  test('a zone shared by several currencies falls back to the language region', () => {
    expect(guessCurrency({ timeZone: 'America/Toronto', languages: ['en-CA'] })).toBe('CAD');
    expect(guessCurrency({ timeZone: 'America/New_York', languages: ['sv-SE', 'en'] })).toBe('SEK');
  });

  test('a bare language finds its likely region', () => {
    expect(guessCurrency({ timeZone: null, languages: ['sv'] })).toBe('SEK');
    expect(guessCurrency({ timeZone: null, languages: ['nb'] })).toBe('NOK');
  });

  test('skips languages whose region has no supported currency', () => {
    expect(guessCurrency({ timeZone: null, languages: ['pt-BR', 'en-GB'] })).toBe('GBP');
  });

  test('answers null when nothing points at a supported currency', () => {
    expect(guessCurrency({ timeZone: 'America/Sao_Paulo', languages: ['pt-BR'] })).toBeNull();
    expect(guessCurrency({ timeZone: null, languages: ['not a tag!'] })).toBeNull();
    expect(guessCurrency({ timeZone: null, languages: [] })).toBeNull();
  });
});
