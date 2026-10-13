import { render, screen, fireEvent } from '@testing-library/react';
import CollapsibleBlock, { CollapseToggle } from './CollapsibleBlock';

// The English text with its {{name}} filled in, as the app shows it.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, vars) => String(fallback).replace(/\{\{(\w+)\}\}/g, (_, k) => vars?.[k] ?? ''),
  }),
}));

// Beta feedback 2026-10-12: every block of the wine and vintage page folds.
describe('CollapsibleBlock', () => {
  const Card = () => (
    <div className="card">
      <div className="head"><h2>Tasting profile</h2></div>
      <p>The body</p>
    </div>
  );

  it('shows a fold button for a card, and folding is a class (the card stays mounted)', () => {
    const onToggle = vi.fn();
    const { container, rerender } = render(
      <CollapsibleBlock id="vintage.tasting" label="Tasting profile" collapsed={false} onToggle={onToggle}><Card /></CollapsibleBlock>
    );
    const button = screen.getByRole('button', { name: 'Hide Tasting profile' });
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(button).toHaveAttribute('aria-controls', 'cblock-vintage-tasting');
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(<CollapsibleBlock id="vintage.tasting" label="Tasting profile" collapsed onToggle={onToggle}><Card /></CollapsibleBlock>);
    expect(container.querySelector('.cblock')).toHaveClass('cblock--collapsed');
    expect(screen.getByRole('button', { name: 'Show Tasting profile' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('The body')).toBeInTheDocument();
  });

  it('shows no button while the card renders nothing', () => {
    render(<CollapsibleBlock id="vintage.reviews" label="Reviews" collapsed={false} onToggle={() => {}}>{null}</CollapsibleBlock>);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('nested: marks the block whose title row is one level down', () => {
    const { container } = render(
      <CollapsibleBlock nested id="vintage.record" label="Wine record" collapsed onToggle={() => {}}><Card /></CollapsibleBlock>
    );
    expect(container.querySelector('.cblock')).toHaveClass('cblock--nested', 'cblock--collapsed');
  });
});

describe('CollapseToggle', () => {
  it('names what it shows or hides', () => {
    const { rerender } = render(<CollapseToggle collapsed={false} onToggle={() => {}} label="Your bottles" controls="x" />);
    expect(screen.getByRole('button', { name: 'Hide Your bottles' })).toBeInTheDocument();
    rerender(<CollapseToggle collapsed onToggle={() => {}} label="Your bottles" controls="x" />);
    expect(screen.getByRole('button', { name: 'Show Your bottles' })).toBeInTheDocument();
  });
});
