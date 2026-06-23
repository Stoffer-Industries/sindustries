# X Bookmarks — Auth Setup (Current)

This archiver now uses **X API v2 + OAuth2 PKCE with refresh tokens**.

- No bird cookie auth required for normal fetches.
- One-time browser auth, then token refresh is automatic.

---

## Current runtime paths

- Tokens: `~/.config/x-bookmarks/tokens.json`
- OAuth config: `~/.config/x-bookmarks/config.json`
- Skill state (pending/processed/log):
  - `scripts/bookmarks/x/state/`

---

## 1) One-time auth

Run once to connect your X account:

```bash
cd ~/.openclaw/workspace
python3 scripts/bookmarks/x/x_api_auth.py --client-id "YOUR_CLIENT_ID"
```

If your app uses a secret:

```bash
python3 scripts/bookmarks/x/x_api_auth.py --client-id "YOUR_CLIENT_ID" --client-secret "YOUR_SECRET"
```

Callback URL required in X app settings:

```text
http://localhost:8739/callback
```

---

## 2) Verify token (and refresh flow)

```bash
python3 scripts/bookmarks/x/x_api_auth.py --print-token
```

- This returns a valid access token.
- If expired, it refreshes using the saved refresh token automatically.
- Re-auth is only needed if refresh token is revoked/expired server-side.

---

## 3) Optional manual refresh

```bash
python3 scripts/bookmarks/x/x_api_auth.py --refresh
```

Notes:
- `--client-id` is optional after first setup (reads from saved config).
- If needed, passing `--client-id`/`--client-secret` updates saved config.

---

## 4) Fetch bookmarks

```bash
node scripts/bookmarks/x/fetch.cjs
```

Fetch uses X API v2 endpoints:
- `https://api.x.com/2/oauth2/token`
- `https://api.x.com/2/users/me`
- `https://api.x.com/2/users/{id}/bookmarks`

---

## Troubleshooting

### `Missing client_id`
Run auth once with `--client-id`, or add it to `~/.config/x-bookmarks/config.json`.

### `X API tokens not found`
Run the one-time auth command above.

### `/users/me` returns unauthorized
Your access/refresh token is no longer valid; re-run one-time auth.

### `print-token` works but fetch fails
Likely endpoint/account permission issue in X developer console (ensure read + bookmark scopes).
