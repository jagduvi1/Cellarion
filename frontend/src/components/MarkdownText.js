import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';

// Renders a trusted-but-sanitised markdown string. Same rehype-sanitize guard
// used for the AI tasting profile on WineDetail. Wrap in a div so callers can
// style the block elements (headings, lists, paragraphs) via a className.
export default function MarkdownText({ children, className }) {
  if (!children) return null;
  return (
    <div className={className}>
      <ReactMarkdown rehypePlugins={[rehypeSanitize]}>{children}</ReactMarkdown>
    </div>
  );
}
