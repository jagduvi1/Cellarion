import { describe, it, expect } from 'vitest';
import { isTranslation, languageName, nativeLanguageName } from './blogLanguage';

describe('isTranslation', () => {
  it('is true only for a post that points at an original', () => {
    expect(isTranslation({ translationOf: '6aa9257367c260237d47185d' })).toBe(true);
    expect(isTranslation({ translationOf: null })).toBe(false);
    expect(isTranslation({})).toBe(false);
    expect(isTranslation(null)).toBe(false);
  });
});

describe('languageName', () => {
  it('names a language in the reader\'s language, or answers the code when it cannot', () => {
    expect(languageName('fr', 'en')).toBe('French');
    expect(languageName('zz-not-a-code', 'en')).toBe('zz-not-a-code');
  });
});

describe('nativeLanguageName', () => {
  it('names a language in itself, capitalised, so its readers find it in any page language', () => {
    expect(nativeLanguageName('sv')).toBe('Svenska');
    expect(nativeLanguageName('fr')).toBe('Français');
  });
});
