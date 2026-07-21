// Entry point. @cloudflare/workers-oauth-provider is the OAuth server that
// Claude talks to; it delegates the actual login to FreeAgentHandler and, once
// authorized, routes MCP traffic (/mcp, /sse) to the FreeAgentMCP Durable Object.

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { FreeAgentMCP } from "./mcp";
import { TokenStore } from "./token-store";
import { FreeAgentHandler } from "./freeagent-handler";

// Durable Object classes must be exported for the runtime to find them.
export { FreeAgentMCP, TokenStore };

const provider = new OAuthProvider({
  apiHandlers: {
    "/mcp": FreeAgentMCP.serve("/mcp"),
    "/sse": FreeAgentMCP.serveSSE("/sse"),
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defaultHandler: FreeAgentHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => provider.fetch(req, env, ctx),

  // Keep-alive cron: proactively refresh the FreeAgent token chain so it
  // never lapses from inactivity. Goes through the single TokenStore authority.
  scheduled: async (_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) => {
    const store = env.TOKEN_STORE.get(env.TOKEN_STORE.idFromName("primary")) as unknown as {
      cronTick(): Promise<unknown>;
    };
    const r = await store.cronTick();
    console.log(`freeagent keep-alive: ${JSON.stringify(r)}`);
  },
};
