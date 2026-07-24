import { describe, test, expect } from 'vitest';
import { prepareImportItems } from './importPrepare';

const row = (over = {}) => ({
  wineName: 'Barolo', producer: 'P', vintage: '2015',
  rating: 4, ratingScale: '5', scanDate: '2019-05-12', ...over,
});

describe('prepareImportItems', () => {
  test('non-Vivino files pass through untouched except the transient scanDate', () => {
    const [out] = prepareImportItems([row()], { vivinoScanHistory: false });
    expect(out).not.toHaveProperty('scanDate');
    expect(out).not.toHaveProperty('addToHistory');
    expect(out).not.toHaveProperty('addToWishlist');
    expect(out.rating).toBe(4);
  });

  test('wishlist mode: rows become wishlist items, never consumed bottles', () => {
    const [out] = prepareImportItems([row()], { vivinoScanHistory: true, vivinoImportMode: 'wishlist' });
    expect(out.addToWishlist).toBe(true);
    expect(out).not.toHaveProperty('addToHistory');
    expect(out).not.toHaveProperty('consumedAt');
    expect(out).not.toHaveProperty('dateAdded');
  });

  test('cellar mode: plain active bottles, scanDate stripped', () => {
    const [out] = prepareImportItems([row()], { vivinoScanHistory: true, vivinoImportMode: 'cellar' });
    expect(out).not.toHaveProperty('scanDate');
    expect(out).not.toHaveProperty('addToHistory');
    expect(out).not.toHaveProperty('consumedAt');
  });

  test('history mode anchors BOTH journey ends to the scan date (dateAdded + consumedAt)', () => {
    const [out] = prepareImportItems([row()], { vivinoScanHistory: true, vivinoImportMode: 'history' });
    expect(out).toMatchObject({
      addToHistory: true,
      consumedReason: 'drank',
      consumedAt: '2019-05-12',
      // Without dateAdded the backend stamps addedToCellarAt = import day →
      // inverted journeys and negative daysHeld (audit 2026-07-24 H1).
      dateAdded: '2019-05-12',
      consumedRating: 4,
      consumedRatingScale: '5',
    });
    expect(out).not.toHaveProperty('scanDate');
  });

  test('history mode without a scan date emits neither date (backend falls back to now)', () => {
    const [out] = prepareImportItems([row({ scanDate: undefined })], { vivinoScanHistory: true, vivinoImportMode: 'history' });
    expect(out.addToHistory).toBe(true);
    expect(out).not.toHaveProperty('consumedAt');
    expect(out).not.toHaveProperty('dateAdded');
  });

  test('history mode without a rating leaves the consumed rating unset', () => {
    const [out] = prepareImportItems([row({ rating: undefined, ratingScale: undefined })], { vivinoScanHistory: true, vivinoImportMode: 'history' });
    expect(out).not.toHaveProperty('consumedRating');
    expect(out).not.toHaveProperty('consumedRatingScale');
  });
});
