import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../Modal';
import { createWineProposal } from '../../api/wineProposals';
import { getSweetnessTerms } from '../../api/taxonomy';
import { messageForResponse } from '../../utils/friendlyError';
import { SWEETNESS_CATEGORIES, sweetnessCategoryLabel } from '../../utils/sweetnessCategory';

/**
 * The "Sweetness" row of the wine record (WineRecordSection), and the form
 * that suggests the term a wine is KNOWN by when its label prints none.
 *
 * Three different facts can stand in this row, and they must not look alike:
 *   - the term the LABEL states (wine.labelSweetness) — part of the wine's
 *     identity, shown as it is;
 *   - the sweetness STYLE (wine.sweetnessStyle) — a term the producer or the
 *     trade names, shown as "known as …" with the page that says so;
 *   - with neither, the CATEGORY the record reads as all the same
 *     (wine.sweetnessCategory, worked out by the server: a sweetness word in
 *     the name, a tier that settles it, the type "dessert"), shown with what
 *     it rests on. A wine that reads as none says "not recorded".
 * Only the style can be suggested here, and not on a wine whose name carries
 * the word: the name states it already. It is filed like every other fix
 * (POST /api/wine-proposals, fields.sweetnessStyle = { term, source, url }).
 * The server applies a customary term at once on a typed wine that has no
 * style and answers `applied`; otherwise a curator decides.
 *
 * Who names the term is the member's own statement and is never chosen for
 * them: a term with a legal definition counts only from the producer, so with
 * such a term the form waits until the member has said "the producer".
 *
 * The form's own state lives here; what a filing changes on the page (the
 * pending line, the thanks, the re-read of the wine) is the section's, told
 * through onFiled(body, fields).
 */

const SOURCES = ['producer', 'trade'];
const NOTE_MIN = 10;
// The bands in reading order, dry first, per scale (models/SweetnessTerm BANDS).
const BAND_ORDER = ['dry', 'off-dry', 'medium-sweet', 'sweet', 'brut-nature', 'extra-brut', 'brut', 'extra-dry', 'sec', 'demi-sec', 'doux'];
const bandRank = (b) => (BAND_ORDER.includes(b) ? BAND_ORDER.indexOf(b) : BAND_ORDER.length);

/** The scale a wine's terms are chosen from; null while its type is unknown. */
const scaleOf = (wine) => (wine.type ? (wine.type === 'sparkling' ? 'sparkling' : 'still') : null);

/** No sweetness term applies to a fortified wine or to a drink that is not wine. */
export const hasSweetnessRow = (wine) => !!wine && wine.nonWine !== true && wine.type !== 'fortified';

