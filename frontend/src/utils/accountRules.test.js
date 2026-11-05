// @vitest-environment node
// The register form checks the email the way the server will, so the server's
// English refusal ("Please enter a valid email") is never what a person sees.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EMAIL_RULE } from './accountRules';

const USER_MODEL = fileURLToPath(new URL('../../../backend/src/models/User.js', import.meta.url));

test('takes a whole address and refuses what the browser lets through', () => {
  expect(EMAIL_RULE.test('anna@example.com')).toBe(true);
  expect(EMAIL_RULE.test('anna.berg+wine@mail.example.co.uk')).toBe(true);
  expect(EMAIL_RULE.test('anna@example')).toBe(false);
  expect(EMAIL_RULE.test('anna example@example.com')).toBe(false);
});

test('is the same pattern as the server model', () => {
  const source = readFileSync(USER_MODEL, 'utf8');
  const match = source.match(/match:\s*\[\/(.+?)\/,\s*'Please enter a valid email'\]/);
  expect(match).not.toBeNull();
  expect(match[1]).toBe(EMAIL_RULE.source);
});
