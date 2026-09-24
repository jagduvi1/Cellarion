import { indexSnapshot } from './offlineData';
import { queueableKind, buildOp, applyOp, applyPending, responseFor } from './offlineOps';

const C1 = 'c00000000000000000000001';
const C2 = 'c00000000000000000000002';
const R1 = 'a00000000000000000000001';
const R2 = 'a00000000000000000000002';
const b1 = 'b00000000000000000000001';
const b2 = 'b00000000000000000000002';
const b3 = 'b00000000000000000000003';
const b4 = 'b00000000000000000000004';

const SNAP = {
  schema: 1, generatedAt: '2026-09-24T12:00:00.000Z', userId: 'u1',
  cellars: [
    { _id: C1, name: 'Home', user: { _id: 'u1' }, userRole: 'owner' },
    { _id: C2, name: 'Shared', user: { _id: 'u9' }, userRole: 'viewer' },
  ],
  wines: { w1: { _id: 'w1', name: 'Barolo' } },
  bottles: [
    { _id: b1, cellar: C1, wineDefinition: 'w1', vintage: '2016', notes: 'old note', rating: 4, ratingScale: '5', price: 50 },
    { _id: b2, cellar: C1, wineDefinition: 'w1', vintage: '2017' },
    { _id: b3, cellar: C1, wineDefinition: 'w1', vintage: '2018' },
    { _id: b4, cellar: C2, wineDefinition: 'w1', vintage: '2019' },
  ],
  racks: [
    { _id: R1, cellar: C1, name: 'Wall', slots: [{ position: 1, bottle: b1 }, { position: 2, bottle: b2 }] },
    { _id: R2, cellar: C2, name: 'Theirs', slots: [] },
  ],
};
const idx = indexSnapshot(SNAP);
const NOW = new Date('2026-09-24T18:00:00.000Z');
const op = (url, method, body) => buildOp({ url, method, body, idx, id: 'k'.repeat(20), userId: 'u1', now: NOW });

describe('queueableKind', () => {
  it('recognises exactly the offline-capable writes', () => {
    expect(queueableKind(`/api/bottles/${b1}/consume`, 'POST')).toBe('consume');
    expect(queueableKind(`/api/bottles/${b1}/open`, 'POST')).toBe('open');
    expect(queueableKind(`/api/bottles/${b1}`, 'PUT')).toBe('edit');
    expect(queueableKind(`/api/racks/${R1}/slots/3`, 'PUT')).toBe('place');
    expect(queueableKind(`/api/racks/${R1}/slots/3`, 'DELETE')).toBe('clear');
    expect(queueableKind(`/api/racks/${R1}/slots/3/move`, 'POST')).toBe('move');
    for (const [u, m] of [[`/api/bottles/${b1}`, 'DELETE'], ['/api/bottles', 'POST'], [`/api/racks/${R1}`, 'PUT'], [`/api/bottles/${b1}/pour`, 'POST'], [`/api/bottles/${b1}`, 'GET']]) {
      expect(queueableKind(u, m)).toBeNull();
    }
  });
});

describe('buildOp', () => {
  it('consume: stamps when it happened and asks the server to consume only an active bottle', () => {
    const o = op(`/api/bottles/${b1}/consume`, 'POST', { reason: 'drank', rating: 5 });
    expect(o).toMatchObject({ kind: 'consume', bottleId: b1, cellarId: C1, status: 'pending', label: { wine: 'Barolo 2016' } });
    expect(o.body).toEqual({ reason: 'drank', rating: 5, consumedAt: '2026-09-24T17:59:55.000Z', ifActive: true });
  });

  it('consume keeps a date the user chose', () => {
    expect(op(`/api/bottles/${b1}/consume`, 'POST', { reason: 'drank', consumedAt: '2026-09-20' }).body.consumedAt).toBe('2026-09-20');
  });

  it('open: stamps when it was opened', () => {
    expect(op(`/api/bottles/${b1}/open`, 'POST', { preservationMethod: 'coravin' }).body)
      .toEqual({ preservationMethod: 'coravin', openedAt: '2026-09-24T17:59:55.000Z' });
  });

  it('edit: the whole edit form, changing only notes → only notes, with what the user saw', () => {
    const form = { notes: 'new note', rating: 4, ratingScale: '5', price: 50, vintage: '2016', purchaseDate: null };
    const o = op(`/api/bottles/${b1}`, 'PUT', form);
    expect(o.body).toEqual({ notes: 'new note', ifUnchanged: { notes: 'old note' } });
    expect(o.label.fields).toEqual(['notes']);
  });

  it('edit: a rating change sends rating (and a scale change sends the rating it resets)', () => {
    expect(op(`/api/bottles/${b1}`, 'PUT', { notes: 'old note', rating: 5, ratingScale: '5' }).body)
      .toEqual({ rating: 5, ifUnchanged: { rating: 4 } });
    expect(op(`/api/bottles/${b1}`, 'PUT', { rating: null, ratingScale: '100' }).body)
      .toEqual({ rating: null, ratingScale: '100', ifUnchanged: { rating: 4, ratingScale: '5' } });
  });

  it('edit: any other field changed → not queueable offline', () => {
    expect(op(`/api/bottles/${b1}`, 'PUT', { notes: 'x', price: 99 })).toBeNull();
    expect(op(`/api/bottles/${b1}`, 'PUT', { notes: 'old note' })).toBeNull(); // nothing changed
  });

  it('place / clear / move carry the slot occupants the user saw', () => {
    expect(op(`/api/racks/${R1}/slots/5`, 'PUT', { bottleId: b3 })).toMatchObject({
      kind: 'place', rackId: R1, position: 5, bottleId: b3, body: { bottleId: b3, expectOccupant: null },
      label: { rack: 'Wall', position: 5 },
    });
    expect(op(`/api/racks/${R1}/slots/2`, 'PUT', { bottleId: b3 }).body.expectOccupant).toBe(b2);
    expect(op(`/api/racks/${R1}/slots/1`, 'DELETE', null)).toMatchObject({ kind: 'clear', bottleId: b1, url: `/api/racks/${R1}/slots/1?expect=${b1}` });
    expect(op(`/api/racks/${R1}/slots/1/move`, 'POST', { toPosition: 2 }).body).toEqual({ toPosition: 2, expectFrom: b1, expectTo: b2 });
  });

  it('never for a viewer, an unknown bottle/rack, or an empty slot', () => {
    expect(op(`/api/bottles/${b4}/consume`, 'POST', {})).toBeNull();
    expect(op(`/api/racks/${R2}/slots/1`, 'PUT', { bottleId: b4 })).toBeNull();
    expect(op(`/api/bottles/${'f'.repeat(24)}/consume`, 'POST', {})).toBeNull();
    expect(op(`/api/racks/${R1}/slots/9`, 'DELETE', null)).toBeNull();
    expect(op(`/api/racks/${R1}/slots/9/move`, 'POST', { toPosition: 3 })).toBeNull();
  });
});

