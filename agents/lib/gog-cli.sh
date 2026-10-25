#!/usr/bin/env bash
set -euo pipefail

# All repository-owned `gog` subprocesses must enter through this wrapper.
# Keep proxy policy here so Python, Go, and shell callers cannot drift apart
# again — same contract as the sibling `github-cli.sh`.

# ---------------------------------------------------------------------------
# Why `gog` must not traverse the secret-egress proxy (2026-10-26)
#
# The OpenClaw secret-egress proxy intercepts TLS and presents a MITM leaf
# certificate that is missing the Authority Key Identifier extension.
#
# `gog` is a Go binary built with cgo, so on macOS it validates the chain with
# the platform verifier (Security.framework). The platform verifier does NOT
# read SSL_CERT_FILE / CURL_CA_BUNDLE / NODE_EXTRA_CA_CERTS — the trust
# bundle every other client on this host uses — and the proxy's root CA is not
# installed in any macOS keychain. Result: every `gog` call fails at the
# OAuth token refresh with
#
#   tls: failed to verify certificate: x509: "oauth2.googleapis.com"
#   certificate is not trusted
#
# `gh` is unaffected because it is a pure-Go (CGO_ENABLED=0) build that loads
# roots from SSL_CERT_FILE, and `github-cli.sh` strips the proxy anyway.
#
# `gog` authenticates with its own OAuth tokens from the local keyring and
# never needs destination-bound secret sentinels, so there is no reason for it
# to traverse the secret-egress proxy. Strip the proxy env vars, exactly as
# `github-cli.sh` does, rather than weakening TLS verification.
#
# Do NOT "fix" this by installing the proxy CA into the macOS system keychain
# or by clearing TLS verification flags — both broaden trust to defeat the
# defect instead of removing the unnecessary hop.
# ---------------------------------------------------------------------------

unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy

exec gog "$@"
