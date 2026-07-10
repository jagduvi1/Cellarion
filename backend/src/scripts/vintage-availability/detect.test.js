'use strict';

const { diffAvailability, mergeSources } = require('./detect');

describe('vintage-availability detect (offline logic)', () => {
  test('flags a newly available vintage vs the last-seen set', () => {
    const r = diffAvailability([2020, 2021, 2022], [2020, 2021, 2022, 2023]);
    expect(r.newlyAvailable).toEqual([2023]);
    expect(r.currentVintages).toEqual([2020, 2021, 2022, 2023]);
  });

  test('no new release when the available set is unchanged', () => {
    const r = diffAvailability([2021, 2022], [2022, 2021]);
    expect(r.newlyAvailable).toEqual([]);
  });

  test('a vintage disappearing (sold out) is NOT reported as newly available', () => {
    const r = diffAvailability([2020, 2021], [2021]);
    expect(r.newlyAvailable).toEqual([]);
  });

  test('wantedNowAvailable is true only when the wanted vintage is currently listed', () => {
    expect(diffAvailability([], [2023, 2024], { wantedVintage: 2024 }).wantedNowAvailable).toBe(true);
    expect(diffAvailability([], [2023], { wantedVintage: 2024 }).wantedNowAvailable).toBe(false);
  });

  test('handles empty / undefined inputs without throwing', () => {
    expect(diffAvailability(undefined, undefined).newlyAvailable).toEqual([]);
    expect(diffAvailability(null, [], {}).currentVintages).toEqual([]);
  });

  test('dedupes and sorts current vintages', () => {
    const r = diffAvailability([], [2022, 2022, 2020, 2021]);
    expect(r.currentVintages).toEqual([2020, 2021, 2022]);
  });

  test('mergeSources unions availability across providers and tracks per-source', () => {
    const merged = mergeSources([
      { source: 'vinmonopolet', ok: true, availableVintages: [2020, 2021] },
      { source: 'alko', ok: true, availableVintages: [2021, 2022] },
      { source: 'lwin', ok: false, availableVintages: [] },
    ]);
    expect(merged.unionAvailableVintages).toEqual([2020, 2021, 2022]);
    expect(merged.bySource.vinmonopolet).toEqual([2020, 2021]);
    expect(merged.bySource.lwin).toBeNull();
  });
});
