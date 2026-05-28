const { ConcurrentStreamLimiter } = require('./concurrentStreams');

describe('ConcurrentStreamLimiter', () => {
  let limiter;

  beforeEach(() => {
    limiter = new ConcurrentStreamLimiter(2);  // cap = 2
  });

  describe('tryAcquire', () => {
    it('returns a stream id on the first acquire', () => {
      const id = limiter.tryAcquire('user-A');
      expect(typeof id).toBe('string');
      expect(id).toMatch(/^[a-f0-9-]{36}$/);  // UUID shape
      expect(limiter.count('user-A')).toBe(1);
    });

    it('allows up to the cap', () => {
      expect(limiter.tryAcquire('user-A')).toBeTruthy();
      expect(limiter.tryAcquire('user-A')).toBeTruthy();
      expect(limiter.count('user-A')).toBe(2);
    });

    it('returns null when at the cap', () => {
      limiter.tryAcquire('user-A');
      limiter.tryAcquire('user-A');
      const id = limiter.tryAcquire('user-A');
      expect(id).toBeNull();
      expect(limiter.count('user-A')).toBe(2);  // unchanged
    });

    it('coerces non-string userIds (ObjectId, number, etc.)', () => {
      // Common case: Mongoose ObjectId — call `.toString()` via String() coercion
      const fakeObjectId = { toString: () => 'abc123' };
      const id = limiter.tryAcquire(fakeObjectId);
      expect(id).toBeTruthy();
      expect(limiter.count(fakeObjectId)).toBe(1);
      expect(limiter.count('abc123')).toBe(1);   // same key
    });

    it('isolates counts between users', () => {
      limiter.tryAcquire('user-A');
      limiter.tryAcquire('user-A');
      limiter.tryAcquire('user-B');
      expect(limiter.count('user-A')).toBe(2);
      expect(limiter.count('user-B')).toBe(1);
      // User A at cap, but B can still acquire
      expect(limiter.tryAcquire('user-A')).toBeNull();
      expect(limiter.tryAcquire('user-B')).toBeTruthy();
    });

    it('re-reads the cap on each acquire (live config tuning)', () => {
      let cap = 1;
      const dynLimiter = new ConcurrentStreamLimiter(() => cap);
      expect(dynLimiter.tryAcquire('user-A')).toBeTruthy();
      expect(dynLimiter.tryAcquire('user-A')).toBeNull();   // cap=1, full
      cap = 3;
      expect(dynLimiter.tryAcquire('user-A')).toBeTruthy(); // cap raised live
      expect(dynLimiter.tryAcquire('user-A')).toBeTruthy();
      expect(dynLimiter.count('user-A')).toBe(3);
    });
  });

  describe('release', () => {
    it('decrements the count', () => {
      const id = limiter.tryAcquire('user-A');
      expect(limiter.count('user-A')).toBe(1);
      limiter.release('user-A', id);
      expect(limiter.count('user-A')).toBe(0);
    });

    it('makes room for a new acquire after the cap was hit', () => {
      const id1 = limiter.tryAcquire('user-A');
      const id2 = limiter.tryAcquire('user-A');
      expect(limiter.tryAcquire('user-A')).toBeNull();  // full
      limiter.release('user-A', id1);
      const id3 = limiter.tryAcquire('user-A');
      expect(id3).toBeTruthy();
      expect(id3).not.toBe(id1);
      expect(limiter.count('user-A')).toBe(2);
      // id2 still holding its slot
      limiter.release('user-A', id2);
      limiter.release('user-A', id3);
      expect(limiter.count('user-A')).toBe(0);
    });

    it('is a no-op for an unknown user', () => {
      expect(() => limiter.release('never-acquired', 'whatever')).not.toThrow();
    });

    it('is a no-op for an unknown stream id (e.g. double release)', () => {
      const id = limiter.tryAcquire('user-A');
      limiter.release('user-A', id);
      limiter.release('user-A', id);            // double release
      limiter.release('user-A', 'random-id');   // unknown id
      expect(limiter.count('user-A')).toBe(0);
    });

    it('removes the user entry when their set is empty (no memory leak)', () => {
      const id = limiter.tryAcquire('user-A');
      expect(limiter.activeUserCount()).toBe(1);
      limiter.release('user-A', id);
      expect(limiter.activeUserCount()).toBe(0);
    });
  });

  describe('diagnostics', () => {
    it('count returns 0 for unknown user', () => {
      expect(limiter.count('never-acquired')).toBe(0);
    });

    it('activeUserCount + totalActive across multiple users', () => {
      limiter.tryAcquire('user-A');
      limiter.tryAcquire('user-A');
      limiter.tryAcquire('user-B');
      limiter.tryAcquire('user-C');
      expect(limiter.activeUserCount()).toBe(3);
      expect(limiter.totalActive()).toBe(4);
    });
  });
});
