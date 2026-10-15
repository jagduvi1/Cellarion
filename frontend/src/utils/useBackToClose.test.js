import { useState } from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { BrowserRouter, Routes, Route, useNavigate, useNavigationType } from 'react-router-dom';
import { useBackToClose, resetBackToCloseForTests, suspendBackToClose } from './useBackToClose';

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
// The pop-up itself closes a task after the pop: wait for that too.
const back = async () => {
  await act(async () => {
    const popped = new Promise((r) => window.addEventListener('popstate', r, { once: true }));
    window.history.back();
    await popped;
    await new Promise((r) => setTimeout(r, 10));
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

test('a pop-up that closed by opening another page is skipped by Back from that page', async () => {
  // The menu-link case: the link opens a page and the pop-up closes with it.
  function Host() {
    const [open, setOpen] = useState(false);
    return (
      <div>
        <button type="button" onClick={() => setOpen(true)}>open</button>
        {open && (
          <Dialog name="menu" onClose={() => setOpen(false)}>
            <button
              type="button"
              onClick={() => {
                // What a router link does: a new entry, one page index on.
                window.history.pushState({ usr: null, key: 'next', idx: 1 }, '', '/bottles/b1');
                setOpen(false);
              }}
            >go</button>
          </Dialog>
        )}
      </div>
    );
  }
  render(<Host />);
  fireEvent.click(screen.getByText('open'));
  fireEvent.click(screen.getByText('go'));
  // The app moved on: the closed pop-up's entry stays under the new page.
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  expect(window.location.pathname).toBe('/bottles/b1');

  await back();
  // Back lands on that entry and goes straight on to the page itself.
  await waitFor(() => expect(window.history.state.cellarionDialog).toBeUndefined());
  expect(window.location.pathname).toBe('/cellars/c1');
  expect(window.history.state.key).toBe('page');
});

test('while another guard owns Back (the room with unsaved changes), pop-ups add no entry', () => {
  const resume = suspendBackToClose();
  render(<Page />);
  fireEvent.click(screen.getByText('open'));
  expect(screen.getByRole('dialog', { name: 'outer' })).toBeInTheDocument();
  expect(window.history.state.cellarionDialog).toBeUndefined();
  resume();
});

test('a pop-up that stays open on Back (it is busy) gets its entry back', async () => {
  function Busy() { useBackToClose(() => {}); return <div role="dialog" aria-label="busy" />; }
  render(<Busy />);
  await back();
  expect(screen.getByRole('dialog', { name: 'busy' })).toBeInTheDocument();
  // So the next Back is still the pop-up's, not the page's.
  await waitFor(() => expect(window.history.state.cellarionDialog).toBeTruthy());
});

test('an entry left by an earlier page load (reloaded with a pop-up open) is not taken for one of ours', async () => {
  window.history.replaceState({ usr: null, key: 'page', idx: 0, cellarionDialog: 'old.1' }, '');
  render(<Page />);
  fireEvent.click(screen.getByText('open'));
  await back();
  expect(screen.queryByRole('dialog')).toBeNull();
});

test("the room's own step off its unsaved-changes entry (after Save) does not close a pop-up", async () => {
  render(<Page />);
  fireEvent.click(screen.getByText('open'));
  // The room turns dirty: it takes Back and seeds its own entry.
  const resume = suspendBackToClose();
  window.history.pushState({ __roomUnsavedSentinel: true }, '');
  // Saved: it steps off that entry and hands Back back once the step landed.
  await act(async () => {
    const popped = new Promise((r) => window.addEventListener('popstate', r, { once: true }));
    window.addEventListener('popstate', resume, { once: true });
    window.history.back();
    await popped;
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  expect(screen.getByRole('dialog', { name: 'outer' })).toBeInTheDocument();
  // Back is the pop-up's again.
  await back();
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('a pop-up that drops its close while saving keeps its entry: Back does not leave the page', async () => {
  // Many pop-ups pass `onClose={busy ? undefined : close}`.
  function Saving() {
    const [busy, setBusy] = useState(false);
    const [open, setOpen] = useState(true);
    if (!open) return null;
    return (
      <Dialog name="form" onClose={busy ? undefined : () => setOpen(false)}>
        <button type="button" onClick={() => setBusy(true)}>save</button>
      </Dialog>
    );
  }
  render(<Saving />);
  const mark = window.history.state.cellarionDialog;
  expect(mark).toBeTruthy();
  fireEvent.click(screen.getByText('save'));
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  expect(window.history.state.cellarionDialog).toBe(mark);

  await back();
  expect(screen.getByRole('dialog', { name: 'form' })).toBeInTheDocument();
  await waitFor(() => expect(window.history.state.cellarionDialog).toBeTruthy());
});

test('Forward onto the entry of a pop-up that Back closed steps off it again', async () => {
  render(<Page />);
  fireEvent.click(screen.getByText('open'));
  await back();
  expect(screen.queryByRole('dialog')).toBeNull();
  await act(async () => {
    const popped = new Promise((r) => window.addEventListener('popstate', r, { once: true }));
    window.history.forward();
    await popped;
  });
  await waitFor(() => expect(window.history.state.cellarionDialog).toBeUndefined());
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('a pop-up whose close opens another page: that page is opened, not come back to', async () => {
  // The post-add "place it?" prompt closes by going to the cellar list, which
  // restores where it was left only when it is come back to.
  let arrivedBy;
  function Next() { arrivedBy = useNavigationType(); return <p>next page</p>; }
  function Home() {
    const navigate = useNavigate();
    return <Dialog name="prompt" onClose={() => navigate('/next')} />;
  }
  window.history.replaceState({ usr: null, key: 'page', idx: 0 }, '', '/home');
  render(
    <BrowserRouter>
      <Routes>
        <Route path="/home" element={<Home />} />
        <Route path="/next" element={<Next />} />
      </Routes>
    </BrowserRouter>,
  );
  await back();
  await screen.findByText('next page');
  expect(arrivedBy).toBe('PUSH');
});

test('a form shown inside its picker from the start: Back closes the form first', async () => {
  // Their effects push child first; the entries still follow render order.
  function Shell() {
    const [open, setOpen] = useState(true);
    const [form, setForm] = useState(true);
    if (!open) return null;
    return (
      <Dialog name="picker" onClose={() => setOpen(false)}>
        {form && <Dialog name="form" onClose={() => setForm(false)} />}
      </Dialog>
    );
  }
  render(<Shell />);
  await back();
  expect(screen.queryByRole('dialog', { name: 'form' })).toBeNull();
  expect(screen.getByRole('dialog', { name: 'picker' })).toBeInTheDocument();
  await back();
  expect(screen.queryByRole('dialog')).toBeNull();
});
