const { runConcurrent } = require('./concurrency');

describe('runConcurrent', () => {
  // ─── All tasks fulfill successfully ────────────────────────────────────────

  test('all tasks fulfill successfully', async () => {
    const tasks = [
      () => Promise.resolve('a'),
      () => Promise.resolve('b'),
      () => Promise.resolve('c'),
    ];
    const results = await runConcurrent(tasks, 3);
    expect(results).toEqual([
      { status: 'fulfilled', value: 'a' },
      { status: 'fulfilled', value: 'b' },
      { status: 'fulfilled', value: 'c' },
    ]);
  });

  test('tasks returning non-promise values work correctly', async () => {
    const tasks = [
      () => 42,
      () => 'hello',
      () => null,
    ];
    const results = await runConcurrent(tasks, 2);
    expect(results).toEqual([
      { status: 'fulfilled', value: 42 },
      { status: 'fulfilled', value: 'hello' },
      { status: 'fulfilled', value: null },
    ]);
  });

  // ─── Mixed fulfilled and rejected results ─────────────────────────────────

  test('mixed fulfilled and rejected results', async () => {
    const err = new Error('task failed');
    const tasks = [
      () => Promise.resolve('ok'),
      () => Promise.reject(err),
      () => Promise.resolve('also ok'),
    ];
    const results = await runConcurrent(tasks, 3);
    expect(results[0]).toEqual({ status: 'fulfilled', value: 'ok' });
    expect(results[1]).toEqual({ status: 'rejected', reason: err });
    expect(results[2]).toEqual({ status: 'fulfilled', value: 'also ok' });
  });

  test('all tasks rejected', async () => {
    const err1 = new Error('fail 1');
    const err2 = new Error('fail 2');
    const tasks = [
      () => Promise.reject(err1),
      () => Promise.reject(err2),
    ];
    const results = await runConcurrent(tasks, 2);
    expect(results[0]).toEqual({ status: 'rejected', reason: err1 });
    expect(results[1]).toEqual({ status: 'rejected', reason: err2 });
  });

  test('synchronous throw is caught as rejected', async () => {
    const err = new Error('sync throw');
    const tasks = [
      () => { throw err; },
      () => Promise.resolve('ok'),
    ];
    const results = await runConcurrent(tasks, 2);
    expect(results[0]).toEqual({ status: 'rejected', reason: err });
    expect(results[1]).toEqual({ status: 'fulfilled', value: 'ok' });
  });

  // ─── Respects concurrency limit ──────────────────────────────────────────

  test('respects concurrency limit (max simultaneous tasks)', async () => {
    let running = 0;
    let maxRunning = 0;

    const createTask = () => async () => {
      running++;
      if (running > maxRunning) maxRunning = running;
      // Simulate async work
      await new Promise(resolve => setTimeout(resolve, 20));
      running--;
      return 'done';
    };

    const tasks = Array.from({ length: 10 }, createTask);
    const results = await runConcurrent(tasks, 3);

    expect(maxRunning).toBeLessThanOrEqual(3);
    expect(results).toHaveLength(10);
    results.forEach(r => {
      expect(r).toEqual({ status: 'fulfilled', value: 'done' });
    });
  });

  test('concurrency of 1 runs tasks sequentially', async () => {
    const order = [];
    const tasks = [
      async () => { order.push('start-0'); await new Promise(r => setTimeout(r, 10)); order.push('end-0'); },
      async () => { order.push('start-1'); await new Promise(r => setTimeout(r, 10)); order.push('end-1'); },
      async () => { order.push('start-2'); await new Promise(r => setTimeout(r, 10)); order.push('end-2'); },
    ];
    await runConcurrent(tasks, 1);
    // With concurrency=1, each task finishes before the next starts
    expect(order).toEqual(['start-0', 'end-0', 'start-1', 'end-1', 'start-2', 'end-2']);
  });

  // ─── Empty tasks array ────────────────────────────────────────────────────

  test('empty tasks array returns empty results', async () => {
    const results = await runConcurrent([], 5);
    expect(results).toEqual([]);
  });

  // ─── Results maintain correct order ───────────────────────────────────────

  test('results maintain correct order regardless of completion order', async () => {
    // Tasks complete in reverse order due to varying delays
    const tasks = [
      () => new Promise(resolve => setTimeout(() => resolve('slow'), 50)),
      () => new Promise(resolve => setTimeout(() => resolve('medium'), 25)),
      () => new Promise(resolve => setTimeout(() => resolve('fast'), 5)),
    ];
    const results = await runConcurrent(tasks, 3);
    // Despite completing in reverse order, results should match task index
    expect(results[0]).toEqual({ status: 'fulfilled', value: 'slow' });
    expect(results[1]).toEqual({ status: 'fulfilled', value: 'medium' });
    expect(results[2]).toEqual({ status: 'fulfilled', value: 'fast' });
  });

  test('results length matches tasks length', async () => {
    const tasks = Array.from({ length: 7 }, (_, i) => () => Promise.resolve(i));
    const results = await runConcurrent(tasks, 2);
    expect(results).toHaveLength(7);
    for (let i = 0; i < 7; i++) {
      expect(results[i]).toEqual({ status: 'fulfilled', value: i });
    }
  });

  // ─── Edge: concurrency larger than task count ─────────────────────────────

  test('concurrency larger than task count works fine', async () => {
    const tasks = [
      () => Promise.resolve('only one'),
    ];
    const results = await runConcurrent(tasks, 100);
    expect(results).toEqual([{ status: 'fulfilled', value: 'only one' }]);
  });
});
