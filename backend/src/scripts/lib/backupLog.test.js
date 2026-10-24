/**
 * scripts/lib/backupLog: a script's pre-change backup, one row per line,
 * written before the row changes.
 *
 * A backup written once after the loop is lost when the run dies halfway
 * (a throw, Ctrl-C, the host killing the process), which leaves the rows
 * already changed with no pre-image. Each row must be on disk by the time
 * append() returns. Real files, in a directory made for the test.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBackupLog, resolveBackupDir } = require('./backupLog');

const readRows = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

let dir;
let log;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-log-'));
  log = jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('after the first append the file is on disk and holds that row, before any later call', () => {
  const backup = createBackupLog('some-script', { dir });
  backup.append({ _id: 'w1', name: 'Old name' });

  expect(backup.file).not.toBeNull();
  expect(path.dirname(backup.file)).toBe(dir);
  expect(path.basename(backup.file)).toMatch(/^some-script-backup-\d+\.ndjson$/);
  expect(fs.existsSync(backup.file)).toBe(true);
  expect(readRows(backup.file)).toEqual([{ _id: 'w1', name: 'Old name' }]);
});

test('each append adds one JSON line to the same file; count follows the appends', () => {
  const backup = createBackupLog('some-script', { dir });
  backup.append({ _id: 'w1', grapes: [] });
  const first = backup.file;
  backup.append({ _id: 'w2', grapes: ['g1'] });

  expect(backup.file).toBe(first);
  expect(backup.count).toBe(2);
  expect(fs.readFileSync(first, 'utf8')).toBe('{"_id":"w1","grapes":[]}\n{"_id":"w2","grapes":["g1"]}\n');
  expect(fs.readdirSync(dir)).toHaveLength(1);
});

test('nothing appended: no file, count 0, and report() prints nothing', () => {
  const backup = createBackupLog('some-script', { dir });

  expect(backup.file).toBeNull();
  expect(backup.count).toBe(0);
  backup.report();
  expect(log).not.toHaveBeenCalled();
  expect(fs.readdirSync(dir)).toHaveLength(0);
});

test('report() names the file and the row count', () => {
  const backup = createBackupLog('some-script', { dir });
  backup.append({ _id: 'w1' });
  backup.append({ _id: 'w2' });
  log.mockClear();

  backup.report();
  const out = log.mock.calls.map((c) => c.join(' ')).join('\n');
  expect(out).toContain(backup.file);
  expect(out).toMatch(/\b2 pre-change rows\b/);
});

describe('the ephemeral-/tmp warning', () => {
  let savedEnv;
  beforeEach(() => {
    savedEnv = ['TMPDIR', 'TMP', 'TEMP', 'SCRIPT_BACKUP_DIR'].map((k) => [k, process.env[k]]);
  });
  afterEach(() => {
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  test('is printed when the file is in the OS temp directory (the default)', () => {
    // os.tmpdir() reads these, so the default directory is the test's own.
    process.env.TMPDIR = dir; process.env.TMP = dir; process.env.TEMP = dir;
    delete process.env.SCRIPT_BACKUP_DIR;
    const backup = createBackupLog('some-script');
    backup.append({ _id: 'w1' });
    expect(path.dirname(backup.file)).toBe(os.tmpdir());
    log.mockClear();

    backup.report();
    const out = log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toMatch(/ephemeral/);
    expect(out).toMatch(/--backup-dir=/);
  });

  test('is not printed for a directory the operator chose', () => {
    const backup = createBackupLog('some-script', { dir });
    backup.append({ _id: 'w1' });
    log.mockClear();

    backup.report();
    expect(log.mock.calls.map((c) => c.join(' ')).join('\n')).not.toMatch(/ephemeral/);
  });
});

describe('resolveBackupDir', () => {
  test('--backup-dir= on the command line comes first', () => {
    expect(resolveBackupDir(['node', 'x.js', '--apply', '--backup-dir=/app/uploads/backups'], { SCRIPT_BACKUP_DIR: '/srv/b' }))
      .toBe('/app/uploads/backups');
  });

  test('then SCRIPT_BACKUP_DIR', () => {
    expect(resolveBackupDir(['node', 'x.js', '--apply'], { SCRIPT_BACKUP_DIR: '/srv/b' })).toBe('/srv/b');
  });

  test('else the OS temp directory', () => {
    expect(resolveBackupDir(['node', 'x.js', '--apply'], {})).toBe(os.tmpdir());
    expect(resolveBackupDir(['node', 'x.js', '--backup-dir='], { SCRIPT_BACKUP_DIR: '' })).toBe(os.tmpdir());
  });
});
