// The MCP server: FreeAgent tools exposed to Claude.
// Reads query the API directly (FreeAgent keeps full history — no cache needed).
// Writes are limited to create/update on a whitelist, require confirm:true,
// and ALL flow through the TokenStore journal so every change is undoable.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { apiBase, faList, faRequest, WRITE_ENDPOINTS, type FreeAgentTokens } from "./freeagent";
import type { Props } from "./freeagent-handler";
import type { TokenStore } from "./token-store";

type State = Record<string, never>;

const CONFIRM = z
  .literal(true)
  .describe("Must be true. ALWAYS show the user exactly what will be written and get their explicit OK first.");

export class FreeAgentMCP extends McpAgent<Env, State, Props> {
  server = new McpServer(
    {
      name: "FreeAgent",
      version: "1.0.0",
    },
    {
      // Sent to every MCP client at connect time — domain context the
      // per-tool descriptions can't carry.
      instructions: [
        "FreeAgent books for F J Williams of Hay — Rew (Ruth) Williams's rental-property business,",
        "used by the family (Richard, Rew, Sarah, Jen).",
        "",
        "Call get_company FIRST to check the company `type`. It drives the domain model:",
        "• UkUnincorporatedLandlord (landlord account): each rental is a native PROPERTY —",
        "  use list_properties; invoices REQUIRE a `property` url (not a project).",
        "• Other types (e.g. sole trader): rentals are modelled as PROJECTS — use list_projects;",
        "  invoices link to a `project`. (This company was migrated from sole-trader to landlord,",
        "  so older data may still be project-shaped while new data is property-shaped.)",
        "",
        "Only the Hay lets flow through FreeAgent — Tenby holiday lets (Travel Chapter), London",
        "(PayProp/direct) are NOT in these books, so FreeAgent totals are not the whole business.",
        "Accounting category codes live on bank_transaction_explanations, per bank account.",
        "FreeAgent ids ARE urls — pass them between tools verbatim; get_resource fetches any of them.",
        "",
        "Writes: always show the user the exact payload and get their OK before setting confirm=true.",
        "Every write is journalled and reversible (list_changes / undo_change). Invoices are created",
        "as drafts only — this connector cannot send or email anything.",
      ].join("\n"),
    },
  );

  initialState: State = {};

  private base(): string {
    return apiBase(this.env);
  }

  private store(): TokenStore {
    return this.env.TOKEN_STORE.get(this.env.TOKEN_STORE.idFromName("primary")) as unknown as TokenStore;
  }

  /** Valid access token via the shared TokenStore — the single authority for
   *  refresh, so tool calls and the keep-alive cron never race. */
  private async token(): Promise<string> {
    const p = this.props;
    const seed: FreeAgentTokens | undefined = p
      ? { accessToken: p.accessToken, refreshToken: p.refreshToken, expiresAt: p.expiresAt }
      : undefined;
    return this.store().getValidToken(seed);
  }

  /** Accept a full FreeAgent url or a bare id for the given endpoint. */
  private resourceUrl(endpoint: string, idOrUrl: string): string {
    return idOrUrl.startsWith("http") ? idOrUrl : `${this.base()}/v2/${endpoint}/${idOrUrl}`;
  }

  private ok(data: unknown) {
    return {
      content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
    };
  }

  private async list(
    endpoint: string,
    params: Record<string, string | undefined>,
    maxItems = 40,
  ) {
    const r = await faList(this.base(), await this.token(), endpoint, params, maxItems);
    return this.ok({
      [r.key]: r.items,
      count: r.items.length,
      has_more: r.hasMore,
      ...(r.hasMore ? { note: "More items exist — narrow with filters or raise max_items." } : {}),
    });
  }

