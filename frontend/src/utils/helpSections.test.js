import { createRequire } from 'module';
import { SECTION_KEYS, sectionKeyFor } from './helpSections';

// The server keeps its own copy of the Help text (backend/src/data/
// helpContent.js): the "Go to" pages come from it, and the crawler page
// /og/help prints it. Both must list the sections the page lists — this
// test reads the real list on both sides, so neither can drift alone.
const { sections: server } = createRequire(import.meta.url)('../../../backend/src/data/helpContent.js');

test('every Help section has exactly one server section, and the server has no others', () => {
  for (const key of SECTION_KEYS) {
    expect(server.filter((s) => sectionKeyFor(s.id) === key), key).toHaveLength(1);
  }
  expect(server.map((s) => s.id).filter((id) => !sectionKeyFor(id))).toEqual([]);
});

test('a section key and its server id name the same section however they are spelled', () => {
  expect(sectionKeyFor('on-order')).toBe('onOrder');
  expect(sectionKeyFor('cellar-chat')).toBe('cellarChat');
  expect(sectionKeyFor('ON_ORDER')).toBe('onOrder');
  expect(sectionKeyFor('nothing-like-it')).toBeNull();
});
