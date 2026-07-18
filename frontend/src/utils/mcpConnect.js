/**
 * Shared contract for pointing an AI client at this Cellarion install.
 *
 * Both the Settings card (AiConnectSection) and the public /connect-ai docs
 * page build claude.ai deep links, so the URL shape lives here — if Anthropic
 * renames a query parameter there must be exactly one place to fix it.
 */

/** The hosted app. Any other origin is a self-hosted install. */
export const HOSTED_ORIGIN = 'https://cellarion.app';

export const isHostedOrigin = (origin) => origin === HOSTED_ORIGIN;

/**
 * claude.ai "add custom connector" deep link, prefilled with this install's MCP
 * endpoint. `connectorUrl` is percent-encoded exactly once, which is what the
 * documented format expects — URLSearchParams does that for us.
 *
 * Hosted-only by design: claude.ai reaches the connector URL from its own
 * servers, so handing it a self-hosted origin (frequently a LAN or localhost
 * address) would produce a connector that can never connect.
 */
export function claudeOneClickUrl(origin) {
  const params = new URLSearchParams({
    modal: 'add-custom-connector',
    connectorName: 'Cellarion',
    connectorUrl: `${origin}/api/mcp`,
  });
  return `https://claude.ai/customize/connectors?${params.toString()}`;
}
