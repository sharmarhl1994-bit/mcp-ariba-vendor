import { McpServer }                      from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport }              from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport }   from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest }             from "@modelcontextprotocol/sdk/types.js";
import { Router, Request, Response }       from "express";
import { VendorAdapter }                   from "../adapters/vendor.js";
import { registerAllTools }                from "../tools/index.js";
import { bearerAuthMiddleware }            from "../auth/middleware.js";
import { logger }                          from "../core/logger.js";


const sseTransports: Record<string, SSEServerTransport> = {};
const streamableTransports: Record<string, StreamableHTTPServerTransport> = {};

function createMcpServer(): McpServer {
  const server = new McpServer({
    name:    "ariba-vendor-agent",
    version: "1.0.0",
  });

  registerAllTools(server, {
    vendor: new VendorAdapter(),
  });

  return server;
}

export function buildMcpRouter(): Router {
  const router = Router();

  // ── StreamableHTTP (BTP / Fiori / programmatic clients) ───────────────────
  router.post("/mcp", bearerAuthMiddleware, async (req: Request, res: Response) => {
    const incomingSessionId = req.headers["mcp-session-id"] as string | undefined;

    let transport: StreamableHTTPServerTransport;

    if (incomingSessionId && streamableTransports[incomingSessionId]) {
      transport = streamableTransports[incomingSessionId];
    } else if (!incomingSessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (sid) => {
          streamableTransports[sid] = transport;
          logger.info("StreamableHTTP session initialized", { sessionId: sid });
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          delete streamableTransports[transport.sessionId];
          logger.info("StreamableHTTP session closed", { sessionId: transport.sessionId });
        }
      };

      const server = createMcpServer();
      await server.connect(transport);
    } else {
      res.status(400).json({
        error: "Bad Request: missing or invalid Mcp-Session-Id, and not an initialize request",
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  });

  // ── SSE transport (Claude Desktop via local proxy) ─────────────────────────
  router.get("/mcp/sse", bearerAuthMiddleware, async (_req: Request, res: Response) => {
    const transport = new SSEServerTransport("/mcp/sse/message", res);
    sseTransports[transport.sessionId] = transport;
    logger.info("SSE client connected", { sessionId: transport.sessionId });

    const server = createMcpServer();
    await server.connect(transport);

    res.on("close", () => {
      delete sseTransports[transport.sessionId];
      logger.info("SSE client disconnected", { sessionId: transport.sessionId });
    });
  });

  router.post("/mcp/sse/message", bearerAuthMiddleware, async (req: Request, res: Response) => {
    const { sessionId } = req.query as { sessionId: string };
    const transport     = sseTransports[sessionId];
    if (!transport) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    await transport.handlePostMessage(req, res, req.body);
  });

  // ── Health ─────────────────────────────────────────────────────────────────
  router.get("/health", (_req, res) => {
    res.json({
      status:            "ok",
      service:           "ariba-vendor-agent",
      activeSseSessions: Object.keys(sseTransports).length,
    });
  });

  return router;
}