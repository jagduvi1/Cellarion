import { render, screen } from '@testing-library/react';
import BottlePlaceholder, { fitName, wrapWords } from './BottlePlaceholder';

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

  it('wrapWords: fills lines up to the width, cutting only a word longer than a line', () => {
    expect(wrapWords('a bb ccc dddd', 6)).toEqual(['a bb', 'ccc', 'dddd']);
    expect(wrapWords('abcdefghij', 6)).toEqual(['abcde…']);
    expect(wrapWords('', 6)).toEqual([]);
  });
});
