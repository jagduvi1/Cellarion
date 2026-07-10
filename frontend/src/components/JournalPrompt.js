import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';

const JournalEntryForm = lazy(() => import('./JournalEntryForm'));

const OPTOUT_KEY = 'cellarion_journal_prompt_optout';

// localStorage can throw in private-browsing / blocked-storage contexts —
// treat that as "no opt-out saved" so the prompt still works.
export function journalPromptOptedOut() {
  try { return localStorage.getItem(OPTOUT_KEY) === '1'; } catch { return false; }
}

export function setJournalPromptOptOut(optOut) {
  try {
    if (optOut) localStorage.setItem(OPTOUT_KEY, '1');
    else localStorage.removeItem(OPTOUT_KEY);
  } catch { /* ignore */ }
}

/**
 * Post-consume "Add to your journal?" prompt, shared by every consume flow
 * (bottle detail, flat rack view, 3D room view). Shows the prompt first; if
 * the user accepts, swaps to the full JournalEntryForm prefilled with the
 * consumed bottle. Calls onDone() when the flow is over, however it ended.
 *
 * The "Don't ask again" checkbox persists the opt-out per device; it can be
 * re-enabled from Settings → Display Preferences.
 */
export default function JournalPrompt({ bottle, onDone }) {
  const { t } = useTranslation();
  const [formOpen, setFormOpen] = useState(false);
  const [dontAsk, setDontAsk] = useState(false);

  const finish = () => {
    if (dontAsk) setJournalPromptOptOut(true);
    onDone();
  };

  const accept = () => {
    if (dontAsk) setJournalPromptOptOut(true);
    setFormOpen(true);
  };

  if (formOpen) {
    return (
      <Suspense fallback={null}>
        <JournalEntryForm prefilledBottle={bottle} onClose={onDone} onSaved={onDone} />
      </Suspense>
    );
  }

  return (
    <div className="modal-overlay" onClick={finish}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <h2>{t('journal.promptTitle', 'Add to your journal?')}</h2>
        <p>{t('journal.promptText', 'Would you like to capture this moment in your wine journal?')}</p>
        <div className="modal-actions" style={{ flexDirection: 'column', gap: '0.5rem' }}>
          <button className="btn btn-primary" onClick={accept}>
            {t('journal.yesAddEntry', 'Yes, add journal entry')}
          </button>
          <button className="btn btn-secondary" onClick={finish}>
            {t('journal.notNow', 'Not now')}
          </button>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.75rem', fontSize: '0.85rem', opacity: 0.75, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={dontAsk}
            onChange={e => setDontAsk(e.target.checked)}
          />
          {t('journal.dontAskAgain', "Don't ask again")}
        </label>
      </div>
    </div>
  );
}
