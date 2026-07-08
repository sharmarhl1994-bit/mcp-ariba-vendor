import express        from "express";
import { buildMcpRouter } from "./mcp/server.js";
import { requestLogger }  from "./auth/middleware.js";
import { logger }         from "./core/logger.js";
import { config }         from "./config/env.js";

export function buildApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use(requestLogger);

  app.use("/", buildMcpRouter());

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error("Unhandled error", { message: err.message, stack: err.stack });
    res.status(500).json({
      error: config.NODE_ENV === "production"
        ? "An internal error occurred. Please try again."
        : err.message,
    });
  });

  return app;
}
