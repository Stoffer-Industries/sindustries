# Wildcard Localhost + Caddy Subdomain Evaluation

**Task:** `474e5525-8362-4e75-9b40-6d5dd18c5bb5`  
**Source spec:** `brain/specs/infra/portless-local-app-subdomains.md`  
**V1 evaluation:** `brain/specs/infra/portless-evaluation.md`; PR #72 added `docs/infra/portless-local-app-subdomains-evaluation.md` with a Portless-focused defer verdict.  
**Date:** 2026-06-19  
**Evaluator:** Rowan  
**Verdict:** adopt subdomain-first local routing with wildcard `*.sindustries.localhost` hostnames and Caddy as the reverse proxy; do not adopt Portless as the default tool.

This document supersedes the v1 defer verdict. What changed is the architecture framing, not the Portless evidence. V1 evaluated "Portless the tool" and correctly deferred on macOS trust/sudo behavior. V2 evaluates "subdomains as the local architecture" and keeps the subdomain goal while choosing a simpler transport that is deterministic for Tom's multi-agent and multi-worktree workflow.

## Decision

Adopt a subdomain-first local map where the hostname is the stable interface and the current port table is an implementation detail behind it.

Use the naming scheme:

- Prodlike/default: `<service>.sindustries.localhost`
- Dev: `<service>.dev.sindustries.localhost`
- Worktree instances: `<branch-slug>.<service>.dev.sindustries.localhost`

Why this scheme:

- The default prodlike names stay short for browser and automation usage.
- Dev names are visibly separate without reversing the natural "service first" scan order.
- `*.localhost` avoids `/etc/hosts`, `dnsmasq`, and local CA trust for the first rollout while still giving wildcard loopback behavior on macOS and modern browsers.
- Branch-prefixed worktree names compose naturally with the dev namespace and avoid manual port memorization.

## Service Map

The README port table is the source of truth. The table below maps each mode's transport port to its stable local hostname.

| Service | dev hostname | dev transport | prodlike hostname | prodlike transport | Notes |
| --- | --- | --- | --- | --- | --- |
| App | `app.dev.sindustries.localhost` | `127.0.0.1:5173` | `app.sindustries.localhost` | `127.0.0.1:5174` | Browser UI. |
| API | `api.dev.sindustries.localhost` | `127.0.0.1:4000` | `api.sindustries.localhost` | `127.0.0.1:4001` | Use `/api/v1` as today. |
| Postgres | `postgres.dev.sindustries.localhost` | `127.0.0.1:6432` | `postgres.sindustries.localhost` | `127.0.0.1:7432` | DNS alias only; not handled by HTTP Caddy proxy. |
| Tilt | `tilt.dev.sindustries.localhost` | `127.0.0.1:10350` | `tilt.sindustries.localhost` | `127.0.0.1:10351` | Browser UI. |
| Grafana | `grafana.dev.sindustries.localhost` | `127.0.0.1:3000` | `grafana.sindustries.localhost` | `127.0.0.1:3001` | Browser UI. |
| Prometheus | `prometheus.dev.sindustries.localhost` | `127.0.0.1:9090` | `prometheus.sindustries.localhost` | `127.0.0.1:9091` | Browser/API UI. |
| Tempo | `tempo.dev.sindustries.localhost` | `127.0.0.1:3200` | `tempo.sindustries.localhost` | `127.0.0.1:3201` | HTTP API/UI where exposed. |
| OTLP HTTP | `otlp-http.dev.sindustries.localhost` | `127.0.0.1:4318` | `otlp-http.sindustries.localhost` | `127.0.0.1:4328` | Collector endpoint; Caddy proxy optional. |
| OTLP gRPC | `otlp-grpc.dev.sindustries.localhost` | `127.0.0.1:4317` | `otlp-grpc.sindustries.localhost` | `127.0.0.1:4327` | DNS alias only unless a gRPC-aware proxy is explicitly configured. |

Worktree convention:

| Instance | Hostname pattern | Example |
| --- | --- | --- |
| Branch-specific app | `<branch-slug>.app.dev.sindustries.localhost` | `feat-portless-subdomain-service-map.app.dev.sindustries.localhost` |
| Branch-specific API | `<branch-slug>.api.dev.sindustries.localhost` | `lox-task-comments.api.dev.sindustries.localhost` |
| Branch-specific observability | `<branch-slug>.<service>.dev.sindustries.localhost` | `rowan-repro.grafana.dev.sindustries.localhost` |

Branch slugs should be lowercase, replace non-alphanumeric runs with `-`, trim leading/trailing `-`, and cap at 40 characters. The Caddy route generator should fail if two active worktrees resolve to the same slug.

## Options Matrix

