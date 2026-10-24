import { indexSnapshot } from './offlineData';
import { buildOp, applyOp, applyPending } from './offlineOps';

// A queued pour carries the glasses the user saw on the bottle (expectPours):
// the server records it only while the bottle still shows that many, so a pour
// that arrives after the server forgot its key is never added twice.
const C1 = 'c00000000000000000000001';
const b1 = 'b00000000000000000000001';
const b2 = 'b00000000000000000000002';
const b3 = 'b00000000000000000000003';
const glass = (ml = 125) => ({ at: '2026-09-24T17:00:00.000Z', ml });

const SNAP = {
  schema: 1, generatedAt: '2026-09-24T12:00:00.000Z', userId: 'u1',
  cellars: [{ _id: C1, name: 'Home', user: { _id: 'u1' }, userRole: 'owner' }],
  wines: { w1: { _id: 'w1', name: 'Barolo' } },
  bottles: [
    { _id: b1, cellar: C1, wineDefinition: 'w1', vintage: '2016', openedAt: '2026-09-24T16:00:00.000Z', preservationMethod: 'coravin', pours: [] },
    { _id: b2, cellar: C1, wineDefinition: 'w1', vintage: '2017', openedAt: '2026-09-24T16:00:00.000Z', preservationMethod: 'vacuum', pours: [glass(), glass(150)] },
    { _id: b3, cellar: C1, wineDefinition: 'w1', vintage: '2018' },
  ],
  racks: [],
};
const NOW = new Date('2026-09-24T18:00:00.000Z');
let n = 0;
const op = (snap, url, method, body, now = NOW) => buildOp({
  url, method, body, idx: indexSnapshot(snap), id: `k${(n += 1)}`, userId: 'u1', now,
});

describe('buildOp — pour', () => {
  it('a freshly opened bottle: expectPours 0, the glass size kept', () => {
    const p = op(SNAP, `/api/bottles/${b1}/pour`, 'POST', { ml: 150 });
    expect(p).toMatchObject({ kind: 'pour', bottleId: b1, method: 'POST', url: `/api/bottles/${b1}/pour` });
    expect(p.body).toEqual({ ml: 150, expectPours: 0 });
  });

  it('after n glasses on the device copy: expectPours n', () => {
    expect(op(SNAP, `/api/bottles/${b2}/pour`, 'POST', { ml: 125 }).body).toEqual({ ml: 125, expectPours: 2 });
  });

  it('glasses poured offline before count too, so the queue still sends them in a row', () => {
    const first = op(SNAP, `/api/bottles/${b2}/pour`, 'POST', { ml: 125 });
    const second = op(applyPending(SNAP, [first]), `/api/bottles/${b2}/pour`, 'POST', { ml: 125 }, new Date(NOW.getTime() + 60000));
    expect([first.body.expectPours, second.body.expectPours]).toEqual([2, 3]);
  });

  it('open then pour, both offline: the pour expects the fresh opening\'s empty log', () => {
    const opened = op(SNAP, `/api/bottles/${b3}/open`, 'POST', { preservationMethod: 'vacuum' });
    const p = op(applyPending(SNAP, [opened]), `/api/bottles/${b3}/pour`, 'POST', {}, new Date(NOW.getTime() + 60000));
    expect(p.body).toEqual({ expectPours: 0 });
  });

  it('the device copy still gets the glass, as before', () => {
    const p = op(SNAP, `/api/bottles/${b2}/pour`, 'POST', { ml: 100 });
    const after = indexSnapshot(applyOp(SNAP, p)).bottleById.get(b2).pours;
    expect(after).toHaveLength(3);
    expect(after[2]).toEqual({ at: p.createdAt, ml: 100 });
  });
});