describe('applyOp — the device copy follows the server', () => {
  const after = (o) => indexSnapshot(applyOp(SNAP, o));

  it('consume takes the bottle out of the cellar and its rack', () => {
    const i = after(op(`/api/bottles/${b1}/consume`, 'POST', { reason: 'drank' }));
    expect(i.bottleById.has(b1)).toBe(false);
    expect(i.placement.has(b1)).toBe(false);
  });

  it('place moves the bottle there, displacing its old slot', () => {
    const i = after(op(`/api/racks/${R1}/slots/5`, 'PUT', { bottleId: b1 }));
    expect(i.placement.get(b1).position).toBe(5);
    expect(i.racksByCellar.get(C1)[0].slots.some((s) => s.position === 1)).toBe(false);
  });

  it('move to an occupied slot swaps, as the server does', () => {
    const i = after(op(`/api/racks/${R1}/slots/1/move`, 'POST', { toPosition: 2 }));
    expect(i.placement.get(b1).position).toBe(2);
    expect(i.placement.get(b2).position).toBe(1);
  });

  it('clear empties the slot; edit and open update the bottle', () => {
    expect(after(op(`/api/racks/${R1}/slots/1`, 'DELETE', null)).placement.has(b1)).toBe(false);
    expect(after(op(`/api/bottles/${b1}`, 'PUT', { notes: 'n2' })).bottleById.get(b1).notes).toBe('n2');
    expect(after(op(`/api/bottles/${b1}/open`, 'POST', { preservationMethod: 'coravin' })).bottleById.get(b1).preservationMethod).toBe('coravin');
  });

  it('does not touch the original snapshot', () => {
    applyOp(SNAP, op(`/api/bottles/${b1}/consume`, 'POST', {}));
    expect(SNAP.bottles).toHaveLength(4);
    expect(SNAP.racks[0].slots).toHaveLength(2);
  });

  it('applyPending applies only this user\'s pending ops, oldest first', () => {
    const first = { ...op(`/api/racks/${R1}/slots/5`, 'PUT', { bottleId: b3 }), createdAt: '2026-09-24T18:00:00Z' };
    const second = { ...op(`/api/racks/${R1}/slots/6`, 'PUT', { bottleId: b3 }), createdAt: '2026-09-24T18:01:00Z' };
    const refused = { ...op(`/api/bottles/${b2}/consume`, 'POST', {}), status: 'attention' };
    const someoneElse = { ...op(`/api/bottles/${b3}/consume`, 'POST', {}), userId: 'u2' };
    const i = indexSnapshot(applyPending(SNAP, [second, refused, someoneElse, first]));
    expect(i.placement.get(b3).position).toBe(6);
    expect(i.bottleById.has(b2)).toBe(true);
    expect(i.bottleById.has(b3)).toBe(true);
  });
});

describe('responseFor — what the page gets back', () => {
  it('consume → the bottle, consumed', () => {
    const o = op(`/api/bottles/${b1}/consume`, 'POST', { reason: 'gifted' });
    const r = responseFor(o, indexSnapshot(applyOp(SNAP, o)), idx);
    expect(r.bottle).toMatchObject({ _id: b1, status: 'gifted', consumedReason: 'gifted' });
  });
  it('slot ops → the rack with its bottles joined', () => {
    const o = op(`/api/racks/${R1}/slots/5`, 'PUT', { bottleId: b3 });
    const r = responseFor(o, indexSnapshot(applyOp(SNAP, o)), idx);
    expect(r.rack.slots.find((s) => s.position === 5).bottle).toMatchObject({ _id: b3, wineDefinition: { name: 'Barolo' } });
  });
});
