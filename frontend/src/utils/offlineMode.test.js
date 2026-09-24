import {
  OFFLINE_MODE_RELEASED,
  isOfflineModeEnabled,
  saveOfflineUser,
  loadOfflineUser,
  clearOfflineUser,
} from './offlineMode';

const USER = {
  _id: 'u1', id: 'u1', username: 'anna', displayName: 'Anna', roles: ['user'], plan: 'free',
  preferences: { language: 'sv', currency: 'SEK' },
  email: 'anna@example.com', bio: 'hello', isSuperAdmin: true, gdprConsent: { version: 'x' },
};

// Node >=22 ships a global localStorage stub that shadows jsdom's (no clear()).
function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => { m.clear(); },
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}

beforeEach(() => { vi.stubGlobal('localStorage', memoryStorage()); });
afterEach(() => vi.unstubAllGlobals());

describe('offline mode switch', () => {
  it('is not released yet: off by default', () => {
    expect(OFFLINE_MODE_RELEASED).toBe(false);
    expect(isOfflineModeEnabled()).toBe(false);
  });

  it('can be switched on (and off) for this browser', () => {
    localStorage.setItem('cellarion-offline', 'on');
    expect(isOfflineModeEnabled()).toBe(true);
    localStorage.setItem('cellarion-offline', 'off');
    expect(isOfflineModeEnabled()).toBe(false);
  });
});

describe('profile kept for an offline start', () => {
  it('is only kept while offline mode is on', () => {
    saveOfflineUser(USER);
    expect(localStorage.getItem('cellarion-offline-user')).toBeNull();
    localStorage.setItem('cellarion-offline', 'on');
    expect(loadOfflineUser()).toBeNull();
  });

  it('keeps only what the UI needs — no email, bio, consent or super-admin flag', () => {
    localStorage.setItem('cellarion-offline', 'on');
    saveOfflineUser(USER);
    const kept = loadOfflineUser();
    expect(kept).toEqual({
      _id: 'u1', id: 'u1', username: 'anna', displayName: 'Anna', roles: ['user'], plan: 'free',
      preferences: { language: 'sv', currency: 'SEK' },
    });
  });

  it('is not handed out once offline mode is switched off', () => {
    localStorage.setItem('cellarion-offline', 'on');
    saveOfflineUser(USER);
    localStorage.setItem('cellarion-offline', 'off');
    expect(loadOfflineUser()).toBeNull();
  });

  it('clearOfflineUser removes it; a corrupt entry reads as none', () => {
    localStorage.setItem('cellarion-offline', 'on');
    saveOfflineUser(USER);
    clearOfflineUser();
    expect(loadOfflineUser()).toBeNull();
    localStorage.setItem('cellarion-offline-user', '{not json');
    expect(loadOfflineUser()).toBeNull();
  });
});
