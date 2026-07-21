// TokenStore: the SINGLE authority for the FreeAgent token chain, and the
// write journal that makes every mutation reversible.
//
// All refreshes serialise through this Durable Object, so nothing races the
// refresh token. All WRITES also go through here: each one records a journal
// entry first (with a before-image for updates), so `undo_change` can always
// restore the prior state. A single well-known instance ("primary") serves
// this single-company connector.

import { DurableObject } from "cloudflare:workers";
import {
  apiBase,
  company as companyLookup,
  faRequest,
  refreshTokens,
  writableEndpointOf,
  WRITE_ENDPOINTS,
  type CompanyInfo,
  type FreeAgentTokens,
} from "./freeagent";

const REFRESH_MARGIN_MS = 5 * 60_000; // refresh when <5 min of access-token life left
const JOURNAL_LIMIT = 1000; // oldest entries pruned beyond this

export interface ChangeEntry {
  id: string; // "chg-<seq>"
  at: string; // ISO timestamp
  action: "create" | "update";
  endpoint: string; // e.g. "invoices"
  url: string; // the FreeAgent resource url
  summary: string; // one line, human-readable
  before?: unknown; // prior state (updates only)
  after?: unknown; // state as written
  undoneAt?: string; // set once reversed
}

/** Owner identity is compared case-insensitively — FreeAgent does not
 *  normalise the case of the email it returns from /users/me. */
function normalizeIdentity(identity: string): string {
  return identity.trim().toLowerCase();
}

/** SAFETY GUARD — recurring invoices can auto-generate invoices AND auto-email
 *  them to the tenant on a schedule (send_new_invoice_emails / send_reminder_emails
 *  / send_thank_you_emails, verified against the FreeAgent invoice API). Rew's
 *  hard rule: nothing reaches a tenant automatically — she generates, reviews and
 *  forwards by hand. So on EVERY recurring_invoices write (create, update, and the
 *  undo-restore) these flags are forced false server-side, overriding whatever the
 *  caller passed. A guard here cannot be forgotten the way a per-call argument can.
 *  recurring_status is left to the caller (typically "Active" so schedules run). */
const EMAIL_FLAGS_OFF: Record<string, boolean> = {
  send_new_invoice_emails: false,
  send_reminder_emails: false,
  send_thank_you_emails: false,
};

function guardWriteAttributes(endpoint: string, attributes: Record<string, unknown>): Record<string, unknown> {
  if (endpoint !== "recurring_invoices") return attributes;
  const guarded: Record<string, unknown> = { ...attributes };
  // Belt: neutralise any caller-supplied send_*_email(s) flag, whatever its name.
  for (const k of Object.keys(guarded)) {
    if (/^send_.*_emails?$/i.test(k)) guarded[k] = false;
  }
  // Braces: force the three known flags off whether or not they were passed.
  return { ...guarded, ...EMAIL_FLAGS_OFF };
}

/** Fields FreeAgent manages itself — stripped before PUT-ing a before-image back. */
const READONLY_KEYS = new Set(["url", "created_at", "updated_at"]);

function writableAttrs(record: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record as Record<string, unknown>)) {
    if (!READONLY_KEYS.has(k)) out[k] = v;
  }
  return out;
}

export class TokenStore extends DurableObject<Env> {
  private base(): string {
    return apiBase(this.env);
  }

  // ── ownership ────────────────────────────────────────────────────────
  /** OWNER LOCK: the first FreeAgent *person* to authorize owns this
   *  deployment. Identity is the email address, NOT the user url: FreeAgent
   *  scopes user urls per company, so the same person authorizing a second of
   *  their own companies arrives as a different url and would be locked out of
   *  their own connector. Email is stable across a person's companies, so the
   *  lock still keeps strangers out while letting the owner repoint.
   *
   *  Pins written before this change hold a user url. They no longer match any
   *  email, so the connector stays locked until POST /admin/release-owner —
   *  deliberately: we cannot prove an old url belongs to the caller, and
   *  auto-upgrading would open a window for anyone to claim ownership. */
  async checkOwner(identity: string): Promise<{ allowed: boolean; reason?: string }> {
    const owner = await this.ctx.storage.get<string>("owner");
    if (!owner) return { allowed: true }; // first authorization pins ownership
    if (owner === normalizeIdentity(identity)) return { allowed: true };
    return {
      allowed: false,
      reason: owner.startsWith("http")
        ? "This connector is pinned to an older identity. Run POST /admin/release-owner, then reconnect."
        : "This connector is locked to its owner's FreeAgent account.",
    };
  }

