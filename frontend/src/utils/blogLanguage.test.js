import { describe, it, expect } from 'vitest';
import { readerLanguage, isTranslation, languageName } from './blogLanguage';

describe('readerLanguage', () => {
  it('is the base code of the language the app shows', () => {
    expect(readerLanguage({ resolvedLanguage: 'sv', language: 'sv' })).toBe('sv');
    expect(readerLanguage({ language: 'fr-CA' })).toBe('fr');
    expect(readerLanguage({ language: 'DE' })).toBe('de');
  });

  it('is English when the app names no usable language', () => {
    // Tests and early renders hand over no i18n instance at all.
    expect(readerLanguage(undefined)).toBe('en');
    expect(readerLanguage({})).toBe('en');
    expect(readerLanguage({ language: '1x' })).toBe('en');
  });
});

describe('isTranslation', () => {
  it('is true only for a post that points at an original', () => {
    expect(isTranslation({ translationOf: '6aa9257367c260237d47185d' })).toBe(true);
    expect(isTranslation({ translationOf: null })).toBe(false);
    expect(isTranslation({})).toBe(false);
    expect(isTranslation(null)).toBe(false);
  });
});

describe('languageName', () => {
  it('names a language, or answers the code when it cannot', () => {
    expect(languageName('fr', 'en')).toBe('French');
    expect(languageName('zz-not-a-code', 'en')).toBe('zz-not-a-code');
  });
});
