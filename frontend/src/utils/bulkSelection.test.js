import { summarizeSelection, bottleLine } from './bulkSelection';

const wine = (id, name, producer) => ({ _id: id, name, producer });

describe('summarizeSelection', () => {
  const items = [
    { key: 'g1', count: 3, bottles: [
      { _id: 'b1', wineDefinition: wine('w1', 'Barolo', 'Azelia'), vintage: '2016', bottleSize: '750ml' },
      { _id: 'b2', wineDefinition: wine('w1', 'Barolo', 'Azelia'), vintage: '2016', bottleSize: '750ml' },
      { _id: 'b3', wineDefinition: wine('w1', 'Barolo', 'Azelia'), vintage: '2016', bottleSize: '750ml' },
    ] },
    { _id: 'b4', wineDefinition: wine('w2', 'Barbaresco', 'Gaja'), vintage: '2015', bottleSize: '1500ml' },
    { _id: 'b5', wineDefinition: null, pendingWineRequest: { wineName: 'Cuvée X', producer: 'Domaine Y' }, vintage: '', bottleSize: '750ml' },
    { _id: 'b6', wineDefinition: null, vintage: '2019' },
  ];

  test('groups only the selected bottles by wine, vintage and size, biggest first', () => {
    const out = summarizeSelection(items, new Set(['b1', 'b2', 'b4', 'b5', 'b6']), 'Unknown wine');
    expect(out).toEqual([
      { key: 'w1|2016|750ml', label: 'Azelia Barolo 2016', count: 2 },
      { key: 'w2|2015|1500ml', label: 'Gaja Barbaresco 2015 1500ml', count: 1 },
      { key: 'Cuvée X|NV|750ml', label: 'Domaine Y Cuvée X NV', count: 1 },
      { key: 'Unknown wine|2019|', label: 'Unknown wine 2019', count: 1 },
    ]);
  });

  test('nothing selected, nothing listed', () => {
    expect(summarizeSelection(items, new Set(), 'Unknown wine')).toEqual([]);
  });
});

describe('bottleLine', () => {
  test('leaves out the standard 750ml size and fills NV', () => {
    expect(bottleLine({ producer: 'Azelia', name: 'Barolo', vintage: '', bottleSize: '750ml' })).toBe('Azelia Barolo NV');
    expect(bottleLine({ producer: '', name: 'Barolo', vintage: '2016', bottleSize: '375ml' })).toBe('Barolo 2016 375ml');
  });
});
