/**
 * Concurrency-limited equivalent of Promise.allSettled.
 *
 * Runs at most `concurrency` tasks simultaneously so we don't blast
 * external rate limits (e.g. 50 req/min for Haiku) when processing
 * large batches.
 *
 * @param {Array<() => Promise>} tasks - array of zero-arg async functions
 * @param {number} concurrency - max parallel workers
 * @returns {Promise<Array<{status:'fulfilled',value:*}|{status:'rejected',reason:*}>>}
 */
async function runConcurrent(tasks, concurrency) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      try { results[i] = { status: 'fulfilled', value: await tasks[i]() }; }
      catch (err) { results[i] = { status: 'rejected', reason: err }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

module.exports = { runConcurrent };
