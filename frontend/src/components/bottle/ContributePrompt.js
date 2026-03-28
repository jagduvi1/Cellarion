import { useState } from 'react';
import { Link } from 'react-router-dom';

function ContributePrompt({ storageKey, icon, title, message, actionLabel, onAction, actionHref }) {
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(storageKey) === '1'; } catch { return false; }
  });

  if (dismissed) return null;

  const dismiss = () => {
    try { localStorage.setItem(storageKey, '1'); } catch {}
    setDismissed(true);
  };

  return (
    <div className="bd-contribute">
      <button className="bd-contribute__dismiss" onClick={dismiss} aria-label="Dismiss">&times;</button>
      <div className="bd-contribute__body">
        <span className="bd-contribute__icon">{icon}</span>
        <div className="bd-contribute__text">
          <strong className="bd-contribute__title">{title}</strong>
          <p className="bd-contribute__msg">{message}</p>
        </div>
      </div>
      {actionHref ? (
        <Link to={actionHref} className="bd-contribute__action">{actionLabel} &rarr;</Link>
      ) : (
        <button className="bd-contribute__action" onClick={onAction}>{actionLabel} &rarr;</button>
      )}
    </div>
  );
}

export default ContributePrompt;
