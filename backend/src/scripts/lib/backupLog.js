/**
 * Pre-change backup for a script that rewrites rows.
 *
 * append(row) writes the row to the backup file before it returns, and the
 * script calls it right before each write. A run that dies halfway (a throw,
 * Ctrl-C, the host killing the process) then still leaves a pre-image of every
 * row it changed; a backup written once after the loop is lost in exactly that
 * case. One JSON object per line (NDJSON), so each row is a single append.
 * The file is created by the first append: a run that changes nothing leaves
 * none.
 *
 * Directory: --backup-dir=<path> on the command line, else SCRIPT_BACKUP_DIR,
 * else os.tmpdir(). In the backend container that is /tmp, which is gone when
 * the container is recreated, so report() says to copy the file off.
 *
 * Usage, on --apply:
 *   const backup = createBackupLog('my-script');
 *   for (const w of rows) {
 *     backup.append({ _id: String(w._id), field: w.field });
 *     await WineDefinition.updateOne(...);
 *   }
 *   backup.report();
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const FLAG = '--backup-dir=';

function resolveBackupDir(argv = process.argv, env = process.env) {
  const flag = argv.find((a) => a.startsWith(FLAG));
  return (flag && flag.slice(FLAG.length)) || env.SCRIPT_BACKUP_DIR || os.tmpdir();
}

/**
 * @param {string} prefix file name prefix (the script's subject)
 * @param {{ dir?: string }} [opts] directory; defaults to resolveBackupDir()
 */
function createBackupLog(prefix, { dir = resolveBackupDir() } = {}) {
  let file = null;
  let count = 0;
  return {
    append(row) {
      const target = file || path.join(dir, `${prefix}-backup-${Date.now()}.ndjson`);
      fs.appendFileSync(target, `${JSON.stringify(row)}\n`);
      if (!file) {
        file = target;
        console.log(`Backing up each row before it changes: ${file}`);
      }
      count += 1;
    },
    get file() { return file; },
    get count() { return count; },
    report() {
      if (!file) return;
      console.log(`\nBackup of ${count} pre-change rows: ${file}`);
      if (path.resolve(dir) === path.resolve(os.tmpdir())) {
        console.log(`(container /tmp is ephemeral: docker cp it off before recreating the container, or pass ${FLAG}<a mounted directory>)`);
      }
    },
  };
}

module.exports = { createBackupLog, resolveBackupDir };
