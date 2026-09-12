/**
 * Private drafts ride the pending-identity gate: a draft IS pendingIdentity
 * (model invariant), so every `pendingIdentity: { $ne: true }` exclusion and
 * every "skip pending" guard in the codebase hides it for free. The places
 * that can go wrong are the ones that deliberately INCLUDE or GRANT on
 * pending rows — the curation queue, the curator scan/photo reads, the admin
 * loads — because a draft must not be included there.
 *
 * A static sweep, same discipline as models/Notification.typesUsed.test.js:
 * every source line that grants on `pendingIdentity: true` / `=== true` must
 * either mention `draft` within two lines (it was considered) or be on the
 * allowlist below WITH a reason. A new grant site fails the build until a
 * human classifies it.
 *
 * Second assertion: nothing outside the three draft modules writes `draft:`
 * through an update operator — an updateOne bypasses the model hook that
 * keeps draft ⇒ pendingIdentity true.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');

function jsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) jsFiles(full, out);
    else if (entry.endsWith('.js') && !entry.endsWith('.test.js')) out.push(full);
  }
  return out;
}

const rel = (f) => path.relative(SRC, f).split(path.sep).join('/');

// file → substrings of lines that are SAFE without a draft mention, with why.
const KNOWN_SAFE = {
  'models/WineDefinition.js': ['*'], // the invariant and the hook live here
  'mcp/tools/bulk.js': ['pendingIdentity: true } : {}'],        // audit detail, not a gate
  'mcp/tools/write.js': ['pendingIdentity: true } : {}', 'const pendingIdentity = wineDoc.pendingIdentity === true'], // audit / response flag
  'mcp/tools/publicContent.js': ['wine.pendingIdentity === true'], // skip guard: hides drafts too
  'routes/import.js': ['pendingIdentity: true } : {}'],          // audit detail
  'routes/somm/pendingWines.js': ['pendingIdentity: wine.pendingIdentity === true'], // response flag on a queue-loaded row
  'routes/wineLists.js': ['pendingIdentity: true })'],            // attach REFUSAL: refuses drafts too
  'services/embeddingJob.js': ['wine.pendingIdentity === true'],  // skip guard
  'services/enrichmentJob.js': ['wine.pendingIdentity === true'], // skip guard
  'services/search.js': ['wine.pendingIdentity === true'],        // index REMOVAL: removes drafts too
  'services/findOrCreateWine.js': ['candidate.pendingIdentity === true', 'pendingIdentity: true, createdBy: userId'], // resolver isolation: a stranger's pending row (draft included) is blocked, the caller's own is not
  'services/wineCommit.js': ['wine.pendingIdentity === true', 'pendingIdentity: true } : {}'], // audit
  'services/wineVisibility.js': ['*'],                             // the rule itself
  'utils/vintageProfile.js': ['{ pendingIdentity: true }'],        // seed REFUSAL: refuses drafts too
};

const GRANT = /pendingIdentity:\s*(true\b|\{\s*\$eq:\s*true)|pendingIdentity\s*===\s*true|pendingIdentity:\s*\{\s*\$in:/;
const isComment = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);

describe('every pendingIdentity grant site has been classified for private drafts', () => {
  test('grant sites mention draft nearby, or are allowlisted with a reason', () => {
    const offenders = [];
    for (const file of jsFiles(SRC)) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      const r = rel(file);
      const safe = KNOWN_SAFE[r] || [];
      if (safe.includes('*')) continue;
      lines.forEach((line, i) => {
        if (!GRANT.test(line) || isComment(line)) return;
        // ±3 lines, plain substring: "DRAFT_EXCLUDED" and "draft: { $ne" both count.
        const window = lines.slice(Math.max(0, i - 3), i + 4).join('\n');
        if (/draft/i.test(window)) return;
        if (safe.some((s) => line.includes(s))) return;
        offenders.push(`${r}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  test('only the draft modules write `draft` through an update operator (the hook is bypassed there)', () => {
    const ALLOWED = new Set([
      'services/wineDraftOps.js',
      'services/wineDraftExpiryJob.js',
      'services/userDataRegistry.js',
    ]);
    const offenders = [];
    for (const file of jsFiles(SRC)) {
      const text = fs.readFileSync(file, 'utf8');
      // Any update operator whose payload names `draft:` within a few hundred
      // characters — $set/$unset/$setOnInsert, and the findByIdAndUpdate /
      // updateOne / updateMany / bulkWrite / insertMany call shapes.
      const writesDraft = /\$(set|unset|setOnInsert):\s*\{[\s\S]{0,400}?\bdraft:/.test(text)
        || /(findByIdAndUpdate|findOneAndUpdate|updateOne|updateMany|bulkWrite|insertMany)\([\s\S]{0,400}?\bdraft:\s*(true|false)/.test(text);
      if (!writesDraft) continue;
      const r = rel(file);
      if (!ALLOWED.has(r)) offenders.push(r);
    }
    expect(offenders).toEqual([]);
  });
});
