import { readStored, writeStored, removeStored } from './safeStorage';

// A browser that blocks site data throws from the storage getters themselves,
// before any getItem/setItem is reached.
const AREAS = ['localStorage', 'sessionStorage'];
let saved;

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => { m.clear(); },
  };
}

function blockStorage() {
  for (const name of AREAS) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get() { throw new DOMException('The operation is insecure.', 'SecurityError'); },
    });
  }
}

beforeEach(() => {
  saved = AREAS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
});
afterEach(() => {
  for (const [name, desc] of saved) {
    if (desc) Object.defineProperty(globalThis, name, desc);
    else delete globalThis[name];
  }
});

describe('with working storage', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: memoryStorage() });
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, writable: true, value: memoryStorage() });
  });

  it('reads, writes and removes in localStorage by default', () => {
    expect(readStored('k')).toBeNull();
    writeStored('k', 'v');
    expect(localStorage.getItem('k')).toBe('v');
    expect(sessionStorage.getItem('k')).toBeNull();
    expect(readStored('k')).toBe('v');
    removeStored('k');
    expect(readStored('k')).toBeNull();
  });

  it("uses sessionStorage for the 'session' area", () => {
    writeStored('k', 'v', 'session');
    expect(sessionStorage.getItem('k')).toBe('v');
    expect(localStorage.getItem('k')).toBeNull();
    expect(readStored('k', 'session')).toBe('v');
    removeStored('k', 'session');
    expect(readStored('k', 'session')).toBeNull();
  });
});

describe('with site data blocked', () => {
  beforeEach(blockStorage);

  it('a read gives null and nothing throws', () => {
    expect(() => localStorage).toThrow('insecure');
    for (const area of ['local', 'session']) {
      expect(readStored('k', area)).toBeNull();
      expect(() => writeStored('k', 'v', area)).not.toThrow();
      expect(() => removeStored('k', area)).not.toThrow();
    }
  });
});
