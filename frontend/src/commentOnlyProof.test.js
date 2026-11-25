// @vitest-environment node
// scripts/check-comment-only.mjs is the proof a comment-only pull request
// rests on: these cases pin what it must accept and what it must refuse.
// It runs here because esbuild, which it minifies with, is a frontend
// dependency, and in the node environment because esbuild refuses jsdom.
import { describe, test, expect } from 'vitest';
import { createRequire } from 'node:module';

// createRequire keeps the script outside Vite's transform pipeline.
const { difference } = createRequire(import.meta.url)('../../scripts/check-comment-only.mjs');

const card = (comment, local = 'alpha') => `
export function Card({ first, second, third }) {
  const ${local} = first + 1;
  const beta = second + 2;
  const gamma = third + 3;
  return (
    <div
      /* ${comment} */
      className="card"
    >
      {${local}}{beta}{gamma}
    </div>
  );
}
`;

describe('comment-only proof', () => {
  test('a reworded comment between the attributes of a JSX tag is not a code change', () => {
    // Enough of one letter to change which characters are the most frequent in the file.
    const before = card('q'.repeat(400));
    const after = card('z'.repeat(400));
    expect(difference('frontend/src/components/Card.js', before, after)).toBeNull();
  });

  test('a reworded line comment, block comment and JSX child comment are not code changes', () => {
    const file = (a, b, c) => `// ${a}\n/* ${b} */\nexport const View = () => <p>{/* ${c} */}text</p>;\n`;
    expect(difference('frontend/src/components/View.js', file('one', 'two', 'three'), file('uno', 'dos', 'tres'))).toBeNull();
  });

  test('a renamed local variable is a code change', () => {
    const why = difference('frontend/src/components/Card.js', card('same'), card('same', 'omega'));
    expect(why).toMatch(/code changed/);
  });

  test('a changed string is a code change', () => {
    const why = difference('backend/src/utils/x.js', "module.exports = 'a';\n", "module.exports = 'b';\n");
    expect(why).toMatch(/code changed/);
  });

  test('a removed pragma comment is refused although the code is the same', () => {
    const before = '// eslint-disable-next-line no-console\nconsole.log(1);\n';
    const after = '// prints one\nconsole.log(1);\n';
    expect(difference('backend/src/utils/x.js', before, after)).toMatch(/pragma/);
  });
});
