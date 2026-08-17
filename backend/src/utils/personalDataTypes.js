// The shared typed-value system (issue #986). Validates a raw value against a
// key's declared type and returns the canonical cast form. Values are
// validated for TYPE, never for truth.
//
// This module is deliberately free of personal-data specifics: the public
// registry vocabulary (#985) and the analytics catalogue (#987) reuse the same
// types, so `key` here is any object shaped { type, enumOptions? } — the unit
// lives on the key and plays no part in validation.

const TYPES = ['text', 'integer', 'decimal', 'boolean', 'date', 'enum'];

const TEXT_MAX = 500;

/**
 * Validate and cast a raw value against a key's declared type.
 *
 * @param {{ type: string, enumOptions?: string[] }} key
 * @param {*} raw
 * @returns {{ ok: true, value: * } | { ok: false, error: string }}
 */
function validateValue(key, raw) {
  if (!key || !TYPES.includes(key.type)) {
    return { ok: false, error: 'Unknown key type' };
  }
  if (raw === null || raw === undefined || raw === '') {
    return { ok: false, error: 'A value is required' };
  }

  switch (key.type) {
    case 'text': {
      if (typeof raw !== 'string') return { ok: false, error: 'Expected text' };
      const value = raw.trim();
      if (!value) return { ok: false, error: 'A value is required' };
      if (value.length > TEXT_MAX) {
        return { ok: false, error: `Text too long (max ${TEXT_MAX} characters)` };
      }
      return { ok: true, value };
    }

    case 'integer': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isInteger(n)) return { ok: false, error: 'Expected a whole number' };
      return { ok: true, value: n };
    }

    case 'decimal': {
      // Accept both 13.5 and the comma form 13,5 that a Swedish keyboard produces.
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim().replace(',', '.'));
      if (!Number.isFinite(n)) return { ok: false, error: 'Expected a number' };
      return { ok: true, value: n };
    }

    case 'boolean': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      const s = String(raw).trim().toLowerCase();
      if (s === 'true' || s === 'yes') return { ok: true, value: true };
      if (s === 'false' || s === 'no') return { ok: true, value: false };
      return { ok: false, error: 'Expected yes or no' };
    }

    case 'date': {
      // Canonical form is the ISO calendar date string (no time component) —
      // stable to store, correct to sort lexicographically.
      const s = String(raw).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        return { ok: false, error: 'Expected a date (YYYY-MM-DD)' };
      }
      const d = new Date(`${s}T00:00:00Z`);
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
        return { ok: false, error: 'Not a valid calendar date' };
      }
      return { ok: true, value: s };
    }

    case 'enum': {
      const options = key.enumOptions || [];
      if (!options.length) return { ok: false, error: 'This key has no options defined' };
      const s = String(raw).trim();
      const match = options.find((o) => o === s);
      if (!match) {
        return { ok: false, error: `Expected one of: ${options.join(', ')}` };
      }
      return { ok: true, value: match };
    }

    default:
      return { ok: false, error: 'Unknown key type' };
  }
}

/**
 * Validate a new key definition. Returns the normalised definition or an error.
 * Unit is only kept on numeric keys; enumOptions only on enum keys.
 */
function validateKeyDefinition({ name, type, unit, enumOptions } = {}) {
  const cleanName = typeof name === 'string' ? name.trim() : '';
  if (!cleanName) return { ok: false, error: 'Key name is required' };
  if (cleanName.length > 60) return { ok: false, error: 'Key name too long (max 60 characters)' };
  if (!TYPES.includes(type)) {
    return { ok: false, error: `Key type must be one of: ${TYPES.join(', ')}` };
  }

  const def = { name: cleanName, type };

  if (type === 'integer' || type === 'decimal') {
    if (unit !== undefined && unit !== null && unit !== '') {
      const cleanUnit = String(unit).trim();
      if (cleanUnit.length > 20) return { ok: false, error: 'Unit too long (max 20 characters)' };
      def.unit = cleanUnit;
    }
  }

  if (type === 'enum') {
    const options = Array.isArray(enumOptions)
      ? [...new Set(enumOptions.map((o) => String(o).trim()).filter(Boolean))]
      : [];
    if (options.length < 2) return { ok: false, error: 'An enum key needs at least 2 options' };
    if (options.length > 20) return { ok: false, error: 'Too many enum options (max 20)' };
    if (options.some((o) => o.length > 40)) {
      return { ok: false, error: 'Enum option too long (max 40 characters)' };
    }
    def.enumOptions = options;
  }

  return { ok: true, def };
}

module.exports = { TYPES, TEXT_MAX, validateValue, validateKeyDefinition };
