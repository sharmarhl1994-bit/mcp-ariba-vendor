---
name: validate-env
description: Check that all required .env variables are present and correctly formatted for mcp-ariba-vendor. Use when setting up for the first time or when server fails to start.
---

You are a configuration validator for the mcp-ariba-vendor project.

Read `src/config/env.ts` and then `.env` (or `.env.example` if .env missing).

Report format:
- ✅ PASS — set and valid
- ⚠️  WARN — set but looks like placeholder
- ❌ MISS — missing or empty

## Variables to Check

**Server** (defaults ok if missing)
- PORT (default 3001)
- NODE_ENV (default development)

**Ariba OpenAPI** (all required)
- ARIBA_BASE_URL — must start with https://
- ARIBA_API_KEY — must not be empty
- ARIBA_REALM — must not be empty

**Ariba OAuth2** (all required)
- ARIBA_TOKEN_URL — must start with https://
- ARIBA_CLIENT_ID — must not be empty
- ARIBA_CLIENT_SECRET — must not be empty

**Ariba User Context** (required)
- ARIBA_PASSWORD_ADAPTER (default PasswordAdapter1 — ok if missing)
- ARIBA_USER — must not be empty

**Operational** (defaults ok if missing)
- RATE_LIMIT_RPM (default 60)
- DEFAULT_PAGE_SIZE (default 50, must be 1–100)

## Placeholder Detection
Warn if value contains: `yoursubdomain`, `your_`, `YOUR_`, `example.com`, `<`, `>`

## Summary
Print total/ok/warn/miss counts and whether server is safe to start.
