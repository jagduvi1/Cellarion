import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import './ReactionPicker.css';

// Curated reaction set. Lock-stepped with backend's REACTION_KINDS in
// backend/src/models/DiscussionReaction.js — adding a new kind requires
// updating both ends. Keys are the backend `kind` enum; emoji + label are
// frontend-only so we can reorder/relabel without a migration.
export const REACTIONS = [
  { kind: 'thumbs_up', emoji: '👍', labelKey: 'reactions.thumbsUp' },
  { kind: 'heart',     emoji: '❤️', labelKey: 'reactions.heart' },
  { kind: 'cheers',    emoji: '🥂', labelKey: 'reactions.cheers' },
  { kind: 'wine',      emoji: '🍷', labelKey: 'reactions.wine' },
  { kind: 'thinking',  emoji: '🤔', labelKey: 'reactions.thinking' },
  { kind: 'target',    emoji: '🎯', labelKey: 'reactions.target' },
  { kind: 'laugh',     emoji: '😂', labelKey: 'reactions.laugh' },
  { kind: 'pray',      emoji: '🙏', labelKey: 'reactions.pray' }
];

// Lookup table for emoji-by-kind; used by ReactionChip to render existing
// counts without re-iterating the array.
export const EMOJI_BY_KIND = Object.fromEntries(REACTIONS.map(r => [r.kind, r.emoji]));

/**
 * Floating "+" button that opens the 8-reaction picker. Calls onPick with
 * the chosen kind. Closes on outside click or Escape.
 */
export default function ReactionPicker({ onPick, disabled }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const choose = (kind) => {
    onPick?.(kind);
    setOpen(false);
  };

  return (
    <div className="reaction-picker" ref={wrapRef}>
      <button
        type="button"
        className="reaction-picker__toggle"
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
        aria-label={t('reactions.addReaction')}
        aria-expanded={open}
        title={t('reactions.addReaction')}
      >
        <span aria-hidden="true">😊</span>
        <span aria-hidden="true" className="reaction-picker__plus">+</span>
      </button>
      {open && (
        <div className="reaction-picker__panel" role="menu">
          {REACTIONS.map(r => (
            <button
              key={r.kind}
              type="button"
              role="menuitem"
              className="reaction-picker__option"
              onClick={() => choose(r.kind)}
              title={t(r.labelKey)}
            >
              <span className="reaction-picker__emoji" aria-hidden="true">{r.emoji}</span>
              <span className="reaction-picker__label">{t(r.labelKey)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
