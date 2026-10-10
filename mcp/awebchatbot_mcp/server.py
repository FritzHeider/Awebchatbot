"""MCP tools for AWebChatbot.

Every tool calls the Worker admin API (`/admin/*`). Tools that change something a customer can see
(replies, closing) are explicit about it so the MCP client asks the user for confirmation.
"""

from __future__ import annotations

from typing import Any, Literal

from mcp.server.mcpserver import MCPServer
from mcp.types import ToolAnnotations

from .client import AWebChatbotClient

INSTRUCTIONS = """AWebChatbot runs AI chatbots + live chat on the user's websites (e.g. breachmodal.com,
isshereal.com, betmodal.com, robomodal.com) with a shared support inbox.

Typical workflows:
- New site: add_chatbot_to_website -> get_setup_status (wait for crawl) -> get_widget_install_code.
- Support: list_conversations(status="open", mode="human") -> get_conversation -> suggest_reply ->
  show the draft to the user -> reply_to_conversation(confirmed=True) only after the user approves.
- Improve the bot: test_chatbot with real customer questions, search_knowledge_base to see what it knows,
  add_knowledge_document for gaps, update_chatbot_settings for persona/guardrails.
- Flows: create_scenario -> add_scenario_step (link steps with previous_step_id / options) -> get_scenario
  to review problems -> activate_scenario to publish.
Never send a message to a customer without the user's explicit confirmation. That includes
close_conversation, which shows the customer a closed message and rating prompt: preview first, then
confirmed=True once the user approves."""

mcp = MCPServer(name="awebchatbot", title="AWebChatbot", instructions=INSTRUCTIONS, version="1.0.0")

_client: AWebChatbotClient | None = None


def get_client() -> AWebChatbotClient:
    global _client
    if _client is None:
        _client = AWebChatbotClient()
    return _client


def set_client(client: AWebChatbotClient | None) -> None:
    """Used by tests to inject a client with a mock transport."""
    global _client
    _client = client


READ = ToolAnnotations(readOnlyHint=True, openWorldHint=False)
WRITE = ToolAnnotations(readOnlyHint=False, destructiveHint=False, openWorldHint=False)
CUSTOMER_FACING = ToolAnnotations(readOnlyHint=False, destructiveHint=False, openWorldHint=True)
DESTRUCTIVE = ToolAnnotations(readOnlyHint=False, destructiveHint=True, openWorldHint=False)

S = AWebChatbotClient.seg
Platform = Literal["html", "wordpress", "shopify", "nextjs", "react", "nuxt", "cloudflare", "gtm"]
StepType = Literal["message", "question", "buttons", "collect_email", "ai", "handoff"]


# ------------------------------------------------------------------------------------------------
# Workspaces & website setup
# ------------------------------------------------------------------------------------------------


@mcp.tool(annotations=READ)
async def list_workspaces() -> dict[str, Any]:
    """List all chatbot workspaces (one per website) with their domain, widget key and settings."""
    data = await get_client().get("/workspaces")
    return {
        "workspaces": [
            {
                "id": w["id"],
                "name": w["name"],
                "domain": w["domain"],
                "public_key": w["publicKey"],
                "provider": w["settings"]["provider"],
                "bot_name": w["settings"]["botName"],
            }
            for w in data["workspaces"]
        ]
    }


@mcp.tool(annotations=WRITE)
async def add_chatbot_to_website(
    url: str,
    name: str | None = None,
    max_pages: int = 150,
    persona: str | None = None,
    brand_color: str | None = None,
    provider: Literal["anthropic", "gemini", "xai", "openai", "workers-ai"] | None = None,
) -> dict[str, Any]:
    """Add an AI chatbot to a website.

    Creates a workspace, starts crawling the site's pages (sitemap + links) into the knowledge base so the
    bot answers from real content, and returns the HTML install snippet plus next steps.

    Args:
        url: The website, e.g. "https://robomodal.com".
        name: Display name (defaults to the domain name).
        max_pages: Maximum pages to crawl.
        persona: Facts about the business and tone the bot should always use.
        brand_color: Hex color for the widget, e.g. "#0ea5e9".
        provider: Primary AI provider (falls back automatically to others that are configured).
    """
    settings: dict[str, Any] = {}
    if persona:
        settings["persona"] = persona
    if brand_color:
        settings["brandColor"] = brand_color
    if provider:
        settings["provider"] = provider
    return await get_client().post(
        "/workspaces", {"url": url, "name": name, "maxPages": max_pages, "settings": settings or None}
    )


