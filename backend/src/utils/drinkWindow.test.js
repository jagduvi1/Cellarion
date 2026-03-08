const { classifyDrinkWindow } = require('./drinkWindow');

const DAY = 24 * 60 * 60 * 1000;
const d = (offsetDays) => new Date(Date.now() + offsetDays * DAY);

describe('classifyDrinkWindow', () => {
  const now = new Date();

  test('no from and no before → noWindow', () => {
    expect(classifyDrinkWindow(null, null, now)).toBe('noWindow');
  });

  test('before in the past → overdue', () => {
    expect(classifyDrinkWindow(null, d(-1), now)).toBe('overdue');
  });

  test('before within 90 days → soon', () => {
    expect(classifyDrinkWindow(null, d(45), now)).toBe('soon');
  });

  test('before exactly 90 days away → soon', () => {
    expect(classifyDrinkWindow(null, d(90), now)).toBe('soon');
  });

  test('before beyond 90 days, no from → inWindow (already started)', () => {
    expect(classifyDrinkWindow(null, d(180), now)).toBe('inWindow');
  });

  test('before beyond 90 days, from in the past → inWindow', () => {
    expect(classifyDrinkWindow(d(-30), d(180), now)).toBe('inWindow');
  });

  test('before beyond 90 days, from in the future → notReady', () => {
    expect(classifyDrinkWindow(d(30), d(180), now)).toBe('notReady');
  });

  test('only from, in the past → inWindow', () => {
    expect(classifyDrinkWindow(d(-10), null, now)).toBe('inWindow');
  });

  test('only from, in the future → notReady', () => {
    expect(classifyDrinkWindow(d(10), null, now)).toBe('notReady');
  });

  test('before exactly today (0 days left) → soon', () => {
    // Math.round(0 / DAY) = 0, which is ≤ 90 → 'soon'
    expect(classifyDrinkWindow(null, now, now)).toBe('soon');
  });
});
