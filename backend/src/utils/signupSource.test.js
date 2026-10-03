/**
 * Signup source: what the browser may tell us about where a new account came
 * from, and how it is grouped for the admin stats.
 *
 * WHY THIS TEST EXISTS:
 * The payload is client-supplied and lands on the account row, so the
 * allow-list is the whole defence against it becoming free-form storage — and
 * the landing page must never carry a public link's token onto an account.
 */
const { sanitizeSignupSource, classifySignupSource } = require('./signupSource');

describe('sanitizeSignupSource', () => {
  it('keeps the allow-listed fields, lowercased and trimmed', () => {
    expect(sanitizeSignupSource({
      referrerDomain: ' WWW.Reddit.com ',
      utmSource: 'Reddit',
      utmMedium: 'social',
      utmCampaign: 'launch_2026',
      landingPage: '/menu',
    })).toEqual({
      referrerDomain: 'reddit.com',
      utmSource: 'reddit',
      utmMedium: 'social',
      utmCampaign: 'launch_2026',
      landingPage: '/menu',
    });
  });

  it('drops unknown fields and anything outside the character sets', () => {
    expect(sanitizeSignupSource({
      email: 'someone@example.com',
      referrerDomain: 'https://evil.example/path?q=1',
      utmSource: '<script>',
      landingPage: '/menu/secret-token',
    })).toEqual({});
  });

  it('caps every value so the field cannot be used as storage', () => {
    const out = sanitizeSignupSource({ utmCampaign: 'a'.repeat(500) });
    expect(out.utmCampaign).toHaveLength(100);
  });

  it('answers null for a payload that is not an object, {} for a direct visit', () => {
    expect(sanitizeSignupSource(undefined)).toBeNull();
    expect(sanitizeSignupSource('reddit')).toBeNull();
    expect(sanitizeSignupSource(['reddit'])).toBeNull();
    expect(sanitizeSignupSource({})).toEqual({});
  });
});

describe('classifySignupSource', () => {
  it.each([
    [null, 'unknown'],
    [{}, 'direct'],
    [{ landingPage: '/menu', referrerDomain: 'google.com' }, 'shared-list'],
    [{ utmSource: 'newsletter', referrerDomain: 'google.com' }, 'newsletter'],
    [{ utmSource: 'chatgpt.com' }, 'ai-assistant'],
    [{ utmSource: 'reddit' }, 'reddit'],
    [{ referrerDomain: 'old.reddit.com' }, 'reddit'],
    [{ referrerDomain: 'google.se' }, 'search'],
    [{ referrerDomain: 'google.co.uk' }, 'search'],
    [{ referrerDomain: 'duckduckgo.com' }, 'search'],
    [{ referrerDomain: 'gemini.google.com' }, 'ai-assistant'],
    [{ referrerDomain: 'chatgpt.com' }, 'ai-assistant'],
    [{ referrerDomain: 'claude.ai' }, 'ai-assistant'],
    [{ referrerDomain: 't.co' }, 'social'],
    [{ referrerDomain: 'news.ycombinator.com' }, 'hacker-news'],
    [{ referrerDomain: 'winesforum.example' }, 'other-site'],
    [{ referrerDomain: 'notgoogle.com' }, 'other-site'],
  ])('%j → %s', (src, channel) => {
    expect(classifySignupSource(src)).toBe(channel);
  });
});
