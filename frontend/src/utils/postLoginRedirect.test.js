/**
 * The destination is only ever written by our own code, so these cases are
 * about the guarantee holding locally rather than about a live attack path —
 * if a ?next= parameter is ever wired in, this is the file that says what
 * "safe" means.
 */
import { isSafeInternalPath, stashPostLoginRedirect, takePostLoginRedirect } from './postLoginRedirect';

beforeEach(() => {
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('isSafeInternalPath', () => {
  it('accepts a root-relative path, query string included', () => {
    expect(isSafeInternalPath('/cellars/6a74f551/room?focusRack=6a750135')).toBe(true);
    expect(isSafeInternalPath('/')).toBe(true);
  });

  it('rejects anything that is not a non-empty string', () => {
    expect(isSafeInternalPath(null)).toBe(false);
    expect(isSafeInternalPath(undefined)).toBe(false);
    expect(isSafeInternalPath('')).toBe(false);
    expect(isSafeInternalPath(42)).toBe(false);
    expect(isSafeInternalPath({ toString: () => '/cellars' })).toBe(false);
  });

  it('rejects paths that leave the origin', () => {
    expect(isSafeInternalPath('https://evil.example/steal')).toBe(false);
    expect(isSafeInternalPath('//evil.example/steal')).toBe(false); // protocol-relative
    expect(isSafeInternalPath('/\\evil.example')).toBe(false);      // browsers fold \ to /
    expect(isSafeInternalPath('cellars')).toBe(false);              // not root-relative
    expect(isSafeInternalPath('javascript:alert(1)')).toBe(false);
  });

  it('rejects control characters smuggled into the path', () => {
    expect(isSafeInternalPath('/cellars\n/evil')).toBe(false);
    expect(isSafeInternalPath('/cellars\t/evil')).toBe(false);
  });

  it('rejects a path long enough to be storage rather than a destination', () => {
    expect(isSafeInternalPath(`/${'a'.repeat(511)}`)).toBe(true);
    expect(isSafeInternalPath(`/${'a'.repeat(512)}`)).toBe(false);
  });
});

describe('stash and take', () => {
  it('carries a destination across the round trip', () => {
    stashPostLoginRedirect('/cellars/abc/room?focusRack=def');
    expect(takePostLoginRedirect()).toBe('/cellars/abc/room?focusRack=def');
  });

  it('clears on read, so a stale destination cannot steer a later sign-in', () => {
    stashPostLoginRedirect('/wishlist');
    expect(takePostLoginRedirect()).toBe('/wishlist');
    expect(takePostLoginRedirect()).toBeNull();
  });

  it('returns null when nothing was stashed', () => {
    expect(takePostLoginRedirect()).toBeNull();
  });

  it('ignores an unsafe destination rather than storing it', () => {
    stashPostLoginRedirect('//evil.example');
    expect(takePostLoginRedirect()).toBeNull();
  });

  it('clears a previous destination when a sign-in starts without one', () => {
    // Otherwise an abandoned journey is inherited by the next sign-in in this
    // tab — on a shared computer, someone else's cellar.
    stashPostLoginRedirect('/wishlist');
    stashPostLoginRedirect(undefined);
    expect(takePostLoginRedirect()).toBeNull();
  });

  it('clears rather than keeps a previous destination when handed an unsafe one', () => {
    stashPostLoginRedirect('/wishlist');
    stashPostLoginRedirect('//evil.example');
    expect(takePostLoginRedirect()).toBeNull();
  });

  it('re-checks on the way out, so a poisoned store cannot redirect off-origin', () => {
    window.sessionStorage.setItem('cellarion.postLoginRedirect', 'https://evil.example');
    expect(takePostLoginRedirect()).toBeNull();
  });

  it('degrades to no destination when storage is unavailable', () => {
    // Replace the whole object rather than spying on its methods: jsdom puts
    // Storage behind a proxy, so a method spy never fires and the test would
    // pass against real storage without ever exercising the failure path.
    const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    const unavailable = () => { throw new Error('storage disabled'); };
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      value: { getItem: unavailable, setItem: unavailable, removeItem: unavailable },
    });

    try {
      expect(() => stashPostLoginRedirect('/cellars/abc')).not.toThrow();
      expect(takePostLoginRedirect()).toBeNull();
    } finally {
      if (original) Object.defineProperty(window, 'sessionStorage', original);
      else delete window.sessionStorage;
    }
  });
});
