"""Thin async client for the AWebChatbot Worker admin API."""

from __future__ import annotations

import os
from typing import Any
from urllib.parse import quote

import httpx


class AWebChatbotError(RuntimeError):
    """Raised when the admin API returns an error."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(f"{status}: {message}")
        self.status = status
        self.message = message


class AWebChatbotClient:
    def __init__(
        self,
        base_url: str | None = None,
        token: str | None = None,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout: float = 60.0,
    ) -> None:
        self.base_url = (base_url or os.environ.get("AWEBCHATBOT_URL", "")).rstrip("/")
        self.token = token or os.environ.get("AWEBCHATBOT_TOKEN", "")
        if not self.base_url:
            raise ValueError("Set AWEBCHATBOT_URL to your Worker URL, e.g. https://awebchatbot.<you>.workers.dev")
        if not self.token:
            raise ValueError("Set AWEBCHATBOT_TOKEN to the ADMIN_TOKEN secret or an agent token")
        self._client = httpx.AsyncClient(
            base_url=f"{self.base_url}/admin",
            headers={"Authorization": f"Bearer {self.token}", "User-Agent": "awebchatbot-mcp/1.0"},
            timeout=timeout,
            transport=transport,
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def request(self, method: str, path: str, *, json: Any = None, params: dict[str, Any] | None = None) -> Any:
        clean_params = {k: v for k, v in (params or {}).items() if v is not None and v != ""}
        response = await self._client.request(method, path, json=json, params=clean_params)
        try:
            data = response.json()
        except ValueError:
            data = {"error": response.text[:500]}
        if response.status_code >= 400:
            message = data.get("error") if isinstance(data, dict) else str(data)
            raise AWebChatbotError(response.status_code, message or response.reason_phrase)
        return data

    # Convenience wrappers -------------------------------------------------------------------
    async def get(self, path: str, **params: Any) -> Any:
        return await self.request("GET", path, params=params)

    async def post(self, path: str, body: Any | None = None) -> Any:
        return await self.request("POST", path, json=body if body is not None else {})

    async def patch(self, path: str, body: Any) -> Any:
        return await self.request("PATCH", path, json=body)

    async def delete(self, path: str) -> Any:
        return await self.request("DELETE", path)

    @staticmethod
    def seg(value: str) -> str:
        """URL-encode one path segment."""
        return quote(value, safe="")