@mcp.tool(annotations=READ)
async def get_setup_status(workspace_id: str) -> dict[str, Any]:
    """Check setup progress for a website: AI providers, crawl progress, indexed pages, widget install,
    published flow and whether an agent is online. Returns a checklist."""
    return await get_client().get(f"/workspaces/{S(workspace_id)}/setup-status")


@mcp.tool(annotations=READ)
async def get_widget_install_code(workspace_id: str, platform: Platform = "html") -> dict[str, Any]:
    """Get the chat widget install code and step-by-step instructions for a platform:
    html, wordpress, shopify, nextjs, react, nuxt, cloudflare (Zaraz / HTML-injector Worker) or gtm."""
    return await get_client().get(f"/workspaces/{S(workspace_id)}/install-code", platform=platform)


@mcp.tool(annotations=READ)
async def get_chatbot_settings(workspace_id: str) -> dict[str, Any]:
    """Get every setting of a chatbot: greeting, persona, guardrails, provider/model, handoff, crawl options."""
    data = await get_client().get(f"/workspaces/{S(workspace_id)}")
    return data["workspace"]


@mcp.tool(annotations=WRITE)
async def update_chatbot_settings(
    workspace_id: str,
    settings: dict[str, Any],
    name: str | None = None,
    allowed_origins: list[str] | None = None,
) -> dict[str, Any]:
    """Update chatbot settings. Only the keys you pass change.

    Useful keys: botName, greeting, persona, guardrails (list of rules), quickReplies (list), disclaimer,
    brandColor, position (right/left), theme (auto/light/dark), launcherText, provider
    (anthropic/gemini/xai/openai/workers-ai), model, fallbacks (list), temperature, maxTokens,
    handoffEnabled, handoffKeywords (list), handoffMessage, offlineMessage, alertEmail, autoCloseHours,
    emailTranscripts, collectEmailBeforeChat, showSources, turnstileSiteKey, renderJs, recrawlDaily, sitemapUrl.
    """
    body: dict[str, Any] = {"settings": settings}
    if name:
        body["name"] = name
    if allowed_origins is not None:
        body["allowedOrigins"] = allowed_origins
    data = await get_client().patch(f"/workspaces/{S(workspace_id)}", body)
    return data["workspace"]


@mcp.tool(annotations=READ)
async def test_chatbot(workspace_id: str, question: str) -> dict[str, Any]:
    """Ask the live chatbot a question exactly as a visitor would (no conversation is created).
    Returns the answer, the provider/model used, whether it would hand off to a human, and its sources."""
    return await get_client().post(f"/workspaces/{S(workspace_id)}/test-chat", {"question": question})


@mcp.tool(annotations=READ)
async def get_platform_status() -> dict[str, Any]:
    """Which integrations are configured on the Worker: Claude, Gemini, Grok, OpenAI, Workers AI,
    AI Gateway, Vectorize, Browser Rendering, Turnstile, Supabase mirror and email."""
    return await get_client().get("/providers")


# ------------------------------------------------------------------------------------------------
# Support inbox
# ------------------------------------------------------------------------------------------------


@mcp.tool(annotations=READ)
async def list_conversations(
    workspace_id: str,
    status: Literal["open", "closed", "all"] = "open",
    assignee: str | None = None,
    mode: Literal["human", "bot", "flow"] | None = None,
    query: str | None = None,
    customer_id: str | None = None,
    limit: int = 25,
) -> dict[str, Any]:
    """List inbox conversations. Conversations waiting for a first human reply are listed first.

    Args:
        status: open, closed or all.
        assignee: "unassigned", "me", or an agent id.
        mode: "human" = handed off to the team, "bot" = AI is answering, "flow" = in a chatbot flow.
        query: Full-text search over messages plus customer name/email and subject (find by topic or customer).
        customer_id: Only this customer's conversations.
    """
    data = await get_client().get(
        f"/workspaces/{S(workspace_id)}/conversations",
        status=status,
        assignee=assignee,
        mode=mode,
        q=query,
        customer_id=customer_id,
        limit=limit,
    )
    return {
        "conversations": [
            {
                "id": c["id"],
                "status": c["status"],
                "mode": c["mode"],
                "customer": c.get("customer_name") or c.get("customer_email") or c["customer_id"],
                "customer_id": c["customer_id"],
                "subject": c.get("subject"),
                "last_message": c.get("last_message_preview"),
                "last_message_at": c["last_message_at"],
                "assignee": c.get("assignee_name"),
                "waiting_for_first_reply": c["mode"] == "human" and c["status"] == "open" and not c.get("first_response_at"),
                "message_count": c["message_count"],
                "page_url": c.get("page_url"),
            }
            for c in data["conversations"]
        ],
        "next_before": data.get("next_before"),
    }


