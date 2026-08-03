# GymTrack MCP Server

Machine-facing OAuth + MCP surface for GymTrack.

## Endpoints

- `GET /.well-known/oauth-authorization-server`
- `GET /.well-known/oauth-protected-resource`
- `GET /oauth/authorize`
- `POST /oauth/token`
- `POST /oauth/revoke`
- `POST /mcp`
- `GET /health`

## Tools

- `plan_workout`
- `read_history`
- `read_exercise_progression`

## Env

Required:

- `VITE_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `GYMTRACK_MCP_ISSUER`
- `GYMTRACK_APP_URL`
- `GYMTRACK_WEB_ORIGIN`

Optional:

- `GYMTRACK_MCP_PORT` (default `8787`)
- `GYMTRACK_MCP_ACCESS_TOKEN_TTL_SECONDS` (default `3600`)
- `GYMTRACK_MCP_REFRESH_TOKEN_TTL_SECONDS` (default `7776000`)
- `GYMTRACK_MCP_AUTH_CODE_TTL_SECONDS` (default `600`)

## Local run

```bash
npm --workspace @sindustries/gymtrack-mcp start
```

## Test

```bash
npm --workspace @sindustries/gymtrack-mcp test
```

## Notes

- Uses OAuth Authorization Code + PKCE (`S256`) for public clients.
- Stores only SHA-256 hashes of authorization codes, access tokens, and refresh tokens.
- Refresh-token replay revokes the whole token family.
- Uses the same shared GymTrack query/validation helpers as the legacy `/api/agent/*` routes so tool behaviour stays aligned with the REST contract.
