/**
 * Strip the userinfo part (user:password@) out of a URL-ish string before it
 * is stored or shown. restic repository strings such as
 * `rest:https://user:pass@host:8000/` or `s3:https://KEY:SECRET@host/bucket`
 * carry credentials in the authority; the super-admin backup panel must show
 * where the backups go without showing how to open them (audit 2026-09 F05-5).
 * Non-strings and strings without an authority pass through unchanged.
 */
function redactUrlCredentials(value) {
  if (typeof value !== 'string' || !value) return value;
  return value.replace(/(:\/\/)[^/@\s]*@/g, '$1***@');
}

module.exports = { redactUrlCredentials };
