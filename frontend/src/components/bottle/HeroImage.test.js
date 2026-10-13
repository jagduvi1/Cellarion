import { render, screen } from '@testing-library/react';
import HeroImage from './HeroImage';

// Release audit 2026-10-13: a bottle still waiting on its wine request drew
// a blank label.
describe('HeroImage drawn bottle', () => {
  it('a bottle waiting on its wine request shows the requested name and producer', () => {
    const bottle = {
      vintage: '2020',
      pendingWineRequest: { wineName: 'Clos des Papes', producer: 'Paul Avril', hints: { type: 'White' } },
    };
    const { container } = render(<HeroImage bottle={bottle} wine={null} isPending displayName="Clos des Papes" />);
    const svg = screen.getByRole('img', { name: 'Clos des Papes' });
    expect(svg).toHaveClass('bottle-placeholder--white');
    const text = [...container.querySelectorAll('text')].map((t) => t.textContent).join(' ');
    expect(text).toContain('PAUL AVRIL');
    expect(text).toContain('Clos des Papes');
    expect(text).toContain('2020');
    expect(screen.getByText('Pending review')).toBeInTheDocument();
  });

  it('a wine from the registry wins over the request', () => {
    const bottle = { vintage: '2018', pendingWineRequest: { wineName: 'Old name', producer: 'Old' } };
    const wine = { name: 'Barolo Cannubi', producer: 'Brezza', type: 'red' };
    const { container } = render(<HeroImage bottle={bottle} wine={wine} displayName="Barolo Cannubi" />);
    const text = [...container.querySelectorAll('text')].map((t) => t.textContent).join(' ');
    expect(text).toContain('Barolo Cannubi');
    expect(text).not.toContain('Old name');
  });
});
