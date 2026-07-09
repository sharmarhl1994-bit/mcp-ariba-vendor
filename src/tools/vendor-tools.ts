import { McpServer }     from "@modelcontextprotocol/sdk/server/mcp.js";
import { z }             from "zod";
import { VendorAdapter } from "../adapters/vendor.js";
import { AuditEmitter }  from "../core/audit.js";
import type { Vendor, VendorAddress, InactiveVendor } from "../adapters/vendor.js";

export function registerVendorTools(server: McpServer, adapter: VendorAdapter): void {

  // ── Tool 1: List / Filter Vendors ──────────────────────────────────────────
  server.tool(
    "list_vendors",
    "List vendors from SAP Ariba. All filters are sent server-side except 'name' which is client-side.",
    {
      smVendorIds:              z.array(z.string()).optional()
                                 .describe("Filter by SM Vendor IDs e.g. [\"S123456\"]"),
      erpVendorIds:             z.array(z.string()).optional()
                                 .describe("Filter by ERP Vendor IDs"),
      registrationStatusList:   z.array(z.string()).optional()
                                 .describe("e.g. [\"Registered\", \"InRegistration\", \"Invited\"]"),
      qualificationStatusList:  z.array(z.string()).optional()
                                 .describe("e.g. [\"Qualified\", \"InQualification\"]"),
      regionList:               z.array(z.string()).optional()
                                 .describe("e.g. [\"USA\", \"INDIA\", \"KAZ\"]"),
      categoryList:             z.array(z.string()).optional()
                                 .describe("Category codes e.g. [\"51\", \"71\"]"),
      businessUnitList:         z.array(z.string()).optional()
                                 .describe("Business unit codes e.g. [\"408\", \"1000\"]"),
      preferredLevelList:       z.array(z.number()).optional()
                                 .describe("Preferred levels e.g. [0, 1, 2]"),
      name:                     z.string().optional()
                                 .describe("Partial name search (client-side, case-insensitive)"),
      withQuestionnaire:        z.boolean().optional().describe("Include questionnaire data (default true)"),
      withGenericCustomFields:  z.boolean().optional().describe("Include custom fields"),
      withBankDetail:           z.boolean().optional().describe("Include bank account details"),
      withTaxDetail:            z.boolean().optional().describe("Include tax number details"),
      withCompanyCodeDetail:    z.boolean().optional().describe("Include company code details"),
      withDisqualifications:    z.boolean().optional().describe("Include disqualification data"),
      pageSize:                 z.number().min(1).max(100).optional()
                                 .describe("Results per page (1–100, default 50)"),
      pageToken:                z.string().optional()
                                 .describe("Pagination cursor from previous call"),
    },
    async (params) => {
      const start  = Date.now();
      const result = await adapter.listVendors(params);

      AuditEmitter.emit({
        action:      "LIST_VENDORS",
        tool:        "list_vendors",
        durationMs:  Date.now() - start,
        resultCount: result.vendors.length,
        filters:     { registrationStatusList: params.registrationStatusList, name: params.name },
      });

      if (!result.vendors.length) {
        return { content: [{ type: "text", text: "No vendors found matching the given filters." }] };
      }

      const rows = result.vendors.map(v =>
        `  ${v.vendorId.padEnd(20)} ${v.name.padEnd(40)} ${v.registrationStatus.padEnd(15)} ${v.primaryAddress?.country ?? "N/A"}`,
      ).join("\n");

      const pagination = result.hasMore && result.pageToken
        ? `\nNext page token: ${result.pageToken}\n(Call list_vendors with pageToken to load more)`
        : "\n(End of results)";

      const text =
        `Vendors — Total: ${result.totalCount} | Showing: ${result.vendors.length}\n\n` +
        `  ${"Vendor ID".padEnd(20)} ${"Name".padEnd(40)} ${"Reg. Status".padEnd(15)} Country\n` +
        `  ${"─".repeat(83)}\n` +
        rows + pagination;

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
        `  ${v.vendorId.padEnd(20)} ${v.name.padEnd(40)} ${v.registrationStatus.padEnd(15)} ${v.primaryAddress?.country ?? "N/A"}`,
      ).join("\n");

      const text =
        `Search results for "${name}" — Found: ${result.vendors.length} of ${result.totalCount}\n\n` +
        `  ${"Vendor ID".padEnd(20)} ${"Name".padEnd(40)} ${"Reg. Status".padEnd(15)} Country\n` +
        `  ${"─".repeat(83)}\n` +
        rows;

      return { content: [{ type: "text", text }] };
    },
  );

  // ── Tool 4: Get Active Vendors ─────────────────────────────────────────────
  server.tool(
    "get_active_vendors",
    "Get all Registered vendors from SAP Ariba.",
    {
      pageSize: z.number().min(1).max(100).optional().describe("Results per page (default 50)"),
    },
    async ({ pageSize }) => {
      const start  = Date.now();
      const result = await adapter.getActiveVendors(pageSize);

      AuditEmitter.emit({
        action:      "GET_ACTIVE_VENDORS",
        tool:        "get_active_vendors",
        durationMs:  Date.now() - start,
        resultCount: result.vendors.length,
      });

      if (!result.vendors.length) {
        return { content: [{ type: "text", text: "No active vendors found." }] };
      }

      const rows = result.vendors.map(v =>
        `  ${v.vendorId.padEnd(20)} ${v.name.padEnd(40)} ${v.registrationStatus.padEnd(15)} ${v.primaryAddress?.country ?? "N/A"}`,
      ).join("\n");

      const pagination = result.hasMore && result.pageToken
        ? `\nNext page token: ${result.pageToken}`
        : "";

      const text =
        `Active Vendors — Total: ${result.totalCount} | Showing: ${result.vendors.length}\n\n` +
        `  ${"Vendor ID".padEnd(20)} ${"Name".padEnd(40)} ${"Reg. Status".padEnd(15)} Country\n` +
        `  ${"─".repeat(83)}\n` +
        rows + pagination;

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
        `  ${v.vendorId.padEnd(20)} ${v.name.padEnd(40)} ${v.registrationStatus.padEnd(15)} ${v.primaryAddress?.country ?? "N/A"}`,
      ).join("\n");

      const next = result.hasMore && result.pageToken
        ? `\nNext page token: ${result.pageToken}`
        : "\n(End of results)";

      const text =
        `Vendors — Showing: ${result.vendors.length} of ${result.totalCount}\n\n` +
        `  ${"Vendor ID".padEnd(20)} ${"Name".padEnd(40)} ${"Reg. Status".padEnd(15)} Country\n` +
        `  ${"─".repeat(83)}\n` +
        rows +
        next;

      return { content: [{ type: "text", text }] };
    },
  );

  // ── Tool 6: List Inactive Vendors ─────────────────────────────────────────
  server.tool(
    "list_inactive_vendors",
    "List inactive/archived vendors from SAP Ariba. These are vendors removed from the active supplier base.",
    {
      smVendorIds:       z.array(z.string()).optional().describe("Filter by SM Vendor IDs e.g. [\"S123456\"]"),
      erpVendorIds:      z.array(z.string()).optional().describe("Filter by ERP Vendor IDs"),
      withQuestionnaire: z.boolean().optional().describe("Include questionnaire data (default true)"),
      name:              z.string().optional().describe("Partial name search (client-side, case-insensitive)"),
      pageSize:          z.number().min(1).max(100).optional().describe("Results per page (default 50)"),
    },
    async ({ smVendorIds, erpVendorIds, withQuestionnaire, name, pageSize }) => {
      const start  = Date.now();
      const result = await adapter.listInactiveVendors({ smVendorIds, erpVendorIds, withQuestionnaire, name, pageSize });

      AuditEmitter.emit({
        action:      "LIST_INACTIVE_VENDORS",
        tool:        "list_inactive_vendors",
        durationMs:  Date.now() - start,
        resultCount: result.vendors.length,
        filters:     { name },
      });

      if (!result.vendors.length) {
        return {
          content: [{ type: "text", text: "No inactive vendors found." }],
        };
      }

      const rows = result.vendors.map(v =>
        `  ${v.vendorId.padEnd(14)} ${v.erpVendorId?.padEnd(14) ?? "N/A".padEnd(14)} ${v.name.padEnd(40)} ${v.registrationStatus.padEnd(16)} ${v.qualificationStatus ?? "N/A"}`,
      ).join("\n");

      const text =
        `Inactive Vendors — Total: ${result.totalCount}\n\n` +
        `  ${"SM Vendor ID".padEnd(14)} ${"ERP Vendor ID".padEnd(14)} ${"Name".padEnd(40)} ${"Reg. Status".padEnd(16)} Qual. Status\n` +
        `  ${"─".repeat(102)}\n` +
        rows;

      return { content: [{ type: "text", text }] };
    },
  );

  // ── Tool 7: Health / Circuit Status ───────────────────────────────────────
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

