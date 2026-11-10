// Support-ticket ids, user handles and user data stay out of the public repo
// (CONTRIBUTING.md, "Personal data"). This test keeps new ticket-shaped ids
// out of the frontend: its source, its stylesheets, the service worker and
// the nginx configuration. The counts in scripts/repo-hygiene-baseline.json
// only go down; lower them with `node scripts/repoHygiene.cjs --update` after
// a scrub.
import { describe, test, expect } from 'vitest';
import { createRequire } from 'node:module';

// createRequire keeps the shared CommonJS scanner outside Vite's transform pipeline.
const { scanTrees, readBaseline, compare } = createRequire(import.meta.url)('../../scripts/repoHygiene.cjs');

const TREES = ['frontend'];

describe('repo hygiene', () => {
  test('the frontend carries no ticket ids or control bytes beyond the baseline', () => {
    const problems = compare(scanTrees(TREES), readBaseline(), TREES);
    expect(problems).toEqual([]);
  });
});
