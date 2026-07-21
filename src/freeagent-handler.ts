// Upstream OAuth handler: bridges the connector's own OAuth (which Claude
// speaks) to FreeAgent's OAuth. Mounted as the OAuthProvider `defaultHandler`.
//
// Flow:
//   Claude    → GET /authorize → we redirect the user to FreeAgent's approval page
//   FreeAgent → GET /callback  → we exchange the code, then complete the grant
//                                back to Claude with the tokens as `props`.

import { Hono } from "hono";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import {
  apiBase,
  buildAuthorizeUrl,
  companyName,
  currentUser,
  exchangeCode,
  type FreeAgentTokens,
} from "./freeagent";
import type { TokenStore } from "./token-store";

// Everything here ends up on `this.props` inside the MCP agent.
export type Props = FreeAgentTokens & {
  name: string;
  userUrl: string;
} & Record<string, unknown>;

type Bindings = Env & { OAUTH_PROVIDER: OAuthHelpers };

const app = new Hono<{ Bindings: Bindings }>();

// The redirect URI registered with the FreeAgent dev app — this Worker's /callback.
function callbackUri(reqUrl: string): string {
  return new URL("/callback", reqUrl).origin + "/callback";
}

app.get("/", (c) =>
  c.html(
    `<h2>FreeAgent → Claude connector</h2>
     <p>Remote MCP server. Add <code>${new URL("/mcp", c.req.url).href}</code> as a
     custom connector in claude.ai, or:</p>
     <pre>claude mcp add --transport http freeagent ${new URL("/mcp", c.req.url).href}</pre>`,
  ),
);

app.get("/authorize", async (c) => {
  // Parse the incoming OAuth request from Claude and stash it in `state`
  // so we can recover it after the round-trip through FreeAgent.
  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  console.log(`authorize hit: client=${oauthReqInfo.clientId} ua=${c.req.header("user-agent")?.slice(0, 80)}`);
  const state = btoa(JSON.stringify(oauthReqInfo));

  return c.redirect(
    buildAuthorizeUrl({
      base: apiBase(c.env),
      clientId: c.env.FREEAGENT_CLIENT_ID,
      redirectUri: callbackUri(c.req.url),
      state,
    }),
  );
});

