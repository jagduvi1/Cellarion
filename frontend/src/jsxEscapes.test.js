import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// A JSX attribute in plain quotes is NOT a JavaScript string: escapes are not
// processed, so placeholder="https://…" showed the six characters
// "…" to members instead of "…" (the purchase-URL field, 2026-10-10).
// Write the character itself, or use braces: placeholder={'https://…'}.

const SRC = path.dirname(fileURLToPath(import.meta.url));
const ATTR_WITH_ESCAPE = /\s[a-zA-Z-]+="[^"{}]*\\u[0-9a-fA-F{]/;

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name.startsWith('__') ? [] : sourceFiles(full);
    return /\.(js|jsx)$/.test(entry.name) && !/\.test\.js$/.test(entry.name) ? [full] : [];
  });
}

test('no JSX attribute in plain quotes carries a \\u escape (it would render literally)', () => {
  const offenders = [];
  for (const file of sourceFiles(SRC)) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (ATTR_WITH_ESCAPE.test(line)) offenders.push(`${path.relative(SRC, file)}:${i + 1}: ${line.trim()}`);
    });
  }
  expect(offenders).toEqual([]);
});