| Option | Fit for subdomain-first | Worktree routing | Headless behavior | Setup burden | Risks | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| Portless `0.14.0` | Strong conceptually: app/worktree hostnames are first-class. | Best built-in worktree behavior when launched through `portless run --name`. | Fails AC6 today: non-TTY default path fell back from sudo then blocked in `security add-trusted-cert`. | Low CLI surface but high trust/sudo ambiguity on macOS. | Pre-1.0 state format, local CA trust, privileged 443 listener, no declarative repo-owned route map. | Do not adopt as default now. Keep as prior evidence and revisit if trust/fail-fast improves. |
| `/etc/hosts` + Caddy on port 80 | Good for a small static map. | Weak: every worktree hostname needs a hosts entry or generator with sudo. | Can fail fast if the route generator refuses to edit hosts without a TTY. | Medium; no local CA, but many host entries and privileged bind/edit steps. | Host file drift, manual cleanup, poor wildcard story. | Defer; acceptable fallback if wildcard `.localhost` stops resolving. |
| `*.sindustries.localhost` + Caddy on port 80 | Strong: wildcard names are first-class and ports stay behind the proxy. | Strong with generated Caddy snippets for active worktree ports. | Good if scripts preflight `*.localhost` resolution and port-80 privilege, then exit clearly in headless contexts. | Medium; Caddy install/manual privileged service setup, no DNS daemon or Keychain trust. | Port 80 still needs privileged/manual setup on this Mac; HTTP-only means no secure-cookie parity until a later TLS decision. | Adopt for v1 rollout. |
| `dnsmasq` + Caddy on port 80 | Strongest if `.local` or another custom suffix is mandatory. | Strong wildcard routing. | Good if setup is manual and automation only validates. | Highest; Homebrew dnsmasq, resolver file, launchd/service management, Caddy. | More moving parts than needed, resolver drift, privileged setup. | Future upgrade only if `.localhost` is insufficient. |

## Exact Rollout Commands

Do not run these from cron or a headless agent. The privileged steps are intentionally human-run. Automation should only run the preflight and fail with the message shown below.

### 1. Preflight wildcard resolution

```bash
python3 - <<'PY'
import socket
name = "preflight.sindustries.localhost"
try:
    infos = socket.getaddrinfo(name, 80, type=socket.SOCK_STREAM)
except socket.gaierror as exc:
    raise SystemExit(f"FAIL: {name} does not resolve to loopback: {exc}")
hosts = {item[4][0] for item in infos}
if not hosts.intersection({"127.0.0.1", "::1"}):
    raise SystemExit(f"FAIL: {name} resolved to {sorted(hosts)}, not loopback")
print(f"OK: {name} resolves to {sorted(hosts)}")
PY
```

### 2. Install Caddy

```bash
brew install caddy
caddy version
```

### 3. Write the repo-owned Caddyfile

Suggested target after adoption:

```bash
mkdir -p infra/local-subdomains
$EDITOR infra/local-subdomains/Caddyfile
```

Initial Caddyfile content:

```caddyfile
{
	auto_https off
	admin off
}

http://app.dev.sindustries.localhost {
	reverse_proxy 127.0.0.1:5173
}

http://api.dev.sindustries.localhost {
	reverse_proxy 127.0.0.1:4000
}

http://tilt.dev.sindustries.localhost {
	reverse_proxy 127.0.0.1:10350
}

http://grafana.dev.sindustries.localhost {
	reverse_proxy 127.0.0.1:3000
}

http://prometheus.dev.sindustries.localhost {
	reverse_proxy 127.0.0.1:9090
}

http://tempo.dev.sindustries.localhost {
	reverse_proxy 127.0.0.1:3200
}

http://otlp-http.dev.sindustries.localhost {
	reverse_proxy 127.0.0.1:4318
}

http://app.sindustries.localhost {
	reverse_proxy 127.0.0.1:5174
}

http://api.sindustries.localhost {
	reverse_proxy 127.0.0.1:4001
}

http://tilt.sindustries.localhost {
	reverse_proxy 127.0.0.1:10351
}

http://grafana.sindustries.localhost {
	reverse_proxy 127.0.0.1:3001
}

http://prometheus.sindustries.localhost {
	reverse_proxy 127.0.0.1:9091
}

http://tempo.sindustries.localhost {
	reverse_proxy 127.0.0.1:3201
}

http://otlp-http.sindustries.localhost {
	reverse_proxy 127.0.0.1:4328
}

import worktrees/*.caddy
```

Postgres and OTLP gRPC remain direct TCP endpoints using the same hostnames as DNS aliases. They are not routed by this HTTP Caddyfile in the first rollout.

### 4. Validate config without binding port 80

```bash
caddy validate --config infra/local-subdomains/Caddyfile --adapter caddyfile
```

