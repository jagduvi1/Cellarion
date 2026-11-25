// A back link's text without a leading arrow. The back links draw their own
// chevron icon, and many translated labels also start with "←", which would
// read "‹ ← Back to …". Stripping it here covers every language at once
// and leaves the strings alone for the screens that show them without an icon.
export function backLabel(label) {
  return String(label ?? '').replace(/^\s*(?:←|‹|<)\s*/, '');
}
