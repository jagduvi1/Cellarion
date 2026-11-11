import { describe, test, expect } from 'vitest';
import { getRackHeight, clampToRoom } from './roomConstants';
import {
  DEFAULT_DIMENSIONS, dragRack, changeRoomDimension, rotateRacks, addRackToRoom, stackRackOnTarget,
  unstackRack, linkRackToTarget, unlinkRack, removeRacksFromRoom, setPlacementField, nudgeRacks,
  linkSelectedRacks, layoutForSave, autoLayoutFor, groupColors,
} from './roomLayoutOps';

// The room editor's layout changes: each takes a layout and what the user did,
// and gives the next layout, or the SAME object when nothing changes (that is
// how the page knows not to record an undo step).

const rack = (id) => ({ _id: id, name: id, type: 'grid', rows: 4, cols: 6, slots: [] });
const RACKS = [rack('a'), rack('b'), rack('c')];
const at = (id, x, z, extra = {}) => ({ rack: id, position: { x, y: 0, z }, rotation: 0, wall: 'none', ...extra });
const layoutOf = (...rackPlacements) => ({ cellar: 'c1', roomDimensions: { width: 10, depth: 10, height: 3 }, rackPlacements });
const placement = (layout, id) => layout.rackPlacements.find((rp) => (rp.rack?._id || rp.rack) === id);
const ROOM = { width: 10, depth: 10, height: 3 };

describe('dragRack', () => {
  test('the dragged rack lands where it was dropped; a rack that is neither grouped nor selected stays', () => {
    const prev = layoutOf(at('a', 0, 0), at('b', 1, 1));

    const next = dragRack(prev, { rackId: 'a', newPosition: { x: 2, y: 0, z: -1 }, currentSelected: ['a'], racks: RACKS });

    expect(placement(next, 'a').position).toEqual({ x: 2, y: 0, z: -1 });
    expect(placement(next, 'b')).toBe(placement(prev, 'b'));
  });

  test('its group and the other selected racks move by the same step', () => {
    const prev = layoutOf(at('a', 0, 0, { group: 'g1' }), at('b', 1, 1, { group: 'g1' }), at('c', -1, 2));

    const next = dragRack(prev, { rackId: 'a', newPosition: { x: 0.5, y: 0, z: 0.25 }, currentSelected: ['a', 'c'], racks: RACKS });

    expect(placement(next, 'b').position).toEqual({ x: 1.5, y: 0, z: 1.25 });
    expect(placement(next, 'c').position).toEqual({ x: -0.5, y: 0, z: 2.25 });
  });

  test('a rack carried along stops at the wall', () => {
    const prev = layoutOf(at('a', 0, 0, { group: 'g1' }), at('b', 4, 0, { group: 'g1' }));

    const next = dragRack(prev, { rackId: 'a', newPosition: { x: 3, y: 0, z: 0 }, currentSelected: ['a'], racks: RACKS });

    const inside = clampToRoom(7, 0, RACKS[1], placement(prev, 'b'), ROOM);
    expect(inside.x).toBeLessThan(7);
    expect(placement(next, 'b').position).toEqual({ x: inside.x, y: 0, z: inside.z });
  });

  test('a rack saved with its document instead of its id is found too; an unknown rack changes nothing', () => {
    const prev = layoutOf({ ...at('a', 0, 0), rack: { _id: 'a' } });

    expect(placement(dragRack(prev, { rackId: 'a', newPosition: { x: 1, y: 0, z: 1 }, currentSelected: [], racks: RACKS }), 'a').position)
      .toEqual({ x: 1, y: 0, z: 1 });
    expect(dragRack(prev, { rackId: 'zz', newPosition: { x: 1, y: 0, z: 1 }, currentSelected: [], racks: RACKS })).toBe(prev);
  });
});

describe('changeRoomDimension', () => {
  test('a dimension is held between 2 and 50 metres, the height at 10 at most', () => {
    const prev = layoutOf(at('a', 0, 0));
    const dims = (field, value) => changeRoomDimension(prev, { field, value, racks: RACKS }).roomDimensions;

    expect(dims('width', '12')).toEqual({ width: 12, depth: 10, height: 3 });
    expect(dims('width', 80).width).toBe(50);
    expect(dims('depth', 1).depth).toBe(2);
    expect(dims('height', 25).height).toBe(10);
    expect(dims('width', 'wide').width).toBe(2);
  });

  test('a rack the new walls would cut through is pulled inside; one that still fits is left as it is', () => {
    const prev = layoutOf(at('a', 4, 0), at('b', 0, 0));

    const next = changeRoomDimension(prev, { field: 'width', value: 4, racks: RACKS });

    const inside = clampToRoom(4, 0, RACKS[0], placement(prev, 'a'), { ...ROOM, width: 4 });
    expect(placement(next, 'a').position).toEqual({ x: inside.x, y: 0, z: inside.z });
    expect(placement(next, 'b')).toBe(placement(prev, 'b'));
  });
});

