/**
 * createNotifications → SSE nudge (docs/ha-push-events.md §1).
 *
 * WHY THIS TEST EXISTS:
 * insertMany runs with { ordered: false }, which REJECTS after inserting the
 * valid rows when one row is bad. The SSE nudge must be emitted for every row
 * that actually landed (via the bulk-write error's insertedDocs) — otherwise
 * one malformed notification silently degrades every other recipient's push
 * to the 6-hour polling fallback.
 */

jest.mock('../models/Notification', () => ({ insertMany: jest.fn() }));
jest.mock('../models/PushSubscription', () => ({ find: jest.fn() }));
jest.mock('../models/User', () => ({ find: jest.fn() }));
jest.mock('./eventBus', () => ({ emit: jest.fn() }));

const Notification = require('../models/Notification');
const eventBus = require('./eventBus');
const { createNotifications } = require('./notifications');

beforeEach(() => jest.clearAllMocks());

const doc = (id, user, type) => ({ _id: { toString: () => id }, user, type });

describe('createNotifications SSE nudges', () => {
  test('every inserted notification emits one nudge to its recipient', async () => {
    Notification.insertMany.mockResolvedValue([
      doc('n1', 'u1', 'drink_window'),
      doc('n2', 'u2', 'community_reply'),
    ]);

    await createNotifications([
      { userId: 'u1', type: 'drink_window', title: 't', message: 'm' },
      { userId: 'u2', type: 'community_reply', title: 't', message: 'm' },
    ]);

    expect(eventBus.emit).toHaveBeenCalledWith('u1', 'notification', { id: 'n1', type: 'drink_window' });
    expect(eventBus.emit).toHaveBeenCalledWith('u2', 'notification', { id: 'n2', type: 'community_reply' });
  });

  test('partial insertMany failure still nudges the rows that DID insert', async () => {
    const err = new Error('E11000 partial failure');
    err.insertedDocs = [doc('n1', 'u1', 'drink_window')];
    Notification.insertMany.mockRejectedValue(err);

    await createNotifications([
      { userId: 'u1', type: 'drink_window', title: 't', message: 'm' },
      { userId: 'u2', type: 'bad-row', title: 't', message: 'm' },
    ]);

    expect(eventBus.emit).toHaveBeenCalledTimes(1);
    expect(eventBus.emit).toHaveBeenCalledWith('u1', 'notification', { id: 'n1', type: 'drink_window' });
  });

  test('total failure (no insertedDocs on the error) emits nothing and does not throw', async () => {
    Notification.insertMany.mockRejectedValue(new Error('connection lost'));
    await expect(createNotifications([
      { userId: 'u1', type: 'drink_window', title: 't', message: 'm' },
    ])).resolves.toBeUndefined();
    expect(eventBus.emit).not.toHaveBeenCalled();
  });
});
