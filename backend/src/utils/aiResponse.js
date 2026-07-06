/**
 * Claude response helpers shared by the AI services.
 *
 * textFromResponse — Claude Sonnet 5 (and newer families) may emit a
 * `thinking` block before the text, so `response.content[0].text` silently
 * returns undefined on exactly the calls where the model reasoned hardest.
 * Join every text block instead.
 *
 * thinkingOff — Claude Sonnet 5 runs adaptive thinking BY DEFAULT when the
 * `thinking` parameter is omitted; thinking tokens are billed and count
 * against max_tokens (this truncated 17% of maturity suggestions in prod).
 * Our extraction and chat tasks don't need extended reasoning, so disable it
 * explicitly on the Sonnet 5 family. The other allowlisted models (Haiku 4.5,
 * Sonnet 4.6, Opus 4.x) don't think when the parameter is omitted — send
 * nothing for them rather than risk an explicit value they might reject.
 */
function textFromResponse(response) {
  return (response?.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

function thinkingOff(model) {
  return typeof model === 'string' && model.startsWith('claude-sonnet-5')
    ? { thinking: { type: 'disabled' } }
    : {};
}

module.exports = { textFromResponse, thinkingOff };
