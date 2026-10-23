/**
 * services/mailgun sendNewMemberCellarEmail / sendNewMemberEmptyEmail: the one
 * email a new member gets two days after joining (services/newMemberEmails).
 *
 * WHY THIS TEST EXISTS:
 * These go to people who have not come back, so they must stay plain service
 * emails: what is in their own cellar, a way back, an honest way out (the
 * delete-account link, equal to "add your first bottle" in the empty one), the
 * one-click unsubscribe, a Reply-To that reaches a person, and nothing that
 * asks for support or money. Names are user text and must be escaped.
 */
process.env.MAILGUN_API_KEY = 'key-test';
process.env.MAILGUN_DOMAIN = 'mg.test';
process.env.FRONTEND_URL = 'https://cellarion.test';
process.env.JWT_SECRET = 'test-secret';

const mockCreate = jest.fn(async () => ({ id: 'msg-1' }));
jest.mock('mailgun.js', () => jest.fn().mockImplementation(() => ({
  client: () => ({ messages: { create: (...args) => mockCreate(...args) } }),
})));

const { sendNewMemberCellarEmail, sendNewMemberEmptyEmail } = require('./mailgun');
const { verifyDeleteAccountToken } = require('../utils/accountDeletionLink');
const { verifyUnsubscribeToken } = require('../utils/unsubscribe');

const USER = '64b000000000000000000001';
beforeEach(() => { mockCreate.mockClear(); });
const sent = () => mockCreate.mock.calls[0][1];

// The delete link in a message must be a working one for THIS account.
function deleteTokenIn(body) {
  const m = body.match(/https:\/\/cellarion\.test\/delete-account\?token=([A-Za-z0-9_%-]+)/);
  return m ? verifyDeleteAccountToken(decodeURIComponent(m[1])) : null;
}
function unsubscribeTokenIn(body) {
  const m = body.match(/https:\/\/cellarion\.test\/api\/users\/unsubscribe\?token=([A-Za-z0-9_-]+)/);
  return m ? verifyUnsubscribeToken(m[1]) : null;
}

const NO_ASKING = /support(er|ing) cellarion|donat|subscri(be|ption) to|patron|benefactor|pay/i;

describe('"your cellar so far"', () => {
  const summary = {
    bottles: 23,
    readyCount: 6,
    readyWines: 4,
    ready: [
      { wine: 'Château Musar Rouge', vintage: 2008, count: 1 },
      { wine: 'Cloudy Bay Sauvignon Blanc', vintage: 2023, count: 3 },
      { wine: 'Bollinger Special Cuvée', vintage: 'NV', count: 1 },
    ],
    cellarPath: '/cellars/c1',
  };

  test('says what is in the cellar, what is ready now, and links back to it', async () => {
    await sendNewMemberCellarEmail('anna@example.com', 'Anna', USER, summary);
    const msg = sent();
    expect(msg.to).toEqual(['anna@example.com']);
    expect(msg.subject).toBe('Your Cellarion cellar so far: 23 bottles');
    expect(msg['h:Reply-To']).toBe('Cellarion <no-reply@mg.test>');
    expect(msg.text).toContain('You added 23 bottles to Cellarion a couple of days ago.');
    expect(msg.text).toContain('6 of them are ready to drink now, among them:');
    expect(msg.text).toContain('- Cloudy Bay Sauvignon Blanc 2023 (×3)');
    expect(msg.text).toContain('Open your cellar: https://cellarion.test/cellars/c1');
    expect(msg.text).toContain('choose Drink on it');
    expect(msg.html).toContain('href="https://cellarion.test/cellars/c1"');
    expect(msg.html).toContain('<li>Château Musar Rouge 2008</li>');
  });

  test('carries the once-only line, a working delete link and the unsubscribe link, in text and html', async () => {
    await sendNewMemberCellarEmail('anna@example.com', 'Anna', USER, summary);
    const msg = sent();
    expect(msg.text).toContain('You get this email once, two days after joining.');
    for (const body of [msg.text, msg.html]) {
      expect(deleteTokenIn(body)).toBe(USER);
      expect(unsubscribeTokenIn(body)).toBe(USER);
    }
  });

  test('"among them" only when the list leaves wines out; "All n" when every bottle is ready', async () => {
    const two = [{ wine: 'Cloudy Bay Sauvignon Blanc', vintage: 2023, count: 6 }, { wine: 'Château Margaux', vintage: 2018, count: 3 }];
    await sendNewMemberCellarEmail('a@example.com', 'Anna', USER, { bottles: 9, readyCount: 9, readyWines: 2, ready: two, cellarPath: '/cellars/c1' });
    expect(sent().text).toContain('All 9 are ready to drink now:');
    mockCreate.mockClear();
    await sendNewMemberCellarEmail('a@example.com', 'Anna', USER, { bottles: 12, readyCount: 9, readyWines: 2, ready: two, cellarPath: '/cellars/c1' });
    expect(sent().text).toContain('9 of them are ready to drink now:');
    expect(sent().text).not.toContain('among them');
  });

  test('with nothing ready (or no drink window known yet), never claims "not ready"', async () => {
    await sendNewMemberCellarEmail('anna@example.com', 'Anna', USER, { bottles: 1, readyCount: 0, ready: [], cellarPath: '/cellars/c1' });
    const msg = sent();
    expect(msg.subject).toBe('Your Cellarion cellar so far: 1 bottle');
    expect(msg.text).toContain('You added 1 bottle to Cellarion');
    expect(msg.text).toContain('Cellarion works out when it is at its best.');
    expect(msg.text).not.toMatch(/not ready|isn't ready|not at its best/i);
    expect(msg.html).not.toContain('<ul');
  });

  test('asks for nothing and escapes the name', async () => {
    await sendNewMemberCellarEmail('x@example.com', '<b>Eve</b>', USER, summary);
    const msg = sent();
    expect(msg.text).not.toMatch(NO_ASKING);
    expect(msg.html).not.toMatch(NO_ASKING);
    expect(msg.html).toContain('&lt;b&gt;Eve&lt;/b&gt;');
    expect(msg.html).not.toContain('<b>Eve</b>');
  });
});

describe('"your cellar is still empty"', () => {
  test('offers adding the first bottle and deleting the account as two plain choices', async () => {
    await sendNewMemberEmptyEmail('bo@example.com', 'Bo', USER);
    const msg = sent();
    expect(msg.subject).toBe('Your Cellarion cellar is still empty');
    expect(msg['h:Reply-To']).toBe('Cellarion <no-reply@mg.test>');
    expect(msg.text).toContain('scan a wine label with your phone');
    expect(msg.text).toContain('Add your first bottle: https://cellarion.test/cellars');
    expect(msg.text).toContain('Not for you? That is fine.');
    expect(msg.html).toContain('>Add your first bottle</a>');
    expect(msg.html).toContain('>Delete my account</a>');
    for (const body of [msg.text, msg.html]) {
      expect(deleteTokenIn(body)).toBe(USER);
      expect(unsubscribeTokenIn(body)).toBe(USER);
    }
    expect(msg.text).toContain('You get this email once, two days after joining.');
    expect(msg.text).not.toMatch(NO_ASKING);
    expect(msg.html).not.toMatch(NO_ASKING);
  });
});
