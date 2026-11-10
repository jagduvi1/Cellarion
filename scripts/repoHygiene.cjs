// Repo hygiene scanner, shared by backend/src/repoHygiene.test.js and
// frontend/src/repoHygiene.test.js and runnable on its own:
//
//   node scripts/repoHygiene.cjs            list every finding
//   node scripts/repoHygiene.cjs --check    exit 1 when the baseline does not hold
//   node scripts/repoHygiene.cjs --update   lower scripts/repo-hygiene-baseline.json
//   node scripts/repoHygiene.cjs --seed     rewrite the baseline from the current counts
//                                           (only when the scanner itself learns a new shape)
//
// What it finds:
//   ticket-id     the word "ticket" followed within 24 characters by an 8-hex
//                 id or an incident date (2026-09 or 2026-09-13), anywhere in
//                 the file (comments, strings, test titles), also when the
//                 comment wraps between the word and the id or date
//   hex-id        a bare 8-hex token with both letters and digits in a comment
//                 or a test title (24-hex ObjectIds, UUID parts, #rrggbbaa
//                 colours and 0x literals do not match)
//   control-byte  a byte below 0x20 other than tab, CR and LF
//
// JavaScript files get all three. Stylesheets, server and workflow
// configuration, shell and Python files are read as plain text: ticket-id
// and control-byte only, because their comment syntax is not parsed.
//
// Why: support-ticket ids, user handles and user data stay out of the public
// repo. A comment that cites a ticket is rewritten as the rule it was about;
// history goes to git. The baseline holds counts per file, never ids, and
// only goes down: --update lowers entries and refuses to add one. Control
// bytes are never allowed, so they are not baselined.
//
// Known limits: the files are walked on disk, so an untracked file counts on
// a developer machine and not in CI; a comment opener inside a regex literal
// or a multi-line template string is read as code or as a comment by the
// line it sits on.
//
// A denylist of handles is deliberately not kept here: it would put the
// handles into the repo. Grep for them locally before pushing.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BASELINE_PATH = path.join(__dirname, 'repo-hygiene-baseline.json');
const CODE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs']);
const TEXT_EXTENSIONS = new Set(['.css', '.conf', '.yml', '.yaml', '.sh', '.py', '.html']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '__snapshots__']);
// The scanner and its tests describe the patterns they look for.
const SKIP_FILES = new Set(['scripts/repoHygiene.cjs', 'backend/src/repoHygiene.test.js', 'frontend/src/repoHygiene.test.js']);
// Vendored bundles are not ours to reword.
const SKIP_PREFIXES = ['frontend/public/developers/'];

// "ticket" followed within 24 characters by an 8-hex id or by a 2026-09(-13) style date.
const TICKET_RE = /\btickets?\b[^\n]{0,24}?\b(?:[0-9a-f]{8}|20\d\d-\d\d(?:-\d\d)?)\b/i;
// "ticket" close enough to the end of a line for the id or date to sit on the next one.
const TICKET_AT_END_RE = /\btickets?\b[^\n]{0,24}$/i;
// The comment leader of a continuation line: " * ", "// ", "# ".
const LEADER_RE = /^\s*(?:\*+|\/\/+|#+)?\s*/;
const HEX_RE = /(?<![\w#\-/.])(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{8}(?![\w\-])/;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
const TITLE_RE = /\b(?:describe|it|test)(?:\.(?:only|skip))?\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;

function listFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) listFiles(path.join(dir, entry.name), out);
    } else {
      const ext = path.extname(entry.name);
      if (CODE_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(ext)) out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/**
 * Where the first comment on a line of code opens: { at, block } or null.
 * An opener inside a string literal ('image/*', 'https://…') is not one. A
 * line whose quotes do not pair up (an apostrophe in JSX text) cannot be read
 * that way, so there the first opener on the line counts.
 */
function commentStart(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
    } else if (ch === '/' && (line[i + 1] === '/' || line[i + 1] === '*')) {
      return { at: i, block: line[i + 1] === '*' };
    }
  }
  if (!quote) return null;
  const block = line.indexOf('/*');
  const slash = line.indexOf('//');
  if (block < 0 && slash < 0) return null;
  return block >= 0 && (slash < 0 || block < slash) ? { at: block, block: true } : { at: slash, block: false };
}

/** The comment text of each line: after `//`, or the whole line inside a block comment. */
function commentLines(lines) {
  const out = [];
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let text = '';
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end >= 0) { text = line.slice(0, end); inBlock = false; } else text = line;
    } else {
      const start = commentStart(line);
      if (start && start.block) {
        const end = line.indexOf('*/', start.at + 2);
        if (end >= 0) text = line.slice(start.at + 2, end);
        else { text = line.slice(start.at + 2); inBlock = true; }
      } else if (start) {
        text = line.slice(start.at + 2);
      }
    }
    if (text) out.push({ line: i + 1, text });
  }
  return out;
}

/**
 * Findings for one file's text: [{ line, kind, excerpt }]. `code: false` reads
 * the file as plain text (no hex-id pass, which needs JavaScript comments).
 */
