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
 * Our extraction and chat tasks don't need extended reasoning, so turn it off
 * explicitly on the Sonnet 5 family — with the setting each model accepts:
 *   - Sonnet 5:   `thinking: { type: 'disabled' }`.
 *   - Sonnet 5.5: `thinking: { type: 'between_tools' }` — its lowest setting;
 *     `disabled` is a 400 there (platform.claude.com, "What's new in Claude
 *     Sonnet 5.5", 2026-09-28). Without tools the reply is text only, exactly
 *     as `disabled` was; with a server tool (the enrichment web search) the
 *     model's notes between calls come back as thinking blocks, which
 *     textFromResponse already skips.
 * The other allowlisted models (Haiku 4.5, Sonnet 4.6, Opus 4.x) don't think
 * when the parameter is omitted — send nothing for them rather than risk an
 * explicit value they might reject. (Opus 5.5 is not allowlisted: its thinking
 * cannot be turned off and shares max_tokens with the answer, so our 600–800
 * token limits would truncate; it needs an effort setting and bigger limits.)
 */
function textFromResponse(response) {
  return (response?.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

function thinkingOff(model) {
  if (typeof model !== 'string') return {};
  // 5.5 first: 'claude-sonnet-5-5' also starts with 'claude-sonnet-5'.
  // Effort medium as well: 5.5's default is high, and the model's launch note
  // (2026-09-28) puts its "up to 30% lower cost per task than Sonnet 5" at
  // medium — between_tools is accepted at low, medium and high. The SDK
  // (0.55.1) predates the parameter and forwards the body as given, exactly
  // as it does for `thinking`.
  if (model.startsWith('claude-sonnet-5-5')) {
    return { thinking: { type: 'between_tools' }, output_config: { effort: 'medium' } };
  }
  if (model.startsWith('claude-sonnet-5')) return { thinking: { type: 'disabled' } };
  return {};
}

module.exports = { textFromResponse, thinkingOff };
