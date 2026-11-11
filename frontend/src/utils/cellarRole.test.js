import { canEditCellar } from './cellarRole';

describe('canEditCellar', () => {
  test('the owner and an editor may edit', () => {
    expect(canEditCellar({ userRole: 'owner' })).toBe(true);
    expect(canEditCellar({ userRole: 'editor' })).toBe(true);
  });

  test('a viewer may not', () => {
    expect(canEditCellar({ userRole: 'viewer' })).toBe(false);
  });

  test('a cellar that has not loaded yet is not editable', () => {
    expect(canEditCellar(null)).toBe(false);
    expect(canEditCellar(undefined)).toBe(false);
  });

  test('a cellar without a role, or with one this app does not know, is not editable', () => {
    expect(canEditCellar({})).toBe(false);
    expect(canEditCellar({ userRole: null })).toBe(false);
    expect(canEditCellar({ userRole: 'admin' })).toBe(false);
  });
});
