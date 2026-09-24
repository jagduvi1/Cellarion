import {
  OFFLINE_MODE_RELEASED,
  isOfflineModeEnabled,
  saveOfflineUser,
  loadOfflineUser,
  clearOfflineUser,
  markPendingLogout,
  hasPendingLogout,
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
  it('is released: off by default in a plain browser tab', () => {
    expect(OFFLINE_MODE_RELEASED).toBe(true);
    expect(isOfflineModeEnabled()).toBe(false);
  });

  it('on by default in the installed app — and still after a reload that loses the app marker', () => {
    const mm = window.matchMedia;
    window.matchMedia = (q) => ({ matches: q === '(display-mode: standalone)' });
    try {
      expect(isOfflineModeEnabled()).toBe(true);
    } finally {
      window.matchMedia = mm;
    }
    // A later load where the app isn't recognisable (the TWA referrer is gone):
    expect(isOfflineModeEnabled()).toBe(true);
    // The user's own choice always wins.
    localStorage.setItem('cellarion-offline', 'off');
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
    saveOfflineUser(USER, { persistent: true });
    expect(localStorage.getItem('cellarion-offline-user')).toBeNull();
    localStorage.setItem('cellarion-offline', 'on');
    expect(loadOfflineUser()).toBeNull();
  });

  it('keeps only what the UI needs — no email, bio, consent or super-admin flag', () => {
    localStorage.setItem('cellarion-offline', 'on');
    saveOfflineUser(USER, { persistent: true });
    const kept = loadOfflineUser();
    expect(kept).toEqual({
      _id: 'u1', id: 'u1', username: 'anna', displayName: 'Anna', roles: ['user'], plan: 'free',
      preferences: { language: 'sv', currency: 'SEK' },
    });
  });

  it('is not handed out once offline mode is switched off', () => {
    localStorage.setItem('cellarion-offline', 'on');
    saveOfflineUser(USER, { persistent: true });
    localStorage.setItem('cellarion-offline', 'off');
    expect(loadOfflineUser()).toBeNull();
  });

  it('clearOfflineUser removes it; a corrupt entry reads as none', () => {
    localStorage.setItem('cellarion-offline', 'on');
    saveOfflineUser(USER, { persistent: true });
    clearOfflineUser();
    expect(loadOfflineUser()).toBeNull();
    localStorage.setItem('cellarion-offline-user', '{not json');
    expect(loadOfflineUser()).toBeNull();
  });
});

describe('audit fixes — who may start offline', () => {
  beforeEach(() => localStorage.setItem('cellarion-offline', 'on'));

  it('a browser-only ("remember me" off) session is never kept for an offline start', () => {
    saveOfflineUser(USER, { persistent: true });
    saveOfflineUser(USER, { persistent: false });
    expect(localStorage.getItem('cellarion-offline-user')).toBeNull();
    expect(loadOfflineUser()).toBeNull();
  });

  it('a profile the server has not confirmed for 30 days is not used', () => {
    saveOfflineUser(USER, { persistent: true });
    const kept = JSON.parse(localStorage.getItem('cellarion-offline-user'));
    kept._verifiedAt = Date.now() - 31 * 24 * 60 * 60 * 1000;
    localStorage.setItem('cellarion-offline-user', JSON.stringify(kept));
    expect(loadOfflineUser()).toBeNull();
  });

  it('the verification stamp is not handed out as a user field', () => {
    saveOfflineUser(USER, { persistent: true });
    expect(loadOfflineUser()._verifiedAt).toBeUndefined();
  });

  it('a logout that could not reach the server is remembered until done', () => {
    expect(hasPendingLogout()).toBe(false);
    markPendingLogout(true);
    expect(hasPendingLogout()).toBe(true);
    markPendingLogout(false);
    expect(hasPendingLogout()).toBe(false);
  });
});
