import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../Modal';
import TypedValueInput, { TYPES, formatTypedValue } from '../TypedValueInput';
import GrapeTokenInput, { foldGrapeName } from '../GrapeTokenInput';
import ContributePrompt from './ContributePrompt';
import { createWineProposal, getMyWineProposals } from '../../api/wineProposals';
import { getWinePublicData, suggestWineValue, proposeRegistryKey } from '../../api/registryData';
import useTaxonomyNames from '../../hooks/useTaxonomyNames';
import useGrapeNames from '../../hooks/useGrapeNames';
import { taxonomyName } from '../../utils/taxonomyName';
import { WINE_COLOURS, isStyleType, recordedColour, wineTypeLabel, colourLabel } from '../../utils/wineColour';
import './WineRecordSection.css';

/**
 * The full public record of a wine, blanks included (#985 Slice A).
 * A visible gap is what invites a contribution — blank fields render as
 * "not recorded", and every field carries a "suggest a fix" action that files
 * into the admin-reviewed WineCorrectionProposal queue. Nothing a user does
 * here writes to the registry; approval stays a human act.
 *
 * Type and grapes are part of the record too (support ticket 2026-09-17). They
 * used to live outside it — grapes in a section of their own with a free-text
 * "suggest grapes" box that only appeared when the list was EMPTY, so a wrong
 * or incomplete grape list had no route at all. One record, one way to fix it.
 */

// Every field a suggestion may carry (must match wineProposalOps FIELDS +
// EXTRA_FIELDS), in reading order: who and what, then where.
const RECORD_FIELDS = ['producer', 'name', 'type', 'grapes', 'appellation', 'region', 'country', 'classification'];
const WINE_TYPES = ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'];
const GRAPES_MAX = 12;
const REASON_MIN = 10;

const PencilIcon = () => (
  <svg className="wr-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
  </svg>
);

