/**
 * dismissUnmatchedAppellation / restoreDismissedAppellation — the unmatched
 * queue's terminal state (ticket 6a842d5e).
 *
 * Pins: the group key is derived exactly as the listing derives it (so a
 * dismissal by any spelling variant lands on the row it means to silence),
 * the reason is required and HTML-stripped (it is the durable review
 * record), first-dismisser-wins on a race, and restore reports whether it
 * actually lifted anything.
 */

jest.mock('../models/WineDefinition', () => ({ aggregate: jest.fn() }));
jest.mock('../models/Appellation', () => ({ find: jest.fn() }));
jest.mock('../models/Country', () => ({ find: jest.fn() }));
jest.mock('../models/Region', () => ({ find: jest.fn() }));
jest.mock('../models/AppellationReviewSkip', () => ({
  find: jest.fn(),
  findOneAndUpdate: jest.fn(),
  deleteOne: jest.fn(),
}));

const AppellationReviewSkip = require('../models/AppellationReviewSkip');
const {
  dismissUnmatchedAppellation,
  restoreDismissedAppellation,
  listDismissedAppellations,
} = require('./taxonomyReview');

const USER = 'a'.repeat(24);
const inserted = () => ({ lastErrorObject: { updatedExisting: false } });
const existing = () => ({ lastErrorObject: { updatedExisting: true } });

beforeEach(() => jest.clearAllMocks());

describe('dismissUnmatchedAppellation', () => {
  test('stores under the queue group key — tier decoration folds off first', async () => {
    AppellationReviewSkip.findOneAndUpdate.mockResolvedValue(inserted());
    const res = await dismissUnmatchedAppellation({ name: 'Samos PDO', reason: 'covered by curated Samos', userId: USER });
    expect(res).toMatchObject({ key: 'samos', created: true });
    const [filter, update] = AppellationReviewSkip.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ normalizedKey: 'samos' });
    expect(update.$setOnInsert).toMatchObject({ normalizedKey: 'samos', name: 'Samos PDO', skippedBy: USER });
  });

  test('requires a real reason — it is the record of the judgement', async () => {
    expect((await dismissUnmatchedAppellation({ name: 'X Y', reason: 'no', userId: USER })).error).toMatch(/at least 5/);
    expect((await dismissUnmatchedAppellation({ name: 'X Y', reason: '<b>hi</b>', userId: USER })).error).toMatch(/at least 5/);
    expect((await dismissUnmatchedAppellation({ name: '', reason: 'long enough', userId: USER })).error).toMatch(/non-empty/);
    expect(AppellationReviewSkip.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('a racing second dismissal reports created:false and keeps the first reason ($setOnInsert)', async () => {
    AppellationReviewSkip.findOneAndUpdate.mockResolvedValue(existing());
    const res = await dismissUnmatchedAppellation({ name: 'Qualitätswein', reason: 'quality tier, not a place', userId: USER });
    expect(res.created).toBe(false);
    expect(AppellationReviewSkip.findOneAndUpdate.mock.calls[0][1]).toHaveProperty('$setOnInsert');
  });
});

describe('restoreDismissedAppellation', () => {
  test('deletes by the folded key and reports whether anything was lifted', async () => {
    AppellationReviewSkip.deleteOne.mockResolvedValueOnce({ deletedCount: 1 });
    expect(await restoreDismissedAppellation('Samos P.D.O.')).toEqual({ key: 'samos', restored: true });
    expect(AppellationReviewSkip.deleteOne).toHaveBeenCalledWith({ normalizedKey: 'samos' });

    AppellationReviewSkip.deleteOne.mockResolvedValueOnce({ deletedCount: 0 });
    expect((await restoreDismissedAppellation('Never Dismissed')).restored).toBe(false);
  });
});

describe('listDismissedAppellations', () => {
  test('maps rows newest-first with the dismisser resolved', async () => {
    const chain = {
      sort: jest.fn().mockReturnThis(),
      populate: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        { normalizedKey: 'qualitatswein', name: 'Qualitätswein', reason: 'quality tier', skippedBy: { username: 'johan' }, skippedAt: new Date('2026-08-18') },
        { normalizedKey: 'bare', skippedBy: null, skippedAt: new Date('2026-08-17') },
      ]),
    };
    AppellationReviewSkip.find.mockReturnValue(chain);
    const rows = await listDismissedAppellations();
    expect(chain.sort).toHaveBeenCalledWith({ skippedAt: -1 });
    expect(rows[0]).toMatchObject({ key: 'qualitatswein', name: 'Qualitätswein', dismissedBy: 'johan' });
    // A row with no display name falls back to its key; a missing user maps to null.
    expect(rows[1]).toMatchObject({ name: 'bare', dismissedBy: null, reason: null });
  });
});
