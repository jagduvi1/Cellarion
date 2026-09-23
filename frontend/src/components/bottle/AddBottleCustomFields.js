import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { getPersonalDataKeys } from '../../api/personalData';
import { getRegistryKeys, getWinePublicData } from '../../api/registryData';
import TypedValueInput, { TYPES } from '../TypedValueInput';
// The chip / select / label styling is shared with the bottle page's card on
// purpose: same data, same affordances, so the two entry points read as one
// feature. This file adds only the add-form's own layout.
import './PersonalDataCard.css';
import './AddBottleCustomFields.css';

/**
 * Custom fields on the add-bottle form (user ticket 6ab05cca — "Have the
 * option to add abv when adding bottles").
 *
 * The data itself is nothing new: these are the same typed personal entries
 * the bottle page already writes (#986). What was missing was an entry point
 * at the moment people actually have the number in front of them — the label
 * is in their hand while they are adding the bottle, not a page-visit later.
 * The reporter had 117 bottles and had never found the card at all.
 *
 * Two suggestion sources feed the chips, in this order:
 *  1. The PUBLIC registry vocabulary (accepted RegistryDataKeys — today: ABV).
 *     A chip carries the canonical name, type and unit, so a field typed here
 *     is named exactly as the registry names it and stays promotable later.
 *     This is the point: seven users had independently minted their own
 *     private "ABV" key while the shared registry already had one.
 *  2. The user's own saved keys, so their vocabulary carries across adds.
 *
 * Nothing here writes on its own. Rows are handed back through onChange and
 * ride the bottle POST, so an abandoned form writes nothing — the same
 * mint-at-commit discipline the wine itself follows.
 */

const NEW_ROW = {
  keyName: '',
  keyType: 'text',
  unit: '',
  enumOptions: '',
  value: '',
  // 'bottle' | 'wine' | 'wine-vintage' — 'wine-vintage' is UI sugar for a
  // wine-level entry the server scopes to this bottle's vintage.
  level: 'bottle',
};

/**
 * The payload rows for POST /api/bottles. Incomplete rows are dropped rather
 * than sent half-built, and a row whose name matches a saved key rides that
 * key's id so the backend reuses it instead of resolving by name.
 */
export function buildPersonalDataPayload(rows, savedKeys, { hasVintage, registryKeys = [] } = {}) {
  const out = [];
  for (const row of rows || []) {
    const name = (row.keyName || '').trim();
    const raw = typeof row.value === 'string' ? row.value.trim() : row.value;
    if (!name || raw === '' || raw === undefined || raw === null) continue;

    const saved = (savedKeys || []).find(
      (k) => k.name.toLowerCase() === name.toLowerCase()
    );
    // A name that matches the PUBLIC vocabulary takes the registry's type and
    // unit even when the user typed it by hand rather than tapping the chip —
    // otherwise "ABV" typed into a fresh row goes out as text, and the user
    // ends up with a text ABV key beside everyone else's decimal one. The id
    // is NOT reused: a RegistryDataKey id is not a PersonalDataKey id, so the
    // definition rides as newKey and the service matches it by name.
    const publicKey = saved ? null : (registryKeys || []).find(
      (k) => k.name.toLowerCase() === name.toLowerCase()
    );
    const known = saved || publicKey;
    const type = known ? known.type : row.keyType;
    // A vintage scope the bottle cannot satisfy is rejected by the service,
    // so it degrades to the wine-wide entry rather than costing the field.
    const level = row.level === 'wine-vintage' && !hasVintage ? 'wine' : row.level;

    out.push({
      level: level === 'bottle' ? 'bottle' : 'wine',
      ...(level === 'wine-vintage' ? { vintageScoped: true } : {}),
      value: type === 'boolean' ? raw === 'true' || raw === true : raw,
      ...(saved
        ? { keyId: saved._id }
        : {
          newKey: {
            // The public vocabulary's own spelling, so everyone's "ABV" is
            // one key rather than ABV / abv / Abv.
            name: publicKey ? publicKey.name : name,
            type,
            ...(publicKey
              ? (publicKey.unit ? { unit: publicKey.unit } : {})
              : (row.unit && row.unit.trim() ? { unit: row.unit.trim() } : {})),
            ...(type === 'enum'
              ? {
                enumOptions: publicKey
                  ? (publicKey.enumOptions || [])
                  : (row.enumOptions || '').split(',').map((o) => o.trim()).filter(Boolean),
              }
              : {}),
          },
        }),
    });
  }
  return out;
}