  async init() {
    const maxItems = z.number().int().min(1).max(200).optional()
      .describe("Max items to return (default 40, max 200).");

    // ── reads ───────────────────────────────────────────────────────────

    this.server.registerTool(
      "get_company",
      {
        description:
          "The FreeAgent company: name, type, currency, accounting dates. Good first call to orient.",
        inputSchema: {},
      },
      async () => this.ok(await faRequest(this.base(), await this.token(), "GET", "/company")),
    );

    this.server.registerTool(
      "list_contacts",
      {
        description: "List contacts (tenants, suppliers, etc.). FreeAgent ids are urls — use them in other calls.",
        inputSchema: {
          view: z.enum(["all", "active", "clients", "suppliers"]).optional().describe("Default: active."),
          max_items: maxItems,
        },
      },
      async ({ view, max_items }) => this.list("contacts", { view }, max_items),
    );

    this.server.registerTool(
      "list_properties",
      {
        description:
          "List rental PROPERTIES (landlord accounts / UkUnincorporatedLandlord only). Each has an address and a url " +
          "used as `property` on invoices. Returns empty/errors on non-landlord accounts — use list_projects there.",
        inputSchema: { max_items: maxItems },
      },
      async ({ max_items }) => this.list("properties", {}, max_items),
    );

    this.server.registerTool(
      "list_projects",
      {
        description:
          "List projects. On NON-landlord accounts rentals are modelled as projects, so this is the property list. " +
          "On a landlord account, rentals are native properties instead — use list_properties.",
        inputSchema: {
          view: z.enum(["active", "completed", "cancelled", "all"]).optional().describe("Default: active."),
          contact: z.string().optional().describe("Filter by contact url."),
          max_items: maxItems,
        },
      },
      async ({ view, contact, max_items }) => this.list("projects", { view, contact }, max_items),
    );

    this.server.registerTool(
      "list_invoices",
      {
        description: "List invoices, filterable by status view, project (= property) or contact.",
        inputSchema: {
          view: z
            .string()
            .optional()
            .describe("e.g. all, open, overdue, open_or_overdue, draft, paid, recent_open_or_overdue, last_N_months."),
          project: z.string().optional().describe("Project (property) url."),
          contact: z.string().optional().describe("Contact url."),
          updated_since: z.string().optional().describe("ISO timestamp."),
          nested_invoice_items: z.boolean().optional().describe("Include line items (bigger payloads)."),
          max_items: maxItems,
        },
      },
      async ({ view, project, contact, updated_since, nested_invoice_items, max_items }) =>
        this.list(
          "invoices",
          { view, project, contact, updated_since, nested_invoice_items: nested_invoice_items ? "true" : undefined },
          max_items,
        ),
    );

    this.server.registerTool(
      "list_bills",
      {
        description: "List bills (money the business owes), filterable by status view or project (= property).",
        inputSchema: {
          view: z.string().optional().describe("e.g. all, open, overdue, open_or_overdue, paid, recurring."),
          project: z.string().optional().describe("Project (property) url."),
          updated_since: z.string().optional().describe("ISO timestamp."),
          max_items: maxItems,
        },
      },
      async ({ view, project, updated_since, max_items }) =>
        this.list("bills", { view, project, updated_since }, max_items),
    );

    this.server.registerTool(
      "list_bank_accounts",
      {
        description: "List bank accounts with balances. Their urls are needed for the transaction tools.",
        inputSchema: {},
      },
      async () => this.list("bank_accounts", {}, 50),
    );

    this.server.registerTool(
      "list_bank_transactions",
      {
        description:
          "List transactions for ONE bank account (FreeAgent requires the account). 'unexplained' view = not yet categorised.",
        inputSchema: {
          bank_account: z.string().describe("Bank account url (or bare id) from list_bank_accounts."),
          view: z.enum(["all", "unexplained", "explained", "manual", "imported", "marked_for_review"]).optional(),
          from_date: z.string().optional().describe("YYYY-MM-DD"),
          to_date: z.string().optional().describe("YYYY-MM-DD"),
          max_items: maxItems,
        },
      },
      async ({ bank_account, view, from_date, to_date, max_items }) =>
        this.list(
          "bank_transactions",
          { bank_account: this.resourceUrl("bank_accounts", bank_account), view, from_date, to_date },
          max_items,
        ),
    );

    this.server.registerTool(
      "list_bank_transaction_explanations",
      {
        description:
          "List explanations (categorisations) for ONE bank account — where the accounting category codes live.",
        inputSchema: {
          bank_account: z.string().describe("Bank account url (or bare id) from list_bank_accounts."),
          from_date: z.string().optional().describe("YYYY-MM-DD"),
          to_date: z.string().optional().describe("YYYY-MM-DD"),
          max_items: maxItems,
        },
      },
      async ({ bank_account, from_date, to_date, max_items }) =>
        this.list(
          "bank_transaction_explanations",
          { bank_account: this.resourceUrl("bank_accounts", bank_account), from_date, to_date },
          max_items,
        ),
    );

    this.server.registerTool(
      "list_categories",
      {
        description: "All accounting categories (income, cost-of-sales, admin expenses, general) with nominal codes.",
        inputSchema: {},
      },
      async () => this.ok(await faRequest(this.base(), await this.token(), "GET", "/categories")),
    );

    this.server.registerTool(
      "get_resource",
      {
        description:
          "GET any single FreeAgent resource by its url (FreeAgent ids ARE urls — invoices, contacts, projects, explanations…). Read-only.",
        inputSchema: {
          url: z.string().describe("A full https://api.freeagent.com/v2/... resource url."),
        },
      },
      async ({ url }) => {
        if (!url.startsWith(`${this.base()}/v2/`)) {
          throw new Error(`url must start with ${this.base()}/v2/`);
        }
        return this.ok(await faRequest(this.base(), await this.token(), "GET", url));
      },
    );

    // ── writes (journalled + undoable) ──────────────────────────────────

    this.server.registerTool(
      "create_record",
      {
        description:
          `Create a record in FreeAgent. Writable endpoints: ${Object.keys(WRITE_ENDPOINTS).join(", ")}. ` +
          "Attributes follow the FreeAgent API docs (dev.freeagent.com) — e.g. an invoice needs contact, dated_on, " +
          "payment_terms_in_days, invoice_items; an explanation needs bank_transaction, dated_on, gross_value and " +
          "category or paid-invoice linkage. IMPORTANT for landlord accounts (UkUnincorporatedLandlord): an invoice " +
          "REQUIRES a `property` url (from list_properties), not a `project`; check get_company if unsure. Invoices are " +
          "created as DRAFTS — this tool cannot send or email anything. The change is journalled and reversible via undo_change.",
        inputSchema: {
          endpoint: z.enum(Object.keys(WRITE_ENDPOINTS) as [string, ...string[]]),
          attributes: z.record(z.string(), z.unknown()).describe("The record's attributes, per the FreeAgent API docs."),
          confirm: CONFIRM,
        },
      },
      async ({ endpoint, attributes }) => this.ok(await this.store().createRecord(endpoint, attributes)),
    );

    this.server.registerTool(
      "update_record",
      {
        description:
          "Update an existing record (same whitelist as create_record) by its url. Send ONLY the attributes to change. " +
          "The prior state is journalled first, so the update is reversible via undo_change.",
        inputSchema: {
          url: z.string().describe("The record's full FreeAgent url."),
          attributes: z.record(z.string(), z.unknown()).describe("Only the fields to change."),
          confirm: CONFIRM,
        },
      },
      async ({ url, attributes }) => this.ok(await this.store().updateRecord(url, attributes)),
    );

    this.server.registerTool(
      "list_changes",
      {
        description:
          "The write journal: every create/update this connector has made, newest first, with undo status. The audit trail.",
        inputSchema: { limit: z.number().int().min(1).max(100).default(20) },
      },
      async ({ limit }) => this.ok(await this.store().listChanges(limit)),
    );

    this.server.registerTool(
      "undo_change",
      {
        description:
          "Reverse a journalled change: a created record is deleted; an updated record is restored to its before-image. " +
          "Check the entry with list_changes first and confirm with the user.",
        inputSchema: {
          id: z.string().describe("Journal id, e.g. chg-42."),
          confirm: CONFIRM,
        },
      },
      async ({ id }) => this.ok(await this.store().undoChange(id)),
    );

    this.server.registerTool(
      "connection_status",
      {
        description: "Connector health: token freshness and how many writes are in the journal.",
        inputSchema: {},
      },
      async () => this.ok(await this.store().status()),
    );
  }
}
