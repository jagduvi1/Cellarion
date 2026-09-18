import { useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import './GrapeTokenInput.css';

/**
 * GrapeTokenInput — pick grape varieties by typing (support ticket 2026-09-17:
 * a comma-separated text box is no way to enter varieties).
 *
 * One field holding the chosen varieties as removable chips plus a search box;
 * matches appear underneath as you type. Matching reads synonyms too, so
 * "Shiraz" finds Syrah and "Tinta Roriz" finds Tempranillo — the canonical
 * variety the registry stores — and says which name it matched on.
 *
 * A variety the list does not have can still be entered, deliberately: with
 * `allowNew` a no-match query offers "add as a new variety", and that chip is
 * marked so the form can tell the server which names are knowingly new.
 *
 * The admin screens keep GrapePicker (every option visible at once, id-based);
 * this one is for end users, on a phone, against a list of hundreds.
 *
 * Props:
 *   options  — [{ name, color, synonyms, wineCount }], or null while loading
 *   value    — [{ name, isNew? }] chosen varieties, in order
 *   onChange — callback(nextValue)
 *   max      — most varieties allowed (default 12, the server's cap)
 *   allowNew — offer "add as a new variety" for a no-match query
 *   inputId  — id for the text input, so a <label htmlFor> can name it
 *   error / onRetry — the list failed to load
 */

// How a name is SEARCHED: lowercase, no diacritics, punctuation as a space —
// so "Müller-Thurgau" is the two words "muller thurgau".
const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g');
const searchFold = (s) => String(s || '')
  .toLowerCase()
  .normalize('NFD')
  .replace(COMBINING_MARKS, '')
  .replace(/[^\w\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// What makes two spellings the SAME variety: the search form without its
// spaces, so "Muller Thurgau", "Müller-Thurgau" and "mullerthurgau" agree. It
// is only ever compared with itself — what is SENT is the canonical name of
// the option picked, which the server resolves its own way.
export const foldGrapeName = (s) => searchFold(s).replace(/ /g, '');

// Mirrors the server's guard on a deliberately-new name (services/
// wineProposalOps): a name, not "60% Merlot" and not a sentence.
const NEW_NAME = /^[\p{L}\d][\p{L}\p{M}\d .'’()/-]*$/u;
const looksLikeGrapeName = (s) => NEW_NAME.test(s)
  && (s.match(/\p{L}/gu) || []).length >= 2
  && s.length <= 60
  && s.split(' ').length <= 5;

const MAX_RESULTS = 7;
const NEW_MIN_CHARS = 3;
const NONE_TAKEN = new Set();

// One entry per name (a variety's own, or a synonym): `id` to compare,
// `key` + `words` to search.
const nameEntry = (label) => {
  const key = searchFold(label);
  return { label, id: key.replace(/ /g, ''), key, words: key.split(' ') };
};

export function buildGrapeIndex(options) {
  return (options || []).map((g) => ({
    ...nameEntry(g.name),
    name: g.name,
    color: g.color || null,
    wineCount: g.wineCount || 0,
    synonyms: (g.synonyms || []).map(nameEntry).filter((e) => e.id),
  }));
}

/**
 * Rank the varieties matching `query`. Tiers, best first: the name itself, a
 * synonym exactly, the name's start, a word inside the name, a synonym's
 * start, then anywhere in the name, then anywhere in a synonym. Within a tier
 * the variety more wines use comes first — "cab" should offer Cabernet
 * Sauvignon before Cabernet Cortis.
 */
export function searchGrapes(index, query, takenIds, limit = MAX_RESULTS) {
  const q = searchFold(query);
  if (!q) return [];
  const qId = q.replace(/ /g, '');
  // Spaced or run together: "muller thurgau" and "mullerthurgau" both find it.
  const starts = (e) => e.key.startsWith(q) || e.id.startsWith(qId);
  const contains = (e) => e.key.includes(q) || e.id.includes(qId);
  // Every typed word starts some word of the name: "cab sauv" finds Cabernet
  // Sauvignon, "blanc sauv" finds Sauvignon Blanc.
  const qWords = q.split(' ');
  const wordsMatch = (words) => qWords.every((qw) => words.some((w) => w.startsWith(qw)));
  const hits = [];
  for (const g of index) {
    if (takenIds.has(g.id)) continue;
    let tier = -1;
    let via = null;
    if (g.id === qId) tier = 0;
    else {
      const exactSyn = g.synonyms.find((e) => e.id === qId);
      if (exactSyn) { tier = 1; via = exactSyn.label; }
      else if (starts(g)) tier = 2;
      else if (wordsMatch(g.words)) tier = 3;
      else {
        const startSyn = g.synonyms.find((e) => starts(e) || wordsMatch(e.words));
        if (startSyn) { tier = 4; via = startSyn.label; }
        else if (contains(g)) tier = 5;
        else {
          const inSyn = g.synonyms.find(contains);
          if (inSyn) { tier = 6; via = inSyn.label; }
        }
      }
    }
    if (tier >= 0) hits.push({ grape: g, tier, via });
  }
  hits.sort((a, b) => a.tier - b.tier || b.grape.wineCount - a.grape.wineCount || a.grape.name.localeCompare(b.grape.name));
  return hits.slice(0, limit);
}

function GrapeTokenInput({ options, value = [], onChange, max = 12, allowNew = false, inputId, error = false, onRetry }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const listId = useId();

  const index = useMemo(() => buildGrapeIndex(options), [options]);
  const takenIds = useMemo(() => new Set(value.map((v) => foldGrapeName(v.name))), [value]);
  const hits = useMemo(() => searchGrapes(index, query, takenIds), [index, query, takenIds]);

  const typed = query.replace(/\s+/g, ' ').trim();
  const typedId = foldGrapeName(typed);
  // "New" only when the list truly lacks it — not when it is merely chosen
  // already, and not while a variety or synonym by exactly that name exists.
  const exactEntry = typedId
    ? index.find((g) => g.id === typedId || g.synonyms.some((e) => e.id === typedId))
    : null;
  const existsExactly = !!exactEntry;
  // Chosen already — under this name, or under the canonical name this one is a
  // synonym of ("Shiraz" typed after Syrah was picked).
  const chosenAs = exactEntry && takenIds.has(exactEntry.id) ? exactEntry.name : null;
  const alreadyChosen = !!chosenAs || (!!typedId && takenIds.has(typedId));
  // … and only when NOTHING matches. Next to real matches it is noise that
  // invites junk: "sauv" is the start of two varieties, not a third one.
  // "Nothing" is judged against the WHOLE list: `hits` leaves out what is
  // already chosen, so with Zinfandel picked, "Zinf" had no hits and was
  // offered as a new variety (pre-deploy audit 2026-09-18).
  const hiddenMatch = useMemo(
    () => (hits.length === 0 && typedId ? (searchGrapes(index, query, NONE_TAKEN, 1)[0] || null) : null),
    [hits.length, typedId, index, query]
  );
  const offerNew = allowNew && !!options && hits.length === 0 && !hiddenMatch && typed.length >= NEW_MIN_CHARS
    && !existsExactly && !alreadyChosen && looksLikeGrapeName(typed);

  const items = [
    ...hits.map((h) => ({ kind: 'grape', name: h.grape.name, color: h.grape.color, via: h.via })),
    ...(offerNew ? [{ kind: 'new', name: typed }] : []),
  ];
  const full = value.length >= max;
  const open = !!typedId && !full;
  const activeIndex = Math.min(active, Math.max(items.length - 1, 0));

  const pick = (item) => {
    if (!item || full) return;
    onChange([...value, item.kind === 'new' ? { name: item.name, isNew: true } : { name: item.name }]);
    setQuery('');
    setActive(0);
    inputRef.current?.focus();
  };

  const removeAt = (i) => {
    onChange(value.filter((_, idx) => idx !== i));
    inputRef.current?.focus();
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(Math.min(activeIndex + 1, Math.max(items.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(Math.max(activeIndex - 1, 0));
    } else if (e.key === 'Enter') {
      // Never let Enter in the search box submit the surrounding form.
      e.preventDefault();
      if (open) pick(items[activeIndex]);
    } else if (e.key === 'Escape' && query) {
      // First Escape clears the search; only an empty box lets it close a modal.
      e.preventDefault();
      e.stopPropagation();
      setQuery('');
    } else if (e.key === 'Backspace' && !query && value.length && !e.repeat) {
      // Not on key REPEAT: holding Backspace to clear a typo kept firing once
      // the box was empty and took one recorded grape per repeat — in a form
      // whose list REPLACES the wine's.
      removeAt(value.length - 1);
    }
  };

  const placeholder = !options
    ? (error ? '' : t('grapeInput.loading', 'Loading the grape list…'))
    : full
      ? t('grapeInput.full', 'That’s the maximum ({{max}})', { max })
      : value.length
        ? t('grapeInput.addAnother', 'Add another grape…')
        : t('grapeInput.search', 'Search {{count}} grape varieties…', { count: options.length });

  return (
    <div className="gti">
      <div className="gti-field" onClick={() => inputRef.current?.focus()}>
        {value.map((v, i) => (
          <span key={`${v.name}-${i}`} className={`gti-chip${v.isNew ? ' gti-chip--new' : ''}`}>
            {v.name}
            {v.isNew && <em className="gti-chip-tag">{t('grapeInput.newTag', 'new')}</em>}
            <button
              type="button"
              className="gti-chip-remove"
              onClick={(e) => { e.stopPropagation(); removeAt(i); }}
              aria-label={t('grapeInput.remove', 'Remove {{name}}', { name: v.name })}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          className="gti-input"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setActive(0); }}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={!options || full}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open && items.length > 0}
          aria-controls={open && items.length > 0 ? listId : undefined}
          aria-activedescendant={open && items.length ? `${listId}-${activeIndex}` : undefined}
          autoComplete="off"
          autoCapitalize="words"
          spellCheck={false}
          enterKeyHint="done"
        />
      </div>

      {error && !options && (
        <p className="gti-note gti-note--error" role="alert">
          {t('grapeInput.loadFailed', 'Couldn’t load the grape list.')}{' '}
          {onRetry && (
            <button type="button" className="gti-link" onClick={onRetry}>
              {t('grapeInput.retry', 'Try again')}
            </button>
          )}
        </p>
      )}

      {open && items.length === 0 && (
        // A status line, not a listbox row: inside the list it was presentational
        // and a screen reader never heard why nothing was offered.
        <p className="gti-empty gti-empty--alone" role="status">
          {chosenAs && foldGrapeName(chosenAs) !== typedId
            ? t('grapeInput.alreadyChosenAs', '“{{name}}” is {{canonical}}, which is already in the list.', { name: typed, canonical: chosenAs })
            : alreadyChosen
              ? t('grapeInput.alreadyChosen', '“{{name}}” is already in the list.', { name: typed })
              : hiddenMatch
                ? t('grapeInput.alreadyChosen', '“{{name}}” is already in the list.', { name: hiddenMatch.grape.name })
                : t('grapeInput.noMatch', 'No variety matches “{{name}}”.', { name: typed })}
        </p>
      )}

      {open && items.length > 0 && (
        <ul className="gti-list" role="listbox" id={listId}>
          {items.map((item, i) => (
            <li
              key={`${item.kind}-${item.name}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              className={`gti-option${i === activeIndex ? ' gti-option--active' : ''}${item.kind === 'new' ? ' gti-option--new' : ''}`}
              // Keep focus in the search box, so the keyboard stays up on a phone.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(item)}
            >
              {item.kind === 'grape' ? (
                <>
                  <span className={`gti-dot${item.color ? ` gti-dot--${item.color.toLowerCase()}` : ''}`} aria-hidden="true" />
                  <span className="gti-option-name">{item.name}</span>
                  {item.via && (
                    <span className="gti-option-via">{t('grapeInput.alsoKnownAs', 'also {{name}}', { name: item.via })}</span>
                  )}
                </>
              ) : (
                <>
                  <span className="gti-plus" aria-hidden="true">+</span>
                  <span className="gti-option-name">
                    {t('grapeInput.addNew', 'Add “{{name}}” as a new variety', { name: item.name })}
                    <span className="gti-option-sub">{t('grapeInput.addNewHint', 'Not in our list yet — a curator will check it')}</span>
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default GrapeTokenInput;