function findings(text, { code = true } = {}) {
  const found = [];
  const lines = text.split('\n');
  const ticketLines = new Set();
  lines.forEach((line, i) => {
    if (CONTROL_RE.test(line)) found.push({ line: i + 1, kind: 'control-byte', excerpt: '' });
    if (TICKET_RE.test(line)) {
      found.push({ line: i + 1, kind: 'ticket-id', excerpt: line.trim().slice(0, 100) });
      ticketLines.add(i + 1);
      return;
    }
    // The reference wrapped: the word ends this line, the id or date opens the next.
    if (i + 1 >= lines.length || !TICKET_AT_END_RE.test(line.trimEnd())) return;
    const head = line.trimEnd();
    const m = TICKET_RE.exec(`${head} ${lines[i + 1].replace(LEADER_RE, '')}`);
    if (m && m.index < head.length) {
      found.push({ line: i + 1, kind: 'ticket-id', excerpt: head.trim().slice(0, 100) });
      ticketLines.add(i + 1).add(i + 2); // the next line holds the id: counted here, once
    }
  });
  if (!code) return found;
  for (const c of commentLines(lines)) {
    if (ticketLines.has(c.line)) continue; // already counted once
    if (HEX_RE.test(c.text)) found.push({ line: c.line, kind: 'hex-id', excerpt: c.text.trim().slice(0, 100) });
  }
  for (const m of text.matchAll(TITLE_RE)) {
    const title = m[2];
    if (HEX_RE.test(title) && !TICKET_RE.test(title)) {
      const line = text.slice(0, m.index).split('\n').length;
      if (!found.some((f) => f.line === line)) found.push({ line, kind: 'hex-id', excerpt: title.slice(0, 100) });
    }
  }
  return found;
}

/** Scan the given repo-relative trees. Returns { 'repo/relative/file.js': [findings] } for files with findings. */
function scanTrees(trees) {
  const result = {};
  for (const tree of trees) {
    const dir = path.join(ROOT, tree);
    if (!fs.existsSync(dir)) continue;
    for (const full of listFiles(dir)) {
      const rel = path.relative(ROOT, full).split(path.sep).join('/');
      if (SKIP_FILES.has(rel) || SKIP_PREFIXES.some((p) => rel.startsWith(p))) continue;
      const f = findings(fs.readFileSync(full, 'utf8'), { code: CODE_EXTENSIONS.has(path.extname(rel)) });
      if (f.length) result[rel] = f;
    }
  }
  return result;
}

function readBaseline() {
  return fs.existsSync(BASELINE_PATH) ? JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) : {};
}

/**
 * Problems for the given trees: control bytes anywhere, more findings than the
 * baseline allows, or a baseline entry that is now too high (lower it with --update).
 */
function compare(scanned, baseline, trees) {
  const inTrees = (file) => trees.some((t) => file.startsWith(t.replace(/\/$/, '') + '/'));
  const problems = [];
  for (const [file, list] of Object.entries(scanned)) {
    for (const f of list.filter((x) => x.kind === 'control-byte')) problems.push(`${file}:${f.line} control byte`);
    const ids = list.filter((x) => x.kind !== 'control-byte');
    const allowed = baseline[file] || 0;
    if (ids.length > allowed) {
      const where = ids.map((f) => `${f.line} (${f.kind})`).join(', ');
      problems.push(`${file}: ${ids.length} ticket-shaped id(s), baseline ${allowed}: lines ${where}. Write the rule, not the ticket.`);
    } else if (ids.length < allowed) {
      problems.push(`${file}: ${ids.length} id(s) left, baseline says ${allowed}: run node scripts/repoHygiene.cjs --update`);
    }
  }
  for (const [file, allowed] of Object.entries(baseline)) {
    if (inTrees(file) && allowed > 0 && !scanned[file]) {
      problems.push(`${file}: clean now, baseline says ${allowed}: run node scripts/repoHygiene.cjs --update`);
    }
  }
  return problems.sort();
}

/**
 * The baseline a run writes. --seed takes the current counts as they are.
 * --update only lowers: an entry never rises, and a file the baseline does
 * not list gets no entry — it is returned in `unlisted` instead, because a
 * new finding is something to rewrite, not something to allow.
 */
function nextBaseline(scanned, baseline, { seed = false } = {}) {
  const next = {};
  const unlisted = [];
  for (const [file, list] of Object.entries(scanned)) {
    const n = list.filter((x) => x.kind !== 'control-byte').length;
    if (n === 0) continue;
    if (seed) next[file] = n;
    else if (file in baseline) next[file] = Math.min(n, baseline[file]);
    else unlisted.push(file);
  }
  const sorted = Object.fromEntries(Object.entries(next).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { next: sorted, unlisted: unlisted.sort() };
}

const ALL_TREES = ['backend', 'frontend', 'cellarion-mcp', 'scripts', 'rembg', '.github'];

function main(argv) {
  const scanned = scanTrees(ALL_TREES);
  const seed = argv.includes('--seed');
  if (seed || argv.includes('--update')) {
    const { next, unlisted } = nextBaseline(scanned, readBaseline(), { seed });
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2) + '\n');
    const total = Object.values(next).reduce((a, b) => a + b, 0);
    console.log(`Baseline written: ${Object.keys(next).length} file(s), ${total} id(s) still to scrub.`);
    for (const file of unlisted) console.error(`${file}: has findings and is not in the baseline. --update never adds an entry: write the rule, not the ticket.`);
    return unlisted.length ? 1 : 0;
  }
  if (argv.includes('--check')) {
    const problems = compare(scanned, readBaseline(), ALL_TREES);
    for (const p of problems) console.log(p);
    if (problems.length === 0) console.log('Repo hygiene OK.');
    return problems.length ? 1 : 0;
  }
  let n = 0;
  for (const [file, list] of Object.entries(scanned)) {
    for (const f of list) { console.log(`${file}:${f.line} ${f.kind} ${f.excerpt}`); n++; }
  }
  console.log(`${n} finding(s) in ${Object.keys(scanned).length} file(s).`);
  return 0;
}

module.exports = { findings, scanTrees, readBaseline, compare, nextBaseline, ALL_TREES };

if (require.main === module) process.exit(main(process.argv.slice(2)));