function formatVendorDetail(v: Vendor): string {
  const taxLines = v.taxNumbers?.length
    ? v.taxNumbers.map(t => `  • [${t.type ?? "?"}] ${t.number}`).join("\n")
    : "  N/A";

  const bankLines = v.bankAccounts?.length
    ? v.bankAccounts.map(b =>
        `  • IBAN: ${b.iban ?? "N/A"}  Country: ${b.country ?? "N/A"}  Valid: ${b.validFrom ?? "?"} – ${b.validTo ?? "?"}`,
      ).join("\n")
    : "  N/A";

  const customLines = v.customFields && Object.keys(v.customFields).length
    ? Object.entries(v.customFields).map(([k, val]) => `  • ${k}: ${val}`).join("\n")
    : "  N/A";

  const qualLines = v.qualifications?.length
    ? v.qualifications.map(q =>
        `  • [${q.category ?? "?"}] ${q.region ?? "All"} — ${q.qualificationStatus ?? "?"}`
      ).join("\n")
    : "  N/A";

  return (
    `Vendor Details\n` +
    `${"═".repeat(60)}\n` +
    `Vendor ID          : ${v.vendorId}\n` +
    `Name               : ${v.name}\n` +
    `Registration Status: ${v.registrationStatus}\n` +
    `Qualification Status: ${v.qualificationStatus ?? "N/A"}\n` +
    `ERP Vendor ID      : ${v.erpVendorId ?? "N/A"}\n` +
    `ACM ID             : ${v.acmId ?? "N/A"}\n` +
    `Integrated to ERP  : ${v.integratedToErp ?? "N/A"}\n` +
    `Blocked            : ${v.isBlocked ?? "N/A"}\n` +
    `Last Updated       : ${v.lastUpdateDate ?? "N/A"}\n` +
    `Realm              : ${v.realm}\n` +
    `\nAddress        :\n  ${formatAddress(v.primaryAddress)}\n` +
    `\nTax Numbers    :\n${taxLines}\n` +
    `\nBank Accounts  :\n${bankLines}\n` +
    `\nCustom Fields  :\n${customLines}\n` +
    `\nQualifications :\n${qualLines}\n`
  );
}
