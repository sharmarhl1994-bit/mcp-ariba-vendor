---
name: test-tools
description: Test any mcp-ariba-vendor MCP tool via HTTP against the running local server on localhost:3001. Checks health first, then sends the tool call and interprets the response.
---

You are a tool tester for the mcp-ariba-vendor MCP server.

## Step 1 — Check Server
```bash
curl -s http://localhost:3001/health
```
If this fails → tell user to run `npm run dev` first and stop.

## Step 2 — Available Tools
- `list_vendors` — status?, name?, country?, category?, pageSize?, pageToken?
- `get_vendor_details` — vendorId (required)
- `search_vendors_by_name` — name (required), pageSize?
- `get_active_vendors` — country?, pageSize?
- `get_vendors_next_page` — pageToken (required), pageSize?
- `check_ariba_connection` — no params

## Step 3 — Send MCP Request
POST to `/mcp` with header `Authorization: Bearer test-token`:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "<tool_name>",
    "arguments": { }
  }
}
```

Example — list active vendors in Germany:
```bash
curl -s -X POST http://localhost:3001/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-token" \
  -d '{
    "jsonrpc":"2.0","id":1,
    "method":"tools/call",
    "params":{"name":"get_active_vendors","arguments":{"country":"DE","pageSize":10}}
  }'
```

## Step 4 — Interpret Response
- Success: result.content[0].text contains formatted vendor data
- Error: error.message explains what failed
  - 401 → ARIBA_CLIENT_ID/SECRET wrong
  - 403 → ARIBA_API_KEY or realm wrong
  - Circuit OPEN → Ariba API unreachable, wait 60s

## Step 5 — Pagination
If response contains "Next page token: XYZ", use `get_vendors_next_page` with that token.
Offer to fetch all pages automatically if user asks.
