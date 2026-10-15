// A back link's text without a leading arrow. The back links draw their own
// chevron icon, and many translated labels also start with "←" (from before
// the icon existed), so every back link read "‹ ← Back to …" (live
// walkthrough 2026-10-15). Stripping it here fixes every language at once
// and leaves the strings alone for the screens that show them without an icon.
export function backLabel(label) {
  return String(label ?? '').replace(/^\s*(?:←|‹|<|&larr;)\s*/, '');
}
