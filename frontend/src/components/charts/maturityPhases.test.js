import { MATURITY_PHASES } from './chartHelpers';
import { MATURITY_FILTER_OPTIONS } from '../../utils/filterLabels';

// The Statistics charts and the per-cellar table open a bottle list filtered
// by ?maturity=<phase.filter>. A filter value the list does not know would
// open the whole cellar while the link says "4 declining".
test('every maturity phase links with a value the bottle list filter accepts, each exactly once', () => {
  expect(MATURITY_PHASES.map((p) => p.filter).sort()).toEqual([...MATURITY_FILTER_OPTIONS].sort());
});

test('the phases are the six buckets of the statistics answer', () => {
  expect(MATURITY_PHASES.map((p) => p.key).sort()).toEqual(['declining', 'early', 'late', 'noProfile', 'notReady', 'peak']);
});