const sameGrapes = (a, b) => {
  const x = a.map(foldGrapeName).sort();
  const y = b.map(foldGrapeName).sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

function WineRecordSection({ wine, canSuggest, apiFetch, vintage, promptMissingGrapes = false, suggestSignal = 0 }) {
  const { t, i18n } = useTranslation();
  // The reader's language rides along on the fetch, and a key comes back
  // with a displayName in it when a translation exists. `name` stays the
  // identifier; only what is SHOWN changes.
  const lang = i18n?.language || null;
  const keyLabel = (key) => key.displayName || key.name;
  // The bottle's vintage when this section sits on a bottle page: public
  // values resolve that year's override over the wine-wide default, and a
  // new suggestion lands in that year's slot unless the user widens it.
  const bottleVintage = vintage && /^\d{4}$/.test(String(vintage)) ? String(vintage) : null;
  const [mine, setMine] = useState([]);
  // The wine's ONE review slot as this viewer may know it ({ fields, mine }):
  // somebody else's pending suggestion blocks a new one, and the page should
  // say so before a correction is typed, not after.
  const [slot, setSlot] = useState(null);
  const [modal, setModal] = useState(null); // { field }
  const [proposed, setProposed] = useState('');
  const [proposedType, setProposedType] = useState('');
  // The colour of a sparkling/dessert/fortified wine — asked only once the
  // chosen type is one of those (support ticket 2026-09-17).
  const [proposedColour, setProposedColour] = useState('');
  const [proposedGrapes, setProposedGrapes] = useState([]); // [{ name, isNew? }]
  const [reason, setReason] = useState('');
  const [evidenceUrl, setEvidenceUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [sentField, setSentField] = useState(null);
  // Most users never file a fix — the per-row actions stay hidden behind ONE
  // section-level toggle so the record reads clean (Johan, 2026-08-17).
  const [suggestMode, setSuggestMode] = useState(false);
  const sectionRef = useRef(null);
  // Public key vocabulary + values (#985 Slice B)
  const [publicFields, setPublicFields] = useState([]);
  const [valueModal, setValueModal] = useState(null); // { field } from publicFields
  const [valueInput, setValueInput] = useState('');
  const [valueReason, setValueReason] = useState('');
  // Which slot a public-value suggestion lands in. On a bottle page the
  // default is THIS vintage — a label or a one-year page is a fact about one
  // bottling, so filing it narrow is never wrong; widening to every vintage
  // is the deliberate choice. Off a bottle page the user may type a year.
  const [valueScope, setValueScope] = useState('vintage'); // 'vintage' | 'wine'
  const [valueVintage, setValueVintage] = useState('');
  const [keyModal, setKeyModal] = useState(false);
  const [keyForm, setKeyForm] = useState({ name: '', type: 'text', unit: '', enumOptions: '', rationale: '' });

  const loadPublicData = useCallback(async () => {
    try {
      const res = await getWinePublicData(apiFetch, wine._id, bottleVintage, lang);
      if (!res.ok) return;
      const body = await res.json().catch(() => ({}));
      setPublicFields(body.fields || []);
    } catch { /* non-critical — the record renders without it */ }
  }, [apiFetch, wine?._id, bottleVintage, lang]);

  useEffect(() => {
    if (wine?._id) loadPublicData();
  }, [wine?._id, loadPublicData]);

  useEffect(() => {
    if (!wine?._id || !canSuggest) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const res = await getMyWineProposals(apiFetch, wine._id);
        if (!res.ok) return;
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        setMine(body.proposals || []);
        setSlot(body.pending || null);
      } catch { /* non-critical — the record renders without it */ }
    })();
    return () => { cancelled = true; };
  }, [apiFetch, wine?._id, canSuggest]);

  // Another surface asking for the fix flow (the report dialog's "suggest a fix
  // instead"): open the mode and bring the record into view.
  // The counter is an EVENT, not a state: only a CHANGE acts. The page keeps it
  // for the whole visit and this section remounts whenever the edit form has
  // been shown — acting on the mounted value re-opened the mode and scrolled
  // the page after every later edit (pre-deploy audit 2026-09-18).
  const seenSignal = useRef(suggestSignal);
  useEffect(() => {
    if (suggestSignal === seenSignal.current) return;
    seenSignal.current = suggestSignal;
    if (!canSuggest) return;
    setSuggestMode(true);
    sectionRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [suggestSignal, canSuggest]);

  // The bottle page stays mounted from one bottle to the next, so everything
  // that belongs to ONE wine goes when the wine changes — otherwise a failed
  // refetch left wine A's "Your suggestion …" lines (and A's review slot, which
  // can hide the Fix buttons) on wine B.
  const shownWineId = useRef(wine?._id);
  useEffect(() => {
    if (shownWineId.current === wine?._id) return;
    shownWineId.current = wine?._id;
    setMine([]);
    setSlot(null);
    setSentField(null);
    setModal(null);
  }, [wine?._id]);

  // Focus goes INTO the suggest dialog and Tab stays there (trapFocus below).
  // The trap lands on the first control — right for a text field, wrong for the
  // grape form, whose first control is a chip's "remove" button: there the
  // dialog itself takes focus, so a screen reader reads the title and a phone
  // does not throw its keyboard over a form whose first job is often a tap.
  const formRef = useRef(null);
  useEffect(() => {
    if (modal?.field === 'grapes') formRef.current?.closest('[role="dialog"]')?.focus();
  }, [modal?.field]);

  const displayNames = useTaxonomyNames();
  // Fetched when the grapes form opens, not with the page: most visits never do.
  const grapeList = useGrapeNames(apiFetch, modal?.field === 'grapes');

  if (!wine) return null;

  const wineGrapes = (wine.grapes || []).filter((g) => g && g.name);

  // What the registry actually STORES. This is what the suggest-a-fix form
  // shows as "currently recorded", and it must stay canonical: a French reader
  // shown "Vallée du Rhône" as the current value would reasonably propose a
  // French correction to it — which is precisely the proposal (6a959b9d) that
  // led to this feature, and telling him the stored value is "Rhône Valley"
  // is what would have prevented it. Same for grapes: the canonical variety,
  // not the regional label the page shows ("Tinta Roriz" is stored Tempranillo).
  const values = {
    producer: wine.producer || null,
    name: wine.name || null,
    type: wine.type || null,
    // Not a row of its own: it qualifies the Type row ("Sparkling rosé").
    colour: recordedColour(wine),
    grapes: wineGrapes.map((g) => g.name),
    country: wine.country?.name || null,
    region: wine.region?.name || null,
    appellation: wine.appellation || null,
    classification: wine.classification || null,
  };

  // What the reader SEES. Only the two taxonomies that genuinely change
  // language; appellation is a protected legal name and is never translated.
  const displayValues = {
    ...values,
    country: taxonomyName(wine.country, displayNames) || null,
    region: taxonomyName(wine.region, displayNames) || null,
  };

  const typeLabel = (v) => (v ? t(`statistics.typeLabels.${v}`, v.charAt(0).toUpperCase() + v.slice(1)) : null);
  const isBlank = (f) => (f === 'grapes' ? values.grapes.length === 0 : !values[f]);

  const hasValue = (v) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== '');
  const myPending = mine.find((p) => p.status === 'pending') || null;
  const pendingValues = myPending?.proposedFields || {};
  // A pending colour is a pending change to the Type row.
  const pendingFields = new Set(RECORD_FIELDS.filter((f) => hasValue(pendingValues[f])
    || (f === 'type' && hasValue(pendingValues.colour))));
  const formatPending = (f) => {
    const v = pendingValues[f];
    if (f === 'grapes') return (v || []).join(', ');
    if (f === 'type') {
      // The type and colour the suggestion would leave. A colour-only
      // suggestion keeps the recorded type; a type-only one keeps the recorded
      // colour when the new type can carry one — exactly what approval does
      // (wineTypeLabel ignores a colour on red/white/rosé).
      return wineTypeLabel({
        type: v || values.type,
        colour: hasValue(pendingValues.colour) ? pendingValues.colour : values.colour,
      }, t);
    }
    return v;
  };
  // One pending suggestion per wine, across ALL users: while somebody else's
  // holds the slot, a new one can only come back as a conflict.
  const blockedByOther = !!slot && !slot.mine && !myPending;

  const openSuggest = (field) => {
    setModal({ field });
    // Pre-filled with what is recorded: fixing a typo is an edit, not a retype.
    setProposed(field === 'type' || field === 'grapes' ? '' : (values[field] || ''));
    // A sparkling/dessert/fortified wine opens on its own type, so fixing only
    // its colour is one tap; a red/white/rosé wine opens with nothing chosen.
    const keepType = field === 'type' && isStyleType(values.type);
    setProposedType(keepType ? values.type : '');
    setProposedColour(keepType ? (values.colour || '') : '');
    setProposedGrapes(values.grapes.map((name) => ({ name })));
    setReason('');
    setEvidenceUrl('');
    setError(null);
  };

  // What this form would send, or null while nothing has actually changed.
  const draftFields = () => {
    if (!modal) return null;
    const f = modal.field;
    if (f === 'type') {
      const nextType = proposedType || values.type;
      const out = {};
      if (proposedType && proposedType !== values.type) out.type = proposedType;
      // Sent only when it differs from the recorded colour — which the wine
      // KEEPS when it moves between two style types (the model drops a colour
      // only on red/white/rosé), so "no change" must mean the same here.
      if (isStyleType(nextType) && proposedColour && proposedColour !== values.colour) out.colour = proposedColour;
      return Object.keys(out).length ? out : null;
    }
    if (f === 'grapes') {
      const names = proposedGrapes.map((g) => g.name);
      if (!names.length || sameGrapes(names, values.grapes)) return null;
      const fresh = proposedGrapes.filter((g) => g.isNew).map((g) => g.name);
      return { grapes: names, ...(fresh.length ? { newGrapes: fresh } : {}) };
    }
    const next = proposed.trim();
    return next && next !== (values[f] || '') ? { [f]: next } : null;
  };

  const submit = async (e) => {
    e.preventDefault();
    const fields = draftFields();
    if (busy || !fields) return;
    setBusy(true);
    setError(null);
    try {
      const res = await createWineProposal(apiFetch, {
        wineId: wine._id,
        fields,
        reason: reason.trim(),
        ...(evidenceUrl.trim() ? { evidenceUrl: evidenceUrl.trim() } : {}),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        // `newGrapes` qualifies the list; it is not a field of the record.
        const sent = { ...fields };
        delete sent.newGrapes;
        // The server answers with the whole pending suggestion — canonical
        // grape names, and every field of it when this filing amended one.
        const stored = body.proposal?.proposedFields;
        setSentField(modal.field);
        // `stored` is authoritative when present: after an amendment it holds
        // every field; after a FRESH filing (my earlier suggestion was decided
        // while this page was open) it holds only the new ones — merging the
        // stale local fields back in kept showing a decided suggestion as
        // pending. The local merge is only the fallback for a bare answer.
        setMine((prev) => {
          const before = prev.find((p) => p.status === 'pending')?.proposedFields || {};
          const merged = stored || { ...(body.amended === false ? {} : before), ...sent };
          return [{ status: 'pending', proposedFields: merged }, ...prev.filter((p) => p.status !== 'pending')];
        });
        setSlot((s) => s || { mine: true, fields: Object.keys(sent) });
        setModal(null);
      } else {
        setError(body.error || t('common.networkError', 'Network error. Please try again.'));
      }
    } catch {
      setError(t('common.networkError', 'Network error. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  const fieldLabel = (f) => t(`wineRecord.field_${f}`, f.charAt(0).toUpperCase() + f.slice(1));

  const formatPublicValue = (field) => formatTypedValue(field.key, field.value, t);

  const submitValue = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const raw = valueModal.field.key.type === 'boolean' ? valueInput === 'true' : valueInput.trim();
      // The slot: this bottle's vintage (default) or every vintage; without a
      // bottle vintage, whatever year was typed, else every vintage.
      const vintageFor = bottleVintage
        ? (valueScope === 'vintage' ? bottleVintage : null)
        : (valueVintage.trim() || null);
      const res = await suggestWineValue(apiFetch, wine._id, {
        keyId: valueModal.field.key._id,
        value: raw,
        ...(vintageFor ? { vintage: vintageFor } : {}),
        ...(valueReason.trim() ? { reason: valueReason.trim() } : {}),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setValueModal(null);
        await loadPublicData();
      } else {
        setError(body.error || t('common.networkError', 'Network error. Please try again.'));
      }
    } catch {
      setError(t('common.networkError', 'Network error. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  const submitKey = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await proposeRegistryKey(apiFetch, {
        name: keyForm.name.trim(),
        type: keyForm.type,
        ...(keyForm.unit.trim() ? { unit: keyForm.unit.trim() } : {}),
        ...(keyForm.type === 'enum'
          ? { enumOptions: keyForm.enumOptions.split(',').map((o) => o.trim()).filter(Boolean) }
          : {}),
        rationale: keyForm.rationale.trim(),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setKeyModal(false);
        setSentField('newKey');
      } else {
        setError(body.error || t('common.networkError', 'Network error. Please try again.'));
      }
    } catch {
      setError(t('common.networkError', 'Network error. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  const renderValue = (f) => {
    if (f === 'grapes' && wineGrapes.length) {
      return (
        <span className="wr-value wr-pills">
          {wineGrapes.map((g) => (
            // displayName = regionally correct label ("Tinta Roriz" on a
            // Douro Port); name stays the canonical variety.
            <span key={g._id || g.name} className="wr-pill">{g.displayName || g.name}</span>
          ))}
        </span>
      );
    }
    const shown = f === 'type' ? wineTypeLabel(wine, t) : (f === 'grapes' ? null : displayValues[f]);
    return (
      <span className={shown ? 'wr-value' : 'wr-value wr-value--blank'}>
        {shown || t('wineRecord.notRecorded', 'not recorded')}
      </span>
    );
  };

  // The recorded type is not a choice — unless it is a style whose colour may
  // be the thing to fix.
  const typeChoices = WINE_TYPES.filter((v) => v !== values.type || isStyleType(v));
  // The colour choice is KEPT while a still type is selected (the row is
  // hidden and draftFields ignores it): arrow keys select as they move, and a
  // pass through "Rosé" on the way back to "Sparkling" used to wipe it.
  const chooseType = (v) => setProposedType(v);
  // Tapping the chosen colour again takes the choice back — to the recorded
  // colour, or to none.
  const chooseColour = (c) => setProposedColour(
    (prev) => (prev === c ? (values.colour && values.colour !== c ? values.colour : '') : c)
  );
  // Arrow keys move within a chip group; the group is one tab stop.
  const radioKeys = (choices, current, choose) => (e) => {
    const dir = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1
      : (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1 : 0;
    if (!dir || !choices.length) return;
    e.preventDefault();
    const i = choices.indexOf(current);
    const next = i === -1
      ? choices[dir > 0 ? 0 : choices.length - 1]
      : choices[(i + dir + choices.length) % choices.length];
    choose(next);
    Array.from(e.currentTarget.querySelectorAll('[role="radio"]')).find((b) => b.dataset.value === next)?.focus();
  };
  const onTypeKey = radioKeys(typeChoices, proposedType, chooseType);
  const onColourKey = radioKeys(WINE_COLOURS, proposedColour, (c) => setProposedColour(c));

  const canSend = !!draftFields() && reason.trim().length >= REASON_MIN;
  const newInDraft = proposedGrapes.filter((g) => g.isNew).map((g) => g.name);
  const showGrapesPrompt = promptMissingGrapes && canSuggest && values.grapes.length === 0
    && !pendingFields.has('grapes') && !blockedByOther;

  return (
    <div className="bd-section wr-section" ref={sectionRef}>
      <div className="wr-header">
        <span className="bd-section-label">{t('wineRecord.title', 'Wine record')}</span>
        {canSuggest && (
          <button
            type="button"
            className={`wr-mode-toggle${suggestMode ? ' wr-mode-toggle--active' : ''}`}
            onClick={() => setSuggestMode((m) => !m)}
            aria-pressed={suggestMode}
          >
            {!suggestMode && <PencilIcon />}
            {suggestMode
              ? t('wineRecord.suggestDone', 'Done')
              : t('wineRecord.suggest', 'Suggest a fix')}
          </button>
        )}
      </div>
      {/* The one-line framing stays for everyone (audit: read-only viewers
          otherwise lose the only explanation of what this shared data is);
          the suggest mode swaps it for the instruction, set apart so the
          change of mode is seen. */}
      {suggestMode ? (
        <p className="wr-intro wr-intro--suggest">
          {blockedByOther
            ? t('wineRecord.blockedByOther', 'Another member’s suggestion for this wine is waiting for a curator. You can suggest a fix as soon as it has been decided.')
            : t('wineRecord.intro', 'Spot something wrong or missing? Tap Fix or Add next to it — a curator reviews every suggestion before it goes live.')}
        </p>
      ) : (
        <p className="wr-intro">
          {t('wineRecord.introShort', 'The shared registry’s record of this wine, curator-reviewed.')}
        </p>
      )}

      {showGrapesPrompt && (
        <ContributePrompt
          storageKey={`cellarion_contrib_grapes_${wine._id}`}
          icon="🍇"
          title={t('bottleDetail.contributeGrapesTitle', 'Help the community')}
          message={t('bottleDetail.contributeGrapesMsg', 'Grape varieties aren\'t listed for this wine yet. Suggest them and our team will review.')}
          actionLabel={t('bottleDetail.contributeGrapesAction', 'Suggest grapes')}
          onAction={() => openSuggest('grapes')}
        />
      )}

      <div className={`wr-grid${suggestMode ? ' wr-grid--suggest' : ''}`}>
        {RECORD_FIELDS.map((f) => (
          <div key={f} className="wr-row">
            <span className="wr-key">{fieldLabel(f)}</span>
            {renderValue(f)}
            {canSuggest && suggestMode && !pendingFields.has(f) && !blockedByOther ? (
              <button
                type="button"
                className="wr-suggest-btn"
                onClick={() => openSuggest(f)}
                aria-label={t('wineRecord.suggestFor', 'Suggest a fix for {{field}}', { field: fieldLabel(f) })}
              >
                {isBlank(f) ? t('wineRecord.add', 'Add') : t('wineRecord.fix', 'Fix')}
              </button>
            ) : null}
            {/* Pending is STATUS, not affordance — shown without suggest mode,
                with the value itself: the suggester's own words, so nothing
                unreviewed is shown to anyone it did not come from. */}
            {canSuggest && pendingFields.has(f) && (
              <span className="wr-pending-line" title={t('wineRecord.pendingTitle', 'Your suggestion is awaiting curator review')}>
                <span className="wr-pending-label">{t('wineRecord.yourSuggestion', 'Your suggestion')}</span>{' '}
                <span className="wr-pending-value">{formatPending(f)}</span>{' '}
                <span className="wr-pending">{t('wineRecord.pending', 'suggestion pending')}</span>
              </span>
            )}
          </div>
        ))}
      </div>
      {/* ── Public data fields (#985 Slice B): the accepted vocabulary with
          published values; blanks invite value suggestions ── */}
      {(publicFields.length > 0 || (canSuggest && suggestMode)) && (
        <>
          <span className="bd-section-label" style={{ marginTop: '0.8rem' }}>
            {t('wineRecord.publicData', 'More data')}
          </span>
          <div className={`wr-grid${suggestMode ? ' wr-grid--suggest' : ''}`}>
            {publicFields.map((field) => {
              const shown = formatPublicValue(field);
              return (
                <div key={field.key._id} className="wr-row">
                  <span className="wr-key">{keyLabel(field.key)}</span>
                  <span className={shown ? 'wr-value' : 'wr-value wr-value--blank'}>
                    {shown || t('wineRecord.notRecorded', 'not recorded')}
                    {/* Which layer answered: this vintage's override, or the
                        wine-wide default (tagged only when a vintage is in
                        play, so the reader knows a year-specific figure could
                        still be added). */}
                    {shown && field.resolvedFrom === 'vintage' && (
                      <span className="wr-scope" title={t('wineRecord.scopeVintageTitle', 'Recorded for the {{year}} vintage specifically', { year: field.resolvedVintage })}>
                        {field.resolvedVintage}
                      </span>
                    )}
                    {shown && field.resolvedFrom === 'wine' && bottleVintage && (
                      <span className="wr-scope wr-scope--wine" title={t('wineRecord.scopeWineTitle', 'The wine-wide value — no {{year}}-specific figure recorded yet', { year: bottleVintage })}>
                        {t('wineRecord.scopeWine', 'all vintages')}
                      </span>
                    )}
                    {/* Who contributed a value is stored, never shown (Johan,
                        2026-09-18): the record is the registry's, not a byline
                        — and the server no longer sends the name at all. */}
                  </span>
                  {/* ANY pending suggestion (yours or someone's) holds the
                      key's single review slot — show status, never a button
                      that can only 409 (audit: second-suggester dead-end). */}
                  {canSuggest && (field.mySuggestion || field.hasPendingSuggestion) ? (
                    <span className="wr-pending" title={field.mySuggestion
                      ? t('wineRecord.pendingTitle', 'Your suggestion is awaiting curator review')
                      : t('wineRecord.pendingOtherTitle', 'A suggestion for this field is awaiting curator review')}>
                      {t('wineRecord.pending', 'suggestion pending')}
                    </span>
                  ) : canSuggest && suggestMode ? (
                    <button
                      type="button"
                      className="wr-suggest-btn"
                      onClick={() => {
                        setValueModal({ field });
                        setValueInput('');
                        setValueReason('');
                        setValueScope(bottleVintage ? 'vintage' : 'wine');
                        setValueVintage('');
                        setError(null);
                      }}
                      aria-label={t('wineRecord.suggestValueFor', 'Suggest a value for {{field}}', { field: keyLabel(field.key) })}
                    >
                      {shown && field.resolvedFrom === 'wine' && bottleVintage
                        ? t('wineRecord.addVintageValue', 'Add {{year}} value', { year: bottleVintage })
                        : shown ? t('wineRecord.fix', 'Fix') : t('wineRecord.suggestValue', 'Add value')}
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
          {canSuggest && suggestMode && (
            <button
              type="button"
              className="wr-text-btn wr-propose-key"
              onClick={() => { setKeyModal(true); setKeyForm({ name: '', type: 'text', unit: '', enumOptions: '', rationale: '' }); setError(null); }}
            >
              {t('wineRecord.proposeKey', '+ Propose a new data field')}
            </button>
          )}
        </>
      )}

      {sentField && (
        <p role="status" className="wr-thanks">
          {t('wineRecord.thanks', 'Thank you — your suggestion is in the review queue. We’ll notify you when a curator has decided.')}
        </p>
      )}

      {modal && (
        <Modal trapFocus title={t('wineRecord.modalTitle', 'Suggest a fix: {{field}}', { field: fieldLabel(modal.field) })} onClose={() => !busy && setModal(null)}>
          <form onSubmit={submit} className="pd-form" ref={formRef}>
            {error && <div className="alert alert-error" style={{ marginBottom: 8 }}>{error}</div>}

            {modal.field === 'grapes' ? (
              <div className="form-group">
                <label htmlFor="wr-grapes">{t('wineRecord.grapesLabel', 'The grapes in this wine')}</label>
                <GrapeTokenInput
                  inputId="wr-grapes"
                  options={grapeList.grapes}
                  error={grapeList.error}
                  onRetry={grapeList.retry}
                  value={proposedGrapes}
                  onChange={setProposedGrapes}
                  max={GRAPES_MAX}
                  allowNew
                />
                {/* The list REPLACES the wine's grapes — said where it matters,
                    because "I only added one" is the natural misreading. */}
                <p className="wr-help">
                  {values.grapes.length
                    ? t('wineRecord.grapesHelp', 'This becomes the wine’s complete grape list: remove what’s wrong, add what’s missing, and leave the rest.')
                    : t('wineRecord.grapesHelpEmpty', 'Add every variety in the wine — type a few letters to search.')}
                </p>
                {newInDraft.length > 0 && (
                  <p className="wr-help wr-help--note">
                    {t('wineRecord.grapesNewNote', 'Not in our grape list yet: {{names}}. A curator will check that before approving your suggestion.', { names: newInDraft.map((n) => `“${n}”`).join(', ') })}
                  </p>
                )}
              </div>
            ) : (
              <>
                <div className="form-group">
                  <label>{t('wineRecord.current', 'Currently recorded')}</label>
                  <div className="wr-current">
                    {(modal.field === 'type' ? wineTypeLabel(wine, t) : values[modal.field]) || t('wineRecord.notRecorded', 'not recorded')}
                  </div>
                </div>
                {modal.field === 'type' ? (
                  <>
                    <div className="form-group">
                      <span className="wr-group-label" id="wr-type-label">{t('wineRecord.proposed', 'Should be')}</span>
                      <div className="wr-choices" role="radiogroup" aria-labelledby="wr-type-label" onKeyDown={onTypeKey}>
                        {typeChoices.map((v, idx) => (
                          <button
                            key={v}
                            type="button"
                            role="radio"
                            data-value={v}
                            aria-checked={proposedType === v}
                            // One tab stop for the group; the arrows move within it.
                            tabIndex={(proposedType ? proposedType === v : idx === 0) ? 0 : -1}
                            className={`wr-choice${proposedType === v ? ' wr-choice--on' : ''}`}
                            onClick={() => chooseType(v)}
                          >
                            {typeLabel(v)}
                          </button>
                        ))}
                      </div>
                    </div>
                    {/* Only for the styles that say nothing about colour — a
                        sparkling rosé is Sparkling + Rosé. */}
                    {isStyleType(proposedType) && (
                      <div className="form-group">
                        <span className="wr-group-label" id="wr-colour-label">{t('wineColour.label', 'Colour')}</span>
                        <div className="wr-choices" role="radiogroup" aria-labelledby="wr-colour-label" onKeyDown={onColourKey}>
                          {WINE_COLOURS.map((c, idx) => (
                            <button
                              key={c}
                              type="button"
                              role="radio"
                              data-value={c}
                              aria-checked={proposedColour === c}
                              tabIndex={(proposedColour ? proposedColour === c : idx === 0) ? 0 : -1}
                              className={`wr-choice${proposedColour === c ? ' wr-choice--on' : ''}`}
                              onClick={() => chooseColour(c)}
                            >
                              {colourLabel(c, t)}
                            </button>
                          ))}
                        </div>
                        <p className="wr-help">{t('wineColour.hint', 'Sparkling, dessert and fortified wines can be red, white or rosé.')}</p>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="form-group">
                    <label htmlFor="wr-proposed">{t('wineRecord.proposed', 'Should be')}</label>
                    <input
                      id="wr-proposed"
                      type="text"
                      value={proposed}
                      onChange={(e) => setProposed(e.target.value)}
                      maxLength={200}
                      required
                    />
                  </div>
                )}
              </>
            )}

            <div className="form-group">
              <label htmlFor="wr-reason">{t('wineRecord.reason', 'How do you know?')}</label>
              <textarea
                id="wr-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t('wineRecord.reasonPlaceholder', 'e.g. It’s printed on the label of my bottle / the producer’s site says…')}
                minLength={REASON_MIN}
                maxLength={1000}
                rows={3}
                required
              />
              {/* A greyed-out Send with no explanation is a dead end. */}
              {reason.trim().length > 0 && reason.trim().length < REASON_MIN && (
                <p className="wr-help">{t('wineRecord.reasonTooShort', 'A few more words, please — a curator has to be able to check it.')}</p>
              )}
            </div>
            <div className="form-group">
              <label htmlFor="wr-evidence">{t('wineRecord.evidence', 'Link that backs it up (optional, speeds up review)')}</label>
              <input
                id="wr-evidence"
                type="url"
                value={evidenceUrl}
                onChange={(e) => setEvidenceUrl(e.target.value)}
                placeholder="https://…"
                maxLength={500}
              />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setModal(null)} disabled={busy}>
                {t('common.cancel', 'Cancel')}
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy || !canSend}>
                {busy ? t('wineRecord.sending', 'Sending…') : t('wineRecord.send', 'Send suggestion')}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {valueModal && (
        <Modal
          title={t('wineRecord.valueModalTitle', 'Suggest a value: {{field}}', { field: keyLabel(valueModal.field.key) })}
          onClose={() => !busy && setValueModal(null)}
        >
          <form onSubmit={submitValue} className="pd-form">
            {error && <div className="alert alert-error" style={{ marginBottom: 8 }}>{error}</div>}
            <div className="form-group">
              <label htmlFor="wr-public-value">{t('personalData.value', 'Value')}</label>
              <TypedValueInput
                id="wr-public-value"
                keyDef={valueModal.field.key}
                value={valueInput}
                onChange={setValueInput}
              />
            </div>
            {/* The one question that decides the slot, asked in the user's
                terms: nobody thinks "default vs override", everybody knows
                whether they read it off their own label or off a spec sheet. */}
            {bottleVintage ? (
              <fieldset className="form-group wr-scope-choice">
                <legend>{t('wineRecord.scopeQuestion', 'Where does this figure come from?')}</legend>
                <label className="wr-scope-option">
                  <input
                    type="radio"
                    name="wr-scope"
                    value="vintage"
                    checked={valueScope === 'vintage'}
                    onChange={() => setValueScope('vintage')}
                  />
                  <span>{t('wineRecord.scopeVintage', 'My bottle, or a page for this vintage — applies to {{year}} only', { year: bottleVintage })}</span>
                </label>
                <label className="wr-scope-option">
                  <input
                    type="radio"
                    name="wr-scope"
                    value="wine"
                    checked={valueScope === 'wine'}
                    onChange={() => setValueScope('wine')}
                  />
                  <span>{t('wineRecord.scopeAll', 'The producer’s general spec, the same every year — applies to all vintages')}</span>
                </label>
              </fieldset>
            ) : (
              <div className="form-group">
                <label htmlFor="wr-value-vintage">{t('wineRecord.scopeYear', 'For one vintage only? (optional)')}</label>
                <input
                  id="wr-value-vintage"
                  type="text"
                  inputMode="numeric"
                  value={valueVintage}
                  onChange={(e) => setValueVintage(e.target.value)}
                  placeholder={t('wineRecord.scopeYearPlaceholder', 'e.g. 2023 — leave empty for all vintages')}
                  maxLength={4}
                  pattern="\d{4}"
                />
              </div>
            )}
            {valueModal.field.wineValue !== null && valueModal.field.wineValue !== undefined && (
              <p className="wr-current-note">
                {t('wineRecord.currentWineValue', 'Wine-wide value today: {{value}}', { value: formatTypedValue(valueModal.field.key, valueModal.field.wineValue, t) })}
              </p>
            )}
            <div className="form-group">
              <label htmlFor="wr-value-reason">{t('wineRecord.valueReason', 'How do you know? (optional)')}</label>
              <input
                id="wr-value-reason"
                type="text"
                value={valueReason}
                onChange={(e) => setValueReason(e.target.value)}
                placeholder={t('wineRecord.reasonPlaceholder', 'e.g. It’s printed on the label of my bottle / the producer’s site says…')}
                maxLength={1000}
              />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setValueModal(null)} disabled={busy}>
                {t('common.cancel', 'Cancel')}
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy || !valueInput}>
                {busy ? t('wineRecord.sending', 'Sending…') : t('wineRecord.send', 'Send suggestion')}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {keyModal && (
        <Modal title={t('wineRecord.keyModalTitle', 'Propose a new data field')} onClose={() => !busy && setKeyModal(false)}>
          <form onSubmit={submitKey} className="pd-form">
            {error && <div className="alert alert-error" style={{ marginBottom: 8 }}>{error}</div>}
            <p style={{ margin: '0 0 0.6rem', fontSize: '0.82rem', color: 'var(--color-text-muted)' }}>
              {t('wineRecord.keyModalIntro', 'A new field becomes available on every wine once an admin accepts it. One field, one meaning — check the list above first.')}
            </p>
            <div className="form-group">
              <label htmlFor="wr-key-name">{t('wineRecord.keyName', 'Field name')}</label>
              <input
                id="wr-key-name"
                type="text"
                value={keyForm.name}
                onChange={(e) => setKeyForm({ ...keyForm, name: e.target.value })}
                placeholder={t('wineRecord.keyNamePlaceholder', 'e.g. ABV')}
                maxLength={60}
                required
              />
            </div>
            <div className="form-group">
              <label htmlFor="wr-key-type">{t('personalData.type', 'Value type')}</label>
              <select
                id="wr-key-type"
                className="pd-select"
                value={keyForm.type}
                onChange={(e) => setKeyForm({ ...keyForm, type: e.target.value })}
              >
                {TYPES.map((ty) => (
                  <option key={ty} value={ty}>{t(`personalData.type_${ty}`, ty)}</option>
                ))}
              </select>
            </div>
            {(keyForm.type === 'integer' || keyForm.type === 'decimal') && (
              <div className="form-group">
                <label htmlFor="wr-key-unit">{t('personalData.unit', 'Unit (optional)')}</label>
                <input
                  id="wr-key-unit"
                  type="text"
                  value={keyForm.unit}
                  onChange={(e) => setKeyForm({ ...keyForm, unit: e.target.value })}
                  placeholder={t('personalData.unitPlaceholder', 'e.g. %, °C, kr')}
                  maxLength={20}
                />
              </div>
            )}
            {keyForm.type === 'enum' && (
              <div className="form-group">
                <label htmlFor="wr-key-options">{t('personalData.enumOptions', 'Allowed values (comma-separated)')}</label>
                <input
                  id="wr-key-options"
                  type="text"
                  value={keyForm.enumOptions}
                  onChange={(e) => setKeyForm({ ...keyForm, enumOptions: e.target.value })}
                  placeholder={t('personalData.enumPlaceholder', 'e.g. cork, screwcap, crown')}
                  required
                />
              </div>
            )}
            <div className="form-group">
              <label htmlFor="wr-key-rationale">{t('wineRecord.keyRationale', 'Why should every wine have this field?')}</label>
              <textarea
                id="wr-key-rationale"
                value={keyForm.rationale}
                onChange={(e) => setKeyForm({ ...keyForm, rationale: e.target.value })}
                minLength={10}
                maxLength={1000}
                rows={3}
                required
              />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setKeyModal(false)} disabled={busy}>
                {t('common.cancel', 'Cancel')}
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy || !keyForm.name.trim() || keyForm.rationale.trim().length < 10}>
                {busy ? t('wineRecord.sending', 'Sending…') : t('wineRecord.proposeKeySend', 'Propose field')}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

export default WineRecordSection;
