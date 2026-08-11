import { useTranslation, Trans } from 'react-i18next';
import Modal from './Modal';
import WineImage from './WineImage';
import './WineModalThumbs.css';

/**
 * Shown when the dedup soft zone returns candidates — the wine the user is
 * trying to add is similar to existing entries but not similar enough to
 * auto-match. Asks the user to pick one or confirm "no, create a new wine".
 * Candidates come from the step-1 resolve (/api/wines/find-or-create, now
 * read-only) or, in the rare commit-time race, from the bottle/wishlist POST
 * itself — which creates NOTHING until this dialog is answered.
 *
 * Props:
 *   candidates   — [{ wine, score }]
 *   queryName    — the name the user was trying to add (shown in the prompt)
 *   onPick(wine) — user picked an existing wine
 *   onCreateNew  — user wants to create a new wine anyway
 *   onCancel     — user wants to back out and re-enter / cancel
 *   busy         — disables buttons while a follow-up request is in flight
 */
function SimilarWinesModal({ candidates, queryName, onPick, onCreateNew, onCancel, busy }) {
  const { t } = useTranslation();
  return (
    <Modal title={t('similarWines.title')} onClose={onCancel} showClose wide>
      <p style={{ margin: '0 0 1rem', fontSize: '0.95rem', color: 'var(--color-text-secondary, #666)' }}>
        <Trans
          i18nKey="similarWines.intro"
          components={{ strong: <strong /> }}
          values={{ query: queryName || t('similarWines.whatYouEntered') }}
        />
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
              borderBottom: '1px solid var(--color-border, #e5e5e5)',
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
              <div style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary, #666)' }}>
                {wine.producer}
                {wine.country?.name ? ` · ${wine.country.name}` : ''}
                {wine.region?.name ? ` · ${wine.region.name}` : ''}
              </div>
              {wine.appellation && (
                <div style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary, #888)' }}>{wine.appellation}</div>
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
              <span
                title={t('similarWines.similarityTitle')}
                style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary, #888)' }}
              >
                {t('similarWines.matchLabel', { percent: Math.round(score * 100) })}
              </span>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => onPick(wine)}
                style={{ padding: '0.35rem 0.8rem', fontSize: '0.85rem' }}
              >
                {t('similarWines.useThis')}
              </button>
            </div>
          </li>
        ))}
      </ul>

      <div className="modal-actions" style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={onCreateNew}>
          {t('similarWines.createNew')}
        </button>
      </div>
    </Modal>
  );
}

export default SimilarWinesModal;