  /** Release the pin so a different FreeAgent identity can claim this
   *  deployment. Needed to repoint at another company: FreeAgent user urls are
   *  per-company, so even the same person authorizing a different company
   *  arrives as a new identity and is refused. Drops the token chain with it —
   *  the connector is disconnected until the next authorization re-pins it.
   *  The write journal is deliberately left intact. */
  async releaseOwner(): Promise<{ ok: boolean; detail: string }> {
    const owner = await this.ctx.storage.get<string>("owner");
    await this.ctx.storage.delete("owner");
    await this.ctx.storage.delete("tokens");
    return owner
      ? { ok: true, detail: `Released ${owner}. Reconnect to pin a new owner.` }
      : { ok: true, detail: "No owner was pinned. Reconnect to pin one." };
  }

  /** Called on OAuth callback — a fresh authorization supersedes any prior
   *  chain. Identity is the owner's email (see checkOwner). */
  async seed(tokens: FreeAgentTokens, identity: string): Promise<void> {
    const id = normalizeIdentity(identity);
    const owner = await this.ctx.storage.get<string>("owner");
    if (owner && owner !== id) {
      throw new Error("Owner lock: refusing to seed tokens for a different FreeAgent user.");
    }
    if (!owner) await this.ctx.storage.put("owner", id);
    await this.ctx.storage.put("tokens", tokens);
  }

  // ── token chain ──────────────────────────────────────────────────────
  /** Return a valid access token, refreshing + persisting if near expiry.
   *  `seed` (from the caller's props) is used only if nothing is stored yet. */
  async getValidToken(seed?: FreeAgentTokens): Promise<string> {
    let t = (await this.ctx.storage.get<FreeAgentTokens>("tokens")) ?? seed;
    if (!t) throw new Error("No FreeAgent tokens stored — reconnect the connector.");

    if (t.expiresAt - Date.now() < REFRESH_MARGIN_MS) {
      t = await refreshTokens({
        base: this.base(),
        clientId: this.env.FREEAGENT_CLIENT_ID,
        clientSecret: this.env.FREEAGENT_CLIENT_SECRET,
        refreshToken: t.refreshToken,
      });
      await this.ctx.storage.put("tokens", t);
    } else if (!(await this.ctx.storage.get("tokens"))) {
      await this.ctx.storage.put("tokens", t); // persist the seed
    }
    return t.accessToken;
  }

