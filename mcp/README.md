# AWebChatbot MCP server

Connects Claude (Claude Desktop, Claude Code, claude.ai custom connectors, or any MCP client) to your
AWebChatbot Worker so you can set up website chatbots, answer customers, look up customers, search the
knowledge base and build chatbot flows without leaving Claude.

## Tools

| Area | Tools |
| --- | --- |
| Website setup | `list_workspaces`, `add_chatbot_to_website`, `get_setup_status`, `get_widget_install_code`, `get_chatbot_settings`, `update_chatbot_settings`, `test_chatbot`, `get_platform_status` |
| Support inbox | `list_conversations`, `get_conversation`, `reply_to_conversation` (preview first, `confirmed=True` to send), `add_internal_note`, `suggest_reply`, `summarize_conversation`, `export_conversation_transcript`, `assign_conversation`, `close_conversation` (preview first, `confirmed=True` to close), `reopen_conversation`, `return_conversation_to_bot`, `get_inbox_stats` |
| Customers | `search_customers`, `get_customer`, `update_customer` |
| Knowledge base | `search_knowledge_base`, `list_knowledge_documents`, `add_knowledge_document`, `delete_knowledge_document`, `crawl_website` |
| Chatbot flows | `list_scenarios`, `get_scenario`, `create_scenario`, `import_scenario`, `rename_scenario`, `add_scenario_step`, `update_scenario_step`, `delete_scenario_step`, `set_scenario_start_step`, `activate_scenario`, `deactivate_scenario`, `delete_scenario` |
| Team | `list_agents`, `create_agent`, `list_webhooks`, `add_webhook` |

Prompts: `triage_inbox`, `improve_chatbot`, `setup_website`.

## Configuration

| Variable | Meaning |
| --- | --- |
| `AWEBCHATBOT_URL` | Your Worker URL, e.g. `https://awebchatbot.<subdomain>.workers.dev` |
| `AWEBCHATBOT_TOKEN` | The Worker's `ADMIN_TOKEN` secret, or an agent token (agents only see their workspaces) |
| `MCP_AUTH_TOKEN` | HTTP mode only: bearer token clients must send (24+ characters) |

## Run locally (stdio) — Claude Desktop / Claude Code

```bash
cd mcp
python3 -m venv .venv && source .venv/bin/activate
pip install -e .
```

Claude Desktop `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "awebchatbot": {
      "command": "/ABSOLUTE/PATH/TO/Awebchatbot/mcp/.venv/bin/awebchatbot-mcp",
      "env": {
        "AWEBCHATBOT_URL": "https://awebchatbot.YOUR-SUBDOMAIN.workers.dev",
        "AWEBCHATBOT_TOKEN": "YOUR_ADMIN_TOKEN"
      }
    }
  }
}
```

Claude Code:

```bash
claude mcp add awebchatbot \
  -e AWEBCHATBOT_URL=https://awebchatbot.YOUR-SUBDOMAIN.workers.dev \
  -e AWEBCHATBOT_TOKEN=YOUR_ADMIN_TOKEN \
  -- /ABSOLUTE/PATH/TO/Awebchatbot/mcp/.venv/bin/awebchatbot-mcp
```

## Run remotely on Fly.io (Streamable HTTP)

```bash
cd mcp
fly launch --no-deploy --copy-config --name awebchatbot-mcp
fly secrets set AWEBCHATBOT_URL=https://awebchatbot.YOUR-SUBDOMAIN.workers.dev \
                AWEBCHATBOT_TOKEN=YOUR_ADMIN_TOKEN \
                MCP_AUTH_TOKEN=$(openssl rand -hex 24)
fly deploy
```

The endpoint is `https://awebchatbot-mcp.fly.dev/mcp` and requires `Authorization: Bearer <MCP_AUTH_TOKEN>`.
Health check: `GET /health`.

## Tests

```bash
pip install -e ".[dev]"
pytest
# Optional live round-trip against a running Worker:
AWEBCHATBOT_LIVE_URL=http://127.0.0.1:8787 AWEBCHATBOT_LIVE_TOKEN=your-admin-token pytest
```
