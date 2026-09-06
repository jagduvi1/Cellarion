import { isApiTarget } from './apiFetch';

// A self-hoster may point VITE_API_URL at another host; relative /api/ calls
// still go to the page origin (nginx proxies them), so BOTH origins are ours.
vi.mock('../api/apiConstants', () => ({
  API_URL: 'https://api.example.test',
  JSON_HEADERS: { 'Content-Type': 'application/json' },
}));

test('with VITE_API_URL set, the page origin and the API origin both count as ours', () => {
  expect(isApiTarget('/api/cellars')).toBe(true);
  expect(isApiTarget(`${window.location.origin}/api/cellars`)).toBe(true);
  expect(isApiTarget('https://api.example.test/api/cellars')).toBe(true);
  expect(isApiTarget('https://api.example.test/uploads/x')).toBe(false);
  expect(isApiTarget('https://evil.example/api/cellars')).toBe(false);
  expect(isApiTarget('//api.example.test.evil.example/api/cellars')).toBe(false);
});
