/**
 * The analytics catalogue declares the label sweetness term once, as a
 * taxonomy dimension that GROUPS ("how many dry Rieslings") — a single ref,
 * unlike grapes and classifications (GitHub discussion #1754).
 */
const { STATIC_FIELDS, OPS_BY_TYPE } = require('./fieldCatalogue');

test('wine.labelSweetness is a groupable, filterable taxonomy dimension on SweetnessTerm', () => {
  const f = STATIC_FIELDS.find((x) => x.key === 'wine.labelSweetness');
  expect(f).toMatchObject({
    label: 'Label sweetness', domain: 'wine', type: 'text', source: 'taxonomy', path: 'wd.labelSweetness',
    taxonomyModel: 'SweetnessTerm', taxonomyCollection: 'sweetnessterms', role: 'dimension',
    groupable: true, filterable: true, sortable: true,
  });
  expect(OPS_BY_TYPE.text).toEqual(['contains', 'eq', 'neq']);
});

test('no field claims the band yet — that needs a lookup the engine does not do', () => {
  expect(STATIC_FIELDS.find((x) => x.key === 'wine.sweetnessBand')).toBeUndefined();
});
