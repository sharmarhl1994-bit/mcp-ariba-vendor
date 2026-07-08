import { config }  from "../config/env.js";
import { logger }  from "../core/logger.js";

interface TokenCache {
  value:     string;
  expiresAt: number;
}

const REFRESH_BUFFER_MS = 30_000;

export class AribaTokenManager {
  private cache: TokenCache | null = null;

  async getToken(): Promise<string> {
    if (this.cache && Date.now() < this.cache.expiresAt - REFRESH_BUFFER_MS) {
      return this.cache.value;
    }
    return this.refresh();
  }

  private async refresh(): Promise<string> {
    logger.debug("Refreshing Ariba OAuth token");

    // Ariba OAuth2: client_credentials + base64 encoded credentials
    const credentials = Buffer.from(
      `${config.ARIBA_CLIENT_ID}:${config.ARIBA_CLIENT_SECRET}`,
    ).toString("base64");

    const res = await fetch(config.ARIBA_TOKEN_URL, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/x-www-form-urlencoded",
        "Authorization": `Basic ${credentials}`,
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error("Ariba token refresh failed", { status: res.status, body });
      throw new Error(`Ariba OAuth token refresh failed [${res.status}]: ${body}`);
    }

    const json = await res.json() as { access_token: string; expires_in: number };

    if (!json.access_token) {
      throw new Error("Ariba token response missing access_token");
    }

    this.cache = {
      value:     json.access_token,
      expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    };

    logger.info("Ariba OAuth token refreshed", {
      expiresIn: json.expires_in,
    });

    return this.cache.value;
  }

  invalidate(): void {
    this.cache = null;
    logger.debug("Ariba token cache invalidated");
  }
}

// Singleton — one token manager for the process lifetime
export const aribaTokens = new AribaTokenManager();
