#!/usr/bin/env python3
"""Provision chatbots for your websites from the presets in ../sites/*.json.

For each site it creates (or updates) the workspace on your AWebChatbot Worker, seeds knowledge,
publishes the preset chatbot flow, starts a crawl, optionally adds a Slack/Discord webhook, and writes:
  - install/<site>.html                       ready-to-paste widget snippet
  - integrations/cloudflare-injector/wrangler.toml   widget URL + key filled in for each [env.<site>]

Usage:
  export AWEBCHATBOT_URL=https://awebchatbot.<subdomain>.workers.dev
  export AWEBCHATBOT_TOKEN=<ADMIN_TOKEN>
  python3 scripts/provision.py                     # all presets
  python3 scripts/provision.py robomodal betmodal  # some presets
  python3 scripts/provision.py --webhook https://hooks.slack.com/services/... --webhook-kind slack
  python3 scripts/provision.py --no-crawl --dry-run

Only the Python standard library is used.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITES_DIR = ROOT / "sites"
INSTALL_DIR = ROOT / "install"
INJECTOR_TOML = ROOT / "integrations" / "cloudflare-injector" / "wrangler.toml"


class ApiError(RuntimeError):
    pass


class Api:
    def __init__(self, base: str, token: str) -> None:
        self.base = base.rstrip("/")
        self.token = token

    def call(self, method: str, path: str, body: dict | None = None) -> dict:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            f"{self.base}/admin{path}",
            data=data,
            method=method,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
                "User-Agent": "awebchatbot-provision/1.0",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as res:
                return json.loads(res.read().decode() or "{}")
        except urllib.error.HTTPError as err:
            detail = err.read().decode(errors="replace")
            try:
                detail = json.loads(detail).get("error", detail)
            except ValueError:
                pass
            raise ApiError(f"{method} {path} -> {err.code}: {detail}") from None
        except urllib.error.URLError as err:
            raise ApiError(f"{method} {path} -> {err.reason}") from None


def domain_of(url: str) -> str:
    host = re.sub(r"^https?://", "", url.strip().lower()).split("/")[0]
    return host[4:] if host.startswith("www.") else host


def load_presets(names: list[str]) -> list[tuple[str, dict]]:
    files = sorted(SITES_DIR.glob("*.json"))
    presets = [(f.stem, json.loads(f.read_text(encoding="utf-8"))) for f in files]
    if names:
        wanted = {n.lower().removesuffix(".json") for n in names}
        unknown = wanted - {stem for stem, _ in presets}
        if unknown:
            sys.exit(f"Unknown preset(s): {', '.join(sorted(unknown))}. Available: {', '.join(s for s, _ in presets)}")
        presets = [(stem, p) for stem, p in presets if stem in wanted]
    return presets


def update_injector(base: str, keys: dict[str, str]) -> None:
    if not INJECTOR_TOML.exists():
        return
    text = INJECTOR_TOML.read_text(encoding="utf-8")
    widget = f"{base}/widget.js"
    text = re.sub(r'WIDGET_SRC = "[^"]*"', f'WIDGET_SRC = "{widget}"', text)
    for stem, key in keys.items():
        pattern = re.compile(rf'(\[env\.{re.escape(stem)}\](?:(?!\n\[).)*?WIDGET_KEY = ")[^"]*(")', re.S)
        text = pattern.sub(rf"\g<1>{key}\g<2>", text)
    INJECTOR_TOML.write_text(text, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("sites", nargs="*", help="preset names (file stems in sites/); default = all")
    parser.add_argument("--url", default=os.environ.get("AWEBCHATBOT_URL", ""), help="Worker URL")
    parser.add_argument("--token", default=os.environ.get("AWEBCHATBOT_TOKEN", ""), help="ADMIN_TOKEN")
    parser.add_argument("--no-crawl", action="store_true", help="skip crawling")
    parser.add_argument("--webhook", help="Slack/Discord/HTTPS webhook URL for handoff + new-conversation alerts")
    parser.add_argument("--webhook-kind", choices=["slack", "discord", "generic"], default="slack")
    parser.add_argument("--dry-run", action="store_true", help="print what would happen")
    args = parser.parse_args()

    if not args.url or not args.token:
        sys.exit("Set AWEBCHATBOT_URL and AWEBCHATBOT_TOKEN (or pass --url/--token).")

    presets = load_presets(args.sites)
    api = Api(args.url, args.token)
    base = args.url.rstrip("/")

    if args.dry_run:
        for stem, p in presets:
            print(f"[dry-run] {stem}: {p['url']} — flow '{p.get('flow', {}).get('name', '-')}', {len(p.get('knowledge', []))} knowledge docs")
        return

    existing = {w["domain"]: w for w in api.call("GET", "/workspaces")["workspaces"]}
    INSTALL_DIR.mkdir(exist_ok=True)
    keys: dict[str, str] = {}

    for stem, preset in presets:
        domain = domain_of(preset["url"])
        print(f"\n=== {preset.get('name', stem)} ({domain}) ===")
        if domain in existing:
            ws = existing[domain]
            print(f"  workspace exists: {ws['id']} — updating settings")
            api.call("PATCH", f"/workspaces/{ws['id']}", {"name": preset.get("name"), "settings": preset.get("settings", {})})
            for doc in preset.get("knowledge", []):
                api.call("POST", f"/workspaces/{ws['id']}/kb/documents", doc)
            if preset.get("flow"):
                names = {s["name"] for s in api.call("GET", f"/workspaces/{ws['id']}/scenarios")["scenarios"]}
                if preset["flow"]["name"] not in names:
                    api.call("POST", f"/workspaces/{ws['id']}/scenarios", {"definition": preset["flow"]})
                    print(f"  flow '{preset['flow']['name']}' created")
                else:
                    print(f"  flow '{preset['flow']['name']}' already exists (left unchanged)")
            if not args.no_crawl:
                job = api.call("POST", f"/workspaces/{ws['id']}/crawl", {"maxPages": preset.get("maxPages", 150)})
                print(f"  crawl started: {job['crawl']['id']} ({job['crawl']['pages_queued']} pages queued)")
            ws_id, key = ws["id"], ws["publicKey"]
        else:
            result = api.call(
                "POST",
                "/workspaces",
                {
                    "url": preset["url"],
                    "name": preset.get("name"),
                    "settings": preset.get("settings", {}),
                    "flow": preset.get("flow"),
                    "knowledge": preset.get("knowledge", []),
                    "crawl": not args.no_crawl,
                    "maxPages": preset.get("maxPages", 150),
                },
            )
            ws_id, key = result["workspace"]["id"], result["workspace"]["publicKey"]
            print(f"  created workspace {ws_id}")
            if result.get("flow"):
                print(f"  flow '{result['flow']['name']}' -> {result['flow']['status']}")
            if result.get("crawl"):
                print(f"  crawl started ({result['crawl']['pages_queued']} pages queued)")

        if args.webhook:
            api.call("POST", f"/workspaces/{ws_id}/webhooks", {"url": args.webhook, "kind": args.webhook_kind})
            print(f"  {args.webhook_kind} webhook added")

        snippet = f'<script src="{base}/widget.js" data-key="{key}" async></script>\n'
        (INSTALL_DIR / f"{stem}.html").write_text(snippet, encoding="utf-8")
        keys[stem] = key
        print(f"  widget key: {key}")
        print(f"  snippet:    install/{stem}.html")
        print(f"  inbox:      {base}/inbox/#/{ws_id}")

    update_injector(base, keys)
    print("\nDone. Cloudflare injector config updated with your widget keys:")
    print(f"  {INJECTOR_TOML.relative_to(ROOT)}  (deploy with: cd integrations/cloudflare-injector && npx wrangler deploy --env <site>)")


if __name__ == "__main__":
    try:
        main()
    except ApiError as exc:
        sys.exit(f"API error: {exc}")
