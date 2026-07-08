import { buildApp } from "./app.js";
import { config }   from "./config/env.js";
import { logger }   from "./core/logger.js";

const app    = buildApp();
const server = app.listen(Number(config.PORT), () => {
  logger.info("Ariba Vendor MCP Agent running", {
    port:        config.PORT,
    environment: config.NODE_ENV,
    realm:       config.ARIBA_REALM,
    endpoints: {
      streamableHttp: `http://localhost:${config.PORT}/mcp`,
      sse:            `http://localhost:${config.PORT}/mcp/sse`,
      health:         `http://localhost:${config.PORT}/health`,
    },
  });
});

process.on("SIGTERM", () => {
  logger.info("SIGTERM received — shutting down gracefully");
  server.close(() => {
    logger.info("Server closed");
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  logger.info("SIGINT received — shutting down gracefully");
  server.close(() => process.exit(0));
});
