import { describe, it, expect } from 'vitest';
import { confirmWordFrom, matchesConfirmWord } from './confirmWord';

describe('confirmWordFrom', () => {
  it('reads the word inside <strong> of the translated sentence', () => {
    expect(confirmWordFrom('Type <strong>DELETE</strong> to confirm:', 'DELETE')).toBe('DELETE');
    expect(confirmWordFrom('Schreibe <strong>LÖSCHEN</strong> zur Bestätigung:', 'DELETE')).toBe('LÖSCHEN');
    expect(confirmWordFrom('Skriv <strong> SLETT </strong> for å bekrefte:', 'DELETE')).toBe('SLETT');
  });

  it('falls back when the sentence has no <strong> part', () => {
    expect(confirmWordFrom('Type DELETE to confirm:', 'DELETE')).toBe('DELETE');
    expect(confirmWordFrom('', 'DELETE')).toBe('DELETE');
    expect(confirmWordFrom(undefined, 'DELETE')).toBe('DELETE');
    expect(confirmWordFrom('Type <strong> </strong> to confirm:', 'DELETE')).toBe('DELETE');
  });
});

describe('matchesConfirmWord', () => {
  const words = ['LÖSCHEN', 'DELETE'];

  it('accepts the translated word and the English one, ignoring case and spaces', () => {
    expect(matchesConfirmWord('LÖSCHEN', words)).toBe(true);
    expect(matchesConfirmWord(' löschen ', words)).toBe(true);
    expect(matchesConfirmWord('DELETE', words)).toBe(true);
    expect(matchesConfirmWord('delete', words)).toBe(true);
  });

  it('refuses anything else', () => {
    expect(matchesConfirmWord('', words)).toBe(false);
    expect(matchesConfirmWord('   ', words)).toBe(false);
    expect(matchesConfirmWord('DELET', words)).toBe(false);
    expect(matchesConfirmWord('DELETE ME', words)).toBe(false);
  });
});
