import { useState } from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { useBackToClose, resetBackToCloseForTests } from './useBackToClose';

// The phone's Back (history.back) closes the open pop-up instead of leaving
// the page — in the Android app it used to leave the page, and a half-filled
// form with it (live walkthrough 2026-10-15).

function Dialog({ name, onClose, children }) {
  useBackToClose(onClose);
  return <div role="dialog" aria-label={name}>{children}</div>;
}

function Page() {
  const [outer, setOuter] = useState(false);
  const [inner, setInner] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOuter(true)}>open</button>
      {outer && (
        <Dialog name="outer" onClose={() => setOuter(false)}>
          <button type="button" onClick={() => setOuter(false)}>cancel</button>
          <button type="button" onClick={() => setInner(true)}>open inner</button>
          {inner && <Dialog name="inner" onClose={() => setInner(false)} />}
        </Dialog>
      )}
    </div>
  );
}

// jsdom moves through history asynchronously, like a browser: wait for the
// pop itself rather than a fixed time.
const back = async () => {
  await act(async () => {
    const popped = new Promise((r) => window.addEventListener('popstate', r, { once: true }));
    window.history.back();
    await popped;
  });
};

beforeEach(() => {
  resetBackToCloseForTests();
  window.history.replaceState({ usr: null, key: 'page', idx: 0 }, '', '/cellars/c1');
});

test('Back closes the open pop-up and stays on the page', async () => {
  render(<Page />);
  const before = window.history.length;
  fireEvent.click(screen.getByText('open'));
  expect(screen.getByRole('dialog', { name: 'outer' })).toBeInTheDocument();
  expect(window.history.length).toBe(before + 1);
  // The entry keeps the router's state: same page, only a mark added.
  expect(window.history.state.key).toBe('page');

  await back();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(window.location.pathname).toBe('/cellars/c1');
  expect(window.history.state.key).toBe('page');
});

test('closing it another way takes its entry off again', async () => {
  render(<Page />);
  fireEvent.click(screen.getByText('open'));
  expect(window.history.state.cellarionDialog).toBeTruthy();
  fireEvent.click(screen.getByText('cancel'));
  expect(screen.queryByRole('dialog')).toBeNull();
  // Back on the page's own entry: the next Back leaves the page, as before.
  await waitFor(() => expect(window.history.state.cellarionDialog).toBeUndefined());
  expect(window.history.state.key).toBe('page');
});

test('with a pop-up open inside another, Back closes only the newest', async () => {
  render(<Page />);
  fireEvent.click(screen.getByText('open'));
  fireEvent.click(screen.getByText('open inner'));
  expect(screen.getByRole('dialog', { name: 'inner' })).toBeInTheDocument();

  await back();
  expect(screen.queryByRole('dialog', { name: 'inner' })).toBeNull();
  expect(screen.getByRole('dialog', { name: 'outer' })).toBeInTheDocument();

  await back();
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('a pop-up that cannot be dismissed adds nothing', () => {
  function Blocking() { useBackToClose(undefined); return <div role="dialog" />; }
  const before = window.history.length;
  render(<Blocking />);
  expect(window.history.length).toBe(before);
});

test('a pop-up opened right after another closed is not closed by that one taking its entry off', async () => {
  render(<Page />);
  fireEvent.click(screen.getByText('open'));
  fireEvent.click(screen.getByText('cancel'));
  // Let the closed one's entry removal start (history.back is on its way)…
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  // …and open a pop-up again before it has landed.
  fireEvent.click(screen.getByText('open'));
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  expect(screen.getByRole('dialog', { name: 'outer' })).toBeInTheDocument();
});

test('a pop-up shown inside another that both close at once leave no extra Back step', async () => {
  // The cellar list's "Drink one": a picker shell with the drink form inside.
  function Nested({ onClose }) {
    useBackToClose(onClose);
    return <Dialog name="form" onClose={onClose}><button type="button" onClick={onClose}>form cancel</button></Dialog>;
  }
  function Host() {
    const [open, setOpen] = useState(false);
    return (
      <div>
        <button type="button" onClick={() => setOpen(true)}>drink</button>
        {open && <Nested onClose={() => setOpen(false)} />}
      </div>
    );
  }
  render(<Host />);
  const before = window.history.length;
  fireEvent.click(screen.getByText('drink'));
  expect(window.history.length).toBe(before + 2);
  fireEvent.click(screen.getByText('form cancel'));
  // Both entries go in one step: the page's own entry is current again.
  await waitFor(() => expect(window.history.state.cellarionDialog).toBeUndefined());
  expect(window.history.state.key).toBe('page');
});
