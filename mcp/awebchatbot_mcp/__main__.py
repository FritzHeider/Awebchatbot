"""Entry point: `awebchatbot-mcp` (stdio, for Claude Desktop / Claude Code) or `awebchatbot-mcp --http` (Fly.io)."""

from __future__ import annotations

import argparse
import hmac
import os
from typing import Any, Awaitable, Callable

from .server import mcp

Scope = dict[str, Any]
Receive = Callable[[], Awaitable[dict[str, Any]]]
Send = Callable[[dict[str, Any]], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]


class BearerAuthMiddleware:
    """Require `Authorization: Bearer <MCP_AUTH_TOKEN>` on every HTTP request except /health."""

    def __init__(self, app: ASGIApp, token: str) -> None:
        self.app = app
        self.token = token.encode()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        if scope.get("path") == "/health":
            await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"application/json")]})
            await send({"type": "http.response.body", "body": b'{"ok":true}'})
            return
        headers = dict(scope.get("headers") or [])
        auth = headers.get(b"authorization", b"")
        expected = b"Bearer " + self.token
        if not hmac.compare_digest(auth, expected):
            await send(
                {
                    "type": "http.response.start",
                    "status": 401,
                    "headers": [(b"content-type", b"application/json"), (b"www-authenticate", b"Bearer")],
                }
            )
            await send({"type": "http.response.body", "body": b'{"error":"unauthorized"}'})
            return
        await self.app(scope, receive, send)


def build_http_app() -> ASGIApp:
    token = os.environ.get("MCP_AUTH_TOKEN", "")
    if len(token) < 24:
        raise SystemExit("Set MCP_AUTH_TOKEN (24+ random characters) before serving MCP over HTTP.")
    app = mcp.streamable_http_app(host="0.0.0.0", stateless_http=True)
    return BearerAuthMiddleware(app, token)


def main() -> None:
    parser = argparse.ArgumentParser(description="AWebChatbot MCP server")
    parser.add_argument("--http", action="store_true", help="Serve Streamable HTTP at /mcp instead of stdio")
    parser.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8080")))
    args = parser.parse_args()
    if args.http:
        import uvicorn

        uvicorn.run(build_http_app(), host=args.host, port=args.port, proxy_headers=True, forwarded_allow_ips="*")
    else:
        mcp.run("stdio")


if __name__ == "__main__":
    main()
