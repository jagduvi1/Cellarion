import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import SearchInput from './SearchInput';

// A controlled host, like the cellar page: the value lives in the parent.
function Host({ initial = '' }) {
  const [value, setValue] = useState(initial);
  return <SearchInput value={value} onChange={setValue} placeholder="Search bottles" />;
}

describe('SearchInput', () => {
  test('no clear button while the field is empty', () => {
    render(<Host />);
    expect(screen.getByPlaceholderText('Search bottles')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  test('a remembered search shows the clear button, and one tap empties the field and refocuses it', () => {
    render(<Host initial="barolo" />);
    const input = screen.getByPlaceholderText('Search bottles');
    expect(input).toHaveValue('barolo');
    fireEvent.click(screen.getByRole('button'));
    expect(input).toHaveValue('');
    expect(input).toHaveFocus();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  test('typing reaches the parent; Escape clears', () => {
    render(<Host />);
    const input = screen.getByPlaceholderText('Search bottles');
    fireEvent.change(input, { target: { value: 'rioja' } });
    expect(input).toHaveValue('rioja');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input).toHaveValue('');
  });

  test('the field keeps its accessible name', () => {
    render(<Host />);
    expect(screen.getByRole('textbox', { name: 'Search bottles' })).toBeInTheDocument();
  });
});
