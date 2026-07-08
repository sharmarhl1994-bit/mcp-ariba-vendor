import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  PORT:     z.string().default("3001"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // Ariba OpenAPI
  ARIBA_BASE_URL:  z.string().url(),
  ARIBA_API_KEY:   z.string().min(1),
  ARIBA_REALM:     z.string().min(1),

  // Ariba OAuth2
  ARIBA_TOKEN_URL:     z.string().url(),
  ARIBA_CLIENT_ID:     z.string().min(1),
  ARIBA_CLIENT_SECRET: z.string().min(1),

  // Ariba user context
  ARIBA_PASSWORD_ADAPTER: z.string().default("PasswordAdapter1"),
  ARIBA_USER:             z.string().min(1),

  // Operational limits
  RATE_LIMIT_RPM:  z.coerce.number().default(60),
  DEFAULT_PAGE_SIZE: z.coerce.number().min(1).max(100).default(50),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:\n", parsed.error.format());
  process.exit(1);
}

export const config = parsed.data;
export type Config  = typeof config;
