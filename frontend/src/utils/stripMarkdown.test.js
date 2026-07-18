import { describe, it, expect } from 'vitest';
import stripMarkdown from './stripMarkdown';

describe('stripMarkdown', () => {
  it('returns empty string for falsy input', () => {
    expect(stripMarkdown('')).toBe('');
    expect(stripMarkdown(null)).toBe('');
    expect(stripMarkdown(undefined)).toBe('');
  });

  it('strips bold and italic markers, keeping the text', () => {
    expect(stripMarkdown('**Nebbiolo** is a *red* grape')).toBe('Nebbiolo is a red grape');
    expect(stripMarkdown('__bold__ and _italic_')).toBe('bold and italic');
  });

  it('strips heading markers and collapses newlines to spaces', () => {
    expect(stripMarkdown('## In the glass\nPale garnet.')).toBe('In the glass Pale garnet.');
  });

  it('reduces links to their text', () => {
    expect(stripMarkdown('see [the guide](/blog/x) now')).toBe('see the guide now');
  });

  it('strips list bullets, inline code and blockquotes', () => {
    expect(stripMarkdown('- one\n- two')).toBe('one two');
    expect(stripMarkdown('use `npx cellarion-mcp`')).toBe('use npx cellarion-mcp');
    expect(stripMarkdown('> a quote')).toBe('a quote');
  });

  it('flattens a realistic taxonomy description for a meta tag', () => {
    const md = '**Syrah** is a red grape from the Northern Rhône.\n\n**In the glass** — black pepper and dark fruit.';
    expect(stripMarkdown(md)).toBe(
      'Syrah is a red grape from the Northern Rhône. In the glass — black pepper and dark fruit.'
    );
  });
});