function AddBottleCustomFields({ apiFetch, wineId, vintage, rows, onChange, onKeysLoaded, onRegistryKeysLoaded }) {
  const { t } = useTranslation();
  const [savedKeys, setSavedKeys] = useState([]);
  const [registryKeys, setRegistryKeys] = useState([]);
  // What the registry already publishes for this wine+vintage. Shown so
  // nobody retypes a figure the registry has, and so a field the registry
  // does not have reads as worth filling in.
  const [published, setPublished] = useState({});

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [pk, rk] = await Promise.all([
          getPersonalDataKeys(apiFetch),
          getRegistryKeys(apiFetch),
        ]);
        if (!live) return;
        if (pk.ok) {
          const body = await pk.json().catch(() => ({}));
          const keys = body.keys || [];
          setSavedKeys(keys);
          onKeysLoaded?.(keys);
        }
        if (rk.ok) {
          const body = await rk.json().catch(() => ({}));
          const keys = body.keys || [];
          setRegistryKeys(keys);
          onRegistryKeysLoaded?.(keys);
        }
      } catch {
        // Suggestions are a convenience — typing a name by hand still works.
      }
    })();
    return () => { live = false; };
    // The onLoaded props are setters from the parent; re-running on their
    // identity would refetch the vocabulary on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiFetch]);

  // Only an existing registry wine has published values to read; the
  // mint-at-commit path has no wine id yet, and that is fine — a brand-new
  // wine has nothing published by definition.
  useEffect(() => {
    let live = true;
    if (!wineId) { setPublished({}); return undefined; }
    (async () => {
      try {
        const res = await getWinePublicData(apiFetch, wineId, vintage || undefined);
        if (!live || !res.ok) return;
        const body = await res.json().catch(() => ({}));
        const map = {};
        for (const f of body.fields || []) {
          if (f.value !== null && f.value !== undefined) {
            // Keyed lower-case for the chip/name comparisons, but the label
            // shown to the reader is the key's own casing — "ABV", not "abv".
            map[f.key.name.toLowerCase()] = {
              name: f.key.name, value: f.value, unit: f.key.unit, from: f.resolvedFrom,
            };
          }
        }
        setPublished(map);
      } catch {
        if (live) setPublished({});
      }
    })();
    return () => { live = false; };
  }, [apiFetch, wineId, vintage]);

  const update = (i, patch) => {
    const next = rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
    onChange(next);
  };

  const addRow = (seed) => onChange([...rows, { ...NEW_ROW, ...seed }]);
  const removeRow = (i) => onChange(rows.filter((_, idx) => idx !== i));

  const usedNames = useMemo(
    () => new Set(rows.map((r) => (r.keyName || '').trim().toLowerCase()).filter(Boolean)),
    [rows]
  );

  // A registry key seeds a row with the canonical type and unit, and defaults
  // to the vintage: ABV is a fact about one bottling, not about the bottle in
  // your hand and not about every year of the wine.
  const registryChips = registryKeys
    .filter((k) => !usedNames.has(k.name.toLowerCase()) && !published[k.name.toLowerCase()])
    .map((k) => ({
      label: k.name,
      seed: {
        keyName: k.name,
        keyType: k.type,
        unit: k.unit || '',
        enumOptions: (k.enumOptions || []).join(', '),
        level: vintage ? 'wine-vintage' : 'wine',
      },
    }));

  const savedChips = savedKeys
    .filter((k) => !usedNames.has(k.name.toLowerCase()))
    .filter((k) => !registryChips.some((c) => c.label.toLowerCase() === k.name.toLowerCase()))
    .map((k) => ({
      label: k.name,
      seed: {
        keyName: k.name,
        keyType: k.type,
        unit: k.unit || '',
        enumOptions: (k.enumOptions || []).join(', '),
        level: 'bottle',
      },
    }));

  const knownPublished = Object.entries(published);

  return (
    <div className="abcf">
      <p className="abcf-intro">
        {t('addBottle.customFieldsIntro', 'Anything else worth recording — ABV, a classification, a score from elsewhere. You can add more later on the bottle page.')}
      </p>

      {knownPublished.length > 0 && (
        <p className="abcf-known">
          {t('addBottle.customFieldsKnown', 'Already in the wine record:')}{' '}
          {knownPublished.map(([slug, p], i) => (
            <span key={slug}>
              {i > 0 ? ', ' : ''}
              <strong>{p.name}</strong> {String(p.value)}{p.unit ? ` ${p.unit}` : ''}
            </span>
          ))}
        </p>
      )}

      {rows.map((row, i) => {
        const rowName = (row.keyName || '').trim().toLowerCase();
        const saved = savedKeys.find((k) => k.name.toLowerCase() === rowName);
        // A public key is a canonical definition too: its type and unit are
        // the registry's answer, not a choice to re-make on this form. Showing
        // a type selector on "ABV" invites exactly the text-vs-decimal split
        // the shared vocabulary exists to prevent.
        const known = saved || registryKeys.find((k) => k.name.toLowerCase() === rowName);
        const type = known ? known.type : row.keyType;
        const unit = known ? known.unit : row.unit;
        // A vintage scope the bottle can no longer satisfy (the vintage was
        // cleared after the row was seeded) shows as the wine-wide entry the
        // payload builder will actually send — never as a blank select.
        const level = row.level === 'wine-vintage' && !vintage ? 'wine' : row.level;
        // A value with no name is dropped on the way out, so ask for the name
        // here rather than losing what they typed without a word.
        const hasValue = String(row.value ?? '').trim() !== '';
        return (
          <div className="abcf-row" key={i}>
            <div className="abcf-row-main">
              <input
                type="text"
                className="abcf-name"
                list="abcf-key-suggestions"
                value={row.keyName}
                onChange={(e) => update(i, { keyName: e.target.value })}
                placeholder={t('addBottle.customFieldName', 'Field name')}
                maxLength={60}
                required={hasValue}
                aria-label={t('addBottle.customFieldName', 'Field name')}
              />
              <span className="abcf-value">
                {/* The row is too tight for a visible label, but the input
                    still needs a name — the row's own field name is the
                    honest one once it has been typed. */}
                <label className="abcf-sr" htmlFor={`abcf-value-${i}`}>
                  {row.keyName.trim() || t('personalData.value', 'Value')}
                </label>
                <TypedValueInput
                  id={`abcf-value-${i}`}
                  keyDef={{ type, unit, enumOptions: known ? known.enumOptions : (row.enumOptions || '').split(',').map((o) => o.trim()).filter(Boolean) }}
                  value={row.value}
                  onChange={(v) => update(i, { value: v })}
                  // A blank row is dropped, not rejected — these inputs sit in
                  // the page's form, so `required` would block the whole add.
                  required={false}
                />
              </span>
              <button
                type="button"
                className="btn btn-secondary abcf-remove"
                onClick={() => removeRow(i)}
                aria-label={t('addBottle.customFieldRemove', 'Remove field')}
              >
                ×
              </button>
            </div>

            <div className="abcf-row-opts">
              {!known && row.keyName.trim() && (
                <>
                  <select
                    className="pd-select abcf-type"
                    value={row.keyType}
                    onChange={(e) => update(i, { keyType: e.target.value, value: '' })}
                    aria-label={t('personalData.type', 'Value type')}
                  >
                    {TYPES.map((ty) => (
                      <option key={ty} value={ty}>{t(`personalData.type_${ty}`, ty)}</option>
                    ))}
                  </select>
                  {(row.keyType === 'integer' || row.keyType === 'decimal') && (
                    <input
                      type="text"
                      className="abcf-unit"
                      value={row.unit}
                      onChange={(e) => update(i, { unit: e.target.value })}
                      placeholder={t('personalData.unit', 'Unit (optional)')}
                      maxLength={20}
                      aria-label={t('personalData.unit', 'Unit (optional)')}
                    />
                  )}
                  {row.keyType === 'enum' && (
                    <input
                      type="text"
                      className="abcf-unit"
                      value={row.enumOptions}
                      onChange={(e) => update(i, { enumOptions: e.target.value })}
                      placeholder={t('personalData.enumOptions', 'Options, comma separated')}
                      aria-label={t('personalData.enumOptions', 'Options, comma separated')}
                    />
                  )}
                </>
              )}
              <select
                className="pd-select abcf-level"
                value={level}
                onChange={(e) => update(i, { level: e.target.value })}
                aria-label={t('personalData.level', 'Applies to')}
              >
                <option value="bottle">{t('personalData.levelBottle', 'This bottle only')}</option>
                {vintage && (
                  <option value="wine-vintage">
                    {t('personalData.levelWineVintage', 'Every bottle of this vintage ({{vintage}})', { vintage })}
                  </option>
                )}
                <option value="wine">{t('personalData.levelWine', 'Every bottle of this wine (all vintages)')}</option>
              </select>
            </div>
          </div>
        );
      })}

      <datalist id="abcf-key-suggestions">
        {[...registryKeys, ...savedKeys].map((k) => <option key={`${k._id}`} value={k.name} />)}
      </datalist>

      {(registryChips.length > 0 || savedChips.length > 0) && (
        <div className="abcf-chips-block">
          {registryChips.length > 0 && (
            <div>
              <span className="pd-chips-label">{t('addBottle.customFieldsRegistry', 'Add:')}</span>
              <div className="pd-chips">
                {registryChips.map((c) => (
                  <button key={c.label} type="button" className="pd-chip" onClick={() => addRow(c.seed)}>
                    + {c.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {savedChips.length > 0 && (
            <div>
              <span className="pd-chips-label">{t('personalData.yourKeys', 'Your saved keys:')}</span>
              <div className="pd-chips">
                {savedChips.map((c) => (
                  <button key={c.label} type="button" className="pd-chip" onClick={() => addRow(c.seed)}>
                    + {c.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <button type="button" className="btn btn-secondary abcf-add" onClick={() => addRow({})}>
        {t('addBottle.customFieldAdd', '+ Add a field')}
      </button>
    </div>
  );
}

export default AddBottleCustomFields;
