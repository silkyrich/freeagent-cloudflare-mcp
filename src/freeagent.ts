// Thin FreeAgent API client + OAuth token helpers.
// Docs: https://dev.freeagent.com/docs

export const DEFAULT_API_BASE = "https://api.freeagent.com";

// FreeAgent rejects requests without a User-Agent ("User agent http header not
// set") — and Workers fetch sends none by default.
export const USER_AGENT = "freeagent-claude-connector/1.0 (Cloudflare Worker)";

export function apiBase(env: Env): string {
  const base = (env as { FREEAGENT_API_BASE?: string }).FREEAGENT_API_BASE;
  return (base ?? DEFAULT_API_BASE).replace(/\/+$/, "");
}

export interface FreeAgentTokens {
  accessToken: string;
  refreshToken: string;
  // epoch ms when the access token expires
  expiresAt: number;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  token_type: string;
}

function tokensFromResponse(r: TokenResponse, prevRefresh?: string): FreeAgentTokens {
  return {
    accessToken: r.access_token,
    // FreeAgent may omit the refresh token on refresh — keep the old one.
    refreshToken: r.refresh_token ?? prevRefresh ?? "",
    expiresAt: Date.now() + r.expires_in * 1000,
  };
}

/** Build the FreeAgent approval URL the user is redirected to. */
export function buildAuthorizeUrl(opts: {
  base: string;
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const u = new URL(`${opts.base}/v2/approve_app`);
  u.searchParams.set("client_id", opts.clientId);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("state", opts.state);
  return u.toString();
}

/** FreeAgent's token endpoint authenticates the app with HTTP Basic auth. */
async function tokenRequest(
  base: string,
  clientId: string,
  clientSecret: string,
  form: Record<string, string>,
): Promise<TokenResponse> {
  const res = await fetch(`${base}/v2/token_endpoint`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
    },
    body: new URLSearchParams(form),
  });
  if (!res.ok) {
    throw new Error(`FreeAgent token request failed (${res.status}): ${await res.text()}`);
  }
  return res.json<TokenResponse>();
}

/** Exchange an authorization code for tokens. */
export async function exchangeCode(opts: {
  base: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<FreeAgentTokens> {
  const r = await tokenRequest(opts.base, opts.clientId, opts.clientSecret, {
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
  });
  return tokensFromResponse(r);
}

/** Refresh an expired access token (refresh token survives if not rotated). */
export async function refreshTokens(opts: {
  base: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<FreeAgentTokens> {
  const r = await tokenRequest(opts.base, opts.clientId, opts.clientSecret, {
    grant_type: "refresh_token",
    refresh_token: opts.refreshToken,
  });
  return tokensFromResponse(r, opts.refreshToken);
}

// ── API requests ───────────────────────────────────────────────────────────

/** Authenticated request with one retry on FreeAgent's 429 rate limit. */
export async function faRequest<T>(
  base: string,
  token: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  pathOrUrl: string,
  body?: unknown,
): Promise<T> {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${base}/v2${pathOrUrl}`;
  const doFetch = () =>
    fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  let res = await doFetch();
  if (res.status === 429) {
    const wait = Math.min(Number(res.headers.get("Retry-After") ?? 5), 25);
    await new Promise((r) => setTimeout(r, wait * 1000));
    res = await doFetch();
  }
  if (!res.ok) {
    const err = new Error(`FreeAgent ${method} ${url} failed (${res.status}): ${await res.text()}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Follow FreeAgent pagination, accumulating the list under its top-level key
 *  until maxItems is reached. Reports whether more pages remain. */
export async function faList(
  base: string,
  token: string,
  endpoint: string,
  params: Record<string, string | undefined>,
  maxItems: number,
): Promise<{ key: string; items: unknown[]; hasMore: boolean }> {
  const items: unknown[] = [];
  let key = endpoint;
  let page = 1;
  let hasMore = false;
  while (items.length < maxItems) {
    const q = new URLSearchParams({ per_page: "100", page: String(page) });
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, v);
    const body = await faRequest<Record<string, unknown>>(base, token, "GET", `/${endpoint}?${q}`);
    key = Object.keys(body).find((k) => Array.isArray(body[k])) ?? endpoint;
    const batch = (body[key] as unknown[]) ?? [];
    items.push(...batch);
    if (batch.length < 100) break;
    if (items.length >= maxItems) {
      hasMore = true;
      break;
    }
    page++;
  }
  if (items.length > maxItems) {
    items.length = maxItems;
    hasMore = true;
  }
  return { key, items, hasMore };
}

// ── Identity helpers (used for labels + the owner lock) ────────────────────

export interface FreeAgentUser {
  url: string;
  email: string;
  first_name?: string;
  last_name?: string;
}

export async function currentUser(base: string, token: string): Promise<FreeAgentUser> {
  const r = await faRequest<{ user: FreeAgentUser }>(base, token, "GET", "/users/me");
  return r.user;
}

export async function companyName(base: string, token: string): Promise<string> {
  const r = await faRequest<{ company: { name?: string } }>(base, token, "GET", "/company");
  return r.company?.name ?? "FreeAgent";
}

export interface CompanyInfo {
  name: string;
  type?: string; // e.g. "UkSoleTrader", "UkUnincorporatedLandlord", "UkLimitedCompany"
}

export async function company(base: string, token: string): Promise<CompanyInfo> {
  const r = await faRequest<{ company: { name?: string; type?: string } }>(base, token, "GET", "/company");
  return { name: r.company?.name ?? "FreeAgent", type: r.company?.type };
}

/** Landlord companies (UkUnincorporatedLandlord) model each rental as a native
 *  Property (/v2/properties) and require `property` on invoices — unlike other
 *  company types, which use projects. */
export function isLandlord(type?: string): boolean {
  return type === "UkUnincorporatedLandlord";
}

// ── Write whitelist ────────────────────────────────────────────────────────
// The ONLY endpoints create_record / update_record may touch, with the
// singular key FreeAgent expects in request bodies. There is no delete tool;
// deletion happens only by undoing a journalled create.

export const WRITE_ENDPOINTS: Record<string, string> = {
  contacts: "contact",
  properties: "property", // landlord accounts (UkUnincorporatedLandlord)
  projects: "project", // non-landlord accounts
  invoices: "invoice",
  bills: "bill",
  bank_transaction_explanations: "bank_transaction_explanation",
};

/** Validate a resource url belongs to this API and a writable endpoint;
 *  returns the endpoint name. */
export function writableEndpointOf(base: string, url: string): string {
  const prefix = `${base}/v2/`;
  if (!url.startsWith(prefix)) throw new Error(`Not a ${prefix} resource url: ${url}`);
  const endpoint = url.slice(prefix.length).split("/")[0];
  if (!WRITE_ENDPOINTS[endpoint]) {
    throw new Error(`Endpoint "${endpoint}" is not writable. Writable: ${Object.keys(WRITE_ENDPOINTS).join(", ")}`);
  }
  return endpoint;
}
