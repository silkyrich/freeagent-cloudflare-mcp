# FreeAgent → Claude Connector

A **remote, serverless** [MCP](https://modelcontextprotocol.io) connector that gives
Claude access to a FreeAgent company — running entirely on a Cloudflare Worker,
with **nothing on your own machine**. Built for the Williams of Hay rentals
(properties are modelled as FreeAgent projects), but generic to any FreeAgent company.

Connect it once in claude.ai (web, desktop, phone) or Claude Code and it follows
you everywhere: *"which bank transactions are unexplained?"*, *"list open invoices
for 1 Lion Street"*, *"explain that £120 payment as Repairs"*.

## Design

Follows the [Monzo → Claude connector](../monzo) pattern:

- **`@cloudflare/workers-oauth-provider`** front door — the Worker is a full OAuth
  server that Claude speaks to; grants live in an `OAUTH_KV` namespace.
- **Upstream bridge** — `/authorize` redirects to FreeAgent's approval page,
  `/callback` exchanges the code (Basic-auth token endpoint) and completes the grant.
- **`TokenStore` Durable Object** — the single authority for the FreeAgent token
  chain: all refreshes serialise through it, and a 6-hourly cron keeps the chain warm.
- **Owner lock** — the first FreeAgent identity to authorize owns the deployment,
  permanently. Anyone else is rejected before a grant exists.
- **Secrets** (`FREEAGENT_CLIENT_ID/SECRET`, `COOKIE_ENCRYPTION_KEY`) are Wrangler
  secrets — never in this repo.

## Writes: journalled and undoable

Instead of a human-approval gate, safety comes from **reversibility**:

| Guard | How |
|---|---|
| Whitelist | Only `contacts, projects, invoices, bills, bank_transaction_explanations` are writable |
| No delete tool | Deletion only happens by undoing a journalled create |
| Before-images | `update_record` snapshots the prior state into the journal *first* |
| Undo | `undo_change` deletes a created record / restores an updated one |
| Audit trail | `list_changes` shows every write this connector ever made |
| Drafts only | Invoices are created as drafts — the connector cannot send/email anything |
| Confirm flag | Every write tool requires `confirm: true` and instructs Claude to show the user first |

## Tools

**Read**: `get_company`, `list_contacts`, `list_projects` (= properties),
`list_invoices`, `list_bills`, `list_bank_accounts`, `list_bank_transactions`,
`list_bank_transaction_explanations`, `list_categories`, `get_resource`,
`connection_status`.

**Write**: `create_record`, `update_record`, `list_changes`, `undo_change`.

## Deploy

You need a (free) Cloudflare account and a FreeAgent dev app
([dev.freeagent.com](https://dev.freeagent.com) — note the OAuth identifier + secret).

```bash
npm install
./setup.sh     # creates the KV namespace, prompts for secrets, deploys
```

Then:

1. At dev.freeagent.com, add the Worker's callback as a **Redirect URI**:
   `https://<your-worker>.workers.dev/callback`
   (keep `http://localhost:3000/callback` too if the local Python pipeline still uses it).
2. claude.ai → **Settings → Connectors → Add custom connector** →
   `https://<your-worker>.workers.dev/mcp` — approve the FreeAgent login when bounced.
3. Claude Code: `claude mcp add --transport http freeagent https://<your-worker>.workers.dev/mcp`

**Sandbox first?** Set `FREEAGENT_API_BASE=https://api.sandbox.freeagent.com` as a
Wrangler var and authorize with a [sandbox account](https://signup.sandbox.freeagent.com/signup).

## Ops

```bash
# token freshness + journal size (COOKIE_ENCRYPTION_KEY as bearer)
curl -s -H "Authorization: Bearer $KEY" https://<worker>/admin/status
# force a keep-alive tick
curl -s -X POST -H "Authorization: Bearer $KEY" https://<worker>/admin/cron
```
