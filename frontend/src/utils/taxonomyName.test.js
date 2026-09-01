import { describe, it, expect } from 'vitest';
import { taxonomyName } from './taxonomyName';

// The map GET /api/taxonomy/display-names?lang=fr returns.
const names = {
  byId: { r1: 'Vallée du Rhône', c1: 'Allemagne' },
  byName: { 'Rhône Valley': 'Vallée du Rhône', Germany: 'Allemagne' },
};

describe('taxonomyName', () => {
  it('shows the French name for a populated region', () => {
    expect(taxonomyName({ _id: 'r1', name: 'Rhône Valley' }, names)).toBe('Vallée du Rhône');
  });

  it('resolves a bare canonical string, which is how half the app holds it', () => {
    expect(taxonomyName('Rhône Valley', names)).toBe('Vallée du Rhône');
  });

  it('prefers the id over the name, because ids are exact', () => {
    // Region names can repeat across countries; the id cannot.
    const map = { byId: { r1: 'Correct' }, byName: { Ambiguous: 'Wrong' } };
    expect(taxonomyName({ _id: 'r1', name: 'Ambiguous' }, map)).toBe('Correct');
  });

  it('accepts `id` as well as `_id`', () => {
    expect(taxonomyName({ id: 'c1', name: 'Germany' }, names)).toBe('Allemagne');
  });

  it('falls back to the canonical name when nothing is translated', () => {
    expect(taxonomyName({ _id: 'r9', name: 'Mosel' }, names)).toBe('Mosel');
    expect(taxonomyName('Mosel', names)).toBe('Mosel');
  });

  it('falls back with no map at all — an unadopted surface must not break', () => {
    // This is the default argument doing the real work: a component that has
    // not been given the map yet renders exactly what it renders today.
    expect(taxonomyName({ _id: 'r1', name: 'Rhône Valley' })).toBe('Rhône Valley');
    expect(taxonomyName('Rhône Valley')).toBe('Rhône Valley');
    expect(taxonomyName({ name: 'Mosel' }, null)).toBe('Mosel');
    expect(taxonomyName({ name: 'Mosel' }, {})).toBe('Mosel');
  });

  it('returns an empty string for nothing, rather than throwing', () => {
    expect(taxonomyName(null, names)).toBe('');
    expect(taxonomyName(undefined, names)).toBe('');
    expect(taxonomyName({}, names)).toBe('');
    expect(taxonomyName({ _id: 'r9' }, names)).toBe('');
  });
});
