import { McpServer }     from "@modelcontextprotocol/sdk/server/mcp.js";
import { z }             from "zod";
import { VendorAdapter } from "../adapters/vendor.js";
import { AuditEmitter }  from "../core/audit.js";
import type { Vendor, VendorAddress, VendorContact } from "../adapters/vendor.js";

export function registerVendorTools(server: McpServer, adapter: VendorAdapter): void {

  // ── Tool 1: List / Filter Vendors ──────────────────────────────────────────
  server.tool(
    "list_vendors",
    "List vendors from SAP Ariba with optional filters. Supports pagination via pageToken.",
    {
      status:    z.enum(["ACTIVE", "INACTIVE", "PENDING"]).optional()
                  .describe("Filter by vendor status"),
      name:      z.string().optional()
                  .describe("Partial vendor name search (case-insensitive)"),
      country:   z.string().max(2).optional()
                  .describe("Filter by country ISO-2 code e.g. DE, US, IN"),
      category:  z.string().optional()
                  .describe("Filter by commodity category code"),
      pageSize:  z.number().min(1).max(100).optional()
                  .describe("Results per page (1–100, default 50)"),
      pageToken: z.string().optional()
                  .describe("Pagination cursor from previous list_vendors call"),
    },
    async ({ status, name, country, category, pageSize, pageToken }) => {
      const start  = Date.now();
      const result = await adapter.listVendors({ status, name, country, category, pageSize, pageToken });

      AuditEmitter.emit({
        action:      "LIST_VENDORS",
        tool:        "list_vendors",
        durationMs:  Date.now() - start,
        resultCount: result.vendors.length,
        filters:     { status, name, country, category },
      });

      if (!result.vendors.length) {
        return {
          content: [{ type: "text", text: "No vendors found matching the given filters." }],
        };
      }

      const rows = result.vendors.map(v =>
        `  ${v.vendorId.padEnd(20)} ${v.name.padEnd(40)} ${v.status.padEnd(10)} ${v.primaryAddress?.country ?? "N/A"}`,
      ).join("\n");

      const pagination = result.hasMore && result.pageToken
        ? `\nNext page token: ${result.pageToken}\n(Call list_vendors with pageToken to load more)`
        : "\n(End of results)";

      const text =
        `Vendors — Total: ${result.totalCount} | Showing: ${result.vendors.length}\n\n` +
        `  ${"Vendor ID".padEnd(20)} ${"Name".padEnd(40)} ${"Status".padEnd(10)} Country\n` +
        `  ${"─".repeat(78)}\n` +
        rows +
        pagination;

      return { content: [{ type: "text", text }] };
    },
  );

  // ── Tool 2: Get Single Vendor Details ──────────────────────────────────────
  server.tool(
    "get_vendor_details",
    "Retrieve full details of a single vendor by Vendor ID from SAP Ariba.",
    {
      vendorId: z.string().min(1).describe("Ariba Vendor ID"),
    },
    async ({ vendorId }) => {
      const start  = Date.now();
      const vendor = await adapter.getVendor(vendorId);

      AuditEmitter.emit({
        action:     "GET_VENDOR",
        tool:       "get_vendor_details",
        vendorId,
        durationMs: Date.now() - start,
      });

      const text = formatVendorDetail(vendor);
      return { content: [{ type: "text", text }] };
    },
  );

  // ── Tool 3: Search Vendors by Name ─────────────────────────────────────────
  server.tool(
    "search_vendors_by_name",
    "Search SAP Ariba vendors by name. Returns matching vendors with key details.",
    {
      name:     z.string().min(1).describe("Vendor name or partial name to search"),
      pageSize: z.number().min(1).max(100).optional()
                 .describe("Max results to return (default 50)"),
    },
    async ({ name, pageSize }) => {
      const start  = Date.now();
      const result = await adapter.searchVendorsByName(name, pageSize);

      AuditEmitter.emit({
        action:      "SEARCH_VENDORS",
        tool:        "search_vendors_by_name",
        durationMs:  Date.now() - start,
        resultCount: result.vendors.length,
        searchName:  name,
      });

      if (!result.vendors.length) {
        return {
          content: [{ type: "text", text: `No vendors found matching "${name}".` }],
        };
      }

      const rows = result.vendors.map(v =>
        `  ${v.vendorId.padEnd(20)} ${v.name.padEnd(40)} ${v.status.padEnd(10)} ${v.primaryAddress?.country ?? "N/A"}`,
      ).join("\n");

      const text =
        `Search results for "${name}" — Found: ${result.vendors.length} of ${result.totalCount}\n\n` +
        `  ${"Vendor ID".padEnd(20)} ${"Name".padEnd(40)} ${"Status".padEnd(10)} Country\n` +
        `  ${"─".repeat(78)}\n` +
        rows;

      return { content: [{ type: "text", text }] };
    },
  );

  // ── Tool 4: Get Active Vendors ─────────────────────────────────────────────
  server.tool(
    "get_active_vendors",
    "Get all active vendors from SAP Ariba, optionally filtered by country.",
    {
      country:  z.string().max(2).optional()
                 .describe("Filter by country ISO-2 code e.g. DE, US"),
      pageSize: z.number().min(1).max(100).optional()
                 .describe("Results per page (default 50)"),
    },
    async ({ country, pageSize }) => {
      const start  = Date.now();
      const result = await adapter.getActiveVendors(country, pageSize);

      AuditEmitter.emit({
        action:      "GET_ACTIVE_VENDORS",
        tool:        "get_active_vendors",
        durationMs:  Date.now() - start,
        resultCount: result.vendors.length,
        country,
      });

      if (!result.vendors.length) {
        return {
          content: [{
            type: "text",
            text: country
              ? `No active vendors found in country "${country}".`
              : "No active vendors found.",
          }],
        };
      }

      const rows = result.vendors.map(v =>
        `  ${v.vendorId.padEnd(20)} ${v.name.padEnd(40)} ${v.primaryAddress?.country ?? "N/A"}`,
      ).join("\n");

      const pagination = result.hasMore && result.pageToken
        ? `\nNext page token: ${result.pageToken}`
        : "";

      const text =
        `Active Vendors${country ? ` in ${country}` : ""} — Total: ${result.totalCount} | Showing: ${result.vendors.length}\n\n` +
        `  ${"Vendor ID".padEnd(20)} ${"Name".padEnd(40)} Country\n` +
        `  ${"─".repeat(68)}\n` +
        rows +
        pagination;

      return { content: [{ type: "text", text }] };
    },
  );

  // ── Tool 5: Get Next Page ──────────────────────────────────────────────────
  server.tool(
    "get_vendors_next_page",
    "Fetch the next page of vendor results using a pagination token from a previous call.",
    {
      pageToken: z.string().min(1).describe("Pagination token from a previous list/search call"),
      pageSize:  z.number().min(1).max(100).optional().describe("Results per page"),
    },
    async ({ pageToken, pageSize }) => {
      const start  = Date.now();
      const result = await adapter.getNextPage(pageToken, pageSize);

      AuditEmitter.emit({
        action:      "PAGINATE_VENDORS",
        tool:        "get_vendors_next_page",
        durationMs:  Date.now() - start,
        resultCount: result.vendors.length,
      });

      if (!result.vendors.length) {
        return {
          content: [{ type: "text", text: "No more vendors — end of results." }],
        };
      }

      const rows = result.vendors.map(v =>
        `  ${v.vendorId.padEnd(20)} ${v.name.padEnd(40)} ${v.status.padEnd(10)} ${v.primaryAddress?.country ?? "N/A"}`,
      ).join("\n");

      const next = result.hasMore && result.pageToken
        ? `\nNext page token: ${result.pageToken}`
        : "\n(End of results)";

      const text =
        `Vendors — Showing: ${result.vendors.length} of ${result.totalCount}\n\n` +
        `  ${"Vendor ID".padEnd(20)} ${"Name".padEnd(40)} ${"Status".padEnd(10)} Country\n` +
        `  ${"─".repeat(78)}\n` +
        rows +
        next;

      return { content: [{ type: "text", text }] };
    },
  );

  // ── Tool 6: Health / Circuit Status ───────────────────────────────────────
  server.tool(
    "check_ariba_connection",
    "Check the current health of the Ariba API connection (circuit breaker state).",
    {},
    async () => {
      const state = adapter.getCircuitState();
      const stateMsg: Record<string, string> = {
        CLOSED:    "HEALTHY — Ariba API is responding normally.",
        OPEN:      "DEGRADED — Ariba API is not responding. Requests are blocked to prevent cascade failures. Retry in ~60 seconds.",
        HALF_OPEN: "RECOVERING — Testing Ariba API connectivity with next request.",
      };
      return {
        content: [{
          type: "text",
          text: `Ariba Connection Status: ${state}\n${stateMsg[state] ?? "Unknown state"}`,
        }],
      };
    },
  );
}

