#!/usr/bin/env bash
# One-time Cloudflare setup for AWebChatbot.
# Creates D1, KV, R2, Vectorize, Queues; writes their IDs into worker/wrangler.toml; sets secrets;
# applies the database migration and deploys the Worker.
#
# Requirements: Node 20+, a Cloudflare account (Workers Paid plan recommended for Queues/Vectorize/Durable Objects),
# and either `npx wrangler login` or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in the environment.
#
# Usage:  ./scripts/bootstrap.sh            (interactive: asks for optional AI keys)
#         NONINTERACTIVE=1 ./scripts/bootstrap.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER="$ROOT/worker"
TOML="$WORKER/wrangler.toml"
cd "$WORKER"

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
wr() { npx --yes wrangler "$@"; }

command -v node >/dev/null || { echo "Node.js 20+ is required"; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required"; exit 1; }

say "Installing Worker dependencies"
npm install --no-fund --no-audit

say "Checking Cloudflare login"
wr whoami || { warn "Run: npx wrangler login   (or set CLOUDFLARE_API_TOKEN)"; exit 1; }

# ------------------------------------------------------------------------------------------------
say "D1 database"
wr d1 create awebchatbot >/dev/null 2>&1 || true
D1_ID="$(wr d1 list --json | python3 -c 'import json,sys; print(next(d["uuid"] for d in json.load(sys.stdin) if d["name"]=="awebchatbot"))')"
echo "database_id = $D1_ID"

say "KV namespace"
wr kv namespace create awebchatbot-cache >/dev/null 2>&1 || true
KV_ID="$(wr kv namespace list | python3 -c 'import json,sys; print(next(n["id"] for n in json.load(sys.stdin) if n["title"].endswith("awebchatbot-cache")))')"
echo "kv id = $KV_ID"

say "R2 bucket"
wr r2 bucket create awebchatbot-files >/dev/null 2>&1 || echo "(bucket already exists)"

say "Vectorize index (768 dims, cosine — matches @cf/baai/bge-base-en-v1.5)"
wr vectorize create awebchatbot-kb --dimensions=768 --metric=cosine >/dev/null 2>&1 || echo "(index already exists)"

say "Queues"
wr queues create awebchatbot-crawl >/dev/null 2>&1 || echo "(queue already exists)"
wr queues create awebchatbot-crawl-dlq >/dev/null 2>&1 || echo "(dead-letter queue already exists)"

say "Writing IDs into wrangler.toml"
python3 - "$TOML" "$D1_ID" "$KV_ID" <<'PY'
import re, sys
path, d1, kv = sys.argv[1:4]
text = open(path, encoding="utf-8").read()
text = re.sub(r'(database_name = "awebchatbot"\ndatabase_id = )"[^"]*"', rf'\1"{d1}"', text)
text = re.sub(r'(binding = "CACHE"\nid = )"[^"]*"', rf'\1"{kv}"', text)
open(path, "w", encoding="utf-8").write(text)
PY
grep -E 'database_id|^id = ' "$TOML"

ACCOUNT_ID="$(wr whoami 2>/dev/null | grep -Eo '[0-9a-f]{32}' | head -1 || true)"
if [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID"; fi
if [ -n "$ACCOUNT_ID" ]; then
  python3 - "$TOML" "$ACCOUNT_ID" <<'PY'
import re, sys
path, account = sys.argv[1:3]
text = open(path, encoding="utf-8").read()
text = re.sub(r'CF_ACCOUNT_ID = "[^"]*"', f'CF_ACCOUNT_ID = "{account}"', text)
open(path, "w", encoding="utf-8").write(text)
PY
  echo "CF_ACCOUNT_ID = $ACCOUNT_ID"
fi

# ------------------------------------------------------------------------------------------------
say "Secrets"
SECRETS_FILE="$ROOT/.awebchatbot-secrets"
if [ -f "$SECRETS_FILE" ]; then
  # shellcheck disable=SC1090
  source "$SECRETS_FILE"
fi
ADMIN_TOKEN="${ADMIN_TOKEN:-$(python3 -c 'import secrets; print(secrets.token_urlsafe(36))')}"
SIGNING_SECRET="${SIGNING_SECRET:-$(python3 -c 'import secrets; print(secrets.token_urlsafe(36))')}"
umask 077
cat > "$SECRETS_FILE" <<EOF
ADMIN_TOKEN=$ADMIN_TOKEN
SIGNING_SECRET=$SIGNING_SECRET
EOF
printf '%s' "$ADMIN_TOKEN" | wr secret put ADMIN_TOKEN
printf '%s' "$SIGNING_SECRET" | wr secret put SIGNING_SECRET

if [ -z "${NONINTERACTIVE:-}" ]; then
  for NAME in ANTHROPIC_API_KEY GEMINI_API_KEY XAI_API_KEY OPENAI_API_KEY TURNSTILE_SECRET CF_API_TOKEN AI_GATEWAY_TOKEN SUPABASE_URL SUPABASE_SERVICE_KEY RESEND_API_KEY RESEND_FROM ALERT_EMAIL; do
    read -r -s -p "$NAME (Enter to skip): " VALUE; echo
    if [ -n "$VALUE" ]; then printf '%s' "$VALUE" | wr secret put "$NAME"; fi
  done
else
  for NAME in ANTHROPIC_API_KEY GEMINI_API_KEY XAI_API_KEY OPENAI_API_KEY TURNSTILE_SECRET CF_API_TOKEN AI_GATEWAY_TOKEN SUPABASE_URL SUPABASE_SERVICE_KEY RESEND_API_KEY RESEND_FROM ALERT_EMAIL; do
    VALUE="${!NAME:-}"
    if [ -n "$VALUE" ]; then printf '%s' "$VALUE" | wr secret put "$NAME"; fi
  done
fi

# ------------------------------------------------------------------------------------------------
say "Applying database migrations"
wr d1 migrations apply awebchatbot --remote

say "Deploying"
DEPLOY_OUT="$(wr deploy 2>&1 | tee /dev/stderr)"
URL="$(printf '%s' "$DEPLOY_OUT" | grep -Eo 'https://[a-zA-Z0-9.-]+\.workers\.dev' | head -1 || true)"

if [ -n "$URL" ]; then
  python3 - "$TOML" "$URL" <<'PY'
import re, sys
path, url = sys.argv[1:3]
text = open(path, encoding="utf-8").read()
text = re.sub(r'PUBLIC_BASE_URL = "[^"]*"', f'PUBLIC_BASE_URL = "{url}"', text)
open(path, "w", encoding="utf-8").write(text)
PY
  wr deploy >/dev/null
fi

say "Done"
echo "Worker URL:   ${URL:-<see deploy output>}"
echo "Inbox:        ${URL:-<worker-url>}/inbox/"
echo "Admin token:  saved in $SECRETS_FILE (keep it private)"
echo
echo "Next:"
echo "  export AWEBCHATBOT_URL=${URL:-<worker-url>}"
echo "  export AWEBCHATBOT_TOKEN=\$(grep ADMIN_TOKEN $SECRETS_FILE | cut -d= -f2)"
echo "  python3 $ROOT/scripts/provision.py          # creates chatbots for breachmodal, isshereal, betmodal, robomodal"
