import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../Modal';
import {
  getPersonalData, addPersonalData, updatePersonalDataEntry,
  deletePersonalDataEntry, getPersonalDataKeys, updatePersonalDataKey,
} from '../../api/personalData';
import { suggestWineValue, proposeRegistryKey, getWinePublicData } from '../../api/registryData';
import TypedValueInput, { TYPES, formatTypedValue } from '../TypedValueInput';
import './PersonalDataCard.css';
import { formatVintage } from '../../utils/vintage';
import { matchKeyByName, normaliseKeyName } from '../../utils/registryKeyName';

/**
 * Personal typed key/value data on this bottle and its wine (issue #986).
 * "Personal" = not published to the shared registry — entries ARE visible to
 * everyone who can see the bottle, attributed to their author. This is a
 * CONTENT card, not a bottle action, so it lives once in the page body.
 *
 * The type lives on the KEY (text/integer/decimal/boolean/date/enum, unit on
 * numeric keys), so the value input adapts to the chosen key and the backend
 * validates every value against the key's stored type.
 */

const emptyForm = {
  level: 'bottle',
  keyName: '',
  keyType: 'text',
  unit: '',
  enumOptions: '',
  value: '',
  newOption: '',
};

// A year a public figure can be scoped to; NV, Unknown and blank have none.
const yearOf = (v) => (v && /^\d{4}$/.test(String(v)) ? String(v) : null);

const hasValue = (v) => v !== null && v !== undefined && v !== '';

// Whether a personal entry says what the wine record says: numbers by value
// ("13,5" is 13.5), everything else folded like key names are.
function sameValue(a, b) {
  const num = (v) => (typeof v === 'number' ? v : Number(String(v).trim().replace(',', '.')));
  if (typeof a !== 'boolean' && typeof b !== 'boolean' && String(a).trim() && String(b).trim()) {
    const x = num(a);
    const y = num(b);
    if (Number.isFinite(x) && Number.isFinite(y)) return x === y;
  }
  const x = normaliseKeyName(a);
  return x !== '' && x === normaliseKeyName(b);
}

// The one question that decides a public figure's slot, worded as the wine
// record's own value form words it.
function ScopeChoice({ name, year, value, onChange, t }) {
  return (
    <fieldset className="form-group pd-scope-choice">
      <legend>{t('wineRecord.scopeQuestion', 'Where does this figure come from?')}</legend>
      <label className="pd-scope-option">
        <input type="radio" name={name} value="vintage" checked={value === 'vintage'} onChange={() => onChange('vintage')} />
        <span>{t('wineRecord.scopeVintage', 'My bottle, or a page for this vintage — applies to {{year}} only', { year })}</span>
      </label>
      <label className="pd-scope-option">
        <input type="radio" name={name} value="wine" checked={value === 'wine'} onChange={() => onChange('wine')} />
        <span>{t('wineRecord.scopeAll', 'The producer’s general spec, the same every year — applies to all vintages')}</span>
      </label>
    </fieldset>
  );
}

