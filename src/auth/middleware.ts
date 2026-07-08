import { Request, Response, NextFunction } from "express";
import { logger } from "../core/logger.js";

export function requestLogger(req: Request, _res: Response, next: NextFunction): void {
  req.headers["x-correlation-id"] ??= crypto.randomUUID();
  logger.debug(`${req.method} ${req.path}`, {
    correlationId: req.headers["x-correlation-id"],
    ip: req.ip,
  });
  next();
}

// In production wire this to XSUAA JWT verification.
// For now: require any non-empty Bearer token so the MCP contract is enforced
// even before a full identity platform is connected.
export function bearerAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    logger.warn("Rejected request — missing Bearer token", {
      path: req.path,
      ip:   req.ip,
    });
    res.status(401).json({ error: "Missing Bearer token" });
    return;
  }
  next();
}
