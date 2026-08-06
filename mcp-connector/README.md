# MCP connector config

This folder holds nothing but client-side configuration for connecting an
MCP-capable AI agent (Claude, or any other MCP client) to a running
seenpaid instance. It's licensed separately, under MIT (see
`LICENSE` in this folder) rather than the AGPL-3.0 that covers the scheduler
core — a tiny config snippet is exactly the kind of thing that should be
freely copyable into agent-directory listings and other MCP client configs
without license friction. The server it points at is still AGPL-3.0.

## Usage

Add this to your MCP client's config (for Claude Code / Claude Desktop,
that's the `mcpServers` block in your settings):

```json
{
  "mcpServers": {
    "seenpaid": {
      "url": "https://your-instance.example.com/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
```

Replace the URL with wherever you're running the instance (`http://localhost:3001/mcp`
for a local dev setup) and `YOUR_API_KEY` with the `API_KEY` value from your
`.env`.

Once connected, the agent has three tools available: `list_accounts`,
`list_posts`, and `schedule_post`. See the root `README.md` for what each
one does.
