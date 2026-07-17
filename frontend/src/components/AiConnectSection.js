import { useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Settings section: "Connect your AI" — copy-paste MCP configs for Claude
 * Desktop (via the npx cellarion-mcp bridge), Claude Code, and any generic
 * Streamable-HTTP MCP client.
 *
 * The token is pasted by the user (minted in the API-tokens section above,
 * `read` scope) and lives ONLY in component state — never persisted, never
 * sent anywhere except the same-origin test call to /api/auth/whoami, the
 * endpoint built for exactly this "is my token valid?" check.
 */
const HOSTED_ORIGIN = 'https://cellarion.app';

function buildSnippets(rawToken) {
  const token = rawToken.trim() || 'cel_YOUR_TOKEN_HERE';
  const origin = window.location.origin;
  const selfHosted = origin !== HOSTED_ORIGIN;
  const desktop = {
    mcpServers: {
      cellarion: {
        command: 'npx',
        args: ['-y', 'cellarion-mcp'],
        env: {
          CELLARION_TOKEN: token,
          ...(selfHosted ? { CELLARION_URL: origin } : {}),
        },
      },
    },
  };
  return {
    desktop: JSON.stringify(desktop, null, 2),
    code: `claude mcp add --transport http cellarion ${origin}/api/mcp --header "Authorization: Bearer ${token}"`,
    generic: `${origin}/api/mcp\nAuthorization: Bearer ${token}`,
  };
}

function Snippet({ label, text }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard unavailable (http / permissions) — user selects manually */ }
  };
  return (
    <div className="ai-connect-snippet-block">
      <div className="ai-connect-snippet-head">
        <h3>{label}</h3>
        <button type="button" className="btn btn-secondary btn-small" onClick={handleCopy}>
          {copied ? t('settings.aiConnect.copied', 'Copied!') : t('settings.aiConnect.copy', 'Copy')}
        </button>
      </div>
      <pre className="api-token-plain ai-connect-snippet"><code>{text}</code></pre>
    </div>
  );
}

export default function AiConnectSection() {
  const { t } = useTranslation();
  const [token, setToken] = useState('');
  const [testState, setTestState] = useState(null); // null | 'testing' | 'ok' | 'fail'

  const snippets = buildSnippets(token);

  const handleTest = async () => {
    setTestState('testing');
    try {
      // Deliberately a raw fetch with the PASTED token (not the session JWT):
      // this verifies the exact credential the AI client will use. /whoami is
      // the read-scope identity endpoint built for this check.
      const res = await fetch('/api/auth/whoami', {
        headers: { Authorization: `Bearer ${token.trim()}` },
      });
      // 401/403 = the token itself was rejected; anything else (429 limiter,
      // 5xx) says nothing about the token — don't blame it.
      setTestState(res.ok ? 'ok' : res.status === 401 || res.status === 403 ? 'fail' : 'error');
    } catch {
      setTestState('error');
    }
  };

  return (
    <div className="card settings-card">
      <h2 className="settings-section-title">
        {t('settings.aiConnect.title', 'Connect your AI')}
        <span className="settings-beta-badge">{t('settings.aiConnect.beta', 'Beta')}</span>
      </h2>
      {/* Shipped to production deliberately early so it gets real use — say so
          plainly rather than letting people discover the rough edges the hard
          way. The reassurance is real (read-only default, reversible, instant
          revoke), so the warning doesn't need to be alarming to be honest. */}
      <div className="alert alert-info">
        {t('settings.aiConnect.betaNotice',
          'This is a beta feature and you use it at your own risk. It works, but it is new and still being tested — expect rough edges, and changes while we refine it. If you are unsure, connect with a read-only token: anything an AI changes can be undone under "What your AI has changed", and revoking the token cuts it off instantly.')}
      </div>
      <p className="settings-hint">
        {t('settings.aiConnect.hint',
          'Talk to your cellar from Claude Desktop, Claude Code, or any MCP-capable assistant: ask what to open tonight, where a bottle is stored, or what your collection is worth. Connections are read-only and use a personal token you can revoke at any time.')}
      </p>
      <p className="settings-hint">
        {t('settings.aiConnect.step1',
          'Step 1 — create an API token with the "read" scope in the API tokens section above, then paste it here to fill in the configs (the token is only kept on this page):')}
      </p>
      <div className="form-group ai-connect-token-row">
        <input
          className="input"
          type="password"
          value={token}
          onChange={(e) => { setToken(e.target.value); setTestState(null); }}
          placeholder={t('settings.aiConnect.tokenPlaceholder', 'cel_… (paste your token, optional)')}
          autoComplete="new-password"
        />
        <button
          type="button"
          className="btn btn-secondary"
          onClick={handleTest}
          disabled={!token.trim() || testState === 'testing'}
        >
          {testState === 'testing'
            ? t('settings.aiConnect.testing', 'Testing…')
            : t('settings.aiConnect.testBtn', 'Test connection')}
        </button>
      </div>
      {testState === 'ok' && (
        <p className="settings-saved">{t('settings.aiConnect.testOk', 'Connected — the token works.')}</p>
      )}
      {testState === 'fail' && (
        <div className="alert alert-error">
          {t('settings.aiConnect.testFail', 'That token was rejected. Check it was copied completely and has the "read" scope, and that it has not been revoked.')}
        </div>
      )}
      {testState === 'error' && (
        <div className="alert alert-error">
          {t('settings.aiConnect.testError', 'Could not verify right now (server busy or unreachable) — this says nothing about your token. Try again in a moment.')}
        </div>
      )}

      <Snippet
        label={t('settings.aiConnect.claudeDesktopTitle', 'Claude Desktop (claude_desktop_config.json)')}
        text={snippets.desktop}
      />
      <Snippet
        label={t('settings.aiConnect.claudeCodeTitle', 'Claude Code (terminal)')}
        text={snippets.code}
      />
      <Snippet
        label={t('settings.aiConnect.genericTitle', 'Any MCP client (Streamable HTTP)')}
        text={snippets.generic}
      />

      <p className="settings-hint ai-connect-footnote">
        {t('settings.aiConnect.securityNote',
          'Your AI sees only your own cellar data. Revoking the token in the API tokens section cuts the connection off instantly.')}
      </p>
    </div>
  );
}
