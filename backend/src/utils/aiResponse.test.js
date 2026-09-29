const { textFromResponse, thinkingOff } = require('./aiResponse');

describe('textFromResponse', () => {
  it('joins text blocks and skips thinking blocks', () => {
    const response = {
      content: [
        { type: 'thinking', thinking: 'internal reasoning' },
        { type: 'text', text: '{"name":' },
        { type: 'text', text: '"Blanc de Blancs"}' },
      ],
    };
    expect(textFromResponse(response)).toBe('{"name":"Blanc de Blancs"}');
  });

  it('returns empty string when there are no text blocks', () => {
    expect(textFromResponse({ content: [{ type: 'thinking', thinking: 'x' }] })).toBe('');
    expect(textFromResponse({ content: [] })).toBe('');
    expect(textFromResponse({})).toBe('');
    expect(textFromResponse(null)).toBe('');
  });

  it('trims the joined text', () => {
    expect(textFromResponse({ content: [{ type: 'text', text: '  hi \n' }] })).toBe('hi');
  });
});

describe('thinkingOff', () => {
  it('disables thinking on Sonnet 5', () => {
    expect(thinkingOff('claude-sonnet-5')).toEqual({ thinking: { type: 'disabled' } });
  });

  // Sonnet 5.5 (2026-09-28) rejects `disabled` with a 400; its lowest thinking
  // setting is `between_tools`, which without tools means text only.
  it('turns thinking off on Sonnet 5.5 with between_tools, the setting that model accepts', () => {
    expect(thinkingOff('claude-sonnet-5-5')).toEqual({ thinking: { type: 'between_tools' } });
    expect(thinkingOff('claude-sonnet-5-5')).not.toEqual({ thinking: { type: 'disabled' } });
  });

  it('sends nothing for models that do not think by default', () => {
    expect(thinkingOff('claude-haiku-4-5-20251001')).toEqual({});
    expect(thinkingOff('claude-sonnet-4-6')).toEqual({});
    expect(thinkingOff('claude-opus-4-8')).toEqual({});
    expect(thinkingOff(undefined)).toEqual({});
  });
});
