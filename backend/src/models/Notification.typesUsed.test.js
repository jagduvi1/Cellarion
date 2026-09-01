/**
 * Every notification type the code SENDS must exist in the model's enum.
 *
 * The failure this pins is perfectly silent: createNotifications catches the
 * insertMany validation error and logs it, so a type missing from the enum
 * does not crash anything — the notification is simply never delivered, and
 * the feature that sent it looks finished. Found the day cellar ownership
 * transfer was built: its 'cellar_ownership_received' notification validated
 * against nothing and would have reached nobody.
 *
 * A static sweep, not a runtime test, because the bug is in the gap between
 * two files that are each individually correct.
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

/** The enum, read from the schema itself rather than re-declared here. */
function enumTypes() {
  const Notification = require('./Notification');
  return new Set(Notification.schema.path('type').enumValues);
}

/**
 * Literal types passed to createNotification(userId, 'type', …) or built into
 * createNotifications items as `type: '…'`. Only string literals are checkable
 * statically; a computed type is out of scope and rare.
 */
function usedTypes(files) {
  const used = new Map(); // type -> first file using it
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    if (!src.includes('createNotification')) continue;
    // createNotification(<arg1>, '<type>'
    for (const m of src.matchAll(/createNotification\s*\(\s*[^,()]+,\s*'([a-z0-9_]+)'/g)) {
      if (!used.has(m[1])) used.set(m[1], path.relative(SRC, file));
    }
    // Batch items. A notification literal pairs `type:` with a `title:` right
    // after it; logAudit's resource descriptor pairs it with `id:` instead —
    // and the first draft of this regex flagged four logAudit descriptors as
    // missing notification types. The `title` neighbour is the discriminator.
    if (src.includes('createNotifications')) {
      for (const m of src.matchAll(/\btype:\s*'([a-z0-9_]+)',\s*\n?\s*title:/g)) {
        if (!used.has(m[1])) used.set(m[1], path.relative(SRC, file));
      }
    }
  }
  return used;
}

describe('notification types', () => {
  const files = jsFiles(SRC).filter((f) => !f.includes(`${path.sep}models${path.sep}`));
  const used = usedTypes(files);
  const known = enumTypes();

  test('the sweep finds a plausible number of send sites (guards the regexes)', () => {
    expect(used.size).toBeGreaterThan(10);
    // A known long-standing pair as a canary for the extraction itself:
    expect(used.has('wine_request_rejected')).toBe(true);
    expect(used.has('cellar_shared')).toBe(true);
  });

  test('every type the code sends exists in the enum', () => {
    const missing = [...used.entries()]
      .filter(([type]) => !known.has(type))
      .map(([type, file]) => `${type} (sent from ${file})`);
    expect(missing).toEqual([]);
  });

  test('the transfer notification specifically survives model validation', () => {
    expect(known.has('cellar_ownership_received')).toBe(true);
  });
});
