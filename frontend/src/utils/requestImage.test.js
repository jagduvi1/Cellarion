import { fitDataUrl } from './requestImage';

// A fake renderer: the size of the output shrinks with quality and edge, the
// way a real encoder's does; `webp` toggles whether the browser can encode WebP.
const fakeRender = ({ webp = true, base = 900000 } = {}) => {
  const calls = [];
  const render = async (edge, type, quality) => {
    calls.push([edge, type, quality]);
    if (type === 'image/webp' && !webp) return 'data:image/png;base64,' + 'A'.repeat(base); // no WebP encoder
    const factor = (type === 'image/webp' ? 0.35 : 0.6) * quality * (edge / 900) * (edge / 900);
    return `data:${type};base64,` + 'A'.repeat(Math.round(base * factor));
  };
  return { render, calls };
};

describe('fitDataUrl', () => {
  test('a WebP at full size and the first quality wins when it fits', async () => {
    const { render, calls } = fakeRender();
    const out = await fitDataUrl(render, { maxChars: 480000 });
    expect(out.startsWith('data:image/webp;')).toBe(true);
    expect(calls).toEqual([[900, 'image/webp', 0.85]]);
  });

  test('quality steps down, then the size, until something fits under the cap', async () => {
    const { render, calls } = fakeRender({ base: 3000000 });
    const out = await fitDataUrl(render, { maxChars: 480000 });
    expect(out.length).toBeLessThanOrEqual(480000);
    expect(calls.length).toBeGreaterThan(1);
  });

  test('a browser without a WebP encoder falls back to JPEG instead of sending PNG', async () => {
    const { render } = fakeRender({ webp: false });
    const out = await fitDataUrl(render, { maxChars: 480000 });
    expect(out.startsWith('data:image/jpeg;')).toBe(true);
  });

  test('nothing fits: null, so the form can say so instead of sending an oversized photo', async () => {
    const render = async (edge, type) => `data:${type};base64,` + 'A'.repeat(600000);
    expect(await fitDataUrl(render, { maxChars: 480000 })).toBeNull();
  });
});
