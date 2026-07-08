import { logger } from "./logger.js";

export interface AuditEvent {
  action:         string;
  tool:           string;
  correlationId?: string;
  durationMs?:    number;
  resultCount?:   number;
  vendorId?:      string;
  realm?:         string;
  error?:         string;
  [key: string]:  unknown;
}

export class AuditEmitter {
  static emit(event: AuditEvent): void {
    logger.info("AUDIT", {
      ...event,
      timestamp: new Date().toISOString(),
    });
  }
}
