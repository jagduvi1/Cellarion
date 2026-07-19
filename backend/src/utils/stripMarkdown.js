// Flatten a markdown string to plain text. Backend counterpart of
// frontend/src/utils/stripMarkdown.js — kept deliberately in sync, same rules.
//
// Why the backend needs it: LLM enrichment output is persisted once and then
// read by consumers that do NOT render markdown (the MCP tools get_wine /
// get_bottle emit the raw subdoc as JSON), so emphasis that renders fine on
// WineDetail leaks as literal ** elsewhere. Stripping at the write point keeps
// every consumer honest without each having to know about markdown.
//
// Not a full parser — it strips the syntax our prose actually uses (headings,
// bold/italic, links, inline code, list bullets, blockquotes) and collapses
// whitespace.
function stripMarkdown(md) {
  if (!md) return '';
  return String(md)
    .replace(/`([^`]+)`/g, '$1')             // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')    // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → link text
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')      // ATX headings
    .replace(/^\s{0,3}>\s?/gm, '')           // blockquotes
    .replace(/^\s*[-*+]\s+/gm, '')           // unordered list bullets
    .replace(/^\s*\d+\.\s+/gm, '')           // ordered list markers
    .replace(/(\*\*|__)(.*?)\1/g, '$2')      // bold
    .replace(/(\*|_)(.*?)\1/g, '$2')         // italic
    .replace(/\s+/g, ' ')                    // collapse whitespace/newlines
    .trim();
}

module.exports = { stripMarkdown };
