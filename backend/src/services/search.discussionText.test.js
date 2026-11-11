/**
 * The text a discussion is indexed with (services/search indexDiscussion).
 *
 * The forum index holds plain text: the body of the thread and the bodies of
 * its replies. A paragraph break, a line break or a list item must leave a
 * space behind, or the last word of one block and the first word of the next
 * are indexed as one word and neither can be found.
 */

jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ find: jest.fn() }));
jest.mock('../models/Discussion', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../models/DiscussionReply', () => ({ find: jest.fn() }));

const { Meilisearch } = require('meilisearch');
const Discussion = require('../models/Discussion');
const DiscussionReply = require('../models/DiscussionReply');

// Chainable like a Mongoose Query, awaitable to `value`.
const query = (value) => {
  const q = {
    populate: () => q, select: () => q, sort: () => q, lean: () => q,
    then: (res, rej) => Promise.resolve(value).then(res, rej),
  };
  return q;
};

let index;

beforeEach(() => {
  index = {
    updateSettings: jest.fn().mockResolvedValue({ taskUid: 1 }),
    getStats: jest.fn().mockResolvedValue({ numberOfDocuments: 1 }),
    addDocuments: jest.fn().mockResolvedValue({ taskUid: 2 }),
  };
  Meilisearch.mockImplementation(() => ({
    health: jest.fn().mockResolvedValue({ status: 'available' }),
    index: jest.fn(() => index),
    tasks: { waitForTasks: jest.fn() },
  }));
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test('a thread and its replies are indexed as text whose blocks stay apart', async () => {
  Discussion.findById.mockReturnValue(query({
    _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    title: 'What to pour with roast lamb',
    body: '<p>We are roasting <strong>lamb</strong></p><p>Rioja or a northern Rhône?</p>',
    category: 'food-pairing',
  }));
  DiscussionReply.find.mockReturnValue(query([
    { body: '<ul><li>Barolo</li><li>Barbaresco</li></ul>' },
    { body: 'Cornas<br>decanted' },
    { body: '<p></p>' },
  ]));

  let service;
  jest.isolateModules(() => { service = require('./search'); });
  await service.initialize({ sync: false });
  await service.indexDiscussion('aaaaaaaaaaaaaaaaaaaaaaaa');

  const [[documents]] = index.addDocuments.mock.calls;
  expect(documents).toHaveLength(1);
  expect(documents[0].body).toBe('We are roasting lamb Rioja or a northern Rhône?');
  // One reply per paragraph of the field; a reply with no text is left out.
  expect(documents[0].replyContent).toBe('Barolo Barbaresco\n\nCornas decanted');
});
