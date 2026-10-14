// The file's raw text (Vite's ?raw), not the parsed object — parsing is
// exactly what hides a duplicate.
import enRaw from './en/translation.json?raw';

// A key written twice in one object is legal JSON, and JSON.parse keeps the
// LAST copy without a word — so a new string added under a name that already
// exists further down is silently never shown (common.loadFailed, release
// audit 2026-10-14). Component tests mock t(), so only the raw text can tell.

// Every key path that occurs more than once in the same object.
function duplicateKeys(text) {
  const dupes = [];
  const stack = []; // { keys: Set, path: string[] } per open object, null per array
  let i = 0;
  let pendingKey = null;
  const readString = () => {
    let out = '';
    i += 1; // opening quote
    while (text[i] !== '"') {
      if (text[i] === '\\') { out += text[i] + text[i + 1]; i += 2; } else { out += text[i]; i += 1; }
    }
    i += 1; // closing quote
    return out;
  };
  while (i < text.length) {
    const c = text[i];
    if (c === '{') {
      const parent = stack[stack.length - 1];
      const path = parent ? [...parent.path, pendingKey ?? '[]'] : [];
      stack.push({ keys: new Set(), path, expectKey: true });
      pendingKey = null;
      i += 1;
    } else if (c === '[') {
      const parent = stack[stack.length - 1];
      stack.push({ keys: null, path: parent ? [...parent.path, pendingKey ?? '[]'] : [], expectKey: false });
      pendingKey = null;
      i += 1;
    } else if (c === '}' || c === ']') {
      stack.pop();
      i += 1;
    } else if (c === ',') {
      const top = stack[stack.length - 1];
      if (top && top.keys) top.expectKey = true;
      i += 1;
    } else if (c === '"') {
      const top = stack[stack.length - 1];
      const str = readString();
      if (top && top.keys && top.expectKey) {
        if (top.keys.has(str)) dupes.push([...top.path, str].join('.'));
        top.keys.add(str);
        top.expectKey = false;
        pendingKey = str;
      }
    } else {
      i += 1;
    }
  }
  return dupes;
}

test('the duplicate-key scanner finds a repeated key and nothing else', () => {
  expect(duplicateKeys('{"a":{"x":"1","y":"2","x":"3"},"b":["x","x"],"c":"x"}')).toEqual(['a.x']);
  expect(duplicateKeys('{"a":"say \\"hi\\"","b":"2"}')).toEqual([]);
});

test('en/translation.json has no key written twice in one object', () => {
  expect(enRaw.length).toBeGreaterThan(1000);
  expect(duplicateKeys(enRaw)).toEqual([]);
});
