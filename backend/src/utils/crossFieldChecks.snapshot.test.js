/**
 * Source snapshot of every cross-field rule's detect() body — the same
 * discipline as nameChecks.snapshot.test.js, for the same reason:
 *
 * A wine's crossChecksCleared clearance means "an admin confirmed this wine
 * passes rule <id> AS THAT RULE WAS DEFINED". Editing a detect() without
 * bumping its versioned id would silently re-scope recorded clearances to
 * logic the admin never saw. This suite makes that edit impossible to land
 * quietly: change a detect body and CI fails HERE, showing the source diff,
 * until you either
 *   - bump the rule id in the same commit (".v1" -> ".v2"), invalidating that
 *     rule's clearances registry-wide — usually the right call, or
 *   - regenerate the snapshot (npx jest crossFieldChecks.snapshot -u) for a
 *     provable no-op (comment/whitespace) and say so in the PR.
 *
 * NOTE: the snapshotted text is String(detect) AS JEST'S BABEL TRANSFORM
 * PRINTS IT (mock hoisting regenerates source), not the raw file bytes —
 * which is why this uses jest snapshots instead of a hand-pinned hash: the
 * transform output is only stable under jest itself.
 *
 * Residual gap, on purpose — one wider here than in nameChecks: edits to
 * shared helpers (normalizeString, resolveCountryName, isUnknownName) change
 * verdicts without changing any detect body, and so do edits to the module's
 * own vocabulary sets (STYLE_WORDS, PLACEHOLDER_PRODUCERS,
 * CONTAINMENT_HOUSE_WORDS) — String(detect) does not serialize captured
 * constants. The unit suite pins the vocabulary's observable behaviour
 * per-word, so a list edit still fails a test; helper edits are reviewed in
 * their own files. See the crossFieldChecks.js header.
 */
const { CROSS_FIELD_CHECKS } = require('./crossFieldChecks');

test('rule ids are pinned (adding/removing/renaming a rule must be deliberate)', () => {
  expect(CROSS_FIELD_CHECKS.map(c => `${c.id}${c.defaultActive ? '' : ' (non-default)'}`))
    .toMatchSnapshot();
});

for (const check of CROSS_FIELD_CHECKS) {
  test(`detect() source of ${check.id} is unchanged — bump the id if you edited it`, () => {
    expect(String(check.detect)).toMatchSnapshot();
  });
}
