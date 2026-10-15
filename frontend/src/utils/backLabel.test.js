import { backLabel } from './backLabel';

// The back links draw a chevron; a label that also starts with an arrow read
// "‹ ← Back to …" (live walkthrough 2026-10-15).
test('drops one leading arrow, whatever the language', () => {
  expect(backLabel('← Back to Cellars')).toBe('Back to Cellars');
  expect(backLabel('←Tillbaka till källaren')).toBe('Tillbaka till källaren');
  expect(backLabel('‹ Zurück')).toBe('Zurück');
});

test('leaves a label without one alone', () => {
  expect(backLabel('Racks')).toBe('Racks');
  expect(backLabel('Back to → somewhere')).toBe('Back to → somewhere');
  expect(backLabel(undefined)).toBe('');
});
