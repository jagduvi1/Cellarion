// Repo hygiene scanner, shared by backend/src/repoHygiene.test.js and
// frontend/src/repoHygiene.test.js and runnable on its own:
//
//   node scripts/repoHygiene.cjs            list every finding
//   node scripts/repoHygiene.cjs --update   lower scripts/repo-hygiene-baseline.json
//
// What it finds:
//   ticket-id     the word "ticket" followed within 24 characters by an 8-hex
//                 id, anywhere in the file (comments, strings, test titles)
//   hex-id        a bare 8-hex token with both letters and digits in a comment
//                 or a test title (24-hex ObjectIds, UUID parts, #rrggbbaa
//                 colours and 0x literals do not match)
//   control-byte  a byte below 0x20 other than tab, CR and LF
//
// Why: support-ticket ids, user handles and user data stay out of the public
// repo. A comment that cites a ticket is rewritten as the rule it was about;
// history goes to git. The baseline holds counts per file, never ids, and
// only goes down. Control bytes are never allowed, so they are not baselined.
//
// A denylist of handles is deliberately not kept here: it would put the
// handles into the repo. Grep for them locally before pushing.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BASELINE_PATH = path.join(__dirname, 'repo-hygiene-baseline.json');
const EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '__snapshots__']);
// The scanner and its tests describe the patterns they look for.
const SKIP_FILES = new Set(['scripts/repoHygiene.cjs', 'backend/src/repoHygiene.test.js', 'frontend/src/repoHygiene.test.js']);

const TICKET_RE = /\btickets?\b[^\n]{0,24}?\b[0-9a-f]{8}\b/i;
const HEX_RE = /(?<![\w#\-/.])(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{8}(?![\w\-])/;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
const TITLE_RE = /\b(?:describe|it|test)(?:\.(?:only|skip))?\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;

function listFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) listFiles(path.join(dir, entry.name), out);
    } else if (EXTENSIONS.has(path.extname(entry.name))) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
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
      const block = line.indexOf('/*');
      const slash = line.indexOf('//');
      if (block >= 0 && (slash < 0 || block < slash)) {
        const end = line.indexOf('*/', block + 2);
        if (end >= 0) text = line.slice(block + 2, end);
        else { text = line.slice(block + 2); inBlock = true; }
      } else if (slash >= 0) {
        text = line.slice(slash + 2);
      }
    }
    if (text) out.push({ line: i + 1, text });
  }
  return out;
}

/** Findings for one file's text: [{ line, kind, excerpt }]. */
function findings(text) {
  const found = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (CONTROL_RE.test(line)) found.push({ line: i + 1, kind: 'control-byte', excerpt: '' });
    if (TICKET_RE.test(line)) found.push({ line: i + 1, kind: 'ticket-id', excerpt: line.trim().slice(0, 100) });
  });
  for (const c of commentLines(lines)) {
    if (TICKET_RE.test(lines[c.line - 1])) continue; // already counted once
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
      if (SKIP_FILES.has(rel)) continue;
      const f = findings(fs.readFileSync(full, 'utf8'));
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

const ALL_TREES = ['backend/src', 'frontend/src', 'cellarion-mcp', 'scripts'];

function main(argv) {
  const scanned = scanTrees(ALL_TREES);
  if (argv.includes('--update')) {
    const baseline = readBaseline();
    const next = {};
    for (const [file, list] of Object.entries(scanned)) {
      const n = list.filter((x) => x.kind !== 'control-byte').length;
      if (n === 0) continue;
      next[file] = Math.min(n, baseline[file] ?? n);
    }
    const sorted = Object.fromEntries(Object.entries(next).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(sorted, null, 2) + '\n');
    const total = Object.values(sorted).reduce((a, b) => a + b, 0);
    console.log(`Baseline written: ${Object.keys(sorted).length} file(s), ${total} id(s) still to scrub.`);
    return 0;
  }
  let n = 0;
  for (const [file, list] of Object.entries(scanned)) {
    for (const f of list) { console.log(`${file}:${f.line} ${f.kind} ${f.excerpt}`); n++; }
  }
  console.log(`${n} finding(s) in ${Object.keys(scanned).length} file(s).`);
  return 0;
}

module.exports = { findings, scanTrees, readBaseline, compare, ALL_TREES };

if (require.main === module) process.exit(main(process.argv.slice(2)));
