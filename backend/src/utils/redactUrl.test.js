const { redactUrlCredentials } = require('./redactUrl');

test('removes user:password from the authority of every URL in the string', () => {
  expect(redactUrlCredentials('rest:https://backup:s3cr3t@box.example:8000/cellarion')).toBe('rest:https://***@box.example:8000/cellarion');
  expect(redactUrlCredentials('s3:https://AKIA:SECRET@s3.eu.example/bucket')).toBe('s3:https://***@s3.eu.example/bucket');
});

test('leaves credential-free strings and non-strings alone', () => {
  expect(redactUrlCredentials('sftp:u123@u123.your-storagebox.de:/restic')).toBe('sftp:u123@u123.your-storagebox.de:/restic');
  expect(redactUrlCredentials('/mnt/backups/restic')).toBe('/mnt/backups/restic');
  expect(redactUrlCredentials('')).toBe('');
  expect(redactUrlCredentials(null)).toBeNull();
  expect(redactUrlCredentials(undefined)).toBeUndefined();
});
