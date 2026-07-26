/**
 * Source snapshot of every name-check rule's detect() body.
 *
 * WHY: a wine's verifiedChecks clearance means "an admin confirmed this wine
 * passes rule <id> AS THAT RULE WAS DEFINED". Editing a detect() without
 * bumping its versioned id would silently re-scope thousands of recorded
 * clearances to logic the admin never saw. This suite makes that edit
 * impossible to land quietly: change a detect body and CI fails HERE, showing
 * the source diff, until you either
 *   - bump the rule id in the same commit (".v1" -> ".v2"), invalidating that
 *     rule's clearances registry-wide — usually the right call, or
 *   - regenerate the snapshot (npx jest nameChecks.snapshot -u) for a provable
 *     no-op (comment/whitespace) and say so in the PR.
 *
 * NOTE: the snapshotted text is String(detect) AS JEST'S BABEL TRANSFORM
 * PRINTS IT (mock hoisting regenerates source), not the raw file bytes — which
 * is why this uses jest snapshots instead of a hand-pinned hash: the transform
 * output is only stable under jest itself.
 *
 * Residual gap, on purpose: edits to shared helpers (stripProducerName,
 * normalizeString) change verdicts without changing any detect body. Those
 * files carry their own suites and reviews; see the nameChecks.js header.
 */
const { NAME_CHECKS } = require('./nameChecks');

test('rule ids are pinned (adding/removing/renaming a rule must be deliberate)', () => {
  expect(NAME_CHECKS.map(c => `${c.id}${c.defaultActive ? '' : ' (non-default)'}`))
    .toMatchSnapshot();
});

for (const check of NAME_CHECKS) {
  test(`detect() source of ${check.id} is unchanged — bump the id if you edited it`, () => {
    expect(String(check.detect)).toMatchSnapshot();
  });
}
