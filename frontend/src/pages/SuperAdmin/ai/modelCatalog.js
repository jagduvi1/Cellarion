// The models the SuperAdmin AI panels offer, with the prices shown beside
// each, and two styles those panels share.

export const CHAT_MODELS = [
  {
    id: 'claude-haiku-4-5-20251001',
    name: 'Claude Haiku 4.5',
    description: 'Fast & affordable — recommended for Cellar Chat',
    inputPrice: '$1.00',
    outputPrice: '$5.00',
    tier: 'economy',
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    description: 'Previous-generation Sonnet — high quality at standard price',
    inputPrice: '$3.00',
    outputPrice: '$15.00',
    tier: 'standard',
  },
  {
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    // The $2/$10 launch price became the standard price; the increase that was
    // scheduled for 2026-09-01 was cancelled (platform.claude.com pricing, 2026-09-25).
    description: 'Previous Sonnet — same price as 5.5; the model prod ran on until September 2026',
    inputPrice: '$2.00',
    outputPrice: '$10.00',
    tier: 'standard',
  },
  {
    id: 'claude-sonnet-5-5',
    name: 'Claude Sonnet 5.5',
    // Released 2026-09-28 at Sonnet 5's prices; June 2026 knowledge cutoff.
    // The backend turns its thinking off the way it accepts (utils/aiResponse).
    description: 'Newest Sonnet — same price, newer knowledge; recommended for wine identification & profiles',
    inputPrice: '$2.00',
    outputPrice: '$10.00',
    tier: 'standard',
  },
  {
    id: 'claude-opus-4-8',
    name: 'Claude Opus 4.8',
    description: 'Most capable — best for complex palate matching',
    inputPrice: '$5.00',
    outputPrice: '$25.00',
    tier: 'premium',
  },
];

export const tierColor = { economy: 'var(--sa-accent)', standard: 'var(--sa-accent2)', premium: '#c9a84c' };

export const codeStyle = { background: 'var(--sa-bg)', padding: '1px 4px', borderRadius: 2 };
