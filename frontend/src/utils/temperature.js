/**
 * Temperatures are stored and exchanged in °C everywhere (registry serving
 * trait, climate readings, the API). The user's preference
 * (preferences.temperatureUnit, 'C' | 'F') converts at display only.
 */

export const TEMPERATURE_UNITS = ['C', 'F'];

export function toFahrenheit(celsius) {
  return celsius * 9 / 5 + 32;
}

/** 'C' or 'F' from a user object (or anything with preferences); °C when unknown. */
export function temperatureUnitOf(user) {
  return user?.preferences?.temperatureUnit === 'F' ? 'F' : 'C';
}

/**
 * One temperature for display. Whole degrees by default (the serving line);
 * `decimals` for readings that carry tenths (climate cards show 12.3 °C).
 */
export function formatTemperature(celsius, unit = 'C', { decimals = 0 } = {}) {
  if (celsius == null || !Number.isFinite(Number(celsius))) return '';
  const value = unit === 'F' ? toFahrenheit(Number(celsius)) : Number(celsius);
  return `${value.toFixed(decimals)} °${unit === 'F' ? 'F' : 'C'}`;
}

/** A range, "16–18 °C" or "61–64 °F": both ends rounded to whole degrees. */
export function formatTemperatureRange(minC, maxC, unit = 'C') {
  if (minC == null || maxC == null) return '';
  const conv = (c) => Math.round(unit === 'F' ? toFahrenheit(c) : c);
  return `${conv(minC)}–${conv(maxC)} °${unit === 'F' ? 'F' : 'C'}`;
}
