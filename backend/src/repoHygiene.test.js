// Support-ticket ids, user handles and user data stay out of the public repo
// (CONTRIBUTING.md, "Personal data"). This test keeps new ticket-shaped ids
// out of backend/src and cellarion-mcp, and keeps the two files that once
// held a literal NUL byte readable as text. The counts in
// scripts/repo-hygiene-baseline.json only go down; lower them with
// `node scripts/repoHygiene.cjs --update` after a scrub.
const { scanTrees, readBaseline, compare, findings } = require('../../scripts/repoHygiene.cjs');

const TREES = ['backend/src', 'cellarion-mcp'];

describe('repo hygiene', () => {
  test('backend/src and cellarion-mcp carry no ticket ids or control bytes beyond the baseline', () => {
    const problems = compare(scanTrees(TREES), readBaseline(), TREES);
    expect(problems).toEqual([]);
  });

  test('the scanner matches the shapes it documents and ignores ordinary hex', () => {
    const id = '7b3c' + '9d1e'; // split so this file never carries an id-shaped token itself
    expect(findings(`// see ticket ${id} for the case\n`).map((f) => f.kind)).toEqual(['ticket-id']);
    expect(findings(`/* the ${id} case */\nconst x = 1;\n`).map((f) => f.kind)).toEqual(['hex-id']);
    expect(findings(`test('keeps ${id} out', () => {});\n`).map((f) => f.kind)).toEqual(['hex-id']);
    expect(findings(`const key = \`a\u0000b\`;\n`).map((f) => f.kind)).toEqual(['control-byte']);
    expect(findings('// 24-hex: 507f1f77bcf86cd799439011, uuid 0f3b2a1c-1111-4222-8333-944445555666, #12ab34cd, 0x1234abcd, 86400000\n')).toEqual([]);
    expect(findings(`const s = '${id}';\n`)).toEqual([]);
  });
});
