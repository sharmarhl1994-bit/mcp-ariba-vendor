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
        return { content: [{ type: "text", text: JSON.stringify({ vendors: [], totalCount: 0 }) }] };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
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

      return { content: [{ type: "text", text: JSON.stringify(vendor, null, 2) }] };
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
        return { content: [{ type: "text", text: JSON.stringify({ vendors: [], totalCount: 0, query: name }) }] };
      }

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  // ── Tool 7: Health / Circuit Status ───────────────────────────────────────
  server.tool(
    "check_ariba_connection",
    "Check the current health of the Ariba API connection (circuit breaker state).",
    {},
    async () => {
      const state = adapter.getCircuitState();
      return {
        content: [{ type: "text", text: JSON.stringify({ status: state, healthy: state === "CLOSED" }, null, 2) }],
      };
    },
  );
}

// unused formatter functions removed — all tools now return raw JSON