@mcp.tool(annotations=READ)
async def get_conversation(conversation_id: str) -> dict[str, Any]:
    """Read a full conversation thread with customer details, assignee and whether the visitor is online now."""
    return await get_client().get(f"/conversations/{S(conversation_id)}")


@mcp.tool(annotations=CUSTOMER_FACING)
async def reply_to_conversation(conversation_id: str, message: str, confirmed: bool = False) -> dict[str, Any]:
    """Send a reply to the customer (they see it live in the chat widget, or by email if they left).

    IMPORTANT: Show the exact message to the user and get explicit approval first. Call with
    confirmed=False to get a preview; only call with confirmed=True after the user says to send it.
    """
    if not confirmed:
        return {
            "sent": False,
            "preview": message,
            "conversation_id": conversation_id,
            "note": "Not sent. Show this preview to the user and call again with confirmed=True once they approve.",
        }
    data = await get_client().post(f"/conversations/{S(conversation_id)}/reply", {"content": message})
    return {"sent": True, "message": data["message"]}


@mcp.tool(annotations=WRITE)
async def add_internal_note(conversation_id: str, note: str) -> dict[str, Any]:
    """Add an internal note to a conversation. Notes are only visible to the team, never to the customer."""
    return await get_client().post(f"/conversations/{S(conversation_id)}/note", {"content": note})


@mcp.tool(annotations=READ)
async def suggest_reply(conversation_id: str, instructions: str | None = None) -> dict[str, Any]:
    """Draft a reply grounded in the knowledge base for a human agent to review. Nothing is sent.

    Args:
        instructions: Optional guidance, e.g. "offer a 10% discount" or "ask for their order number".
    """
    return await get_client().post(f"/conversations/{S(conversation_id)}/suggest-reply", {"instructions": instructions})


@mcp.tool(annotations=WRITE)
async def summarize_conversation(conversation_id: str) -> dict[str, Any]:
    """Summarize a conversation (intent, sentiment, next steps). The summary is saved on the conversation."""
    return await get_client().post(f"/conversations/{S(conversation_id)}/summarize")


@mcp.tool(annotations=READ)
async def export_conversation_transcript(conversation_id: str) -> dict[str, Any]:
    """Export a conversation as a Markdown transcript."""
    return await get_client().get(f"/conversations/{S(conversation_id)}/transcript")


@mcp.tool(annotations=WRITE)
async def assign_conversation(
    conversation_id: str, agent_id: str | None = None, assign_to_me: bool = False
) -> dict[str, Any]:
    """Assign a conversation to a teammate (agent_id from list_agents), to yourself, or unassign (no agent_id)."""
    body: dict[str, Any] = {"me": True} if assign_to_me else {"agent_id": agent_id}
    return await get_client().post(f"/conversations/{S(conversation_id)}/assign", body)


@mcp.tool(annotations=CUSTOMER_FACING)
async def close_conversation(conversation_id: str, confirmed: bool = False) -> dict[str, Any]:
    """Close a conversation. The customer sees a "conversation closed" message and is asked for a rating;
    a transcript is emailed to them if that setting is on.

    IMPORTANT: This messages the customer. Call with confirmed=False to get a preview; only call with
    confirmed=True after the user says to close it.
    """
    if not confirmed:
        return {
            "closed": False,
            "conversation_id": conversation_id,
            "note": "Not closed. Closing shows the customer a closed message and rating prompt, and may email "
            "them the transcript. Ask the user, then call again with confirmed=True once they approve.",
        }
    data = await get_client().post(f"/conversations/{S(conversation_id)}/close")
    return {"closed": True, **data}


@mcp.tool(annotations=WRITE)
async def reopen_conversation(conversation_id: str) -> dict[str, Any]:
    """Reopen a closed conversation."""
    return await get_client().post(f"/conversations/{S(conversation_id)}/reopen")


@mcp.tool(annotations=WRITE)
async def return_conversation_to_bot(conversation_id: str) -> dict[str, Any]:
    """Hand a conversation back from the human team to the AI chatbot."""
    return await get_client().post(f"/conversations/{S(conversation_id)}/return-to-bot")


