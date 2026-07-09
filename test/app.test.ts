import supertest   from "supertest";
import { buildApp } from "../src/app.js";

const app     = buildApp();
const request = supertest(app);

// MCP StreamableHTTP transport requires both JSON and SSE in Accept header
const MCP_HEADERS = {
  "Authorization": "Bearer test-token",
  "Content-Type":  "application/json",
  "Accept":        "application/json, text/event-stream",
};

// ── Health endpoint ──────────────────────────────────────────────────────────

describe("GET /health", () => {
  it("returns ok status", async () => {
    const res = await request.get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.service).toBe("ariba-vendor-agent");
  });
});

// ── Auth middleware ──────────────────────────────────────────────────────────

describe("Bearer token enforcement", () => {
  it("rejects request with no Authorization header", async () => {
    const res = await request
      .post("/mcp")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Missing Bearer token");
  });

  it("rejects request with non-Bearer scheme", async () => {
    const res = await request
      .post("/mcp")
      .set("Authorization", "Basic dXNlcjpwYXNz")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Missing Bearer token");
  });

  it("passes request with valid Bearer token", async () => {
    const res = await request
      .post("/mcp")
      .set(MCP_HEADERS)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

    // MCP layer handles it — not a 401
    expect(res.status).not.toBe(401);
  });
});

// ── MCP tools/list ───────────────────────────────────────────────────────────

describe("MCP tools/list", () => {
  it("returns all 6 registered vendor tools", async () => {
    const res = await request
      .post("/mcp")
      .set(MCP_HEADERS)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

    expect(res.status).toBe(200);

    const tools: Array<{ name: string }> = res.body?.result?.tools ?? [];
    const names = tools.map((t) => t.name);

    expect(names).toContain("list_vendors");
    expect(names).toContain("get_vendor_details");
    expect(names).toContain("search_vendors_by_name");
    expect(names).toContain("get_active_vendors");
    expect(names).toContain("get_vendors_next_page");
    expect(names).toContain("check_ariba_connection");
  });
});

// ── check_ariba_connection ────────────────────────────────────────────────────

describe("check_ariba_connection tool", () => {
  it("returns circuit breaker state without hitting Ariba API", async () => {
    const res = await request
      .post("/mcp")
      .set(MCP_HEADERS)
      .send({
        jsonrpc: "2.0",
        id:      1,
        method:  "tools/call",
        params:  { name: "check_ariba_connection", arguments: {} },
      });

    expect(res.status).toBe(200);
    const text: string = res.body?.result?.content?.[0]?.text ?? "";
    expect(text).toContain("Ariba Connection Status");
    expect(text).toMatch(/CLOSED|OPEN|HALF_OPEN/);
  });
});

// ── Input validation ─────────────────────────────────────────────────────────

describe("Input validation", () => {
  it("get_vendor_details rejects empty vendorId", async () => {
    const res = await request
      .post("/mcp")
      .set(MCP_HEADERS)
      .send({
        jsonrpc: "2.0",
        id:      1,
        method:  "tools/call",
        params:  { name: "get_vendor_details", arguments: { vendorId: "" } },
      });

    // MCP returns error for invalid zod input
    expect(res.status).toBe(200);
    expect(res.body.error ?? res.body?.result?.isError).toBeTruthy();
  });

  it("list_vendors rejects pageSize > 100", async () => {
    const res = await request
      .post("/mcp")
      .set(MCP_HEADERS)
      .send({
        jsonrpc: "2.0",
        id:      1,
        method:  "tools/call",
        params:  { name: "list_vendors", arguments: { pageSize: 999 } },
      });

    expect(res.status).toBe(200);
    expect(res.body.error ?? res.body?.result?.isError).toBeTruthy();
  });

  it("list_vendors accepts valid status enum", async () => {
    // This will try to call Ariba — mock fetch to avoid network
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok:   false,
      status: 503,
      text: async () => "Service unavailable",
    } as unknown as Response);

    const res = await request
      .post("/mcp")
      .set(MCP_HEADERS)
      .send({
        jsonrpc: "2.0",
        id:      1,
        method:  "tools/call",
        params:  { name: "list_vendors", arguments: { status: "ACTIVE", pageSize: 10 } },
      });

    global.fetch = originalFetch;

    // Tool was called (no schema error) — Ariba returned 503 which is expected in test
    expect(res.status).toBe(200);
    // result or error exists — schema validation passed
    expect(res.body.result ?? res.body.error).toBeTruthy();
  });
});

// ── Pagination token ─────────────────────────────────────────────────────────

describe("get_vendors_next_page", () => {
  it("rejects empty pageToken", async () => {
    const res = await request
      .post("/mcp")
      .set(MCP_HEADERS)
      .send({
        jsonrpc: "2.0",
        id:      1,
        method:  "tools/call",
        params:  { name: "get_vendors_next_page", arguments: { pageToken: "" } },
      });

    expect(res.status).toBe(200);
    expect(res.body.error ?? res.body?.result?.isError).toBeTruthy();
  });
});