### 5. Start Caddy manually

On this Mac, normal-user binding to `127.0.0.1:80` returned `PermissionError: [Errno 13] Permission denied`, so the first start must be a human-supervised privileged step:

```bash
sudo caddy run --config "$PWD/infra/local-subdomains/Caddyfile" --adapter caddyfile
```

For durable service setup, prefer a reviewed launchd plist or Homebrew service after the Caddyfile is committed and reviewed. Do not let cron or agent code run `sudo`.

Headless fail-fast check:

```bash
python3 - <<'PY'
import os, socket, sys
if not sys.stdin.isatty() and os.geteuid() != 0:
    raise SystemExit("FAIL: local subdomain proxy requires a human-supervised privileged Caddy start on port 80")
s = socket.socket()
try:
    s.bind(("127.0.0.1", 80))
except PermissionError:
    raise SystemExit("FAIL: cannot bind 127.0.0.1:80 as this user; start Caddy manually with reviewed privileges")
except OSError as exc:
    raise SystemExit(f"FAIL: cannot bind 127.0.0.1:80: {exc}")
finally:
    s.close()
print("OK: port 80 bind preflight passed")
PY
```

### 6. Smoke test

With the relevant stack running:

```bash
curl -I http://api.sindustries.localhost/api/v1/tasks
curl -I http://app.sindustries.localhost/
curl -I http://grafana.sindustries.localhost/
curl -I http://prometheus.sindustries.localhost/
curl -I http://tempo.sindustries.localhost/
```

Expected result is an HTTP response from each backing service. The exact status can be `200`, `302`, `401`, or a service-specific health response depending on the app.

## Worktree Route Generation

The first implementation task should add a small script that reads active worktree metadata and writes `infra/local-subdomains/worktrees/<branch-slug>.caddy`.

Example generated snippet:

```caddyfile
http://feat-portless-subdomain-service-map.app.dev.sindustries.localhost {
	reverse_proxy 127.0.0.1:5183
}

http://feat-portless-subdomain-service-map.api.dev.sindustries.localhost {
	reverse_proxy 127.0.0.1:4010
}
```

The generator must be deterministic, repo-owned, and non-privileged. It should fail fast if:

- the worktree has no branch name;
- the branch slug collides;
- the requested app/API port is missing;
- Caddy is not installed;
- Caddy config validation fails.

## Rollback

Rollback was tested as a written walkthrough only, per this task's guardrail not to install or modify system services. No Caddy or DNS changes were applied during this evaluation.

Rollback procedure after a real Caddy rollout:

1. Stop the foreground process with `Ctrl-C`, or stop the service:

   ```bash
   sudo launchctl bootout system /Library/LaunchDaemons/nz.co.sindustries.local-subdomains.plist
   ```

   Use the actual plist label/path from the reviewed service install.

2. Confirm port 80 is free:

   ```bash
   lsof -nP -iTCP:80 -sTCP:LISTEN
   ```

   Expected: no Caddy listener remains.

3. Revert to the README port table:

   ```bash
   curl -I http://localhost:4001/api/v1/tasks
   curl -I http://localhost:5174/
   curl -I http://localhost:3001/
   curl -I http://localhost:9091/
   curl -I http://localhost:3201/
   ```

4. If Caddy was installed only for this feature:

   ```bash
   brew uninstall caddy
   ```

5. Remove generated worktree snippets:

   ```bash
   trash infra/local-subdomains/worktrees/*.caddy
   ```

6. There is no Keychain CA to remove and no `/etc/hosts` entry to clean for the chosen `*.localhost` option.

## Acceptance Criteria Reopened

- **AC1:** Reopened and replaced. The v1 Portless defer was correct for Portless, but the v2 architecture verdict is adopt subdomain-first via wildcard localhost + Caddy.
- **AC2:** Complete in this evaluation doc. The full service map is recorded above.
- **AC3:** Defined but not implemented. Worktree route generation is specified as the first follow-up implementation slice.
- **AC4:** Partially satisfied by the proposed repo-owned Caddyfile path. Full completion requires committing the actual Caddyfile and generator in a follow-up.
- **AC5:** Not live-tested because no system install was allowed in this pass. Browser endpoints are listed for the follow-up smoke test.
- **AC6:** Addressed by choosing no local CA/trust path and requiring fail-fast preflights for headless execution. Port 80 remains a manual privileged setup.
- **AC7:** Updated in Rowan's `TOOLS.md` with the v2 hostname map and verdict note.

## One-Line Verdict

Adopt subdomain-first local routing with `*.sindustries.localhost` and Caddy, superseding the Portless v1 defer while keeping Portless out of the default path until its macOS trust/sudo behavior is agent-safe.
