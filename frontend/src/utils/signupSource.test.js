/**
 * Where a visit came from, captured in memory for the signup's admin stats.
 *
 * WHY THIS TEST EXISTS:
 * The capture is the minimisation: a referrer must be reduced to its hostname,
 * a public link's token must never ride along in the landing page, and our own
 * site must not count as a source.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  captureSignupSource, getSignupSource, stashSignupSourceForSso, takeSsoSignupSource,
  __resetSignupSourceForTests,
} from './signupSource';

const loc = (href) => {
  const u = new URL(href);
  return { search: u.search, pathname: u.pathname, hostname: u.hostname };
};

beforeEach(() => {
  __resetSignupSourceForTests();
  sessionStorage.clear();
});

describe('captureSignupSource', () => {
  it('keeps the referrer hostname and campaign tags, nothing more', () => {
    captureSignupSource(
      loc('https://cellarion.app/?utm_source=Reddit&utm_medium=social&utm_campaign=launch&ref=x'),
      'https://www.reddit.com/r/wine/comments/abc/some_title/',
    );
    expect(getSignupSource()).toEqual({
      referrerDomain: 'reddit.com',
      utmSource: 'reddit',
      utmMedium: 'social',
      utmCampaign: 'launch',
      landingPage: '/',
    });
  });

  it('reduces the landing page to its first segment, so a list token never travels', () => {
    captureSignupSource(loc('https://cellarion.app/menu/secret-token-123'), '');
    expect(getSignupSource()).toEqual({ landingPage: '/menu' });
  });

  it('does not count our own site, subdomains included, as a referrer', () => {
    captureSignupSource(loc('https://cellarion.app/'), 'https://analytics.cellarion.app/websites');
    expect(getSignupSource()).not.toHaveProperty('referrerDomain');
  });

  it('keeps the first landing: later calls do not overwrite it', () => {
    captureSignupSource(loc('https://cellarion.app/blog'), 'https://news.ycombinator.com/item?id=1');
    captureSignupSource(loc('https://cellarion.app/login'), '');
    expect(getSignupSource()).toEqual({ referrerDomain: 'news.ycombinator.com', landingPage: '/blog' });
  });
});

describe('SSO round trip', () => {
  it('carries the source across the provider trip once, then forgets it', () => {
    captureSignupSource(loc('https://cellarion.app/?utm_source=newsletter'), '');
    stashSignupSourceForSso();
    expect(takeSsoSignupSource()).toEqual({ utmSource: 'newsletter', landingPage: '/' });
    expect(takeSsoSignupSource()).toBeNull();
  });

  it('answers null for a missing or tampered stash', () => {
    expect(takeSsoSignupSource()).toBeNull();
    sessionStorage.setItem('cellarion.signupSource', '["not", "an", "object"]');
    expect(takeSsoSignupSource()).toBeNull();
    sessionStorage.setItem('cellarion.signupSource', '{broken');
    expect(takeSsoSignupSource()).toBeNull();
  });
});
