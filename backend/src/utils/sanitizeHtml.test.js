const { sanitizeForumHtml, visibleTextLength, sanitizeBlogHtml, extractFaqFromHtml, extractHowToFromHtml, ALLOWED_TAGS } = require('./sanitizeHtml');

describe('sanitizeForumHtml', () => {
  test('returns empty string for non-string input', () => {
    expect(sanitizeForumHtml(null)).toBe('');
    expect(sanitizeForumHtml(undefined)).toBe('');
    expect(sanitizeForumHtml(42)).toBe('');
    expect(sanitizeForumHtml({})).toBe('');
  });

  test('preserves all whitelisted tags', () => {
    const input = '<p>plain</p><p><strong>bold</strong> <em>italic</em> <s>strike</s> <u>underline</u></p>';
    const out = sanitizeForumHtml(input);
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<em>italic</em>');
    expect(out).toContain('<s>strike</s>');
    expect(out).toContain('<u>underline</u>');
  });

  test('preserves blockquote and list structure', () => {
    const input = '<blockquote><p>quoted</p></blockquote><ul><li>one</li><li>two</li></ul><ol><li>first</li></ol>';
    const out = sanitizeForumHtml(input);
    expect(out).toContain('<blockquote>');
    expect(out).toContain('<ul>');
    expect(out).toContain('<ol>');
    expect(out).toContain('<li>one</li>');
  });

  // ── XSS payloads ───────────────────────────────────────────────────────────

  test('strips <script> tags entirely', () => {
    const input = '<p>hi</p><script>alert(1)</script>';
    expect(sanitizeForumHtml(input)).toBe('<p>hi</p>');
  });

  test('strips inline event handlers (onclick, onerror, onload)', () => {
    const input = '<p onclick="alert(1)">hi</p>';
    const out = sanitizeForumHtml(input);
    expect(out).not.toContain('onclick');
    expect(out).toContain('hi');
  });

  test('strips style attributes (no CSS-based exfil/cover attacks)', () => {
    const input = '<p style="position:fixed;left:0;top:0;width:100vw;height:100vh">x</p>';
    const out = sanitizeForumHtml(input);
    expect(out).not.toContain('style');
  });

  test('strips class and id attributes', () => {
    const input = '<p class="evil" id="x">hi</p>';
    const out = sanitizeForumHtml(input);
    expect(out).not.toContain('class');
    expect(out).not.toContain('id="x"');
  });

  test('strips <iframe>, <img>, <video>, <object>, <embed>', () => {
    const input = '<iframe src="//evil"></iframe><img src=x onerror=alert(1)><video><source src="x"></video><object data="x"></object><embed src="x">';
    const out = sanitizeForumHtml(input);
    expect(out).not.toContain('<iframe');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<video');
    expect(out).not.toContain('<object');
    expect(out).not.toContain('<embed');
  });

  test('strips <a> with javascript: scheme (and other non-http schemes)', () => {
    expect(sanitizeForumHtml('<a href="javascript:alert(1)">click</a>')).not.toContain('javascript');
    expect(sanitizeForumHtml('<a href="data:text/html,<script>alert(1)</script>">x</a>')).not.toContain('data:');
    expect(sanitizeForumHtml('<a href="vbscript:msgbox(1)">x</a>')).not.toContain('vbscript');
  });

  test('keeps <a> with http, https, and mailto schemes', () => {
    expect(sanitizeForumHtml('<a href="https://example.com">x</a>')).toContain('href="https://example.com"');
    expect(sanitizeForumHtml('<a href="http://example.com">x</a>')).toContain('href="http://example.com"');
    expect(sanitizeForumHtml('<a href="mailto:a@b.c">x</a>')).toContain('mailto:a@b.c');
  });

  test('forces target=_blank and rel=noopener noreferrer nofollow on links', () => {
    const out = sanitizeForumHtml('<a href="https://example.com">x</a>');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
  });

  test('does not allow span, div, or other layout tags', () => {
    expect(sanitizeForumHtml('<div><span>hello</span></div>')).toBe('hello');
    expect(sanitizeForumHtml('<table><tr><td>x</td></tr></table>')).toBe('x');
    expect(sanitizeForumHtml('<form><input value=x></form>')).toBe('');
  });

  test('strips data attributes (forward-compat: future custom nodes use sanitize-html opts to allow)', () => {
    const out = sanitizeForumHtml('<a href="https://x.com" data-tracking="evil">x</a>');
    expect(out).not.toContain('data-tracking');
  });

  test('keeps <br> for soft line breaks', () => {
    expect(sanitizeForumHtml('line1<br>line2')).toContain('<br');
  });

  test('exposes the allowlist for documentation and frontend mirroring', () => {
    expect(ALLOWED_TAGS).toContain('p');
    expect(ALLOWED_TAGS).toContain('a');
    expect(ALLOWED_TAGS).not.toContain('script');
    expect(ALLOWED_TAGS).not.toContain('iframe');
  });
});