describe('rotateRacks', () => {
  test('one rack selected: it turns a quarter, and its group orbits it', () => {
    const prev = layoutOf(at('a', 1, 1, { group: 'g1', rotation: 270 }), at('b', 3, 1, { group: 'g1' }), at('c', 0, 0));

    const next = rotateRacks(prev, { selectedRackIds: ['a'] });

    expect(placement(next, 'a')).toMatchObject({ rotation: 0, position: { x: 1, y: 0, z: 1 } });
    // b was 2 m along x from the pivot: after the turn it is 2 m along z.
    expect(placement(next, 'b')).toMatchObject({ rotation: 90, position: { x: 1, y: 0, z: 3 } });
    expect(placement(next, 'c')).toBe(placement(prev, 'c'));
  });

  test('several selected: each turns in place', () => {
    const prev = layoutOf(at('a', 1, 1, { group: 'g1' }), at('b', 3, 1, { group: 'g1' }), at('c', 0, 0));

    const next = rotateRacks(prev, { selectedRackIds: ['a', 'c'] });

    expect(placement(next, 'a')).toMatchObject({ rotation: 90, position: { x: 1, y: 0, z: 1 } });
    expect(placement(next, 'c')).toMatchObject({ rotation: 90, position: { x: 0, y: 0, z: 0 } });
    expect(placement(next, 'b')).toBe(placement(prev, 'b'));
  });

  test('a selected rack that is not in the room changes nothing', () => {
    const prev = layoutOf(at('a', 0, 0));

    expect(rotateRacks(prev, { selectedRackIds: ['zz'] })).toBe(prev);
  });
});

describe('addRackToRoom', () => {
  test('a rack not placed yet goes to the centre of the room, against no wall', () => {
    const prev = layoutOf(at('a', 1, 1));

    const next = addRackToRoom(prev, { rackId: 'b' });

    expect(next.rackPlacements).toHaveLength(2);
    expect(placement(next, 'b')).toEqual({ rack: 'b', position: { x: 0, y: 0, z: 0 }, rotation: 0, wall: 'none' });
  });

  test('a rack already in the room changes nothing', () => {
    const prev = layoutOf(at('a', 1, 1));

    expect(addRackToRoom(prev, { rackId: 'a' })).toBe(prev);
  });
});

describe('stackRackOnTarget', () => {
  test('the selected rack takes the place and the turn of the target, one rack higher; its group follows', () => {
    const target = at('b', 2, 3, { rotation: 90 });
    const prev = layoutOf(at('a', 0, 0, { group: 'g1' }), target, at('c', 1, 0, { group: 'g1' }));
    const targetY = getRackHeight(RACKS[1]);

    const next = stackRackOnTarget(prev, {
      selectedRackId: 'a', targetPlacement: target, targetX: 2, targetY, targetZ: 3, group: 'g1', dx: 2, dy: targetY, dz: 3,
    });

    expect(placement(next, 'a')).toMatchObject({ position: { x: 2, y: targetY, z: 3 }, rotation: 90 });
    expect(placement(next, 'c').position).toEqual({ x: 3, y: targetY, z: 3 });
    expect(placement(next, 'b')).toBe(target);
  });
});

describe('unstackRack', () => {
  test('the selected rack goes back to the floor, with the group members at its height', () => {
    const prev = layoutOf(
      { ...at('a', 0, 0, { group: 'g1' }), position: { x: 0, y: 0.5, z: 0 } },
      { ...at('b', 1, 0, { group: 'g1' }), position: { x: 1, y: 0.5, z: 0 } },
      { ...at('c', 2, 0, { group: 'g1' }), position: { x: 2, y: 1.2, z: 0 } },
    );

    const next = unstackRack(prev, { selectedRackId: 'a' });

    expect(placement(next, 'a').position.y).toBe(0);
    expect(placement(next, 'b').position.y).toBe(0);
    expect(placement(next, 'c').position.y).toBe(1.2);
  });

  test('a rack on the floor, or not in the room, changes nothing', () => {
    const prev = layoutOf(at('a', 0, 0));

    expect(unstackRack(prev, { selectedRackId: 'a' })).toBe(prev);
    expect(unstackRack(prev, { selectedRackId: 'zz' })).toBe(prev);
  });
});

