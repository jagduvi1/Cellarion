import { useState, useMemo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import SEOHead from '../components/SEOHead';
import SITE_URL from '../config/siteUrl';
import { HOSTED_ORIGIN, isHostedOrigin, claudeOneClickUrl } from '../utils/mcpConnect';
import './ConnectAi.css';

const TOKEN_PLACEHOLDER = 'cel_YOUR_TOKEN_HERE';

function Snippet({ text, copyLabel, copiedLabel }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);

  // Clear on unmount, and reset on every click, so rapid re-clicks can't have
  // an older timer flip the label back early.
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable (insecure context / denied) — the text is
         selectable anyway, so failing silently is the honest behaviour */
    }
  };

  return (
    <div className="connect-ai-snippet-block">
      <button type="button" className="btn btn-secondary btn-small connect-ai-copy" onClick={copy}>
        {copied ? copiedLabel : copyLabel}
      </button>
      <pre className="connect-ai-snippet"><code>{text}</code></pre>
    </div>
  );
}

function ConnectAi() {
  const { t } = useTranslation();
  const origin = typeof window !== 'undefined' ? window.location.origin : HOSTED_ORIGIN;
  const selfHosted = !isHostedOrigin(origin);
  const mcpUrl = `${origin}/api/mcp`;
  const publicUrl = `${origin}/api/mcp/public`;

  const copyLabel = t('connectAi.copy', 'Copy');
  const copiedLabel = t('connectAi.copied', 'Copied');

  // Every client's config, derived from the running origin so a self-hosted
  // install shows its own URLs. Snippets themselves are code and stay
  // untranslated; only the surrounding prose goes through i18n.
  const clients = useMemo(() => {
    const stdio = JSON.stringify(
      {
        mcpServers: {
          cellarion: {
            command: 'npx',
            args: ['-y', 'cellarion-mcp'],
            env: {
              CELLARION_TOKEN: TOKEN_PLACEHOLDER,
              ...(selfHosted ? { CELLARION_URL: origin } : {}),
            },
          },
        },
      },
      null,
      2,
    );

    return [
      {
        id: 'claude',
        title: t('connectAi.clients.claude.title', 'Claude (web, desktop and mobile)'),
        body: t(
          'connectAi.clients.claude.body',
          'Settings → Connectors → Add custom connector, then paste the URL below. You sign in with your Cellarion account and choose what the assistant may do.',
        ),
        snippet: mcpUrl,
      },
      {
        id: 'claudeDesktop',
        title: t('connectAi.clients.claudeDesktop.title', 'Claude Desktop (local bridge)'),
        body: t(
          'connectAi.clients.claudeDesktop.body',
          'Prefer a local connection, or self-hosting? Add this to claude_desktop_config.json. It runs on your machine and talks to your server with a personal API token.',
        ),
        snippet: stdio,
      },
      {
        id: 'claudeCode',
        title: t('connectAi.clients.claudeCode.title', 'Claude Code'),
        body: t('connectAi.clients.claudeCode.body', 'One command in your terminal.'),
        snippet: `claude mcp add --transport http cellarion ${mcpUrl}`,
      },
      {
        id: 'chatgpt',
        title: t('connectAi.clients.chatgpt.title', 'ChatGPT'),
        body: t(
          'connectAi.clients.chatgpt.body',
          'Settings → Connectors → Advanced → enable Developer mode, then Create and paste the URL below with authentication set to OAuth.',
        ),
        snippet: mcpUrl,
      },
      {
        id: 'vscode',
        title: t('connectAi.clients.vscode.title', 'VS Code (GitHub Copilot)'),
        body: t('connectAi.clients.vscode.body', 'Add to .vscode/mcp.json in your workspace, or your user mcp.json.'),
        snippet: JSON.stringify({ servers: { cellarion: { type: 'http', url: mcpUrl } } }, null, 2),
      },
      {
        id: 'cursor',
        title: t('connectAi.clients.cursor.title', 'Cursor and Windsurf'),
        body: t('connectAi.clients.cursor.body', 'Add to ~/.cursor/mcp.json (Cursor) or the equivalent Windsurf config.'),
        snippet: JSON.stringify({ mcpServers: { cellarion: { url: mcpUrl } } }, null, 2),
      },
      {
        id: 'gemini',
        title: t('connectAi.clients.gemini.title', 'Gemini CLI'),
        body: t('connectAi.clients.gemini.body', 'Add to ~/.gemini/settings.json.'),
        snippet: JSON.stringify({ mcpServers: { cellarion: { httpUrl: mcpUrl } } }, null, 2),
      },
      {
        id: 'stdio',
        title: t('connectAi.clients.stdio.title', 'LM Studio, Jan, LibreChat, Open WebUI, Goose'),
        body: t(
          'connectAi.clients.stdio.body',
          'These connect over stdio. Use the same bridge as Claude Desktop — it works with any MCP client that can run a command.',
        ),
        snippet: stdio,
      },
    ];
  }, [t, mcpUrl, origin, selfHosted]);

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'TechArticle',
        headline: t('connectAi.title', 'Connect your AI to your wine cellar'),
        description: t(
          'connectAi.subtitle',
          'Cellarion speaks the Model Context Protocol, so you can run your cellar from Claude, ChatGPT or any MCP client.',
        ),
        url: `${SITE_URL}/connect-ai`,
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Cellarion', item: SITE_URL },
          {
            '@type': 'ListItem',
            position: 2,
            name: t('connectAi.title', 'Connect your AI to your wine cellar'),
            item: `${SITE_URL}/connect-ai`,
          },
        ],
      },
    ],
  };

  return (
    <div className="connect-ai-page">
      <SEOHead
        title={`${t('connectAi.title', 'Connect your AI to your wine cellar')} — Cellarion`}
        description={t(
          'connectAi.subtitle',
          'Cellarion speaks the Model Context Protocol, so you can run your cellar from Claude, ChatGPT or any MCP client.',
        )}
        path="/connect-ai"
        jsonLd={jsonLd}
      />

      <div className="connect-ai-container">
        <header className="connect-ai-header">
          <h1>{t('connectAi.title', 'Connect your AI to your wine cellar')}</h1>
          <p className="connect-ai-subtitle">
            {t(
              'connectAi.subtitle',
              'Cellarion speaks the Model Context Protocol, so you can run your cellar from Claude, ChatGPT or any MCP client.',
            )}
          </p>
          <p className="connect-ai-beta">
            {t(
              'connectAi.beta',
              'The AI connector is in beta. Everything an assistant changes is listed in your account and can be undone.',
            )}
          </p>
        </header>

        {!selfHosted && (
          <section className="connect-ai-oneclick">
            <h2>{t('connectAi.oneClick.title', 'One click with Claude')}</h2>
            <p>
              {t(
                'connectAi.oneClick.body',
                'Opens Claude with the connector details filled in. You still sign in and choose an access level.',
              )}
            </p>
            <a className="btn btn-primary" href={claudeOneClickUrl(origin)} target="_blank" rel="noopener noreferrer">
              {t('connectAi.oneClick.cta', 'Add Cellarion to Claude')}
            </a>
          </section>
        )}

        <section className="connect-ai-section">
          <h2>{t('connectAi.access.title', 'What the assistant may do')}</h2>
          <p>
            {t(
              'connectAi.access.body',
              'You pick an access level when you connect, and you can revoke it at any time from your settings.',
            )}
          </p>
          <ul className="connect-ai-scopes">
            <li>
              <strong>{t('connectAi.access.readTitle', 'Read')}</strong>
              {' — '}
              {t('connectAi.access.readBody', 'Look at your cellars, bottles, racks and notes. Changes nothing.')}
            </li>
            <li>
              <strong>{t('connectAi.access.consumeTitle', 'Read and drink')}</strong>
              {' — '}
              {t('connectAi.access.consumeBody', 'Also mark bottles as consumed, and track open bottles (opened, glasses poured, preservation). All of it is reversible.')}
            </li>
            <li>
              <strong>{t('connectAi.access.writeTitle', 'Full access')}</strong>
              {' — '}
              {t('connectAi.access.writeBody', 'Also add and edit bottles, and organise racks and cellars.')}
            </li>
          </ul>
          <p className="connect-ai-note">
            {t(
              'connectAi.access.tokenNote',
              'Set-ups that use a URL sign you in with OAuth, so there is nothing to paste. Only the stdio bridge needs a personal API token: mint one under Settings → API tokens and put it where those snippets say cel_YOUR_TOKEN_HERE.',
            )}
          </p>
        </section>

        <section className="connect-ai-section">
          <h2>{t('connectAi.clientsTitle', 'Set-up per client')}</h2>
          {clients.map((c) => (
            <div className="connect-ai-client" key={c.id}>
              <h3>{c.title}</h3>
              <p>{c.body}</p>
              <Snippet text={c.snippet} copyLabel={copyLabel} copiedLabel={copiedLabel} />
            </div>
          ))}
        </section>

        <section className="connect-ai-section">
          <h2>{t('connectAi.publicTitle', 'The open wine registry — no account needed')}</h2>
          <p>
            {t(
              'connectAi.publicBody',
              'Cellarion also runs a public endpoint that any AI can use without signing up. It serves the shared wine registry, grape and region profiles, sommelier drink windows and our published guides. It holds no personal data and changes nothing.',
            )}
          </p>
          <Snippet text={publicUrl} copyLabel={copyLabel} copiedLabel={copiedLabel} />
        </section>

        <section className="connect-ai-section">
          <h2>{t('connectAi.rawTitle', 'Raw protocol details')}</h2>
          <p>{t('connectAi.rawBody', 'For anything that speaks MCP directly.')}</p>
          <Snippet
            text={[
              `Personal endpoint   ${mcpUrl}`,
              `Public endpoint     ${publicUrl}`,
              'Transport           Streamable HTTP',
              'Auth                OAuth 2.1 (PKCE S256), or Bearer cel_ token',
              `Discovery           ${origin}/.well-known/oauth-protected-resource/api/mcp`,
              'Scopes              read · consume · write · offline_access',
            ].join('\n')}
            copyLabel={copyLabel}
            copiedLabel={copiedLabel}
          />
          {selfHosted && (
            <p className="connect-ai-note">
              {t(
                'connectAi.selfHostNote',
                'These URLs point at this install. All OAuth discovery URLs are derived from FRONTEND_URL, so set it to the address your users actually reach.',
              )}
            </p>
          )}
        </section>

        <footer className="connect-ai-footer">
          <p>
            <Link to="/help">{t('connectAi.helpLink', 'Browse the help centre')}</Link>
            {' · '}
            <Link to="/privacy">{t('connectAi.privacyLink', 'How your data is handled')}</Link>
          </p>
        </footer>
      </div>
    </div>
  );
}

export default ConnectAi;
