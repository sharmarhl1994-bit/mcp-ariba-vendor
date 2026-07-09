// Set dummy env vars so config/env.ts validates without a real .env file
process.env.PORT                  = "3001";
process.env.NODE_ENV              = "test";
process.env.ARIBA_BASE_URL        = "https://eu.openapi.ariba.com";
process.env.ARIBA_API_KEY         = "test-api-key";
process.env.ARIBA_REALM           = "744088967-T";
process.env.ARIBA_TOKEN_URL       = "https://api.ariba.com/v2/oauth/token";
process.env.ARIBA_CLIENT_ID       = "test-client-id";
process.env.ARIBA_CLIENT_SECRET   = "test-client-secret";
process.env.ARIBA_PASSWORD_ADAPTER= "PasswordAdapter1";
process.env.ARIBA_USER            = "test-user";
process.env.RATE_LIMIT_RPM        = "60";
process.env.DEFAULT_PAGE_SIZE     = "50";
