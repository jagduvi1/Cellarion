const { getCellarRole } = require('./cellarAccess');

// Minimal ObjectId-like helper: plain strings work because .toString() is called
const id = (str) => str; // already a string

describe('getCellarRole', () => {
  test('returns null when cellar is null', () => {
    expect(getCellarRole(null, 'user1')).toBeNull();
  });

  test('returns null when userId is null', () => {
    const cellar = { user: 'owner1', members: [] };
    expect(getCellarRole(cellar, null)).toBeNull();
  });

  test('returns "owner" when userId matches cellar.user (unpopulated string)', () => {
    const cellar = { user: 'owner1', members: [] };
    expect(getCellarRole(cellar, 'owner1')).toBe('owner');
  });

  test('returns "owner" when userId matches cellar.user._id (populated document)', () => {
    const cellar = { user: { _id: 'owner1' }, members: [] };
    expect(getCellarRole(cellar, 'owner1')).toBe('owner');
  });

  test('returns member role (editor) for a member with edit access', () => {
    const cellar = {
      user: 'owner1',
      members: [{ user: 'user2', role: 'editor' }],
    };
    expect(getCellarRole(cellar, 'user2')).toBe('editor');
  });

  test('returns member role (viewer) for a read-only member', () => {
    const cellar = {
      user: 'owner1',
      members: [{ user: 'user2', role: 'viewer' }],
    };
    expect(getCellarRole(cellar, 'user2')).toBe('viewer');
  });

  test('handles populated member user object (member.user._id)', () => {
    const cellar = {
      user: 'owner1',
      members: [{ user: { _id: 'user2' }, role: 'editor' }],
    };
    expect(getCellarRole(cellar, 'user2')).toBe('editor');
  });

  test('returns null for a user who is neither owner nor member', () => {
    const cellar = {
      user: 'owner1',
      members: [{ user: 'user2', role: 'viewer' }],
    };
    expect(getCellarRole(cellar, 'stranger')).toBeNull();
  });

  test('returns null when members array is absent', () => {
    const cellar = { user: 'owner1' };
    expect(getCellarRole(cellar, 'stranger')).toBeNull();
  });

  test('handles multiple members and finds the correct one', () => {
    const cellar = {
      user: 'owner1',
      members: [
        { user: 'user2', role: 'viewer' },
        { user: 'user3', role: 'editor' },
      ],
    };
    expect(getCellarRole(cellar, 'user2')).toBe('viewer');
    expect(getCellarRole(cellar, 'user3')).toBe('editor');
  });
});
