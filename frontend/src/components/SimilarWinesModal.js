import Modal from './Modal';
import WineImage from './WineImage';
import './WineModalThumbs.css';

/**
 * Shown when the backend's find-or-create returns soft-zone candidates —
 * the wine the user is trying to add is similar to existing entries but
 * not similar enough to auto-match. Asks the user to pick one or confirm
 * "no, create a new wine".
 *
 * Props:
 *   candidates   — [{ wine, score }] from /api/wines/find-or-create
 *   queryName    — the name the user was trying to add (shown in the prompt)
 *   onPick(wine) — user picked an existing wine
 *   onCreateNew  — user wants to create a new wine anyway
 *   onCancel     — user wants to back out and re-enter / cancel
 *   busy         — disables buttons while a follow-up request is in flight
 */
function SimilarWinesModal({ candidates, queryName, onPick, onCreateNew, onCancel, busy }) {
  return (
    <Modal title="Did you mean one of these?" onClose={onCancel} showClose wide>
      <p style={{ margin: '0 0 1rem', fontSize: '0.95rem', color: 'var(--text-secondary, #666)' }}>
        We found wines in the registry that look close to{' '}
        <strong>{queryName || 'what you entered'}</strong>. Picking an existing
        wine keeps the registry tidy and lets you share data with other users.
      </p>

      <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 1.25rem', maxHeight: 380, overflowY: 'auto' }}>
        {candidates.map(({ wine, score }) => (
          <li
            key={wine._id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '0.6rem 0.4rem',
              borderBottom: '1px solid var(--border, #e5e5e5)',
            }}
          >
            <div style={{ width: 48, height: 64, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <WineImage
                image={wine.image}
                alt={wine.name}
                className="similar-wine-thumb"
                wineType={wine.type}
                placeholder="similar-wine-placeholder"
              />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{wine.name}</div>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary, #666)' }}>
                {wine.producer}
                {wine.country?.name ? ` · ${wine.country.name}` : ''}
                {wine.region?.name ? ` · ${wine.region.name}` : ''}
              </div>
              {wine.appellation && (
                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary, #888)' }}>{wine.appellation}</div>
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
              <span
                title="Similarity score"
                style={{ fontSize: '0.75rem', color: 'var(--text-secondary, #888)' }}
              >
                {Math.round(score * 100)}% match
              </span>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => onPick(wine)}
                style={{ padding: '0.35rem 0.8rem', fontSize: '0.85rem' }}
              >
                Use this
              </button>
            </div>
          </li>
        ))}
      </ul>

      <div className="modal-actions" style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={onCreateNew}>
          No, create new wine
        </button>
      </div>
    </Modal>
  );
}

export default SimilarWinesModal;
