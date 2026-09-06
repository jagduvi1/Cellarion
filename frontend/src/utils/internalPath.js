/**
 * Accept only an in-app path ("/cellars/abc", "/wines/x?tab=y#z") and return
 * it normalised. Anything that could leave the origin — an absolute URL, a
 * protocol-relative "//host", a backslash variant, javascript: — yields null.
 * Use it wherever a navigation target arrives as DATA (a notification's link,
 * a stored return path) rather than as code (audit 2026-09 F03-5).
 */
export default function internalPath(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v.startsWith('/') || v.startsWith('//') || v.startsWith('/\\')) return null;
  if (/[\\\x00-\x1f]/.test(v)) return null;
  try {
    const u = new URL(v, 'http://cellarion.invalid');
    if (u.origin !== 'http://cellarion.invalid') return null;
    return u.pathname + u.search + u.hash;
  } catch {
    return null;
  }
}