// ── Formatter ──────────────────────────────────────────────────────────────────

function formatAddress(a?: VendorAddress): string {
  if (!a) return "N/A";
  return [a.addressLine1, a.addressLine2, a.city, a.state, a.postalCode, a.country]
    .filter(Boolean)
    .join(", ");
}

function formatContact(c?: VendorContact): string {
  if (!c) return "N/A";
  const name  = [c.firstName, c.lastName].filter(Boolean).join(" ");
  const parts = [name, c.role, c.email, c.phone].filter(Boolean);
  return parts.join(" | ") || "N/A";
}

function formatVendorDetail(v: Vendor): string {
  return (
    `Vendor Details\n` +
    `${"═".repeat(60)}\n` +
    `Vendor ID      : ${v.vendorId}\n` +
    `Name           : ${v.name}\n` +
    `Status         : ${v.status}\n` +
    `Type           : ${v.type          ?? "N/A"}\n` +
    `Tax ID         : ${v.taxId         ?? "N/A"}\n` +
    `DUNS Number    : ${v.dunsNumber    ?? "N/A"}\n` +
    `Website        : ${v.website       ?? "N/A"}\n` +
    `Registered     : ${v.registeredDate ?? "N/A"}\n` +
    `Realm          : ${v.realm}\n` +
    `\nAddress        : ${formatAddress(v.primaryAddress)}\n` +
    `\nPrimary Contact: ${formatContact(v.primaryContact)}\n` +
    (v.categories?.length
      ? `\nCategories     :\n${v.categories.map(c => `  • ${c}`).join("\n")}`
      : "")
  );
}
