/**
 * The layering rule: a service never requires a route module.
 *
 * A route parses a request and words an answer; what the request does lives in
 * a service, which the MCP tools and the scheduled jobs call too. A service
 * that reaches into a route file pulls the whole Express tree behind it, ties
 * its tests to a route's mocks, and closes require cycles that then have to be
 * broken with lazy requires.
 *
 * This reads the source of every module under services/ (and under mcp/, with
 * the exceptions listed below) and fails on a require of anything in routes/.
 * The exception list only shrinks: when an entry's code moves to a service,
 * delete the entry, and the test fails if it is left behind.
 */
const fs = require('fs');
const path = require('path');

const SRC = __dirname;

// MCP modules that still call into a route module, each with what it needs
// from there. Not a place to add to: new code goes through a service.
const MCP_EXCEPTIONS = {
  'mcp/tools/somm/grapes.js': 'routes/taxonomy.clearTaxonomyListCache (the public taxonomy list cache lives in the route)',
};

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) out.push(full);
  }
  return out;
}

const rel = (file) => path.relative(SRC, file).split(path.sep).join('/');

/** The route modules a file requires, as paths relative to src/ (lazy requires included). */
function routeRequires(file) {
  const text = fs.readFileSync(file, 'utf8');
  const found = [];
  for (const m of text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (!m[1].startsWith('.')) continue;
    const target = rel(path.resolve(path.dirname(file), m[1]));
    if (target === 'routes' || target.startsWith('routes/')) found.push(target);
  }
  return found;
}

test('no service requires a route module', () => {
  const offenders = sourceFiles(path.join(SRC, 'services'))
    .map((file) => ({ file: rel(file), routes: routeRequires(file) }))
    .filter((f) => f.routes.length);
  expect(offenders).toEqual([]);
});

test('no MCP module requires a route module, beyond the listed exceptions', () => {
  const offenders = sourceFiles(path.join(SRC, 'mcp'))
    .map((file) => ({ file: rel(file), routes: routeRequires(file) }))
    .filter((f) => f.routes.length && !(f.file in MCP_EXCEPTIONS));
  expect(offenders).toEqual([]);
});

test('every listed exception still exists, so the list shrinks when its code moves', () => {
  const stale = Object.keys(MCP_EXCEPTIONS).filter((file) => {
    const full = path.join(SRC, file);
    return !fs.existsSync(full) || routeRequires(full).length === 0;
  });
  expect(stale).toEqual([]);
});

test('the reading finds a require of a route, top-level or lazy', () => {
  // The exception is the live sample: it must be seen for the two tests above to mean anything.
  expect(routeRequires(path.join(SRC, 'mcp/tools/somm/grapes.js'))).toContain('routes/taxonomy');
});
