import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';

// Renders a trusted-but-sanitised markdown string. Same rehype-sanitize guard
// used for the AI tasting profile on WineDetail. Wrap in a div so callers can
// style the block elements (headings, lists, paragraphs) via a className.
// Images are dropped (unwrapDisallowed keeps any alt text): an off-site <img>
// in a description would report every reader's IP to its host (audit 2026-09 F02-2).
export default function MarkdownText({ children, className }) {
  if (!children) return null;
  return (
    <div className={className}>
      <ReactMarkdown rehypePlugins={[rehypeSanitize]} disallowedElements={['img']} unwrapDisallowed>{children}</ReactMarkdown>
    </div>
  );
}
