/**
 * AI service for the interactive help guide.
 *
 * Uses Claude to understand user questions and match them to the most
 * relevant tour or text answer. The feature knowledge comes from
 * data/helpContent.js — the single source of truth shared with the
 * /api/help endpoint and the frontend Help page.
 */

const aiConfig = require('../config/aiConfig');
const { extractFirstJsonObject } = require('../utils/jsonExtract');
const helpContent = require('../data/helpContent');

/** Build the feature reference section from helpContent. */
function buildFeatureRef() {
  return helpContent.sections.map(s => {
    const header = s.route ? `### ${s.title} (${s.route})` : `### ${s.title}`;
    const bullets = s.details.map(d => `- ${d}`).join('\n');
    return `${header}\n${bullets}`;
  }).join('\n\n');
}

/** Build the tour list from helpContent. */
function buildTourList() {
  return helpContent.tours.map(t => `- "${t.id}" — ${t.label}`).join('\n');
}

const PROMPT_PREAMBLE =
`You are Cellarion's help assistant. You help users navigate the app.

Current page: {{currentPage}}

## CRITICAL RULE
NEVER invent, guess, or describe features, buttons, toggles, or workflows that are not listed below. If you are unsure how something works, say "I'm not sure about the details — try exploring the page!" Do NOT make up steps. ONLY describe what is documented here.`;

const PROMPT_RULES =
`## Response Rules
1. Be friendly, concise — under 60 words.
2. If a tour matches, include the tourId.
3. NEVER describe UI details (buttons, toggles, steps) not listed above. If unsure, say so.
4. If the user asks about sharing a bottle, tell them about the share icon on the bottle detail page.
5. Always suggest 2-3 follow-up questions.
6. Reply in the user's language.

Respond with ONLY a raw JSON object (no markdown, no code fences):
{"message":"Your helpful response","tourId":"tour-id-or-null","suggestions":["Follow-up 1?","Follow-up 2?","Follow-up 3?"]}`;

// Build the full system prompt once at startup (content is static)
const GUIDE_SYSTEM_PROMPT = [
  PROMPT_PREAMBLE,
  '\n## Complete Feature Reference\n',
  buildFeatureRef(),
  '\n## Available Tours\nWhen the user asks "how do I..." suggest the matching tour (use exact ID):\n',
  buildTourList(),
  '\n',
  PROMPT_RULES,
].join('\n');

let _client;
function getClient() {
  if (_client !== undefined) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { _client = null; return null; }
  const sdk = require('@anthropic-ai/sdk');
  const Anthropic = sdk.default ?? sdk;
  _client = new Anthropic({ apiKey });
  return _client;
}

/**
 * Ask the guide AI a question.
 * Returns { message, tourId, suggestions }.
 */
async function askGuide(question, currentPage) {
  const client = getClient();
  if (!client) return null;

  const systemPrompt = GUIDE_SYSTEM_PROMPT.replace('{{currentPage}}', currentPage || '/cellars');

  const response = await client.messages.create({
    model: aiConfig.get().chatModel || 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    system: systemPrompt,
    messages: [
      { role: 'user', content: question }
    ],
  });

  const raw = (response.content[0]?.text ?? '').trim();
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  try {
    const parsed = JSON.parse(extractFirstJsonObject(stripped));
    return {
      message: parsed.message || 'I can help you with that!',
      tourId: parsed.tourId || null,
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.slice(0, 3) : [],
    };
  } catch {
    return {
      message: stripped.slice(0, 300),
      tourId: null,
      suggestions: [],
    };
  }
}

module.exports = { askGuide };