describe('linkRackToTarget', () => {
  test('two racks without a group get a new one', () => {
    const prev = layoutOf(at('a', 0, 0), at('b', 1, 0), at('c', 2, 0));

    const next = linkRackToTarget(prev, { selectedRackId: 'a', targetRackId: 'b' });

    expect(placement(next, 'a').group).toMatch(/^g[0-9a-z]+$/);
    expect(placement(next, 'b').group).toBe(placement(next, 'a').group);
    expect(placement(next, 'c').group).toBeUndefined();
  });

  test('the selected rack\'s group is kept, and the target\'s whole group joins it', () => {
    const prev = layoutOf(at('a', 0, 0, { group: 'g1' }), at('b', 1, 0, { group: 'g2' }), at('c', 2, 0, { group: 'g2' }));

    const next = linkRackToTarget(prev, { selectedRackId: 'a', targetRackId: 'b' });

    expect(next.rackPlacements.map((rp) => rp.group)).toEqual(['g1', 'g1', 'g1']);
  });

  test('a rack that is not in the room changes nothing', () => {
    const prev = layoutOf(at('a', 0, 0));

    expect(linkRackToTarget(prev, { selectedRackId: 'a', targetRackId: 'zz' })).toBe(prev);
  });
});

describe('unlinkRack and removeRacksFromRoom', () => {
  test('the selected rack leaves its group; the others keep it', () => {
    const prev = layoutOf(at('a', 0, 0, { group: 'g1' }), at('b', 1, 0, { group: 'g1' }));

    const next = unlinkRack(prev, { selectedRackId: 'a' });

    expect(placement(next, 'a').group).toBeNull();
    expect(placement(next, 'b').group).toBe('g1');
  });

  test('the racks in the set leave the layout', () => {
    const prev = layoutOf(at('a', 0, 0), at('b', 1, 0), { ...at('c', 2, 0), rack: { _id: 'c' } });

    const next = removeRacksFromRoom(prev, { removeSet: new Set(['a', 'c']) });

    expect(next.rackPlacements.map((rp) => rp.rack)).toEqual(['b']);
  });
});

describe('setPlacementField', () => {
  test('a value is stored as a number; an empty one clears the field', () => {
    const prev = layoutOf(at('a', 0, 0, { widthOverride: 1.2 }));
    const set = (value) => placement(setPlacementField(prev, { field: 'widthOverride', value, selectedRackId: 'a', racks: RACKS }), 'a');

    expect(set('0.8').widthOverride).toBe(0.8);
    expect(set('')).not.toHaveProperty('widthOverride');
    expect(set(null)).not.toHaveProperty('widthOverride');
    expect(set(undefined)).not.toHaveProperty('widthOverride');
  });

  test('a new scale lifts what stands on the rack by what the rack grew', () => {
    const height = getRackHeight(RACKS[0]);
    const prev = layoutOf(
      at('a', 0, 0),
      { ...at('b', 0, 0), position: { x: 0, y: height, z: 0 } },
      { ...at('c', 3, 0), position: { x: 3, y: 0.3, z: 0 } },
    );

    const next = setPlacementField(prev, { field: 'scaleOverride', value: 2, selectedRackId: 'a', racks: RACKS });

    expect(placement(next, 'a').scaleOverride).toBe(2);
    expect(placement(next, 'b').position.y).toBeCloseTo(height * 2, 6);
    expect(placement(next, 'c').position.y).toBe(0.3);
  });

  test('a rack that a wider shape pushes through the wall is pulled inside', () => {
    const edge = clampToRoom(99, 0, RACKS[0], at('a', 0, 0), ROOM).x;
    const prev = layoutOf(at('a', edge, 0));

    const next = setPlacementField(prev, { field: 'scaleOverride', value: 3, selectedRackId: 'a', racks: RACKS });

    const inside = clampToRoom(edge, 0, RACKS[0], { ...at('a', edge, 0), scaleOverride: 3 }, ROOM);
    expect(inside.x).toBeLessThan(edge);
    expect(placement(next, 'a').position.x).toBe(inside.x);
  });
});

describe('nudgeRacks', () => {
  test('the selected racks and their groups step along the 5 cm grid', () => {
    const prev = layoutOf(at('a', 0.02, 0, { group: 'g1' }), at('b', 1, 1, { group: 'g1' }), at('c', -1, 0));

    const next = nudgeRacks(prev, { selectedRackIds: ['a'], dx: 0.05, dz: 0, racks: RACKS });

    expect(placement(next, 'a').position).toEqual({ x: 0.05, y: 0, z: 0 });
    expect(placement(next, 'b').position).toEqual({ x: 1.05, y: 0, z: 1 });
    expect(placement(next, 'c')).toBe(placement(prev, 'c'));
  });

  test('a step into the wall stops there', () => {
    const edge = clampToRoom(99, 0, RACKS[0], at('a', 0, 0), ROOM).x;
    const prev = layoutOf(at('a', edge, 0));

    const next = nudgeRacks(prev, { selectedRackIds: ['a'], dx: 0.05, dz: 0, racks: RACKS });

    expect(placement(next, 'a').position.x).toBe(edge);
  });
});

