import { useState, useEffect, useRef } from 'react';
import { track } from '../utils/track';
import './ConnectSnippet.css';

/**
 * A copyable code box for the AI-connector pages (/connect-ai and its Claude
 * guide): the text in a scrolling <pre>, with a Copy button floating over it.
 * A copy counts as an ai-connect-started event; `via` says which page it was.
 */
export default function ConnectSnippet({ text, copyLabel, copiedLabel, via = 'copy' }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);

  // Clear on unmount, and reset on every click, so rapid re-clicks can't have
  // an older timer flip the label back early.
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      track('ai-connect-started', { via });
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable (insecure context / denied) — the text is
         selectable anyway, so failing silently is the honest behaviour */
    }
  };

  return (
    <div className="connect-ai-snippet-block">
      <button type="button" className="btn btn-secondary btn-small connect-ai-copy" onClick={copy}>
        {copied ? copiedLabel : copyLabel}
      </button>
      <pre className="connect-ai-snippet"><code>{text}</code></pre>
    </div>
  );
}
