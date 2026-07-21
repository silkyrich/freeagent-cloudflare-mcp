#!/usr/bin/env bash
# One-shot setup for the FreeAgent → Claude connector.
# Creates the KV namespace, sets secrets, and deploys to your Cloudflare account.
# Re-runnable: safe to run again to update secrets or redeploy.
set -euo pipefail

cyan() { printf '\033[36m%s\033[0m\n' "$1"; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }
red() { printf '\033[31m%s\033[0m\n' "$1"; }

command -v node >/dev/null || { red "Node.js is required — https://nodejs.org"; exit 1; }
[ -d node_modules ] || { cyan "Installing dependencies…"; npm install; }

cyan "You'll need your FreeAgent dev app (https://dev.freeagent.com)."
cyan "Have the OAuth identifier (Client ID) + OAuth secret ready."
echo

# 1. Cloudflare login (no-op if already authed)
npx wrangler whoami >/dev/null 2>&1 || { cyan "Log in to Cloudflare…"; npx wrangler login; }

# 2. KV namespace — create and wire the id into wrangler.jsonc
if grep -q "<YOUR_OAUTH_KV_NAMESPACE_ID>" wrangler.jsonc; then
  cyan "Creating OAUTH_KV namespace…"
  KV_ID=$(npx wrangler kv namespace create OAUTH_KV 2>/dev/null | grep -oE '"id": "[a-f0-9]+"' | grep -oE '[a-f0-9]{32}')
  [ -n "$KV_ID" ] || { red "Could not parse KV namespace id — create it manually and paste into wrangler.jsonc"; exit 1; }
  sed -i.bak "s/<YOUR_OAUTH_KV_NAMESPACE_ID>/$KV_ID/" wrangler.jsonc && rm -f wrangler.jsonc.bak
  green "KV namespace created: $KV_ID"
else
  green "KV namespace already configured."
fi

# 3. Secrets
echo
read -rp "FREEAGENT_CLIENT_ID: " FREEAGENT_CLIENT_ID
read -rsp "FREEAGENT_CLIENT_SECRET: " FREEAGENT_CLIENT_SECRET; echo
[ -n "$FREEAGENT_CLIENT_ID" ] && [ -n "$FREEAGENT_CLIENT_SECRET" ] || { red "Both client id and secret are required."; exit 1; }

cyan "Pushing secrets…"
printf '%s' "$FREEAGENT_CLIENT_ID"     | npx wrangler secret put FREEAGENT_CLIENT_ID   >/dev/null
printf '%s' "$FREEAGENT_CLIENT_SECRET" | npx wrangler secret put FREEAGENT_CLIENT_SECRET >/dev/null
openssl rand -hex 32 | npx wrangler secret put COOKIE_ENCRYPTION_KEY >/dev/null
green "Secrets set."

# 4. Deploy
cyan "Deploying…"
npx wrangler deploy

echo
green "Done. Next steps:"
echo "  1. At https://dev.freeagent.com, add your OAuth client's Redirect URI:"
echo "       https://<your-worker>.workers.dev/callback   (see the deployed URL above)"
echo "  2. In claude.ai → Settings → Connectors → Add custom connector:"
echo "       https://<your-worker>.workers.dev/mcp"
echo "  3. Approve the FreeAgent login when prompted, and you're live."