describe('linkSelectedRacks', () => {
  test('a group one of them is in already takes them all, with the rest of that group', () => {
    const prev = layoutOf(at('a', 0, 0, { group: 'g1' }), at('b', 1, 0), at('c', 2, 0, { group: 'g1' }));

    const next = linkSelectedRacks(prev, { selectedRackIds: ['a', 'b'] });

    expect(next.rackPlacements.map((rp) => rp.group)).toEqual(['g1', 'g1', 'g1']);
  });

  test('with no group among them they get a new one; the others are left alone', () => {
    const prev = layoutOf(at('a', 0, 0), at('b', 1, 0), at('c', 2, 0));

    const next = linkSelectedRacks(prev, { selectedRackIds: ['a', 'b'] });

    expect(placement(next, 'a').group).toMatch(/^g[0-9a-z]+$/);
    expect(placement(next, 'b').group).toBe(placement(next, 'a').group);
    expect(placement(next, 'c')).toBe(placement(prev, 'c'));
  });
});

describe('layoutForSave', () => {
  test('a rack goes by its plain id, with only the fields the server knows', () => {
    const layout = layoutOf(
      { rack: { _id: 'a', name: 'Left wall' }, position: { x: 1, y: 0, z: 2 }, rotation: 90, wall: 'north', group: 'g1', widthOverride: 1.5, selected: true },
      { rack: 'b', position: { x: 0, y: 0, z: 0 } },
    );

    expect(layoutForSave(layout)).toEqual({
      roomDimensions: { width: 10, depth: 10, height: 3 },
      rackPlacements: [
        { rack: 'a', position: { x: 1, y: 0, z: 2 }, rotation: 90, wall: 'north', group: 'g1', widthOverride: 1.5 },
        { rack: 'b', position: { x: 0, y: 0, z: 0 }, rotation: 0, wall: 'none' },
      ],
    });
  });

  test('every number is held to the range the layout schema takes', () => {
    const layout = {
      roomDimensions: { width: 80, depth: 'deep', height: 1 },
      rackPlacements: [{
        rack: 'a', position: { x: 500, y: -40, z: 'far' },
        group: 'g'.repeat(80), widthOverride: 9, depthOverride: 0.01, scaleOverride: 12,
      }],
    };

    const sent = layoutForSave(layout);

    // A dimension that is not a number falls back to the default room.
    expect(sent.roomDimensions).toEqual({ width: 50, depth: 10, height: 2 });
    expect(sent.rackPlacements[0]).toEqual({
      rack: 'a', position: { x: 100, y: -10, z: 0 }, rotation: 0, wall: 'none',
      group: 'g'.repeat(50), widthOverride: 5, depthOverride: 0.1, scaleOverride: 5,
    });
  });
});

describe('autoLayoutFor', () => {
  test('the racks stand in a line along the north wall of the default room, each inside it', () => {
    const layout = autoLayoutFor('c1', RACKS);

    expect(layout.cellar).toBe('c1');
    expect(layout.roomDimensions).toBe(DEFAULT_DIMENSIONS);
    expect(layout.rackPlacements.map((rp) => rp.rack)).toEqual(['a', 'b', 'c']);
    layout.rackPlacements.forEach((rp, i) => {
      const inside = clampToRoom(-3 + i * 1.5, -3, RACKS[i], {}, DEFAULT_DIMENSIONS);
      expect(rp).toEqual({ rack: RACKS[i]._id, position: { x: inside.x, y: 0, z: inside.z }, rotation: 0, wall: 'north' });
    });
  });

  test('a cellar without racks gets an empty room', () => {
    expect(autoLayoutFor('c1', []).rackPlacements).toEqual([]);
  });
});

describe('groupColors', () => {
  test('each group gets a colour by the order it appears; the seventh starts over', () => {
    const groups = ['g1', 'g2', 'g1', 'g3', 'g4', 'g5', 'g6', 'g7'];
    const colors = groupColors(groups.map((group, i) => at(`r${i}`, i, 0, { group })));

    expect(Object.keys(colors)).toEqual(['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7']);
    expect(new Set(Object.values(colors).slice(0, 6)).size).toBe(6);
    expect(colors.g7).toBe(colors.g1);
  });

  test('racks without a group, and no layout at all, give no colours', () => {
    expect(groupColors([at('a', 0, 0), at('b', 1, 0, { group: null })])).toEqual({});
    expect(groupColors(undefined)).toEqual({});
  });
});

test('the room a cellar starts with', () => {
  expect(DEFAULT_DIMENSIONS).toEqual({ width: 10, depth: 10, height: 3 });
});