app.get("/callback", async (c) => {
  const code = c.req.query("code");
  const stateParam = c.req.query("state");
  console.log(
    `callback hit: code=${code?.slice(0, 8)}… ua=${c.req.header("user-agent")?.slice(0, 80)} ` +
      `sec-purpose=${c.req.header("sec-purpose") ?? "-"} sec-fetch-site=${c.req.header("sec-fetch-site") ?? "-"}`,
  );
  // Ignore browser prefetch/preview hits — they would consume the one-shot code.
  if ((c.req.header("sec-purpose") ?? "").includes("prefetch") || c.req.header("x-purpose") === "preview") {
    return c.body(null, 204);
  }
  if (!code || !stateParam) {
    return c.text("Missing code or state from FreeAgent", 400);
  }

  let oauthReqInfo: AuthRequest;
  try {
    oauthReqInfo = JSON.parse(atob(stateParam)) as AuthRequest;
  } catch {
    return c.text("Invalid state", 400);
  }
  if (!oauthReqInfo.clientId) {
    return c.text("Invalid state (no client)", 400);
  }

  const base = apiBase(c.env);
  let tokens;
  try {
    tokens = await exchangeCode({
      base,
      clientId: c.env.FREEAGENT_CLIENT_ID,
      clientSecret: c.env.FREEAGENT_CLIENT_SECRET,
      redirectUri: callbackUri(c.req.url),
      code,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`callback token exchange failed: ${msg}`);
    return c.text(`Token exchange with FreeAgent failed.\n${msg}`, 502);
  }
  if (!tokens.refreshToken) {
    return c.text("FreeAgent did not return a refresh token — cannot stay connected.", 400);
  }

  // Who just authorized? (identity for the owner lock + a friendly label)
  let user;
  try {
    user = await currentUser(base, tokens.accessToken);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`callback /users/me failed: ${msg}`);
    return c.text(`Connected to FreeAgent but could not read the user identity.\n${msg}`, 502);
  }
  let name = "FreeAgent";
  try {
    name = await companyName(base, tokens.accessToken);
  } catch {
    // non-fatal — labelling only
  }

  // OWNER LOCK: the first FreeAgent identity to authorize owns this
  // deployment. Anyone else is rejected HERE — before any grant is minted.
  // Identity is the email, which is stable across the owner's companies —
  // user urls are per-company and would lock the owner out of their own
  // connector when repointing it. See TokenStore.checkOwner.
  const store = c.env.TOKEN_STORE.get(c.env.TOKEN_STORE.idFromName("primary")) as unknown as TokenStore;
  const ownership = await store.checkOwner(user.email);
  if (!ownership.allowed) {
    return c.text(ownership.reason ?? "This connector is locked to its owner.", 403);
  }

  // Seed the shared TokenStore — a fresh authorization supersedes any prior
  // chain, and makes the store the single authority for refresh.
  try {
    await store.seed(tokens, user.email);
  } catch {
    // non-fatal — first tool call will seed from props as a fallback
  }

  // Hand the grant back to Claude, carrying the tokens as encrypted props.
  // NOTE: userId must not contain ":" — the provider embeds it in the
  // authorization code as userId:grantId:secret. FreeAgent user ids are
  // URLs, so use a sanitized form (the trailing numeric id, prefixed).
  const providerUserId = `freeagent-${user.url.split("/").pop() ?? "owner"}`;
  try {
    const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthReqInfo,
      userId: providerUserId,
      metadata: { label: name },
      scope: oauthReqInfo.scope,
      props: { ...tokens, name, userUrl: user.url } satisfies Props,
    });
    return c.redirect(redirectTo);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`callback completeAuthorization failed: ${msg}`);
    return c.text(`FreeAgent authorized, but completing the grant back to Claude failed.\n${msg}`, 502);
  }
});

// Manual cron trigger for ops/verification — gated by the deployment's own
// COOKIE_ENCRYPTION_KEY (a Wrangler secret). Useful right after deploy.
app.post("/admin/cron", async (c) => {
  const auth = c.req.header("Authorization") ?? "";
  if (auth !== `Bearer ${c.env.COOKIE_ENCRYPTION_KEY}`) return c.text("forbidden", 403);
  const store = c.env.TOKEN_STORE.get(c.env.TOKEN_STORE.idFromName("primary")) as unknown as TokenStore;
  return c.json(await store.cronTick());
});

app.get("/admin/status", async (c) => {
  const auth = c.req.header("Authorization") ?? "";
  if (auth !== `Bearer ${c.env.COOKIE_ENCRYPTION_KEY}`) return c.text("forbidden", 403);
  const store = c.env.TOKEN_STORE.get(c.env.TOKEN_STORE.idFromName("primary")) as unknown as TokenStore;
  return c.json(await store.status());
});

// Release the owner pin so this deployment can be claimed afresh — used to
// repoint at a different FreeAgent company, and to clear pins written before
// ownership moved from user url to email. Same gate as the other admin routes:
// only whoever holds the deployment secret can do it, which is the whole point
// of the lock. Disconnects the connector; the next authorization re-pins it.
app.post("/admin/release-owner", async (c) => {
  const auth = c.req.header("Authorization") ?? "";
  if (auth !== `Bearer ${c.env.COOKIE_ENCRYPTION_KEY}`) return c.text("forbidden", 403);
  const store = c.env.TOKEN_STORE.get(c.env.TOKEN_STORE.idFromName("primary")) as unknown as TokenStore;
  return c.json(await store.releaseOwner());
});

export { app as FreeAgentHandler };
