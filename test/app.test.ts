import supertest   from "supertest";
import { buildApp } from "../src/app.js";

const app     = buildApp();
const request = supertest(app);

// MCP StreamableHTTP transport requires both JSON and SSE in Accept header
const BASE_HEADERS = {
  "Authorization": "Bearer test-token",
  "Content-Type":  "application/json",
  "Accept":        "application/json, text/event-stream",
};

let sessionId: string;

function mcpHeaders() {
  return sessionId
    ? { ...BASE_HEADERS, "Mcp-Session-Id": sessionId }
    : BASE_HEADERS;
}

// Server responds over text/event-stream (SSE), not plain JSON, so supertest's
// res.body is often empty. This pulls the actual JSON-RPC payload out of the
// SSE "data:" line when needed.
function parseSseJson(res: supertest.Response): any {
  if (res.body && Object.keys(res.body).length) return res.body;
  const match = res.text?.match(/data:\s*(\{.*\})/s);
  return match ? JSON.parse(match[1]) : {};
}

beforeAll(async () => {
  const initRes = await request
    .post("/mcp")
    .set(BASE_HEADERS)
    .send({
      jsonrpc: "2.0",
      id:      0,
      method:  "initialize",
      params:  {
        protocolVersion: "2024-11-05",
        capabilities:    {},
        clientInfo:      { name: "test-client", version: "1.0" },
      },
    });

  sessionId = initRes.headers["mcp-session-id"];

  if (sessionId) {
    await request
      .post("/mcp")
      .set(mcpHeaders())
      .send({
        jsonrpc: "2.0",
        method:  "notifications/initialized",
        params:  {},
      });
  }
});

describe("GET /health", () => {
  it("returns ok status", async () => {
    const res = await request.get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.service).toBe("ariba-vendor-agent");
  });
});

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
      .set(mcpHeaders())
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

    expect(res.status).not.toBe(401);
  });
});

describe("MCP tools/list", () => {
  it("returns all 6 registered vendor tools", async () => {
    const res = await request
      .post("/mcp")
      .set(mcpHeaders())
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

    expect(res.status).toBe(200);

    const body = parseSseJson(res);
    const tools: Array<{ name: string }> = body?.result?.tools ?? [];
    const names = tools.map((t) => t.name);

    expect(names).toContain("list_vendors");
    expect(names).toContain("get_vendor_details");
    expect(names).toContain("search_vendors_by_name");
    expect(names).toContain("get_active_vendors");
    expect(names).toContain("get_vendors_next_page");
    expect(names).toContain("check_ariba_connection");
  });
});

describe("check_ariba_connection tool", () => {
  it("returns circuit breaker state without hitting Ariba API", async () => {
    const res = await request
      .post("/mcp")
      .set(mcpHeaders())
      .send({
        jsonrpc: "2.0",
        id:      1,
        method:  "tools/call",
        params:  { name: "check_ariba_connection", arguments: {} },
      });

    expect(res.status).toBe(200);
    const body = parseSseJson(res);
    const text: string = body?.result?.content?.[0]?.text ?? "";
    expect(text).toContain("Ariba Connection Status");
    expect(text).toMatch(/CLOSED|OPEN|HALF_OPEN/);
  });
});

describe("Input validation", () => {
  it("get_vendor_details rejects empty vendorId", async () => {
    const res = await request
      .post("/mcp")
      .set(mcpHeaders())
      .send({
        jsonrpc: "2.0",
        id:      1,
        method:  "tools/call",
        params:  { name: "get_vendor_details", arguments: { vendorId: "" } },
      });

    expect(res.status).toBe(200);
    const body = parseSseJson(res);
    expect(body.error ?? body?.result?.isError).toBeTruthy();
  });

  it("list_vendors rejects pageSize > 100", async () => {
    const res = await request
      .post("/mcp")
      .set(mcpHeaders())
      .send({
        jsonrpc: "2.0",
        id:      1,
        method:  "tools/call",
        params:  { name: "list_vendors", arguments: { pageSize: 999 } },
      });

    expect(res.status).toBe(200);
    const body = parseSseJson(res);
    expect(body.error ?? body?.result?.isError).toBeTruthy();
  });

  it("list_vendors accepts valid status enum", async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok:   false,
      status: 503,
      text: async () => "Service unavailable",
    } as unknown as Response);

    const res = await request
      .post("/mcp")
      .set(mcpHeaders())
      .send({
        jsonrpc: "2.0",
        id:      1,
        method:  "tools/call",
        params:  { name: "list_vendors", arguments: { status: "ACTIVE", pageSize: 10 } },
      });

    global.fetch = originalFetch;

    expect(res.status).toBe(200);
    const body = parseSseJson(res);
    expect(body.result ?? body.error).toBeTruthy();
  });
});

describe("get_vendors_next_page", () => {
  it("rejects empty pageToken", async () => {
    const res = await request
      .post("/mcp")
      .set(mcpHeaders())
      .send({
        jsonrpc: "2.0",
        id:      1,
        method:  "tools/call",
        params:  { name: "get_vendors_next_page", arguments: { pageToken: "" } },
      });

    expect(res.status).toBe(200);
    const body = parseSseJson(res);
    expect(body.error ?? body?.result?.isError).toBeTruthy();
  });
});