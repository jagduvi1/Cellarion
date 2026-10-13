import { render, screen } from '@testing-library/react';
import BottlePlaceholder, { clampLines, fitName, textEm, wrapWords } from './BottlePlaceholder';

// Beta feedback 2026-10-12: a wine with no photo showed a flat colour block.
describe('BottlePlaceholder', () => {
  const wine = { name: 'Erdener Prälat Riesling Spätlese', producer: 'Dr. Hermann', type: 'white' };

  it('draws a bottle in the wine\'s colour with the producer, name and vintage on its label', () => {
    const { container } = render(<BottlePlaceholder wine={wine} vintage="2022" />);
    const svg = screen.getByRole('img', { name: 'Dr. Hermann Erdener Prälat Riesling Spätlese 2022' });
    expect(svg).toHaveClass('bottle-placeholder', 'bottle-placeholder--white');
    const text = [...container.querySelectorAll('text')].map((t) => t.textContent);
    expect(text).toContain('DR. HERMANN');
    expect(text).toContain('2022');
    expect(text.join(' ')).toContain('Erdener Prälat Riesling Spätlese');
  });

  it('compact: no text and hidden from screen readers (the name sits beside it)', () => {
    const { container } = render(<BottlePlaceholder wine={wine} vintage="2022" compact />);
    expect(container.querySelectorAll('text')).toHaveLength(0);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('leaves out an unknown vintage and falls back to red glass for a wine without a type', () => {
    const { container } = render(<BottlePlaceholder wine={{ name: 'Rouge', producer: 'X' }} vintage="Unknown" />);
    expect(container.querySelector('svg')).toHaveClass('bottle-placeholder--red');
    expect([...container.querySelectorAll('text')].map((t) => t.textContent)).not.toContain('Unknown');
  });

  it('fitName: the largest size at which every word fits whole', () => {
    const short = fitName('Tabuérniga');
    expect(short.lines).toEqual(['Tabuérniga']);
    const long = fitName('Trittenheimer Apotheke Riesling Spätlese');
    expect(long.lines.join(' ')).toBe('Trittenheimer Apotheke Riesling Spätlese');
    expect(long.lines.every((l) => !l.includes('…'))).toBe(true);
    expect(long.size).toBeLessThan(short.size);
  });

  it('fitName: a name too long for the label ends in "…" within four lines', () => {
    const { lines } = fitName('Brauneberger Juffer-Sonnenuhr Riesling Trockenbeerenauslese Goldkapsel Versteigerungswein Lange');
    expect(lines.length).toBeLessThanOrEqual(4);
    expect(lines[lines.length - 1].endsWith('…')).toBe(true);
  });

  it('wrapWords: fills lines up to the width, breaking only a word wider than a line', () => {
    expect(wrapWords('a bb ccc dddd', 3)).toEqual(['a bb', 'ccc', 'dddd']);
    expect(wrapWords('abcdefghij', 3)).toEqual(['abcd-', 'efgh-', 'ij']);
    expect(wrapWords('', 3)).toEqual([]);
  });

  // Release audit 2026-10-13: names were measured in letters, so capitals and
  // Chinese, Japanese or Korean names ran off the label.
  it('measures capitals and CJK characters wider than lower-case letters', () => {
    expect(textEm('ABCD')).toBeGreaterThan(textEm('abcd'));
    expect(textEm('张裕解百')).toBeGreaterThan(textEm('ABCD'));
  });

  it('wrapWords: a CJK name, which has no spaces, breaks between characters without a hyphen', () => {
    expect(wrapWords('张裕解百纳干红葡萄酒', 4)).toEqual(['张裕解百', '纳干红葡', '萄酒']);
  });

  const LABEL_TEXT_W = 64;
  const fits = ({ size, lines }) => lines.every((l) => textEm(l) * size <= LABEL_TEXT_W);

  it.each([
    'Erdener Prälat Riesling Spätlese',
    'CHÂTEAU MOUTON ROTHSCHILD PAUILLAC PREMIER GRAND CRU CLASSÉ',
    '张裕解百纳干红葡萄酒',
    '山崎 シングルモルト ワイン 甲州',
    '샤또 마고 그랑 뱅',
    'Trockenbeerenauslese',
    'Brauneberger Juffer-Sonnenuhr Riesling Trockenbeerenauslese Goldkapsel Versteigerungswein Lange',
  ])('fitName: every line of "%s" fits the label', (name) => {
    const fitted = fitName(name);
    expect(fitted.lines.length).toBeGreaterThan(0);
    expect(fitted.lines.length).toBeLessThanOrEqual(4);
    expect(fits(fitted)).toBe(true);
  });

  it('fitName: a short CJK name stays at the largest size', () => {
    expect(fitName('张裕干红')).toEqual({ size: 12, lines: ['张裕干红'] });
  });

  it('clampLines: keeps the first lines and ends the last in "…" that still fits', () => {
    expect(clampLines(['a', 'b'], 2, 3)).toEqual(['a', 'b']);
    const out = clampLines(['abcd-', 'efgh-', 'ij'], 2, 3);
    expect(out).toEqual(['abcd-', 'efgh…']);
    expect(textEm(out[1])).toBeLessThanOrEqual(3);
  });

  it('a producer too long for two lines ends in "…", and the text is clipped to the label', () => {
    const { container } = render(
      <BottlePlaceholder
        wine={{ name: 'Rosso', producer: 'Azienda Agricola Fratelli Giacosa di Neive e Barbaresco Riserva' }}
        vintage="2019"
      />
    );
    const producer = [...container.querySelectorAll('.bottle-placeholder__producer')].map((t) => t.textContent);
    expect(producer).toHaveLength(2);
    expect(producer[1].endsWith('…')).toBe(true);
    expect(producer.every((l) => textEm(l) * 6.5 <= LABEL_TEXT_W)).toBe(true);

    const clip = container.querySelector('clipPath');
    expect(clip).not.toBeNull();
    expect(container.querySelector('.bottle-placeholder__text')).toHaveAttribute('clip-path', `url(#${clip.id})`);
  });

  it('two bottles on one page clip to their own labels', () => {
    const { container } = render(<><BottlePlaceholder wine={wine} /><BottlePlaceholder wine={wine} /></>);
    const ids = [...container.querySelectorAll('clipPath')].map((c) => c.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => /^[a-zA-Z0-9_-]+$/.test(id))).toBe(true);
  });
});
