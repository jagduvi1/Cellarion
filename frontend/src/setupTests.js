// jest-dom adds custom jest matchers for asserting on DOM nodes.
// allows you to do things like:
// expect(element).toHaveTextContent(/react/i)
// learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom';

// Every test starts with empty web storage: jsdom keeps it for a whole file, so
// a value one test leaves behind (a remembered choice, a stash) would decide
// how the next test's screen opens. Guarded: on Node 25 the global storage has
// no working methods unless a test stubs it.
afterEach(() => {
  try { window.localStorage.clear(); } catch { /* no working storage */ }
  try { window.sessionStorage.clear(); } catch { /* no working storage */ }
});