function SweetnessStyleRow({ wine, canSuggest, suggestMode, blocked, pending, apiFetch, onFiled }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [terms, setTerms] = useState(null); // null = not loaded
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [term, setTerm] = useState('');
  const [source, setSource] = useState('');
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const scale = scaleOf(wine);
  const wineId = wine._id;

  // The terms are fetched when the form opens, not with the page: most visits
  // never open it. The latest request wins: an answer for a form that has
  // closed, or for another wine, is dropped (a generation counter).
  const generation = useRef(0);
  useEffect(() => {
    if (!open) return undefined;
    const mine = ++generation.current;
    setTerms(null);
    setLoadFailed(false);
    (async () => {
      try {
        const res = await getSweetnessTerms(apiFetch, scale);
        const body = await res.json().catch(() => ({}));
        if (mine !== generation.current) return;
        if (!res.ok || !Array.isArray(body.terms)) { setLoadFailed(true); return; }
        setTerms(body.terms);
      } catch {
        if (mine === generation.current) setLoadFailed(true);
      }
    })();
    return () => { generation.current += 1; };
  }, [open, apiFetch, scale, wineId, attempt]);

  // The form belongs to one wine: it closes when the wine changes, and an
  // answer still on its way for the wine before is not this wine's.
  const shownWine = useRef(wineId);
  useEffect(() => {
    shownWine.current = wineId;
    setOpen(false);
  }, [wineId]);

  // The dialog itself takes focus when the form opens: its first control is a
  // list that is still loading, and a screen reader should read the title.
  const formRef = useRef(null);
  useEffect(() => {
    if (open) formRef.current?.closest('[role="dialog"]')?.focus();
  }, [open]);

  const sourceLabel = (s) => (s === 'producer'
    ? t('wineRecord.styleByProducer', 'named by the producer')
    : t('wineRecord.styleByTrade', 'named by the trade'));
  const withSource = (name, s) => t('wineRecord.styleWithSource', '{{term}} ({{source}})', { term: name, source: sourceLabel(s) });

  const labelTerm = wine.labelSweetness && typeof wine.labelSweetness === 'object' ? wine.labelSweetness.name : null;
  const style = wine.sweetnessStyle && typeof wine.sweetnessStyle === 'object' && wine.sweetnessStyle.name ? wine.sweetnessStyle : null;
  // What the record reads as when neither term is there to show, and why.
  const category = SWEETNESS_CATEGORIES.includes(wine.sweetnessCategory) ? wine.sweetnessCategory : null;
  const basis = category ? wine.sweetnessCategoryBasis : null;
  const basisText = basis === 'name' ? t('wineRecord.categoryFromName', 'from the name')
    : basis === 'tier' ? t('wineRecord.categoryFromTier', 'by its tier')
      : basis === 'type' ? t('wineRecord.categoryFromType', 'dessert wine')
        : null;

  const openForm = () => {
    setTerm('');
    setSource('');
    setUrl('');
    setNote('');
    setError(null);
    setOpen(true);
  };

  const chosen = (terms || []).find((x) => x.name === term) || null;
  // A term with a legal definition is a statement by the wine: only the
  // producer names it. The member says who names it; nothing is chosen for them.
  const producerOnly = !!chosen && chosen.regulated !== false;
  const sourceRefused = producerOnly && source === 'trade';
  const linkOk = /^https?:\/\/\S+\.\S+/i.test(url.trim());
  const canSend = !!chosen && SOURCES.includes(source) && !sourceRefused && linkOk && !busy;
  // What the server does with it (services/proposalDirectApply): a customary
  // term on a typed wine that has no style goes live at once.
  const goesLive = !!chosen && !producerOnly && !style && !!scale;

  const groups = [];
  for (const x of [...(terms || [])].sort((a, b) => bandRank(a.band) - bandRank(b.band) || a.name.localeCompare(b.name))) {
    const last = groups[groups.length - 1];
    if (last && last.band === x.band && last.scale === x.scale) last.terms.push(x);
    else groups.push({ band: x.band, scale: x.scale, terms: [x] });
  }
  const bandLabel = (g) => {
    const band = t(`sweetness.band.${g.band}`, g.band);
    // With the type unknown both scales are offered, and say which they are.
    return scale ? band : t('wineRecord.styleBandOnScale', '{{band}} · {{scale}}', { band, scale: t(`sweetness.scale.${g.scale}`, g.scale) });
  };

  // Arrow keys move within the two choices; the group is one tab stop.
  const onSourceKey = (e) => {
    const dir = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1
      : (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const i = SOURCES.indexOf(source);
    const next = SOURCES[i === -1 ? (dir > 0 ? 0 : SOURCES.length - 1) : (i + dir + SOURCES.length) % SOURCES.length];
    setSource(next);
    Array.from(e.currentTarget.querySelectorAll('[role="radio"]')).find((b) => b.dataset.value === next)?.focus();
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!canSend) return;
    setBusy(true);
    setError(null);
    const sentFor = wineId;
    const fields = { sweetnessStyle: { term: chosen.name, source, url: url.trim() } };
    const typed = note.trim();
    // The link is the evidence; a note is welcome, never required. A short
    // one rides behind the sentence that says what is filed.
    const composed = t('wineRecord.styleReasonDefault', '{{term}}: the term this wine is known by, {{source}} on the linked page.', { term: chosen.name, source: sourceLabel(source) });
    try {
      const res = await createWineProposal(apiFetch, {
        wineId: sentFor,
        fields,
        reason: typed.length >= NOTE_MIN ? typed : (typed ? `${composed} ${typed}` : composed),
        evidenceUrl: url.trim(),
      });
      const body = await res.json().catch(() => ({}));
      // The page moved on to another wine while this was on its way.
      if (shownWine.current !== sentFor) return;
      if (res.ok) {
        setOpen(false);
        onFiled(body, fields);
      } else {
        setError(messageForResponse(res, body, undefined, t));
      }
    } catch {
      if (shownWine.current === sentFor) setError(t('common.networkError', 'Network error. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  const fieldName = t('wineRecord.field_sweetness', 'Sweetness');
  // The label's own term is not suggested here, and a style beside it — or
  // beside a name that carries the word — would say nothing new: no action on
  // such a wine.
  const canAct = canSuggest && suggestMode && !blocked && !pending && !labelTerm && basis !== 'name';

  return (
    <div className="wr-row">
      <span className="wr-key">{fieldName}</span>
      {labelTerm ? (
        <span className="wr-value">{labelTerm}</span>
      ) : style ? (
        <span className="wr-value">
          <span className="wr-style-source">{t('wineRecord.styleKnownAs', 'known as')}</span>{' '}
          {style.name}{' '}
          <span className="wr-style-source">
            {'· '}
            {style.sourceUrl ? (
              <a href={style.sourceUrl} target="_blank" rel="noopener noreferrer nofollow">{sourceLabel(style.source)}</a>
            ) : sourceLabel(style.source)}
          </span>
        </span>
      ) : category ? (
        <span className="wr-value">
          {sweetnessCategoryLabel(t, category)}
          {basisText && <>{' '}<span className="wr-style-source">{'· '}{basisText}</span></>}
        </span>
      ) : (
        <span className="wr-value wr-value--blank">{t('wineRecord.notRecorded', 'not recorded')}</span>
      )}
      {canAct ? (
        <button
          type="button"
          className="wr-suggest-btn"
          onClick={openForm}
          aria-label={t('wineRecord.suggestFor', 'Suggest a fix for {{field}}', { field: fieldName })}
        >
          {style ? t('wineRecord.fix', 'Fix') : t('wineRecord.add', 'Add')}
        </button>
      ) : null}
      {canSuggest && pending && (
        <span className="wr-pending-line" title={t('wineRecord.pendingTitle', 'Your suggestion is awaiting curator review')}>
          <span className="wr-pending-label">{t('wineRecord.yourSuggestion', 'Your suggestion')}</span>{' '}
          <span className="wr-pending-value">{withSource(pending.term, pending.source)}</span>{' '}
          <span className="wr-pending">{t('wineRecord.pending', 'suggestion pending')}</span>
        </span>
      )}

      {open && (
        <Modal trapFocus title={t('wineRecord.styleModalTitle', 'Sweetness: the term this wine is known by')} onClose={() => !busy && setOpen(false)}>
          <form onSubmit={submit} className="pd-form" ref={formRef}>
            {error && <div className="alert alert-error" style={{ marginBottom: 8 }}>{error}</div>}
            <p className="wr-help" style={{ marginTop: 0 }}>
              {t('wineRecord.styleIntro', 'For a wine whose label prints no sweetness word, but which the producer or the trade calls by one: feinherb, fruchtsüß and the like. A word the label prints is part of the wine’s name, not this.')}
            </p>
            {style && (
              <div className="form-group">
                <label>{t('wineRecord.current', 'Currently recorded')}</label>
                <div className="wr-current">{withSource(style.name, style.source)}</div>
              </div>
            )}

            <div className="form-group">
              <label htmlFor="wr-style-term">{t('wineRecord.styleTermLabel', 'The term')}</label>
              {/* Always there, so the label has its control; filled when the list arrives. */}
              <select id="wr-style-term" value={term} onChange={(e) => setTerm(e.target.value)} disabled={!terms} required>
                <option value="">
                  {terms ? t('wineRecord.styleTermChoose', 'Choose a term…') : (loadFailed ? '' : t('common.loading', 'Loading...'))}
                </option>
                {groups.map((g) => (
                  <optgroup key={`${g.scale}-${g.band}`} label={bandLabel(g)}>
                    {g.terms.map((x) => <option key={x._id} value={x.name}>{x.name}</option>)}
                  </optgroup>
                ))}
              </select>
              {loadFailed && (
                <p className="wr-help wr-help--note">
                  {t('wineRecord.styleLoadFailed', 'Couldn’t load the list of sweetness terms.')}{' '}
                  <button type="button" className="wr-text-btn" onClick={() => setAttempt((n) => n + 1)}>
                    {t('common.retry', 'Retry')}
                  </button>
                </p>
              )}
            </div>

            <div className="form-group">
              <span className="wr-group-label" id="wr-style-source-label">{t('wineRecord.styleSourceLabel', 'Who calls it that?')}</span>
              <div className="wr-choices" role="radiogroup" aria-labelledby="wr-style-source-label" onKeyDown={onSourceKey}>
                {SOURCES.map((s, idx) => (
                  <button
                    key={s}
                    type="button"
                    role="radio"
                    data-value={s}
                    aria-checked={source === s}
                    // One tab stop for the group; the arrows move within it.
                    tabIndex={(source ? source === s : idx === 0) ? 0 : -1}
                    className={`wr-choice${source === s ? ' wr-choice--on' : ''}`}
                    onClick={() => setSource(s)}
                  >
                    {s === 'producer'
                      ? t('wineRecord.styleSourceProducer', 'The producer')
                      : t('wineRecord.styleSourceTrade', 'A merchant, critic or wine database')}
                  </button>
                ))}
              </div>
              {producerOnly && (
                <p className={`wr-help${sourceRefused ? ' wr-help--note' : ''}`} role="status">
                  {t('wineRecord.styleRegulatedNote', '“{{term}}” has a legal definition, so only the producer’s own wording counts for it.', { term: chosen.name })}
                </p>
              )}
            </div>

            <div className="form-group">
              <label htmlFor="wr-style-url">{t('wineRecord.styleUrlLabel', 'The page that names it')}</label>
              <input
                id="wr-style-url"
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://…"
                maxLength={500}
                required
              />
              <p className="wr-help">
                {t('wineRecord.styleUrlHelp', 'A page that uses this term for this wine. Another vintage of the same wine is fine. Your own impression of the taste is not a source.')}
              </p>
            </div>

            <div className="form-group">
              <label htmlFor="wr-style-note">{t('wineRecord.styleNoteLabel', 'Anything a curator should know (optional)')}</label>
              <textarea id="wr-style-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={900} rows={2} />
            </div>

            {chosen && (
              <p className="wr-help" role="status">
                {goesLive
                  ? t('wineRecord.styleGoesLive', 'This wine has no such term yet, so yours goes live at once.')
                  : t('wineRecord.styleReviewed', 'A curator reviews this before it goes live.')}
              </p>
            )}
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setOpen(false)} disabled={busy}>
                {t('common.cancel', 'Cancel')}
              </button>
              <button type="submit" className="btn btn-primary" disabled={!canSend}>
                {busy ? t('wineRecord.sending', 'Sending…') : t('wineRecord.send', 'Send suggestion')}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

export default SweetnessStyleRow;
