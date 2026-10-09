import json
import os

import httpx
import pytest

from awebchatbot_mcp import server
from awebchatbot_mcp.__main__ import BearerAuthMiddleware
from awebchatbot_mcp.client import AWebChatbotClient, AWebChatbotError

EXPECTED_TOOLS = {
    # Tools named in the project brief
    "activate_scenario",
    "add_chatbot_to_website",
    "add_scenario_step",
    "assign_conversation",
    "close_conversation",
    "create_scenario",
    "delete_scenario_step",
    "get_conversation",
    "get_customer",
    "get_inbox_stats",
    "get_scenario",
    "get_setup_status",
    "get_widget_install_code",
    "list_conversations",
    "list_scenarios",
    "list_workspaces",
    "rename_scenario",
    "reply_to_conversation",
    "search_customers",
    "search_knowledge_base",
    "set_scenario_start_step",
    "update_scenario_step",
    # Extras
    "suggest_reply",
    "summarize_conversation",
    "test_chatbot",
    "add_knowledge_document",
    "crawl_website",
    "update_chatbot_settings",
    "import_scenario",
    "add_webhook",
    "create_agent",
}


class Recorder:
    def __init__(self, responses):
        self.calls = []
        self.responses = responses

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        self.calls.append((request.method, request.url.raw_path.decode().split("?")[0], dict(request.url.params), body, request.headers.get("authorization")))
        for (method, path), (status, payload) in self.responses.items():
            if request.method == method and request.url.raw_path.decode().split("?")[0] == path:
                return httpx.Response(status, json=payload)
        return httpx.Response(404, json={"error": "not mocked"})


@pytest.fixture
def mock(request):
    recorder = Recorder(getattr(request, "param", {}))
    client = AWebChatbotClient("https://chat.example.com", "secret-token", transport=httpx.MockTransport(recorder))
    server.set_client(client)
    yield recorder
    server.set_client(None)


async def test_all_expected_tools_are_registered():
    tools = await server.mcp.list_tools()
    names = {t.name for t in tools}
    missing = EXPECTED_TOOLS - names
    assert not missing, f"missing tools: {missing}"


async def test_tools_have_descriptions_and_annotations():
    for tool in await server.mcp.list_tools():
        assert tool.description and len(tool.description) > 20, tool.name
        assert tool.annotations is not None, tool.name


@pytest.mark.parametrize(
    "mock",
    [{("GET", "/admin/workspaces"): (200, {"workspaces": [{"id": "ws_1", "name": "Robomodal", "domain": "robomodal.com", "publicKey": "pk_1", "settings": {"provider": "anthropic", "botName": "Robo"}}]})}],
    indirect=True,
)
async def test_list_workspaces_shapes_output(mock):
    result = await server.list_workspaces()
    assert result["workspaces"][0] == {
        "id": "ws_1",
        "name": "Robomodal",
        "domain": "robomodal.com",
        "public_key": "pk_1",
        "provider": "anthropic",
        "bot_name": "Robo",
    }
    assert mock.calls[0][4] == "Bearer secret-token"


@pytest.mark.parametrize("mock", [{("POST", "/admin/conversations/conv_1/reply"): (200, {"message": {"id": "m1"}})}], indirect=True)
async def test_reply_requires_confirmation(mock):
    preview = await server.reply_to_conversation("conv_1", "Hello there", confirmed=False)
    assert preview["sent"] is False
    assert mock.calls == []
    sent = await server.reply_to_conversation("conv_1", "Hello there", confirmed=True)
    assert sent["sent"] is True
    assert mock.calls[0][3] == {"content": "Hello there"}


@pytest.mark.parametrize("mock", [{("GET", "/admin/workspaces/ws_1/conversations"): (200, {"conversations": [], "next_before": None})}], indirect=True)
async def test_list_conversations_passes_filters_and_drops_empty(mock):
    await server.list_conversations("ws_1", status="open", mode="human", query="refund")
    method, path, params, _, _ = mock.calls[0]
    assert params == {"status": "open", "mode": "human", "q": "refund", "limit": "25"}


@pytest.mark.parametrize("mock", [{("POST", "/admin/workspaces/ws_1/scenarios/scn_1/steps"): (201, {"scenario": {}})}], indirect=True)
async def test_add_scenario_step_builds_config(mock):
    await server.add_scenario_step("ws_1", "scn_1", "buttons", "Pick one", options=["A", "B"], variable="topic", previous_step_id="step_0")
    body = mock.calls[0][3]
    assert body == {
        "type": "buttons",
        "content": "Pick one",
        "config": {"options": [{"label": "A"}, {"label": "B"}], "variable": "topic"},
        "previous_step_id": "step_0",
    }


@pytest.mark.parametrize("mock", [{("GET", "/admin/workspaces/ws_1/setup-status"): (403, {"error": "No access to this workspace"})}], indirect=True)
async def test_api_errors_raise(mock):
    with pytest.raises(AWebChatbotError) as err:
        await server.get_setup_status("ws_1")
    assert err.value.status == 403
    assert "No access" in err.value.message


async def test_path_segments_are_encoded(mock):
    with pytest.raises(AWebChatbotError):
        await server.get_conversation("a/b")
    assert mock.calls[0][1] == "/admin/conversations/a%2Fb"


async def test_bearer_middleware_blocks_and_allows():
    seen = []

    async def app(scope, receive, send):
        seen.append(scope["path"])
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    mw = BearerAuthMiddleware(app, "x" * 30)
    sent = []

    async def send(msg):
        sent.append(msg)

    async def receive():
        return {"type": "http.request"}

    await mw({"type": "http", "path": "/mcp", "headers": [(b"authorization", b"Bearer wrong")]}, receive, send)
    assert sent[0]["status"] == 401 and seen == []
    sent.clear()
    await mw({"type": "http", "path": "/mcp", "headers": [(b"authorization", b"Bearer " + b"x" * 30)]}, receive, send)
    assert sent[0]["status"] == 200 and seen == ["/mcp"]
    sent.clear()
    await mw({"type": "http", "path": "/health", "headers": []}, receive, send)
    assert sent[0]["status"] == 200


@pytest.mark.skipif(not os.environ.get("AWEBCHATBOT_LIVE_URL"), reason="set AWEBCHATBOT_LIVE_URL + AWEBCHATBOT_LIVE_TOKEN for a live test")
async def test_live_round_trip():
    server.set_client(AWebChatbotClient(os.environ["AWEBCHATBOT_LIVE_URL"], os.environ["AWEBCHATBOT_LIVE_TOKEN"]))
    try:
        workspaces = await server.list_workspaces()
        assert "workspaces" in workspaces
        if workspaces["workspaces"]:
            ws = workspaces["workspaces"][0]["id"]
            status = await server.get_setup_status(ws)
            assert status["checklist"]
            convs = await server.list_conversations(ws, status="all")
            assert "conversations" in convs
            code = await server.get_widget_install_code(ws, "nextjs")
            assert "widget.js" in code["snippet"]
    finally:
        server.set_client(None)
