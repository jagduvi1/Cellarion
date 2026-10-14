import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import useHandedOverState from './useHandedOverState';

// Read once, then taken off the history entry: Back, Forward or a reload must
// not hand the same notice over again (an Undo for a bottle already undone).

function Probe() {
  const [notice] = useHandedOverState('bottleNotice');
  return <p>{notice ? `notice:${notice.name}` : 'no notice'}</p>;
}

afterEach(() => window.history.replaceState(null, '', '/'));

test('the handed-over value is shown once and removed from the history entry', () => {
  window.history.replaceState({ usr: { bottleNotice: { name: 'Barolo 2016' }, other: 1 }, key: 'k1', idx: 0 }, '', '/cellars/c1?type=red');
  render(<BrowserRouter><Probe /></BrowserRouter>);

  expect(screen.getByText('notice:Barolo 2016')).toBeInTheDocument();
  expect(window.history.state.usr).toEqual({ other: 1 });
  expect(window.history.state.key).toBe('k1');
  // The URL itself is left alone (no navigation).
  expect(window.location.pathname + window.location.search).toBe('/cellars/c1?type=red');
});

test('nothing handed over: nothing shown, nothing touched', () => {
  window.history.replaceState({ usr: null, key: 'k2', idx: 0 }, '', '/cellars/c1');
  render(<BrowserRouter><Probe /></BrowserRouter>);
  expect(screen.getByText('no notice')).toBeInTheDocument();
  expect(window.history.state).toEqual({ usr: null, key: 'k2', idx: 0 });
});
