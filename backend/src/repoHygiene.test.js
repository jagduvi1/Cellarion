// Support-ticket ids, user handles and user data stay out of the public repo
// (CONTRIBUTING.md, "Personal data"), and a comment states the rule, not the
// audit, issue or date it came from (CONTRIBUTING.md, "Comments"). This test
// keeps new ticket-shaped ids and reference marks out of everything outside
// the frontend (the backend, cellarion-mcp, the scripts, rembg and the
// workflows; frontend/src/repoHygiene.test.js holds the frontend), and keeps
// control bytes out of the source. The counts in
// scripts/repo-hygiene-baseline.json only go down; lower them with
// `node scripts/repoHygiene.cjs --update` after a scrub.
const { scanTrees, readBaseline, compare, findings, nextBaseline } = require('../../scripts/repoHygiene.cjs');

const TREES = ['backend', 'cellarion-mcp', 'scripts', 'rembg', '.github'];

// Split so this file never carries an id-shaped token or a ticket date itself.
const id = '7b3c' + '9d1e';
const date = '2026' + '-09-13';
const kinds = (text, options) => findings(text, options).map((f) => f.kind);

describe('repo hygiene', () => {
  test('nothing outside the frontend carries ticket ids, reference marks or control bytes beyond the baseline', () => {
    const problems = compare(scanTrees(TREES), readBaseline(), TREES);
    expect(problems).toEqual([]);
  });

  test('the scanner matches the shapes it documents and ignores ordinary hex', () => {
    expect(kinds(`// see ticket ${id} for the case\n`)).toEqual(['ticket-id']);
    expect(kinds(`/* the ${id} case */\nconst x = 1;\n`)).toEqual(['hex-id']);
    expect(kinds(`test('keeps ${id} out', () => {});\n`)).toEqual(['hex-id']);
    expect(kinds(`const key = \`a\u0000b\`;\n`)).toEqual(['control-byte']);
    expect(findings('// 24-hex: 507f1f77bcf86cd799439011, uuid 0f3b2a1c-1111-4222-8333-944445555666, #12ab34cd, 0x1234abcd, 86400000\n')).toEqual([]);
    expect(findings(`const s = '${id}';\n`)).toEqual([]);
  });

  test('a reference that wraps between the word and its id or date is one finding, on the line of the word', () => {
    const wrapped = [
      `// keeps drafts out of the list (support ticket\n// ${date}). A draft is private.\n`,
      `/**\n * The private-draft clock (support ticket\n * ${date}).\n */\n`,
      `# is how a support ticket\n#   ${id} came to report it.\n`,
    ];
    for (const text of wrapped) {
      const found = findings(text);
      expect(found.map((f) => f.kind)).toEqual(['ticket-id']);
      expect(text.split('\n')[found[0].line - 1]).toMatch(/ticket$/);
    }
    // The word far from the end of its line, or a next line that opens with neither, is no reference.
    expect(findings(`// a support ticket is opened for every report the member sends in\n// ${date} was a Sunday.\n`)).toEqual([]);
    expect(findings('// answers the ticket\n// and closes it.\n')).toEqual([]);
  });

  test('a comment opener inside a string is not a comment; a line with an unpaired quote falls back to the first opener', () => {
    // 'image/*' opens no block comment, so the code below it is not read as one.
    expect(findings(`const accept = 'image/*';\nconst n = '${id}';\nconst y = 2; // done\n`)).toEqual([]);
    expect(findings(`const url = 'https://example.org/${id}';\n`)).toEqual([]);
    expect(kinds(`const accept = 'image/*'; // the ${id} case\n`)).toEqual(['hex-id']);
    expect(kinds(`<p>Don't open it</p> {/* the ${id} case */}\n`)).toEqual(['hex-id']);
  });

  test('a file read as plain text reports ticket references and control bytes, never a bare hex token', () => {
    expect(kinds(`/* Stacked actions (support ticket ${date}) */\n.a { color: #${id}; }\n`, { code: false })).toEqual(['ticket-id']);
    expect(kinds(`# cache key ${id}\nlocation / { }\n`, { code: false })).toEqual([]);
  });

  test('a comment that cites where a rule came from is a finding; the rule itself, and the same words in code, are not', () => {
    const marks = [
      `// Two taps would file it twice (release audit ${date}, L).\n`,
      `// Audit ${date} M7: the click is an objection to email as such.\n`,
      '// The scan is partial (audit M-2: the producer looks like label text).\n',
      '/* Offline mode (#1355) */\nconst a = 1;\n',
      '// Sort by quantity (issue #987).\n',
      '// The tier is one field (GitHub discussion #1696): absent leaves it alone.\n',
      `// One column on a phone (${date}).\n`,
      `<p>text</p> {/* The name wraps (newcomer walkthrough ${date}). */}\n`,
      '// The gate refuses it (M-2).\n',
    ];
    for (const text of marks) expect(kinds(text)).toEqual(['history-mark']);

    const fine = [
      '// Every mutation writes one row (audit).\n',
      '// Audit: the row is written after the response.\n',
      '// Muted text (#666) on the dark card.\n',
      `// Deprecated routes answer until ${date}.\n`,
      '// The last page starts at offset (N-1) * limit.\n',
      "const title = 'Sort by quantity (issue #987)';\n",
    ];
    for (const text of fine) expect(findings(text)).toEqual([]);

    // A stylesheet's comments are read; a file whose comments cannot be told from its code is not.
    const sheet = `/* Stacked on a phone (audit ${date}) */\n.a { color: red; }\n`;
    expect(kinds(sheet, { code: false, comments: true })).toEqual(['history-mark']);
    expect(kinds(`# keep-alive (audit ${date})\nlisten 80;\n`, { code: false })).toEqual([]);
  });

  test('an archived script keeps the record of its run: no history mark is reported there', () => {
    // The shape is a mark in any other file.
    expect(kinds(`/**\n * Finished: the bounded run recorded below (${date}) is done.\n */\n`)).toEqual(['history-mark']);
    const scanned = scanTrees(['backend/src/scripts/archive']);
    const marks = Object.values(scanned).flat().filter((f) => f.kind === 'history-mark');
    expect(marks).toEqual([]);
  });

  test('--update lowers an entry, never raises one and never adds one; --seed takes the counts as they are', () => {
    const two = [{ kind: 'ticket-id' }, { kind: 'hex-id' }, { kind: 'control-byte' }];
    const scanned = { 'a.js': two, 'b.js': two, 'new.js': two, 'bytes.js': [{ kind: 'control-byte' }] };
    expect(nextBaseline(scanned, { 'a.js': 5, 'b.js': 1, 'gone.js': 3 }))
      .toEqual({ next: { 'a.js': 2, 'b.js': 1 }, unlisted: ['new.js'] });
    expect(nextBaseline(scanned, {}, { seed: true }))
      .toEqual({ next: { 'a.js': 2, 'b.js': 2, 'new.js': 2 }, unlisted: [] });
  });
});
