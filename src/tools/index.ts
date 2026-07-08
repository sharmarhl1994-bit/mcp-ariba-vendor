import { McpServer }      from "@modelcontextprotocol/sdk/server/mcp.js";
import { VendorAdapter }  from "../adapters/vendor.js";
import { registerVendorTools } from "./vendor-tools.js";

export interface AdapterDeps {
  vendor: VendorAdapter;
}

export function registerAllTools(server: McpServer, deps: AdapterDeps): void {
  registerVendorTools(server, deps.vendor);
}
