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

/**
 * Floating "+" button that opens the 8-reaction picker. Calls onPick with
 * the chosen kind. Closes on outside click or Escape.
 *
 * Keyboard nav (WAI-ARIA menu pattern): when the panel opens, focus jumps
 * to the first option. Arrow Up/Down cycles within the panel; Home/End
 * jump to the ends; Escape closes and returns focus to the toggle.
 */
export default function ReactionPicker({ onPick, disabled }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const wrapRef = useRef(null);
  const toggleRef = useRef(null);
  const optionRefs = useRef([]);

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

  // Focus first option on open; restore focus to toggle on close.
  useEffect(() => {
    if (open) {
      setActiveIdx(0);
      // Defer focus until after the panel has mounted.
      const id = requestAnimationFrame(() => {
        optionRefs.current[0]?.focus();
      });
      return () => cancelAnimationFrame(id);
    } else if (toggleRef.current && document.activeElement && wrapRef.current?.contains(document.activeElement)) {
      // Only restore focus if we owned focus when closing — avoids stealing
      // focus when the user clicked outside to dismiss.
      toggleRef.current.focus();
    }
    return undefined;
  }, [open]);

  const choose = (kind) => {
    onPick?.(kind);
    setOpen(false);
  };

  const handlePanelKey = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = (activeIdx + 1) % REACTIONS.length;
      setActiveIdx(next);
      optionRefs.current[next]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const next = (activeIdx - 1 + REACTIONS.length) % REACTIONS.length;
      setActiveIdx(next);
      optionRefs.current[next]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActiveIdx(0);
      optionRefs.current[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      const last = REACTIONS.length - 1;
      setActiveIdx(last);
      optionRefs.current[last]?.focus();
    }
  };

  return (
    <div className="reaction-picker" ref={wrapRef}>
      <button
        ref={toggleRef}
        type="button"
        className="reaction-picker__toggle"
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
        aria-label={t('reactions.addReaction')}
        aria-expanded={open}
        aria-haspopup="menu"
        title={t('reactions.addReaction')}
      >
        <span aria-hidden="true">😊</span>
        <span aria-hidden="true" className="reaction-picker__plus">+</span>
      </button>
      {open && (
        <div
          className="reaction-picker__panel"
          role="menu"
          aria-label={t('reactions.addReaction')}
          onKeyDown={handlePanelKey}
        >
          {REACTIONS.map((r, idx) => (
            <button
              key={r.kind}
              ref={el => { optionRefs.current[idx] = el; }}
              type="button"
              role="menuitem"
              tabIndex={idx === activeIdx ? 0 : -1}
              className="reaction-picker__option"
              onClick={() => choose(r.kind)}
              onFocus={() => setActiveIdx(idx)}
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