@mcp.tool(annotations=READ)
async def get_inbox_stats(workspace_id: str, days: int = 7) -> dict[str, Any]:
    """Support metrics: conversation volume, open/unassigned now, handoff rate, bot resolution rate,
    average first-response and resolution times, CSAT, daily volume, top pages and AI token usage."""
    return await get_client().get(f"/workspaces/{S(workspace_id)}/stats", days=days)


# ------------------------------------------------------------------------------------------------
# Customers
# ------------------------------------------------------------------------------------------------


@mcp.tool(annotations=READ)
async def search_customers(workspace_id: str, query: str = "", limit: int = 25) -> dict[str, Any]:
    """Find customers by name, email, phone, id or collected attribute. Empty query = most recent visitors."""
    return await get_client().get(f"/workspaces/{S(workspace_id)}/customers", q=query, limit=limit)


@mcp.tool(annotations=READ)
async def get_customer(customer_id: str) -> dict[str, Any]:
    """Get a customer's contact details, collected information (location, flow answers) and conversation history."""
    return await get_client().get(f"/customers/{S(customer_id)}")


@mcp.tool(annotations=WRITE)
async def update_customer(
    customer_id: str,
    name: str | None = None,
    email: str | None = None,
    phone: str | None = None,
    attributes: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Update a customer's contact details or custom attributes (e.g. plan, company)."""
    body = {k: v for k, v in {"name": name, "email": email, "phone": phone, "attributes": attributes}.items() if v is not None}
    return await get_client().patch(f"/customers/{S(customer_id)}", body)


# ------------------------------------------------------------------------------------------------
# Knowledge base
# ------------------------------------------------------------------------------------------------


@mcp.tool(annotations=READ)
async def search_knowledge_base(workspace_id: str, query: str, limit: int = 6) -> dict[str, Any]:
    """Search the content the chatbot answers from (hybrid semantic + keyword search). Use it to draft
    accurate replies or to check what the bot knows about a topic."""
    return await get_client().get(f"/workspaces/{S(workspace_id)}/kb/search", q=query, limit=limit)


@mcp.tool(annotations=READ)
async def list_knowledge_documents(workspace_id: str, limit: int = 100, offset: int = 0) -> dict[str, Any]:
    """List indexed pages and manual documents in the knowledge base."""
    return await get_client().get(f"/workspaces/{S(workspace_id)}/kb/documents", limit=limit, offset=offset)


@mcp.tool(annotations=WRITE)
async def add_knowledge_document(workspace_id: str, title: str, content: str, url: str | None = None) -> dict[str, Any]:
    """Teach the chatbot something: add an FAQ answer, policy or product fact. Re-adding the same url
    replaces the previous version."""
    return await get_client().post(
        f"/workspaces/{S(workspace_id)}/kb/documents", {"title": title, "content": content, "url": url}
    )


@mcp.tool(annotations=DESTRUCTIVE)
async def delete_knowledge_document(workspace_id: str, document_id: str) -> dict[str, Any]:
    """Remove a document from the knowledge base so the bot stops using it."""
    return await get_client().delete(f"/workspaces/{S(workspace_id)}/kb/documents/{S(document_id)}")


@mcp.tool(annotations=WRITE)
async def crawl_website(workspace_id: str, url: str | None = None, max_pages: int = 150, max_depth: int = 3) -> dict[str, Any]:
    """(Re)crawl a website into the knowledge base. Defaults to the workspace's own domain.
    Progress is visible in get_setup_status."""
    return await get_client().post(
        f"/workspaces/{S(workspace_id)}/crawl", {"url": url, "maxPages": max_pages, "maxDepth": max_depth}
    )


# ------------------------------------------------------------------------------------------------
# Chatbot flows (scenarios)
# ------------------------------------------------------------------------------------------------


@mcp.tool(annotations=READ)
async def list_scenarios(workspace_id: str) -> dict[str, Any]:
    """List chatbot flows. At most one is 'active' (live on the site)."""
    return await get_client().get(f"/workspaces/{S(workspace_id)}/scenarios")


@mcp.tool(annotations=READ)
async def get_scenario(workspace_id: str, scenario_id: str) -> dict[str, Any]:
    """Get a flow with all steps, how they link together, and a list of problems that would block publishing."""
    return await get_client().get(f"/workspaces/{S(workspace_id)}/scenarios/{S(scenario_id)}")


@mcp.tool(annotations=WRITE)
async def create_scenario(workspace_id: str, name: str) -> dict[str, Any]:
    """Create an empty draft flow. Add steps with add_scenario_step; the first step becomes the start step."""
    return await get_client().post(f"/workspaces/{S(workspace_id)}/scenarios", {"name": name})


@mcp.tool(annotations=WRITE)
async def import_scenario(workspace_id: str, definition: dict[str, Any]) -> dict[str, Any]:
    """Create a complete flow in one call from a definition that references steps by key:

    {"name": "Welcome", "start": "hello", "activate": false, "steps": [
      {"key": "hello", "type": "message", "content": "Hi!", "next": "menu"},
      {"key": "menu", "type": "buttons", "content": "How can we help?", "variable": "topic",
       "options": [{"label": "Pricing", "next": "ai"}, {"label": "Talk to sales", "next": "email"}]},
      {"key": "email", "type": "collect_email", "content": "Your email?", "next": "handoff"},
      {"key": "handoff", "type": "handoff", "content": "Thanks {{email}}, connecting you now."},
      {"key": "ai", "type": "ai", "content": "Ask me anything about pricing."}]}
    """
    return await get_client().post(f"/workspaces/{S(workspace_id)}/scenarios", {"definition": definition})


@mcp.tool(annotations=WRITE)
async def rename_scenario(workspace_id: str, scenario_id: str, name: str) -> dict[str, Any]:
    """Rename a chatbot flow (scenario); the flow keeps its steps and published status."""
    return await get_client().patch(f"/workspaces/{S(workspace_id)}/scenarios/{S(scenario_id)}", {"name": name})


@mcp.tool(annotations=WRITE)
async def add_scenario_step(
    workspace_id: str,
    scenario_id: str,
    type: StepType,
    content: str = "",
    options: list[str] | None = None,
    variable: str | None = None,
    validation: Literal["text", "email", "phone"] | None = None,
    next_step_id: str | None = None,
    previous_step_id: str | None = None,
) -> dict[str, Any]:
    """Add a step to a flow.

    Step types: message (bot says something then continues), question (waits for free text, saved to
    `variable`), buttons (menu of `options`), collect_email (asks for and validates an email), ai (hands
    over to AI answers), handoff (routes to a human). Use {{variable}} in content to insert saved answers.

    Args:
        previous_step_id: Link this new step after an existing step (sets that step's next_step_id).
        next_step_id: Step to go to after this one.
        options: Button labels for a buttons step. Link each option with update_scenario_step afterwards
            (config.options[i].next_step_id), otherwise they continue to this step's next_step_id or AI.
    """
    config: dict[str, Any] = {}
    if options:
        config["options"] = [{"label": o} for o in options]
    if variable:
        config["variable"] = variable
    if validation:
        config["validation"] = validation
    if next_step_id:
        config["next_step_id"] = next_step_id
    return await get_client().post(
        f"/workspaces/{S(workspace_id)}/scenarios/{S(scenario_id)}/steps",
        {"type": type, "content": content, "config": config, "previous_step_id": previous_step_id},
    )


@mcp.tool(annotations=WRITE)
async def update_scenario_step(
    workspace_id: str,
    scenario_id: str,
    step_id: str,
    content: str | None = None,
    type: StepType | None = None,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Update a step's text, type or config. Config keys: next_step_id, options
    ([{"label": "...", "next_step_id": "..."}]), variable, validation, error_message, fallback ("ai" or "repeat")."""
    body = {k: v for k, v in {"content": content, "type": type, "config": config}.items() if v is not None}
    return await get_client().patch(
        f"/workspaces/{S(workspace_id)}/scenarios/{S(scenario_id)}/steps/{S(step_id)}", body
    )


@mcp.tool(annotations=DESTRUCTIVE)
async def delete_scenario_step(workspace_id: str, scenario_id: str, step_id: str) -> dict[str, Any]:
    """Delete a step. Links pointing at it are re-routed to its next step."""
    return await get_client().delete(f"/workspaces/{S(workspace_id)}/scenarios/{S(scenario_id)}/steps/{S(step_id)}")


@mcp.tool(annotations=WRITE)
async def set_scenario_start_step(workspace_id: str, scenario_id: str, step_id: str) -> dict[str, Any]:
    """Choose which step a flow starts with."""
    return await get_client().post(
        f"/workspaces/{S(workspace_id)}/scenarios/{S(scenario_id)}/start", {"step_id": step_id}
    )


@mcp.tool(annotations=CUSTOMER_FACING)
async def activate_scenario(workspace_id: str, scenario_id: str) -> dict[str, Any]:
    """Publish a flow so new website visitors see it (replaces the currently live flow). Confirm with the
    user first. Fails with a list of problems if the flow is incomplete."""
    return await get_client().post(f"/workspaces/{S(workspace_id)}/scenarios/{S(scenario_id)}/activate")


@mcp.tool(annotations=WRITE)
async def deactivate_scenario(workspace_id: str, scenario_id: str) -> dict[str, Any]:
    """Unpublish a flow; visitors then get the greeting and AI answers directly."""
    return await get_client().post(f"/workspaces/{S(workspace_id)}/scenarios/{S(scenario_id)}/deactivate")


@mcp.tool(annotations=DESTRUCTIVE)
async def delete_scenario(workspace_id: str, scenario_id: str) -> dict[str, Any]:
    """Delete a flow and all its steps."""
    return await get_client().delete(f"/workspaces/{S(workspace_id)}/scenarios/{S(scenario_id)}")


# ------------------------------------------------------------------------------------------------
# Team & notifications
# ------------------------------------------------------------------------------------------------


@mcp.tool(annotations=READ)
async def list_agents() -> dict[str, Any]:
    """List team members (agents) who can answer conversations, with ids for assign_conversation."""
    return await get_client().get("/agents")


@mcp.tool(annotations=WRITE)
async def create_agent(
    name: str, email: str, role: Literal["agent", "admin"] = "agent", workspace_ids: list[str] | None = None
) -> dict[str, Any]:
    """Invite a teammate. Returns a sign-in token for the /inbox web app (shown once).
    workspace_ids limits which websites they can see (empty = all)."""
    return await get_client().post(
        "/agents", {"name": name, "email": email, "role": role, "workspace_ids": workspace_ids or []}
    )


@mcp.tool(annotations=READ)
async def list_webhooks(workspace_id: str) -> dict[str, Any]:
    """List Slack / Discord / generic webhooks that get notified about new conversations, handoffs and leads."""
    return await get_client().get(f"/workspaces/{S(workspace_id)}/webhooks")


@mcp.tool(annotations=WRITE)
async def add_webhook(
    workspace_id: str,
    url: str,
    kind: Literal["slack", "discord", "generic"] = "slack",
    events: list[
        Literal["conversation.created", "handoff", "message.visitor", "conversation.closed", "lead.captured"]
    ]
    | None = None,
) -> dict[str, Any]:
    """Send notifications to Slack (incoming webhook URL), Discord (webhook URL) or any HTTPS endpoint
    (generic, HMAC-signed with the returned secret)."""
    return await get_client().post(
        f"/workspaces/{S(workspace_id)}/webhooks", {"url": url, "kind": kind, "events": events}
    )


# ------------------------------------------------------------------------------------------------
# Prompts: reusable workflows
# ------------------------------------------------------------------------------------------------


@mcp.prompt(title="Triage the support inbox")
def triage_inbox(workspace_id: str) -> str:
    """Walk through open conversations that need a human and draft replies."""
    return (
        f"Use the AWebChatbot tools for workspace {workspace_id}. "
        "1) get_inbox_stats(days=1) for a quick overview. "
        "2) list_conversations(status='open', mode='human'). "
        "3) For each conversation waiting for a first reply: get_conversation, then suggest_reply. "
        "Show me each draft with the customer's last message and wait for my approval before calling "
        "reply_to_conversation(confirmed=True). Suggest assign/close actions but do not take them without asking."
    )


@mcp.prompt(title="Improve the chatbot from real conversations")
def improve_chatbot(workspace_id: str, days: int = 7) -> str:
    """Find knowledge gaps from recent handoffs and propose fixes."""
    return (
        f"For workspace {workspace_id}, review the last {days} days: get_inbox_stats, then list_conversations "
        "(status='all', mode='human') and read the handoffs. Group the questions the bot could not answer, "
        "check search_knowledge_base for each topic, and propose: new add_knowledge_document entries (full text), "
        "persona/guardrail changes via update_chatbot_settings, and flow changes. Verify each fix with "
        "test_chatbot before and after. Ask me before applying changes."
    )


@mcp.prompt(title="Set up the chatbot on a new website")
def setup_website(url: str, platform: str = "html") -> str:
    """End-to-end website setup."""
    return (
        f"Add the AWebChatbot to {url}: call add_chatbot_to_website, then poll get_setup_status until the crawl "
        f"is done, run test_chatbot with 3 realistic visitor questions, and finally get_widget_install_code "
        f"for platform '{platform}'. If you can edit the site's code, add the snippet for me; otherwise give me "
        "the exact steps."
    )
