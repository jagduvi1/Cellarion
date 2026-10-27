import { describe, test, expect } from 'vitest';
import { toFahrenheit, formatTemperature, formatTemperatureRange, temperatureUnitOf } from './temperature';

describe('temperatures are stored in °C and shown in the user\'s unit', () => {
  test('conversion', () => {
    expect(toFahrenheit(0)).toBe(32);
    expect(toFahrenheit(100)).toBe(212);
    expect(toFahrenheit(16)).toBeCloseTo(60.8);
  });

  test('one value: whole degrees for the serving line, tenths for a reading', () => {
    expect(formatTemperature(12.34, 'C', { decimals: 1 })).toBe('12.3 °C');
    expect(formatTemperature(12.34, 'F', { decimals: 1 })).toBe('54.2 °F');
    expect(formatTemperature(16, 'F')).toBe('61 °F');
    expect(formatTemperature(null, 'F')).toBe('');
  });

  test('a range: "16–18 °C" reads "61–64 °F"', () => {
    expect(formatTemperatureRange(16, 18, 'C')).toBe('16–18 °C');
    expect(formatTemperatureRange(16, 18, 'F')).toBe('61–64 °F');
    expect(formatTemperatureRange(6, 8, 'F')).toBe('43–46 °F');
    expect(formatTemperatureRange(null, 8, 'F')).toBe('');
  });

  test('the unit comes from the user\'s preference, °C when unknown', () => {
    expect(temperatureUnitOf({ preferences: { temperatureUnit: 'F' } })).toBe('F');
    expect(temperatureUnitOf({ preferences: { temperatureUnit: 'C' } })).toBe('C');
    expect(temperatureUnitOf({ preferences: {} })).toBe('C');
    expect(temperatureUnitOf(null)).toBe('C');
  });
});