// `scope="vintage"`: the card on the vintage page, which reaches the data
// through one bottle of the vintage. There "this bottle" means nothing, so
// new data goes on this vintage or on every vintage of the wine, and one
// bottle's own entries stay on that bottle's page (beta feedback 2026-10-10).
// `vintageScopable`: whether that bottle has a vintage to scope to — the
// server scopes "this vintage" through it, and an NV group of imported
// bottles may have only empty ones; then "every vintage" is the one choice.
function PersonalDataCard({ apiFetch, bottleId, currentUserId, wineId, vintage, scope = 'bottle', vintageScopable = true }) {
  const { t, i18n } = useTranslation();
  const lang = i18n?.language || null;
  const onVintagePage = scope === 'vintage' && !!vintage;
  const offerVintage = !!vintage && (!onVintagePage || vintageScopable);
  const bottleYear = yearOf(vintage);
  const [data, setData] = useState({ bottleEntries: [], wineEntries: [] });
  const [keys, setKeys] = useState([]);
  const [modal, setModal] = useState(null); // { mode: 'add' } | { mode: 'edit', entry }
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Typing a value that is not on a list key's list yet (the list is
  // extended first, then the entry saved — user ticket 2026-10-27).
  const [addingOption, setAddingOption] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(null);
  // Promotion path (#985): "suggest this to the registry" on an own entry.
  const [promote, setPromote] = useState(null); // entry
  const [promoteReason, setPromoteReason] = useState('');
  const [promoteBusy, setPromoteBusy] = useState(false);
  const [promoteError, setPromoteError] = useState(null);
  const [promoteDone, setPromoteDone] = useState(null); // 'value' | 'key'
  const [promoteScope, setPromoteScope] = useState('vintage'); // 'vintage' | 'wine'
  // The wine record's public fields (the accepted vocabulary, translations
  // included, with this vintage's values): a figure typed here under a public
  // name belongs there, where every owner of the wine sees it. Fetched only
  // when something here can use it, and tagged with the wine/vintage/language
  // it answers for, so a late answer for another bottle is never read.
  // `fields` is null when the record could not be read (a draft wine, a
  // network error): then nothing is steered and the card works as before.
  const publicSlot = wineId ? `${wineId}|${bottleYear || ''}|${lang || ''}` : null;
  const [publicData, setPublicData] = useState(null); // { slot, fields }
  const requestedSlot = useRef(null);
  const publicReady = !!publicData && publicData.slot === publicSlot;
  const publicFields = publicReady ? publicData.fields : null;
  const [publicScope, setPublicScope] = useState('vintage'); // 'vintage' | 'wine'

  const loadPublic = useCallback(async ({ force = false } = {}) => {
    if (!publicSlot || (!force && requestedSlot.current === publicSlot)) return;
    requestedSlot.current = publicSlot;
    let fields = null;
    try {
      const res = await getWinePublicData(apiFetch, wineId, bottleYear, lang);
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        fields = Array.isArray(body.fields) ? body.fields : [];
      }
    } catch { /* fields stays null */ }
    // A late answer for a slot asked before this one is dropped.
    if (requestedSlot.current === publicSlot) setPublicData({ slot: publicSlot, fields });
  }, [apiFetch, wineId, bottleYear, lang, publicSlot]);

  const load = useCallback(async () => {
    try {
      const res = await getPersonalData(apiFetch, bottleId);
      if (!res.ok) return;
      const body = await res.json().catch(() => ({}));
      setData({ bottleEntries: body.bottleEntries || [], wineEntries: body.wineEntries || [] });
    } catch {
      // Non-critical card — the bottle page works without it.
    }
  }, [apiFetch, bottleId]);

  useEffect(() => {
    if (bottleId) load();
  }, [bottleId, load]);

  // An own entry's share action depends on what the record holds for it.
  const hasOwnShown = (onVintagePage ? [] : data.bottleEntries).concat(data.wineEntries)
    .some((e) => String(e.author?._id) === String(currentUserId));
  useEffect(() => {
    if (hasOwnShown) loadPublic();
  }, [hasOwnShown, loadPublic]);

  // The typed key name matched against the user's own vocabulary — a match
  // locks the type to the key's stored one (a key keeps one type).
  const matchedKey = keys.find(
    (k) => k.name.toLowerCase() === form.keyName.trim().toLowerCase()
  );

  // The public field a name means (ABV, Alkoholhalt …) — the server resolves
  // names by the same rule (utils/registryKeyName).
  const publicFieldFor = (name) => {
    if (!publicFields) return null;
    const key = matchKeyByName(publicFields.map((f) => f.key), name);
    return key ? publicFields.find((f) => f.key === key) || null : null;
  };
  const publicLabel = (field) => field.key.displayName || field.key.name;
  // Any pending suggestion holds the field's one review slot.
  const publicHeld = (field) => !!(field.mySuggestion || field.hasPendingSuggestion);

  // Steering at the moment of typing: 'offer' = the record lacks this figure,
  // 'recorded' = it has one, 'pending' = one is waiting for a curator.
  const steerField = modal?.mode === 'add' && form.keyName.trim() ? publicFieldFor(form.keyName) : null;
  const steer = !steerField ? null
    : hasValue(steerField.value) ? 'recorded'
      : publicHeld(steerField) ? 'pending' : 'offer';
  // A NEW personal key under a public name takes the public key's type and
  // unit, so the figure validates the same on either path.
  const publicDef = steerField && !matchedKey ? steerField.key : null;
  const offerLater = modal?.mode === 'add' && !!wineId && publicFields !== null
    && !steerField && !matchedKey && !!form.keyName.trim();
  const effectiveType = matchedKey ? matchedKey.type : (publicDef ? publicDef.type : form.keyType);
  // The saved list key behind the value input, if any: the matched key, or
  // the key of the entry being edited. Only such a key can take a new value
  // — a key still being created gets its list typed in directly.
  const listKey = effectiveType === 'enum'
    ? (matchedKey || (modal?.mode === 'edit' ? modal.entry.key : null))
    : null;
  const listOptions = listKey?.enumOptions || [];

  const openAdd = async () => {
    setForm(onVintagePage ? { ...emptyForm, level: offerVintage ? 'wine-vintage' : 'wine' } : emptyForm);
    setError(null);
    setAddingOption(false);
    // A figure from this bottle is true of its vintage; with no year to
    // narrow to, it can only be the wine-wide one.
    setPublicScope(bottleYear ? 'vintage' : 'wine');
    setModal({ mode: 'add' });
    loadPublic();
    try {
      const res = await getPersonalDataKeys(apiFetch);
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        setKeys(body.keys || []);
      }
    } catch { /* type-ahead is a convenience, not a requirement */ }
  };

  const openEdit = (entry) => {
    setForm({
      ...emptyForm,
      level: entry.level,
      keyName: entry.key.name,
      keyType: entry.key.type,
      value: entry.key.type === 'boolean' ? String(entry.value) : String(entry.value),
    });
    setError(null);
    setAddingOption(false);
    setModal({ mode: 'edit', entry });
  };

  const closeModal = () => { if (!busy) setModal(null); };

  const formValue = () => {
    if (effectiveType === 'boolean') return form.value === 'true';
    if (effectiveType === 'integer' || effectiveType === 'decimal') {
      // Send the raw string — the backend casts (and accepts the comma form).
      return form.value.trim();
    }
    return form.value.trim();
  };

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      let value = formValue();
      // A new value for a list key: extend the key first (the server keeps
      // every value an entry holds), then save the entry with it. A value
      // already on the list, in any case, is reused as spelled there.
      if (listKey && addingOption) {
        const typed = form.newOption.trim();
        const listed = listOptions.find((o) => o.toLowerCase() === typed.toLowerCase());
        if (listed) {
          value = listed;
        } else {
          const keyRes = await updatePersonalDataKey(apiFetch, listKey._id, { enumOptions: [...listOptions, typed] });
          const keyBody = await keyRes.json().catch(() => ({}));
          if (!keyRes.ok) {
            setError(keyBody.error || t('common.networkError', 'Network error. Please try again.'));
            return;
          }
          const options = keyBody.key?.enumOptions || [...listOptions, typed];
          setKeys((prev) => prev.map((k) => (k._id === listKey._id ? { ...k, enumOptions: options } : k)));
          // In edit mode the key comes from the entry: a retry after a failed
          // entry save must find the value listed, not PATCH the key again.
          if (modal.mode === 'edit') setModal({ ...modal, entry: { ...modal.entry, key: { ...modal.entry.key, enumOptions: options } } });
          value = typed;
        }
      }
      let res;
      if (modal.mode === 'edit') {
        res = await updatePersonalDataEntry(apiFetch, modal.entry._id, value);
      } else {
        // 'wine-vintage' is UI sugar (user ticket 6a853211): a wine-level
        // entry the server scopes to THIS bottle's vintage.
        const payload = {
          level: form.level === 'wine-vintage' ? 'wine' : form.level,
          ...(form.level === 'wine-vintage' ? { vintageScoped: true } : {}),
          value,
        };
        if (matchedKey) {
          payload.keyId = matchedKey._id;
        } else if (publicDef) {
          payload.newKey = {
            name: form.keyName.trim(),
            type: publicDef.type,
            ...(publicDef.unit ? { unit: publicDef.unit } : {}),
            ...(publicDef.type === 'enum' && publicDef.enumOptions ? { enumOptions: publicDef.enumOptions } : {}),
          };
        } else {
          payload.newKey = {
            name: form.keyName.trim(),
            type: form.keyType,
            ...(form.unit.trim() ? { unit: form.unit.trim() } : {}),
            ...(form.keyType === 'enum'
              ? { enumOptions: form.enumOptions.split(',').map((o) => o.trim()).filter(Boolean) }
              : {}),
          };
        }
        res = await addPersonalData(apiFetch, bottleId, payload);
      }
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setModal(null);
        setAddingOption(false);
        await load();
      } else {
        setError(body.error || t('common.networkError', 'Network error. Please try again.'));
      }
    } catch {
      setError(t('common.networkError', 'Network error. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  // "Add to the wine record": the typed figure goes to the curator queue
  // under the CANONICAL public key, and nothing is kept privately — that
  // stays the member's own choice ("Keep it private").
  const submitPublic = async (e) => {
    e.preventDefault();
    if (busy || !steerField) return;
    setBusy(true);
    setError(null);
    try {
      const value = listKey && addingOption ? form.newOption.trim() : formValue();
      const vintageFor = bottleYear && publicScope === 'vintage' ? bottleYear : null;
      const res = await suggestWineValue(apiFetch, wineId, {
        keyId: steerField.key._id,
        value,
        ...(vintageFor ? { vintage: vintageFor } : {}),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setModal(null);
        setPromoteDone('value');
        loadPublic({ force: true });
      } else {
        setError(body.error || t('common.networkError', 'Network error. Please try again.'));
      }
    } catch {
      setError(t('common.networkError', 'Network error. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  // The secondary "Keep it private" is a plain button (Enter sends the
  // primary action), so it asks the form to validate itself first.
  // Enter in the form saves privately, as it always has: filing a figure
  // publicly takes a click on this button, never a reflex key.
  const addToRecord = (e) => {
    const f = e.currentTarget.form;
    if (f && typeof f.reportValidity === 'function' && !f.reportValidity()) return;
    submitPublic(e);
  };

  const remove = async (entry) => {
    if (deleteBusy) return;
    setDeleteBusy(entry._id);
    try {
      const res = await deletePersonalDataEntry(apiFetch, entry._id);
      if (res.ok) await load();
    } catch { /* leave the entry visible; user can retry */ } finally {
      setDeleteBusy(null);
    }
  };

  // The public field an entry's key is, and the year its figure can be
  // scoped to: the entry's own vintage, else the bottle's.
  const promoteField = promote && wineId ? publicFieldFor(promote.key.name) : null;
  const promoteYear = promote ? (yearOf(promote.vintage) || bottleYear) : null;

  const openPromote = (entry) => {
    setPromote(entry);
    setPromoteReason('');
    setPromoteError(null);
    setPromoteDone(null);
    // An entry the member declared for every bottle of the wine shares
    // wine-wide; a bottle's or a vintage's figure shares into its vintage.
    const wineWide = entry.level === 'wine' && !yearOf(entry.vintage);
    setPromoteScope(!wineWide && (yearOf(entry.vintage) || bottleYear) ? 'vintage' : 'wine');
  };

  const submitPromote = async (e) => {
    e.preventDefault();
    if (promoteBusy) return;
    setPromoteBusy(true);
    setPromoteError(null);
    try {
      // A key the public vocabulary has: filed under its canonical id, into
      // the slot the member chose — never proposed again as a new field.
      if (promoteField) {
        const vintageFor = promoteYear && promoteScope === 'vintage' ? promoteYear : null;
        const res = await suggestWineValue(apiFetch, wineId, {
          keyId: promoteField.key._id,
          value: promote.value,
          ...(vintageFor ? { vintage: vintageFor } : {}),
          ...(promoteReason.trim() ? { reason: promoteReason.trim() } : {}),
        });
        if (res.ok) {
          setPromoteDone('value');
          setPromote(null);
          loadPublic({ force: true });
        } else {
          const body = await res.json().catch(() => ({}));
          setPromoteError(body.error || t('common.networkError', 'Network error. Please try again.'));
        }
        return;
      }
      // Server-side resolution (audit fix): suggest by key NAME — the backend
      // matches against its own nameKey rule. 404 = no such accepted key →
      // propose the key itself; a type mismatch surfaces the type-validation
      // message instead of a dead-end "already in the vocabulary" conflict.
      // A vintage-scoped personal entry promotes into that vintage's slot;
      // a wine-level one into the wine-wide default. The entry already knows.
      const res = await suggestWineValue(apiFetch, wineId, {
        keyName: promote.key.name,
        value: promote.value,
        ...(promote.vintage ? { vintage: promote.vintage } : {}),
        ...(promoteReason.trim() ? { reason: promoteReason.trim() } : {}),
      });
      if (res.ok) {
        setPromoteDone('value');
        setPromote(null);
        return;
      }
      const body = await res.json().catch(() => ({}));
      if (res.status === 404) {
        const kres = await proposeRegistryKey(apiFetch, {
          name: promote.key.name,
          type: promote.key.type,
          ...(promote.key.unit ? { unit: promote.key.unit } : {}),
          ...(promote.key.enumOptions ? { enumOptions: promote.key.enumOptions } : {}),
          rationale: promoteReason.trim(),
        });
        const kbody = await kres.json().catch(() => ({}));
        if (kres.ok) {
          setPromoteDone('key');
          setPromote(null);
        } else {
          setPromoteError(kbody.error || t('common.networkError', 'Network error. Please try again.'));
        }
      } else {
        setPromoteError(body.error || t('common.networkError', 'Network error. Please try again.'));
      }
    } catch {
      setPromoteError(t('common.networkError', 'Network error. Please try again.'));
    } finally {
      setPromoteBusy(false);
    }
  };

  const formatValue = (entry) => formatTypedValue(entry.key, entry.value, t);

  const authorName = (entry) =>
    entry.author?.displayName || entry.author?.username || t('personalData.someone', 'a cellar member');

  const isOwn = (entry) => String(entry.author?._id) === String(currentUserId);

  // Chosen values (enum) and yes/no read best as pills; free numbers, dates
  // and text as plain strong values with their unit.
  const isPillValue = (entry) => entry.key.type === 'enum' || entry.key.type === 'boolean';

  // An own entry under a public key: what the record already says decides
  // the offer. Nothing is ever copied or changed automatically.
  const renderShare = (entry) => {
    // Held until the record has answered, so the offer never changes label
    // under the member's finger.
    if (!publicReady) return null;
    const field = publicFieldFor(entry.key.name);
    if (field && hasValue(field.value) && sameValue(field.value, entry.value)) {
      return <span className="pd-entry-note">{t('personalData.matchesRecord', 'matches the wine record')}</span>;
    }
    if (field && publicHeld(field)) {
      return (
        <span className="pd-entry-note" title={t('wineRecord.pendingOtherTitle', 'A suggestion for this field is awaiting curator review')}>
          {t('wineRecord.pending', 'suggestion pending')}
        </span>
      );
    }
    const share = !!field && !hasValue(field.value);
    return (
      <button
        type="button"
        className={share ? 'btn btn-small btn-primary' : 'btn btn-small'}
        title={t('personalData.promoteTitle', 'Offer this to the shared registry — a curator reviews it first')}
        onClick={() => openPromote(entry)}
      >
        {share
          ? t('personalData.share', 'Share with the wine record')
          : t('personalData.promote', 'Suggest to registry')}
      </button>
    );
  };

  const renderEntries = (entries) => (
    <div className="pd-entries">
      {entries.map((entry) => (
        <div key={entry._id} className="pd-entry">
          <span className="pd-entry-key">
            {entry.key.name}
            {entry.vintage && (
              <span
                style={{ marginLeft: 4, fontSize: '0.75rem', fontWeight: 400, color: 'var(--color-text-muted)' }}
                title={t('personalData.vintageScopeTitle', 'Applies only to bottles of this vintage')}
              >
                ({formatVintage(entry.vintage, t)})
              </span>
            )}
          </span>
          <span className="pd-entry-main">
            <span className={isPillValue(entry) ? 'pd-value-pill' : 'pd-entry-value'}>
              {formatValue(entry)}
            </span>
            {!isOwn(entry) && (
              <span className="pd-entry-author">
                {t('personalData.by', 'by {{name}}', { name: authorName(entry) })}
              </span>
            )}
          </span>
          {isOwn(entry) && (
            <span className="pd-entry-actions">
              {wineId && renderShare(entry)}
              <button type="button" className="btn btn-small" onClick={() => openEdit(entry)}>
                {t('common.edit', 'Edit')}
              </button>
              <button
                type="button"
                className="btn btn-small btn-danger"
                onClick={() => remove(entry)}
                disabled={deleteBusy === entry._id}
              >
                {t('common.delete', 'Delete')}
              </button>
            </span>
          )}
        </div>
      ))}
    </div>
  );

  const sectionTitleStyle = {
    margin: '0.6rem 0 0.2rem', fontSize: '0.8rem', fontWeight: 700,
    textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--color-text-muted)',
  };

  const bottleEntries = onVintagePage ? [] : data.bottleEntries;
  const hasEntries = bottleEntries.length > 0 || data.wineEntries.length > 0;

  return (
    <div className="card pd-card" style={{ padding: '1rem 1.25rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h2 style={{ margin: 0, fontSize: '1rem' }}>
          {t('personalData.title', 'Your wine data')}
        </h2>
        <button type="button" className="btn btn-small" style={{ marginLeft: 'auto' }} onClick={openAdd}>
          {t('personalData.add', '+ Add')}
        </button>
      </div>
      <p style={{ margin: '0.25rem 0 0.4rem', color: 'var(--color-text-muted)', fontSize: '0.82rem' }}>
        {t('personalData.intro', 'Notes about your own bottles — provenance, where you bought it, cork condition. Visible to everyone who shares this cellar, never published. Facts about the wine itself, like ABV, belong in the wine record, where every owner sees them.')}
      </p>

      {!hasEntries && (
        <p style={{ margin: '0.4rem 0 0', fontSize: '0.88rem', color: 'var(--color-text-muted)' }}>
          {t('personalData.empty', 'Nothing recorded yet.')}
        </p>
      )}

      {bottleEntries.length > 0 && (
        <>
          <h3 style={sectionTitleStyle}>{t('personalData.bottleSection', 'This bottle')}</h3>
          {renderEntries(bottleEntries)}
        </>
      )}
      {data.wineEntries.length > 0 && (
        <>
          <h3 style={sectionTitleStyle}>{t('personalData.wineSection', 'This wine (all bottles of it)')}</h3>
          {renderEntries(data.wineEntries)}
        </>
      )}

      {promoteDone && (
        <p role="status" style={{ margin: '0.5rem 0 0', fontSize: '0.85rem', fontWeight: 600 }}>
          {promoteDone === 'value'
            ? t('personalData.promotedValue', 'Thank you — your value is in the registry review queue.')
            : t('personalData.promotedKey', 'Thank you — the field itself was proposed first; once a curator accepts it, values can follow.')}
        </p>
      )}

      {promote && (
        <Modal
          title={t('personalData.promoteModalTitle', 'Suggest to the shared registry')}
          onClose={() => !promoteBusy && setPromote(null)}
        >
          <form onSubmit={submitPromote} className="pd-form">
            {promoteError && <div className="alert alert-error" style={{ marginBottom: 8 }}>{promoteError}</div>}
            {promoteField ? (
              // A field the record already has: only the value is offered, so
              // the reason is optional and the slot is asked, not assumed.
              <p style={{ margin: '0 0 0.6rem', fontSize: '0.85rem' }}>
                {t('personalData.shareIntro', 'Offer “{{value}}” to the wine record as {{key}}, where every owner of this wine sees it. A curator checks it first.', { key: publicLabel(promoteField), value: formatValue(promote) })}
                {!promoteYear && (
                  <>{' '}{t('personalData.promoteScopeWine', 'It will apply to every vintage of this wine.')}</>
                )}
              </p>
            ) : (
              <p style={{ margin: '0 0 0.6rem', fontSize: '0.85rem' }}>
                {t('personalData.promoteIntro', 'Offer “{{key}}: {{value}}” to the shared registry. A curator reviews it; if the field doesn’t exist in the public vocabulary yet, the field itself is proposed first.', { key: promote.key.name, value: String(promote.value) })}
                {' '}
                {promote.vintage
                  ? t('personalData.promoteScopeVintage', 'It will apply to the {{year}} vintage only.', { year: formatVintage(promote.vintage, t) })
                  : t('personalData.promoteScopeWine', 'It will apply to every vintage of this wine.')}
              </p>
            )}
            {promoteField && promoteYear && (
              <ScopeChoice name="pd-promote-scope" year={promoteYear} value={promoteScope} onChange={setPromoteScope} t={t} />
            )}
            <div className="form-group">
              <label htmlFor="pd-promote-reason">
                {promoteField
                  ? t('wineRecord.valueReason', 'How do you know? (optional)')
                  : t('wineRecord.reason', 'How do you know?')}
              </label>
              <textarea
                id="pd-promote-reason"
                value={promoteReason}
                onChange={(e) => setPromoteReason(e.target.value)}
                placeholder={t('wineRecord.reasonPlaceholder', 'e.g. It’s printed on the label of my bottle / the producer’s site says…')}
                minLength={promoteField ? undefined : 10}
                maxLength={1000}
                rows={3}
                required={!promoteField}
              />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setPromote(null)} disabled={promoteBusy}>
                {t('common.cancel', 'Cancel')}
              </button>
              <button type="submit" className="btn btn-primary" disabled={promoteBusy || (!promoteField && promoteReason.trim().length < 10)}>
                {promoteBusy ? t('wineRecord.sending', 'Sending…') : t('wineRecord.send', 'Send suggestion')}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {modal && (
        <Modal
          title={modal.mode === 'edit'
            ? t('personalData.editTitle', 'Edit entry')
            : t('personalData.addTitle', 'Add wine data')}
          onClose={closeModal}
        >
          <form onSubmit={submit} className="pd-form">
            {error && <div className="alert alert-error" style={{ marginBottom: 8 }}>{error}</div>}

            {modal.mode === 'add' && (
              <>
                <div className="form-group">
                  <label htmlFor="pd-level">{t('personalData.level', 'Applies to')}</label>
                  <select
                    id="pd-level"
                    className="pd-select"
                    value={form.level}
                    onChange={(e) => setForm({ ...form, level: e.target.value })}
                  >
                    {!onVintagePage && (
                      <option value="bottle">{t('personalData.levelBottle', 'This bottle only')}</option>
                    )}
                    {offerVintage && (
                      <option value="wine-vintage">{t('personalData.levelWineVintage', 'Every bottle of this vintage ({{vintage}})', { vintage: formatVintage(vintage, t) })}</option>
                    )}
                    <option value="wine">{t('personalData.levelWine', 'Every bottle of this wine (all vintages)')}</option>
                  </select>
                </div>

                <div className="form-group">
                  <label htmlFor="pd-key-name">{t('personalData.key', 'What is it?')}</label>
                  <input
                    id="pd-key-name"
                    type="text"
                    list="pd-key-suggestions"
                    value={form.keyName}
                    onChange={(e) => setForm({ ...form, keyName: e.target.value })}
                    placeholder={t('personalData.keyPlaceholder', 'e.g. ABV, Provenance, Cork condition')}
                    maxLength={60}
                    required
                  />
                  <datalist id="pd-key-suggestions">
                    {keys.map((k) => <option key={k._id} value={k.name} />)}
                  </datalist>

                  {/* Saved keys as one-tap chips — the datalist alone is invisible
                      until you type, which made reuse look broken (Johan, 08-17):
                      a value list created on one wine seemed to vanish on the next. */}
                  {keys.length > 0 && (
                    <div style={{ marginTop: '0.5rem' }}>
                      <span className="pd-chips-label">
                        {t('personalData.yourKeys', 'Your saved keys:')}
                      </span>
                      <div className="pd-chips">
                        {keys.map((k) => {
                          const selected = matchedKey && matchedKey._id === k._id;
                          return (
                            <button
                              key={k._id}
                              type="button"
                              className={`pd-chip${selected ? ' pd-chip--selected' : ''}`}
                              onClick={() => setForm({ ...form, keyName: k.name, value: '' })}
                              title={k.type + (k.unit ? ` (${k.unit})` : '')}
                            >
                              {k.name}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {matchedKey && (
                    <p className="pd-key-note">
                      {t('personalData.existingKey', 'Existing key — type: {{type}}', { type: matchedKey.type })}
                      {matchedKey.unit ? ` (${matchedKey.unit})` : ''}
                    </p>
                  )}
                  {steer && (
                    <p className={`pd-public-note${steer === 'offer' ? ' pd-public-note--offer' : ''}`}>
                      {steer === 'offer' && t('personalData.publicKeyOffer', '{{key}} is part of the shared wine record — add it there and every owner of this wine sees it. A curator checks it first.', { key: publicLabel(steerField) })}
                      {steer === 'recorded' && t('personalData.publicKeyRecorded', 'The wine record already has {{key}}: {{value}}.', { key: publicLabel(steerField), value: formatTypedValue(steerField.key, steerField.value, t) })}
                      {steer === 'pending' && t('personalData.publicKeyPending', '{{key}} is part of the shared wine record, and a suggested value for it is already waiting for a curator.', { key: publicLabel(steerField) })}
                    </p>
                  )}
                  {offerLater && (
                    <p className="pd-key-note">
                      {t('personalData.offerLater', 'Is this a fact every bottle of this wine shares? You can offer it to the shared registry after saving.')}
                    </p>
                  )}
                </div>

                {!matchedKey && !publicDef && form.keyName.trim() && (
                  <>
                    <div className="form-group">
                      <label htmlFor="pd-key-type">{t('personalData.type', 'Value type')}</label>
                      <select
                        id="pd-key-type"
                        className="pd-select"
                        value={form.keyType}
                        onChange={(e) => setForm({ ...form, keyType: e.target.value, value: '' })}
                      >
                        {TYPES.map((ty) => (
                          <option key={ty} value={ty}>
                            {t(`personalData.type_${ty}`, ty)}
                          </option>
                        ))}
                      </select>
                    </div>
                    {(form.keyType === 'integer' || form.keyType === 'decimal') && (
                      <div className="form-group">
                        <label htmlFor="pd-unit">{t('personalData.unit', 'Unit (optional)')}</label>
                        <input
                          id="pd-unit"
                          type="text"
                          value={form.unit}
                          onChange={(e) => setForm({ ...form, unit: e.target.value })}
                          placeholder={t('personalData.unitPlaceholder', 'e.g. %, °C, kr')}
                          maxLength={20}
                        />
                      </div>
                    )}
                    {form.keyType === 'enum' && (
                      <div className="form-group">
                        <label htmlFor="pd-enum-options">{t('personalData.enumOptions', 'Allowed values (comma-separated)')}</label>
                        <input
                          id="pd-enum-options"
                          type="text"
                          value={form.enumOptions}
                          onChange={(e) => setForm({ ...form, enumOptions: e.target.value })}
                          placeholder={t('personalData.enumPlaceholder', 'e.g. cork, screwcap, crown')}
                          required
                        />
                      </div>
                    )}
                  </>
                )}
              </>
            )}

            <div className="form-group">
              {/* Explicit htmlFor/id: the unit suffix lives beside the input,
                  and a wrapping label would fold it into the accessible name. */}
              <label htmlFor="pd-value-input">
                {t('personalData.value', 'Value')}
              </label>
              {listKey && addingOption ? (
                <input
                  id="pd-value-input"
                  type="text"
                  value={form.newOption}
                  onChange={(e) => setForm({ ...form, newOption: e.target.value })}
                  placeholder={t('personalData.newOptionPlaceholder', 'A value not on the list yet')}
                  maxLength={40}
                  required
                />
              ) : (
                <TypedValueInput
                  id="pd-value-input"
                  keyDef={{
                    type: effectiveType,
                    unit: matchedKey?.unit || publicDef?.unit
                      || (modal.mode === 'edit' ? modal.entry.key.unit : form.unit.trim() || null),
                    enumOptions: matchedKey?.enumOptions
                      || publicDef?.enumOptions
                      || (modal.mode === 'edit' ? modal.entry.key.enumOptions : null)
                      || (effectiveType === 'enum'
                        ? form.enumOptions.split(',').map((o) => o.trim()).filter(Boolean)
                        : null),
                  }}
                  value={form.value}
                  onChange={(v) => setForm({ ...form, value: v })}
                />
              )}
              {listKey && !addingOption && listOptions.length < 20 && (
                <button
                  type="button"
                  className="pd-add-option"
                  onClick={() => { setAddingOption(true); setForm({ ...form, value: '', newOption: '' }); }}
                >
                  {t('personalData.addOption', '+ Add a new value to the list')}
                </button>
              )}
              {listKey && addingOption && (
                <button type="button" className="pd-add-option" onClick={() => setAddingOption(false)}>
                  {t('personalData.backToList', 'Back to the list')}
                </button>
              )}
            </div>

            {steer === 'offer' && bottleYear && (
              <ScopeChoice name="pd-public-scope" year={bottleYear} value={publicScope} onChange={setPublicScope} t={t} />
            )}

            <div className="modal-actions">
              <button type="button" className="btn" onClick={closeModal} disabled={busy}>
                {t('common.cancel', 'Cancel')}
              </button>
              {steer === 'offer' ? (
                <>
                  <button type="submit" className="btn" disabled={busy}>
                    {t('personalData.keepPrivate', 'Keep it private')}
                  </button>
                  <button type="button" className="btn btn-primary" onClick={addToRecord} disabled={busy}>
                    {t('personalData.addToRecord', 'Add to the wine record')}
                  </button>
                </>
              ) : (
                <button type="submit" className="btn btn-primary" disabled={busy}>
                  {busy ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
                </button>
              )}
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

export default PersonalDataCard;
