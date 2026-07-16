# cellarion-mcp

Connect your AI to your wine cellar. This is the [MCP](https://modelcontextprotocol.io) bridge for [Cellarion](https://cellarion.app) — it lets stdio-based MCP clients (Claude Desktop, Cursor, …) talk to your Cellarion account, so you can ask your assistant things like:

- *"What should I open tonight before it goes past its peak?"*
- *"Do I still have any Barolo, and where is it stored?"*
- *"What did I drink last month, and what did I rate it?"*

It runs entirely on **your** machine and proxies to your Cellarion server's `/api/mcp` endpoint using a personal, revocable API token. Tools and resources are defined by the server — updating Cellarion automatically updates what your AI can do; this bridge never needs to know.

## Setup

1. **Mint a token** in Cellarion: *Settings → API tokens* → create a token with the `read` scope. Copy the `cel_…` value (shown once).
2. **Add the server to your client.** Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "cellarion": {
      "command": "npx",
      "args": ["-y", "cellarion-mcp"],
      "env": {
        "CELLARION_TOKEN": "cel_your_token_here"
      }
    }
  }
}
```

3. Restart the client. Ask it about your cellar.

**Self-hosting Cellarion?** Point the bridge at your instance:

```json
      "env": {
        "CELLARION_TOKEN": "cel_your_token_here",
        "CELLARION_URL": "https://cellarion.your-domain.example"
      }
```

(`--token` / `--url` command-line arguments work too.)

## Security notes

- The token is scoped and **revocable instantly** from Cellarion — revoking it cuts this bridge off mid-session.
- A `read`-scope token can only read your own cellar data. It cannot modify anything, cannot read other accounts, and cannot manage tokens.
- The token goes only to the host in `CELLARION_URL` — nowhere else. Nothing is logged.

## License

AGPL-3.0, like Cellarion itself. Source: <https://github.com/jagduvi1/Cellarion> (`cellarion-mcp/`).
