#!/usr/bin/env python3
"""
X API OAuth 2.0 PKCE Authentication Helper

One-time setup: runs a local server to handle the OAuth callback,
opens the browser for user authorization, and saves tokens to disk.

Usage:
    python3 x_api_auth.py --client-id YOUR_CLIENT_ID [--client-secret YOUR_SECRET]

Tokens are saved to ~/.config/x-bookmarks/tokens.json and auto-refreshed.
"""

# PEP 604 union syntax (`dict | None`, `str | None`) is runtime-evaluated in
# Python < 3.10. `from __future__ import annotations` makes all annotations
# lazy strings, so the same source runs cleanly on Python 3.7+ — including
# the macOS system /usr/bin/python3 (3.9.6), which the OpenClaw cron env can
# fall back to if /opt/homebrew/bin isn't first in PATH. Without this, the
# script crashes at import with `TypeError: unsupported operand type(s) for
# |: 'type' and 'NoneType'`.
from __future__ import annotations

import argparse
import base64
import hashlib
import http.server
import json
import os
import secrets
import sys
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

TOKEN_DIR = Path.home() / ".config" / "x-bookmarks"
TOKEN_FILE = TOKEN_DIR / "tokens.json"
CONFIG_FILE = TOKEN_DIR / "config.json"
AUTH_LOG_FILE = TOKEN_DIR / "auth-events.log"

AUTHORIZE_URL = "https://x.com/i/oauth2/authorize"
TOKEN_URL = "https://api.x.com/2/oauth2/token"
REDIRECT_PORT = 8739
REDIRECT_URI = f"http://localhost:{REDIRECT_PORT}/callback"
SCOPES = "tweet.read users.read bookmark.read bookmark.write offline.access"


def save_config(client_id: str, client_secret: str = ""):
    TOKEN_DIR.mkdir(parents=True, exist_ok=True)
    config = {"client_id": client_id}
    if client_secret:
        config["client_secret"] = client_secret
    CONFIG_FILE.write_text(json.dumps(config, indent=2))
    print(f"Config saved to {CONFIG_FILE}")


def load_config() -> dict:
    if not CONFIG_FILE.exists():
        return {}
    return json.loads(CONFIG_FILE.read_text())


def save_tokens(tokens: dict):
    TOKEN_DIR.mkdir(parents=True, exist_ok=True)
    # Store absolute expiry time so we can check it reliably
    if "expires_at" not in tokens and "expires_in" in tokens:
        tokens["expires_at"] = time.time() + tokens["expires_in"]
    TOKEN_FILE.write_text(json.dumps(tokens, indent=2))
    os.chmod(TOKEN_FILE, 0o600)
    print(f"Tokens saved to {TOKEN_FILE}")


def load_tokens() -> dict | None:
    if not TOKEN_FILE.exists():
        return None
    return json.loads(TOKEN_FILE.read_text())


def _is_headless() -> bool:
    """True when invoked from a non-interactive context (e.g. a cron).

    In headless mode we never attempt the interactive OAuth fallback — it would
    block for 120s waiting on a browser callback that will never come, and the
    chatty failure output would trip LLM-cron summarizers into hallucinating a
    cause. Real diagnostics go to AUTH_LOG_FILE instead.
    """
    return bool(os.environ.get("X_AUTH_HEADLESS"))


def _log_event(msg: str) -> None:
    """Write a timestamped event to the auth log file. Never to stdout/stderr.

    This keeps recovery chatter ("refresh failed", "falling back to OAuth",
    etc.) out of the cron output path so the LLM summarizer doesn't see words
    like 'failed' / 'expired' and invent a cause that isn't there.
    """
    try:
        TOKEN_DIR.mkdir(parents=True, exist_ok=True)
        with AUTH_LOG_FILE.open("a") as f:
            ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            f.write(f"{ts} {msg}\n")
    except Exception:
        pass  # never block auth on log write failure


def generate_pkce():
    verifier = secrets.token_urlsafe(64)[:128]
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()
    ).rstrip(b"=").decode()
    return verifier, challenge


