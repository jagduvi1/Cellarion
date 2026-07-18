// Flatten a markdown string to plain text for places that must stay
// unformatted: <meta description>, JSON-LD, OpenGraph. Not a full parser —
// just strips the syntax our taxonomy descriptions actually use (headings,
// bold/italic, links, inline code, list bullets, blockquotes) and collapses
// whitespace. Rendering to the page uses react-markdown; this is for metadata.
export default function stripMarkdown(md) {
  if (!md) return '';
  return String(md)
    .replace(/`([^`]+)`/g, '$1')            // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')    // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → link text
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')      // ATX headings
    .replace(/^\s{0,3}>\s?/gm, '')           // blockquotes
    .replace(/^\s*[-*+]\s+/gm, '')           // unordered list bullets
    .replace(/^\s*\d+\.\s+/gm, '')           // ordered list markers
    .replace(/(\*\*|__)(.*?)\1/g, '$2')      // bold
    .replace(/(\*|_)(.*?)\1/g, '$2')         // italic
    .replace(/\s+/g, ' ')                     // collapse whitespace/newlines
    .trim();
}