  /** Cron keep-alive: refresh proactively so the chain never lapses.
   *  Failure leaves the last-good token in place and reports — never wipes. */
  async keepAlive(): Promise<{ ok: boolean; detail: string; expiresInMin?: number }> {
    const t = await this.ctx.storage.get<FreeAgentTokens>("tokens");
    if (!t) return { ok: false, detail: "not connected (no tokens stored)" };
    try {
      const refreshed = await refreshTokens({
        base: this.base(),
        clientId: this.env.FREEAGENT_CLIENT_ID,
        clientSecret: this.env.FREEAGENT_CLIENT_SECRET,
        refreshToken: t.refreshToken,
      });
      await this.ctx.storage.put("tokens", refreshed);
      return { ok: true, detail: "refreshed", expiresInMin: Math.round((refreshed.expiresAt - Date.now()) / 60000) };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  async cronTick(): Promise<{ keepAlive: { ok: boolean; detail: string } }> {
    return { keepAlive: await this.keepAlive() };
  }

  async status(): Promise<{ connected: boolean; owner?: string; company?: string; companyType?: string; expiresInMin?: number; changes: number }> {
    const t = await this.ctx.storage.get<FreeAgentTokens>("tokens");
    const owner = await this.ctx.storage.get<string>("owner");
    const seq = (await this.ctx.storage.get<number>("chgSeq")) ?? 0;
    if (!t) return { connected: false, owner, changes: seq };
    let company: CompanyInfo | undefined;
    try {
      company = await companyLookup(this.base(), await this.getValidToken());
    } catch {
      // non-fatal — status still reports connectivity
    }
    return {
      connected: true,
      owner,
      company: company?.name,
      companyType: company?.type,
      expiresInMin: Math.round((t.expiresAt - Date.now()) / 60000),
      changes: seq,
    };
  }

  // ── journalled writes ────────────────────────────────────────────────
  // Every mutation flows through here so the journal can never be skipped.

  private async journal(entry: Omit<ChangeEntry, "id" | "at">): Promise<ChangeEntry> {
    const seq = ((await this.ctx.storage.get<number>("chgSeq")) ?? 0) + 1;
    await this.ctx.storage.put("chgSeq", seq);
    const full: ChangeEntry = { id: `chg-${seq}`, at: new Date().toISOString(), ...entry };
    await this.ctx.storage.put(`chg:${String(seq).padStart(8, "0")}`, full);
    // prune the oldest beyond the cap
    if (seq > JOURNAL_LIMIT) {
      await this.ctx.storage.delete(`chg:${String(seq - JOURNAL_LIMIT).padStart(8, "0")}`);
    }
    return full;
  }

  /** POST a new record to a whitelisted endpoint. Journalled as a create. */
  async createRecord(
    endpoint: string,
    attributes: Record<string, unknown>,
  ): Promise<{ changeId: string; record: unknown }> {
    const singular = WRITE_ENDPOINTS[endpoint];
    if (!singular) {
      throw new Error(`Endpoint "${endpoint}" is not writable. Writable: ${Object.keys(WRITE_ENDPOINTS).join(", ")}`);
    }
    const guarded = guardWriteAttributes(endpoint, attributes);
    const token = await this.getValidToken();
    const body = await faRequest<Record<string, unknown>>(
      this.base(), token, "POST", `/${endpoint}`, { [singular]: guarded },
    );
    const record = (body?.[singular] ?? body) as { url?: string };
    const entry = await this.journal({
      action: "create",
      endpoint,
      url: record?.url ?? "",
      summary: `created ${singular} ${record?.url ?? ""}`,
      after: record,
    });
    return { changeId: entry.id, record };
  }

  /** PUT changed attributes to an existing record. The prior state is fetched
   *  and journalled FIRST, so the update is always reversible. */
  async updateRecord(
    url: string,
    attributes: Record<string, unknown>,
  ): Promise<{ changeId: string; before: unknown; record: unknown }> {
    const endpoint = writableEndpointOf(this.base(), url);
    const singular = WRITE_ENDPOINTS[endpoint];
    const token = await this.getValidToken();

    const beforeBody = await faRequest<Record<string, unknown>>(this.base(), token, "GET", url);
    const before = beforeBody?.[singular] ?? beforeBody;

    const guarded = guardWriteAttributes(endpoint, attributes);
    await faRequest(this.base(), token, "PUT", url, { [singular]: guarded });
    const afterBody = await faRequest<Record<string, unknown>>(this.base(), token, "GET", url);
    const after = afterBody?.[singular] ?? afterBody;

    const entry = await this.journal({
      action: "update",
      endpoint,
      url,
      summary: `updated ${singular} ${url} (${Object.keys(attributes).join(", ")})`,
      before,
      after,
    });
    return { changeId: entry.id, before, record: after };
  }

  async listChanges(limit: number): Promise<ChangeEntry[]> {
    const page = await this.ctx.storage.list<ChangeEntry>({
      prefix: "chg:",
      reverse: true,
      limit: Math.min(limit, 100),
    });
    // Return without the (potentially large) before/after blobs; get them via undo or the resource itself.
    return [...page.values()].map((e) => ({ ...e, before: undefined, after: undefined }));
  }

  async getChange(id: string): Promise<ChangeEntry | undefined> {
    const seq = Number(id.replace(/^chg-/, ""));
    if (!Number.isFinite(seq)) return undefined;
    return this.ctx.storage.get<ChangeEntry>(`chg:${String(seq).padStart(8, "0")}`);
  }

  /** Reverse a journalled change: a create is deleted; an update has its
   *  before-image PUT back. The reversal itself is recorded on the entry. */
  async undoChange(id: string): Promise<{ ok: boolean; detail: string }> {
    const seq = Number(id.replace(/^chg-/, ""));
    const key = `chg:${String(seq).padStart(8, "0")}`;
    const entry = await this.ctx.storage.get<ChangeEntry>(key);
    if (!entry) return { ok: false, detail: `No journal entry ${id} (it may have been pruned).` };
    if (entry.undoneAt) return { ok: false, detail: `${id} was already undone at ${entry.undoneAt}.` };

    const token = await this.getValidToken();
    const singular = WRITE_ENDPOINTS[entry.endpoint];

    if (entry.action === "create") {
      await faRequest(this.base(), token, "DELETE", entry.url);
      entry.undoneAt = new Date().toISOString();
      await this.ctx.storage.put(key, entry);
      return { ok: true, detail: `Deleted ${entry.url} (reversing ${id}).` };
    }

    // update → restore the before-image (minus server-managed fields). The
    // email guard applies here too: even restoring a prior state must not
    // re-enable tenant auto-emails on a recurring invoice.
    if (!entry.before) return { ok: false, detail: `${id} has no before-image to restore.` };
    const restore = guardWriteAttributes(entry.endpoint, writableAttrs(entry.before));
    await faRequest(this.base(), token, "PUT", entry.url, { [singular]: restore });
    entry.undoneAt = new Date().toISOString();
    await this.ctx.storage.put(key, entry);
    return { ok: true, detail: `Restored ${entry.url} to its state before ${id}.` };
  }
}