describe('visibleTextLength', () => {
  test('returns 0 for non-string input', () => {
    expect(visibleTextLength(null)).toBe(0);
    expect(visibleTextLength(undefined)).toBe(0);
    expect(visibleTextLength(42)).toBe(0);
  });

  test('counts only visible characters, not HTML tags', () => {
    expect(visibleTextLength('<p>Hello</p>')).toBe(5);
    expect(visibleTextLength('<p><strong>Hi</strong></p>')).toBe(2);
  });

  test('collapses whitespace so a wall of <br> does not inflate the count', () => {
    expect(visibleTextLength('Hello<br><br><br>world')).toBe(11); // "Hello world"
  });

  test('handles empty content', () => {
    expect(visibleTextLength('')).toBe(0);
    expect(visibleTextLength('<p></p>')).toBe(0);
    expect(visibleTextLength('<p>   </p>')).toBe(0);
  });
});

describe('sanitizeBlogHtml', () => {
  test('returns empty string for non-string input', () => {
    expect(sanitizeBlogHtml(null)).toBe('');
    expect(sanitizeBlogHtml(undefined)).toBe('');
    expect(sanitizeBlogHtml(42)).toBe('');
  });

  test('preserves heading structure (h2/h3/h4) — the whole point of the fix', () => {
    const out = sanitizeBlogHtml('<h2>Storage</h2><h3>Temperature</h3><h4>Detail</h4>');
    expect(out).toContain('<h2>Storage</h2>');
    expect(out).toContain('<h3>Temperature</h3>');
    expect(out).toContain('<h4>Detail</h4>');
  });

  test('preserves lists, blockquotes, and inline formatting', () => {
    const out = sanitizeBlogHtml('<ul><li>a</li></ul><ol><li>b</li></ol><blockquote>q</blockquote><p><strong>x</strong> <em>y</em></p>');
    expect(out).toContain('<ul><li>a</li></ul>');
    expect(out).toContain('<ol><li>b</li></ol>');
    expect(out).toContain('<blockquote>q</blockquote>');
    expect(out).toContain('<strong>x</strong>');
  });

  test('preserves images with src/alt (forum sanitizer strips these)', () => {
    const out = sanitizeBlogHtml('<img src="https://cellarion.app/x.jpg" alt="bottle" width="800" />');
    expect(out).toContain('<img');
    expect(out).toContain('src="https://cellarion.app/x.jpg"');
    expect(out).toContain('alt="bottle"');
  });

  test('demotes in-content <h1> to <h2> (single top-level h1 on the page)', () => {
    const out = sanitizeBlogHtml('<h1>Should become h2</h1>');
    expect(out).toContain('<h2>Should become h2</h2>');
    expect(out).not.toContain('<h1>');
  });

  test('strips <script>, event handlers, style, and <iframe>', () => {
    const out = sanitizeBlogHtml('<h2 onclick="x" style="color:red">T</h2><script>alert(1)</script><iframe src="//evil"></iframe>');
    expect(out).toContain('<h2>T</h2>');
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('style');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<iframe');
  });

  test('strips dangerous URL schemes on links and images', () => {
    expect(sanitizeBlogHtml('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript');
    expect(sanitizeBlogHtml('<img src="javascript:alert(1)">')).not.toContain('javascript');
  });
});

describe('extractFaqFromHtml', () => {
  test('returns [] for non-string or content with no questions', () => {
    expect(extractFaqFromHtml(null)).toEqual([]);
    expect(extractFaqFromHtml('<h2>Storage tips</h2><p>Keep it cool.</p>')).toEqual([]);
  });

  test('pairs question-style headings with the following body text', () => {
    const html = '<h2>How long does wine age?</h2><p>It depends on the wine.</p><h2>Where to store it?</h2><p>A cool, dark place.</p>';
    const faqs = extractFaqFromHtml(html);
    expect(faqs).toHaveLength(2);
    expect(faqs[0]).toEqual({ question: 'How long does wine age?', answer: 'It depends on the wine.' });
    expect(faqs[1].question).toBe('Where to store it?');
    expect(faqs[1].answer).toBe('A cool, dark place.');
  });

  test('ignores non-question headings and stops the answer at the next heading', () => {
    const html = '<h2>Intro</h2><p>ignored</p><h3>Is it free?</h3><p>Yes.</p><h3>Pricing</h3><p>n/a</p>';
    const faqs = extractFaqFromHtml(html);
    expect(faqs).toHaveLength(1);
    expect(faqs[0].question).toBe('Is it free?');
    expect(faqs[0].answer).toBe('Yes.');
  });

  test('decodes entities and collapses whitespace in extracted text', () => {
    const faqs = extractFaqFromHtml('<h2>Tom &amp; Jerry?</h2><p>Cheese\n\n  &amp;  wine.</p>');
    expect(faqs[0].question).toBe('Tom & Jerry?');
    expect(faqs[0].answer).toBe('Cheese & wine.');
  });

  test('skips questions with no answer body', () => {
    expect(extractFaqFromHtml('<h2>Empty?</h2><h2>Also empty?</h2>')).toEqual([]);
  });
});

describe('extractHowToFromHtml', () => {
  test('returns [] for non-string or content with no Step headings', () => {
    expect(extractHowToFromHtml(null)).toEqual([]);
    expect(extractHowToFromHtml('<h2>Why track wine?</h2><p>Because it helps.</p>')).toEqual([]);
  });

  test('builds ordered steps from "Step N" headings, stripping the numbering prefix', () => {
    const html =
      '<h2>Step 1 — Create a cellar</h2><p>Name your cellar.</p>' +
      '<h2>Step 2 — Add bottles</h2><p>Log each bottle.</p>';
    const steps = extractHowToFromHtml(html);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toEqual({ name: 'Create a cellar', text: 'Name your cellar.' });
    expect(steps[1]).toEqual({ name: 'Add bottles', text: 'Log each bottle.' });
  });

  test('accepts colon, period, and hyphen separators after the step number', () => {
    const html =
      '<h2>Step 1: Sign up</h2><p>Make an account.</p>' +
      '<h2>Step 2. Add a rack</h2><p>Define the grid.</p>' +
      '<h2>Step 3 - Place bottles</h2><p>Drop them in.</p>';
    const steps = extractHowToFromHtml(html);
    expect(steps.map(s => s.name)).toEqual(['Sign up', 'Add a rack', 'Place bottles']);
  });

  test('ignores non-step h2 sections and keeps a step\'s own sub-headings in its body', () => {
    const html =
      '<h2>Introduction</h2><p>ignored</p>' +
      '<h2>Step 1 — Set up</h2><p>Do this.</p><h3>A detail</h3><p>And this.</p>' +
      '<h2>Frequently asked questions</h2><h3>Is it free?</h3><p>Yes.</p>';
    const steps = extractHowToFromHtml(html);
    expect(steps).toHaveLength(1);
    expect(steps[0].name).toBe('Set up');
    // The <h3> sub-heading and its text stay inside the step body (h3 is not a boundary).
    expect(steps[0].text).toBe('Do this. A detail And this.');
  });

  test('does not treat FAQ question headings as steps (only h2 "Step N" matches)', () => {
    const html = '<h2>How do I start?</h2><p>Sign up.</p><h2>Where are bottles?</h2><p>In cellars.</p>';
    expect(extractHowToFromHtml(html)).toEqual([]);
  });

  test('falls back to the heading as text for a heading-only step', () => {
    const html = '<h2>Step 1 — Open the app</h2><h2>Step 2 — Sign in</h2><p>Enter credentials.</p>';
    const steps = extractHowToFromHtml(html);
    expect(steps[0]).toEqual({ name: 'Open the app', text: 'Open the app' });
  });
});
