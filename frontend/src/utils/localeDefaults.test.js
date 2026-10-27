import { guessCurrency, guessTemperatureUnit } from './localeDefaults';

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

// Release audit 2026-10-16: en-GB is the English many devices outside Europe
// are set to; other languages' regions still count.
test('an English region tag outside Europe says nothing about money', () => {
  expect(guessCurrency({ timeZone: 'Asia/Kolkata', languages: ['en-GB'] })).toBeNull();
  expect(guessCurrency({ timeZone: 'Asia/Dubai', languages: ['en-GB', 'en'] })).toBeNull();
  expect(guessCurrency({ timeZone: 'Asia/Bangkok', languages: ['sv-SE'] })).toBe('SEK');
  expect(guessCurrency({ timeZone: 'America/Puerto_Rico', languages: ['en-US'] })).toBe('USD');
});

describe('guessTemperatureUnit', () => {
  test('a US time zone reads Fahrenheit; Canada, the UK and Europe read Celsius', () => {
    expect(guessTemperatureUnit({ timeZone: 'America/New_York', languages: ['en-US'] })).toBe('F');
    expect(guessTemperatureUnit({ timeZone: 'America/Los_Angeles', languages: ['sv-SE'] })).toBe('F');
    expect(guessTemperatureUnit({ timeZone: 'America/Toronto', languages: ['en-US'] })).toBe('C');
    expect(guessTemperatureUnit({ timeZone: 'Europe/London', languages: ['en-US'] })).toBe('C');
    expect(guessTemperatureUnit({ timeZone: 'Europe/Stockholm', languages: ['en-US'] })).toBe('C');
  });

  test('a zone outside the table is Celsius; only an unknown zone lets the language tag decide', () => {
    expect(guessTemperatureUnit({ timeZone: 'Australia/Sydney', languages: ['en-US'] })).toBe('C');
    expect(guessTemperatureUnit({ timeZone: null, languages: ['en-US'] })).toBe('F');
    expect(guessTemperatureUnit({ timeZone: null, languages: ['en-GB', 'en-US'] })).toBe('C');
    expect(guessTemperatureUnit({ timeZone: null, languages: ['en'] })).toBe('C');
    expect(guessTemperatureUnit({ timeZone: null, languages: [] })).toBe('C');
  });
});