def exchange_code(code: str, verifier: str, client_id: str, client_secret: str = "") -> dict:
    data = urllib.parse.urlencode({
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": REDIRECT_URI,
        "code_verifier": verifier,
        "client_id": client_id,
    }).encode()

    req = urllib.request.Request(TOKEN_URL, data=data, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")

    if client_secret:
        creds = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
        req.add_header("Authorization", f"Basic {creds}")

    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


def refresh_access_token(refresh_token: str, client_id: str, client_secret: str = "") -> dict:
    data = urllib.parse.urlencode({
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": client_id,
    }).encode()

    req = urllib.request.Request(TOKEN_URL, data=data, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")

    if client_secret:
        creds = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
        req.add_header("Authorization", f"Basic {creds}")

    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


def get_valid_token() -> str | None:
    """Get a valid access token, refreshing if needed.

    In headless mode (X_AUTH_HEADLESS=1, e.g. from a cron), never attempts the
    interactive OAuth fallback. Returns None on any unrecoverable situation so
    the caller can surface a clean error. Real recovery attempts and failures
    are written to AUTH_LOG_FILE — never to stdout/stderr — so the LLM-cron
    summarizer does not pattern-match on words like 'failed' or 'expired' and
    hallucinate a cause.
    """
    tokens = load_tokens()
    if not tokens:
        return None

    config = load_config()
    if not config.get("client_id"):
        return None

    # Determine whether the current access token is still usable. We use a
    # 60-second safety margin so we never call the X API with a token that's
    # about to expire mid-request.
    expires_at = tokens.get("expires_at") or 0
    is_expired = expires_at and time.time() > expires_at - 60

    # Fast path: not expired → return what we have, do NOT refresh. X's
    # refresh tokens are one-time-use, so refreshing on every call would burn
    # the refresh token and lock us out of future refreshes.
    if not is_expired:
        if tokens.get("access_token"):
            return tokens["access_token"]
        # No access token and not "expired" — fall through to refresh.

    # Slow path: token is expired (or missing). Refresh.
    if not tokens.get("refresh_token"):
        _log_event("WARN access token expired and no refresh_token available")
        if _is_headless():
            return None
        _log_event("INFO falling back to interactive OAuth flow")
        try:
            authorize(config["client_id"], config.get("client_secret", ""))
            new_tokens = load_tokens()
            if new_tokens:
                return new_tokens.get("access_token")
        except Exception as e:
            _log_event(f"ERROR re-auth failed: {e}")
        return None

    try:
        new_tokens = refresh_access_token(
            tokens["refresh_token"],
            config["client_id"],
            config.get("client_secret", ""),
        )
        # Only keep the rotated refresh_token if X returned one. Otherwise
        # keep the existing one (some flows don't rotate).
        if "refresh_token" not in new_tokens and tokens.get("refresh_token"):
            new_tokens["refresh_token"] = tokens["refresh_token"]
        save_tokens(new_tokens)
        _log_event("INFO token refresh succeeded")
        return new_tokens["access_token"]
    except Exception as e:
        _log_event(f"WARN token refresh failed: {e}")

    # Refresh failed. Decide whether to fall back to interactive re-auth.
    if _is_headless():
        _log_event("ERROR refresh unavailable in headless mode; returning no token")
        return None

    _log_event("INFO falling back to interactive OAuth flow")
    try:
        authorize(config["client_id"], config.get("client_secret", ""))
        new_tokens = load_tokens()
        if new_tokens:
            return new_tokens.get("access_token")
    except Exception as e:
        _log_event(f"ERROR re-auth failed: {e}")

    return None


def authorize(client_id: str, client_secret: str = ""):
    """Run the full OAuth 2.0 PKCE authorization flow."""
    verifier, challenge = generate_pkce()
    state = secrets.token_urlsafe(32)

    auth_params = urllib.parse.urlencode({
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": REDIRECT_URI,
        "scope": SCOPES,
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    })

    auth_url = f"{AUTHORIZE_URL}?{auth_params}"
    result = {"code": None, "error": None}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            params = urllib.parse.parse_qs(parsed.query)

            if parsed.path == "/callback":
                if params.get("state", [None])[0] != state:
                    result["error"] = "State mismatch"
                elif "error" in params:
                    result["error"] = params["error"][0]
                else:
                    result["code"] = params.get("code", [None])[0]

                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                msg = "✅ Authorization successful! You can close this tab." if result["code"] else f"❌ Error: {result['error']}"
                self.wfile.write(f"<html><body><h2>{msg}</h2></body></html>".encode())
            else:
                self.send_response(404)
                self.end_headers()

        def log_message(self, *args):
            pass  # Suppress logs

    server = http.server.HTTPServer(("localhost", REDIRECT_PORT), Handler)
    server.timeout = 120

    print(f"\n🔐 Opening browser for X authorization...")
    print(f"   If it doesn't open, visit:\n   {auth_url}\n")
    webbrowser.open(auth_url)

    # Wait for callback
    server.handle_request()
    server.server_close()

    if result["error"]:
        print(f"❌ Authorization failed: {result['error']}")
        sys.exit(1)

    if not result["code"]:
        print("❌ No authorization code received (timeout?)")
        sys.exit(1)

    print("🔄 Exchanging code for tokens...")
    tokens = exchange_code(result["code"], verifier, client_id, client_secret)
    save_tokens(tokens)
    save_config(client_id, client_secret)

    print(f"✅ Authenticated! Access token expires in {tokens.get('expires_in', '?')}s")
    if tokens.get("refresh_token"):
        print("   Refresh token saved — will auto-refresh.")
    else:
        print("   ⚠️  No refresh token. Add 'offline.access' scope or re-auth when expired.")


def main():
    parser = argparse.ArgumentParser(description="X API OAuth 2.0 PKCE setup")
    parser.add_argument("--client-id", default="", help="Your X API Client ID")
    parser.add_argument("--client-secret", default="", help="Client Secret (for confidential apps)")
    parser.add_argument("--refresh", action="store_true", help="Just refresh the existing token")
    parser.add_argument("--print-token", action="store_true", help="Print current access token")

    args = parser.parse_args()

    if args.print_token:
        token = get_valid_token()
        if token:
            print(token)
        else:
            print("No valid token found. Run without --print-token to authorize.", file=sys.stderr)
            sys.exit(1)
        return

    existing = load_config()
    client_id = args.client_id or existing.get("client_id", "")
    client_secret = args.client_secret or existing.get("client_secret", "")

    if not client_id:
        print("❌ Missing client_id. Pass --client-id or set it in ~/.config/x-bookmarks/config.json", file=sys.stderr)
        sys.exit(1)

    if args.refresh:
        save_config(client_id, client_secret)
        token = get_valid_token()
        if token:
            print(f"✅ Token refreshed successfully")
        else:
            print("❌ Refresh failed. Re-run without --refresh to re-authorize.")
            sys.exit(1)
        return

    authorize(client_id, client_secret)


if __name__ == "__main__":
    main()
