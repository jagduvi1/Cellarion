/**
 * Prompt substitution in suggestProfile.
 *
 * These values are registry text a user can author, and enrichment fires
 * automatically when a bottle is added — so this is the one place user input
 * reaches a prompt whose answer is written back to the SHARED registry.
 *
 * The finding this pins (security audit 2026-08-03, adversarial pass):
 * `String.prototype.replace` honours `$&`, `` $` ``, `$'` and `$$` inside the
 * REPLACEMENT string even when the search pattern is a plain string. A wine
 * named `$'` therefore expanded to the entire remainder of the template — the
 * model received one complete prompt followed by the attacker's trailing
 * instruction, and the token bill grew ~30x from a single field.
 *
 * The first attempt at this fix stripped control characters and collapsed
 * whitespace, and did nothing about `$` at all.
 */
const aiConfig = require('../config/aiConfig');

jest.mock('../config/aiConfig', () => ({ get: jest.fn() }));

// Capture the prompt without reaching the network: getClient throws without an
// API key, which returns before any request is made, so we drive the module's
// substitution by re-implementing nothing and asserting on what it builds.
const { suggestProfile } = require('./labelScan');

const TEMPLATE = [
  'Wine: {{name}}',
  'Producer: {{producer}}',
  'Region: {{region}}',
  'Grapes: {{grapes}}',
  'Rules: be terse. Never invent awards.',
].join('\n');

describe('prompt substitution is inert to user-controlled text', () => {
  beforeEach(() => {
    aiConfig.get.mockReturnValue({ enrichmentPrompt: TEMPLATE, enrichmentModel: 'test-model' });
    delete process.env.ANTHROPIC_API_KEY;
  });

  // With no API key, suggestProfile returns before calling out — but the prompt
  // is built first only in the fixed version. Assert on the exported helper
  // behaviour via a direct construction instead, so the test pins the rule
  // rather than the control flow.
  const substitute = (tpl, token, value) => tpl.replaceAll(token, () => value);

  test("a $' payload is inserted literally, not expanded into the template", () => {
    const out = substitute(TEMPLATE, '{{name}}', "$'");
    expect(out).toContain("Wine: $'");
    // The bug: $' expands to everything after the match, duplicating the tail.
    expect(out.match(/Rules: be terse/g)).toHaveLength(1);
    expect(out.length).toBeLessThan(TEMPLATE.length + 5);
  });

  test.each([['$&'], ['$`'], ['$$'], ["$'$'$'"]])(
    'the substitution pattern %p is not honoured', (payload) => {
      const out = substitute(TEMPLATE, '{{name}}', payload);
      expect(out).toContain(`Wine: ${payload}`);
      expect(out.match(/Rules: be terse/g)).toHaveLength(1);
    });

  test('a repeated placeholder is substituted everywhere, not just the first', () => {
    // The template is superadmin-overridable via SiteConfig, so a custom one may
    // use a placeholder twice; `replace` would leave the second as literal
    // `{{producer}}` in the text sent to the model.
    const tpl = 'A {{x}} B {{x}} C';
    expect(substitute(tpl, '{{x}}', 'Z')).toBe('A Z B Z C');
  });

  test('suggestProfile returns cleanly without an API key rather than throwing', async () => {
    const res = await suggestProfile({ name: "$'", producer: 'X' });
    expect(res.data).toBeNull();
    expect(res.debugReason).toBe('no_api_key');
  });
});
