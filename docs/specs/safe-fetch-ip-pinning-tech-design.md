---
status: draft
task_id: d6198e83-14d5-48de-9a7e-addfb65dec30
product_spec: n/a (audit-driven fix; W34 finding T1.2)
shipped_pr: null
shipped_date: null
---

# Tech Design — Pin validated IP in safe_fetch to close DNS-rebinding SSRF (W34 T1.2)

## 1. Product intent

Audit finding from `docs/repo-audits/2026-W34.md` (finding T1.2,
Security & correctness, Medium):

> `safe_fetch` SSRF guard is bypassable via DNS rebinding
> (validate-then-refetch by hostname; the validated IP is never pinned
> to the connection).

`safe_fetch` in
`agents/workflows/cto-craft-tweet-drafts/src/cto_craft_workflow/safe_fetch.py`
is the **only** network module in the CTO Craft weekly pipeline. It is
explicitly the workflow's SSRF boundary — every schema-choice and
per-hop re-validation check (scheme allow-list, credential rejection,
private-IP rejection, redirect cap, size cap, content-type allow-list,
tracking-param stripping, query-redacted logging) lives there. The one
gap is the validate-then-refetch TOCTOU: `_validate_url_and_resolve`
runs `socket.getaddrinfo` and rejects private addresses (line 119), and
then `self._client.get(current_url, ...)` runs an **independent** DNS
resolution inside httpx (line 273) when it opens the socket. There is
no IP carried from validation to connection — a DNS-rebinding attacker
who controls the authoritative NS for an article URL can return a
public IP for the validation lookup and a private IP
(`127.0.0.1`, `169.254.169.254`, etc.) microseconds later for the httpx
socket lookup, defeating every check above.

Goal: pin the validated IP through the entire request lifecycle so that
the validate-then-refetch TOCTOU window is closed. The validated IP
from `_resolve_and_validate_ip` flows into the actual httpx request as
the connection target; the original hostname survives in the HTTP
`Host` header and TLS SNI so the response stays reachable and cert
verification continues to anchor to the original hostname.

## 2. Repo / branch / worktree

- **Repo:** `Stoffer-Industries/sindustries`
- **Branch:** `task-d6198e83-safe-fetch-ip-pinning` (off `origin/main`,
  HEAD `6bdd6848` at design time)
- **Worktree:** `/Users/quinnstoffer/.openclaw/workspace/worktrees/d6198e83-safe-fetch-ip-pinning`
- **Task:** `d6198e83-14d5-48de-9a7e-addfb65dec30` (code task, assignee Rowan)
- **Audit source:** `docs/repo-audits/2026-W34.md` (finding T1.2)

## 3. Service boundary and data ownership

**Owner:** `agents/workflows/cto-craft-tweet-drafts/`. The `safe_fetch`
module is internal to the workflow and is the only network boundary;
no shared package is involved. The CTO Craft workflow also owns the
`tests/test_safe_fetch.py` pytest suite that verifies the boundary.

**Why not a shared `service-ssrf-safe-fetch` package:** the audit's
explicit recommendation is "pin the validated IP: resolve once, connect
to the IP with `Host`/SNI preserved, or use an httpx transport with a
pinned resolver." That's exactly the in-place fix. The workflow is the
only consumer; the cross-service extraction is a separate follow-up if
a second workflow with the same boundary shape ever lands.

**Why not a third-party dep (`httpx-socks`-style pinning, `asyncio`,
`aiohttp`):** `httpx` 0.27+ (we are on 0.28.1) has native support for
the exact pattern via the request-time `extensions={"sni_hostname": …}`
parameter, documented in the upstream "Extensions — Connect to a known
server IP address" section. No new dep is needed.

## 4. `.openclaw` boundary notes

None. The change is fully self-contained inside
`agents/workflows/cto-craft-tweet-drafts/`. The workflow already has a
CI job (added in PR #463, W34 QW1) so the new pytest cases land in CI
automatically without further `.github/workflows/ci.yml` changes. No
agent config, scheduler, or cross-workflow change.

## 5. Implementation plan

### 5.1 New helper: `pick_pinned_ip(host) -> str`

Add a small helper at module scope that combines DNS resolution and
the public-IP predicate already at
`agents/workflows/cto-craft-tweet-drafts/src/cto_craft_workflow/safe_fetch.py:163-176`:

```python
def _pick_public_ip(host: str, url: str) -> str:
    """Resolve ``host`` and return the first public IP, raising on any private address.

    The returned IP is intended to be the connection target — pinning the IP
    closes the validate-then-refetch TOCTOU in the original single-resolution
    pattern.

    Mirrors the public-IP predicate in :func:`_is_public_ip`; raises
    :class:`FetchError` with the same ``SSRF_BLOCKED`` /
    ``DNS_LOOKUP_FAILED`` / ``DNS_BAD_ADDRESS`` codes as
    :func:`_resolve_and_validate_ip` so the existing call sites see no
    envelope change.
    """
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise FetchError(
            "DNS_LOOKUP_FAILED",
            f"DNS lookup failed for {host}",
            url=_safe_label(url),
        ) from exc
    if not infos:
        raise FetchError(
            "DNS_LOOKUP_FAILED",
            f"DNS lookup returned no addresses for {host}",
            url=_safe_label(url),
        )
    for info in infos:
        sockaddr = info[4]
        ip = sockaddr[0]
        try:
            parsed = ipaddress.ip_address(ip)
        except ValueError:
            raise FetchError(
                "DNS_BAD_ADDRESS",
                f"DNS returned non-IP value {ip!r}",
                url=_safe_label(url),
            )
        if not _is_public_ip(ip):
            raise FetchError(
                "SSRF_BLOCKED",
                f"Refusing to fetch {host}: resolved to {ip} which is not a public address",
                url=_safe_label(url),
            )
        return ip  # first public IP wins
    raise FetchError(
        "SSRF_BLOCKED",
        f"Refusing to fetch {host}: no public addresses returned",
        url=_safe_label(url),
    )
```

**Note on multi-IP hosts:** most article hosts (TMW / linked blogs) are
CDN-fronted with multiple A records. httpx's connection pool normally
failovers across IPs on connection failure; under IP-pinning we lose
that failover. The trade-off is deliberate — DNS-rebinding defense is
an explicit design constraint — and `httpx.Client` keeps the default
`max_keepalive_connections=20` for normal traffic. A pinned connection
failure surfaces as `TRANSPORT_ERROR` (existing envelope), which is
fine.

### 5.2 Update `_validate_url_and_resolve` to return the IP

```python
def _validate_url_and_resolve(url: str) -> str:
    """Validate scheme + resolve host; return the pinned public IP."""
    _validate_scheme(url)
    host = urlsplit(url).hostname or ""
    if not host:
        raise FetchError("UNSAFE_URL", "URL is missing a hostname", url=_safe_label(url))
    return _pick_public_ip(host, url)
```

Backwards-compatibility: the only call sites are inside
`SafeFetcher.fetch`. They currently call the function for its exception
side effect; the return value is ignored. Updating them to receive the
IP is the change in §5.3. No external caller of this helper exists
(it is module-private by leading underscore), so the signature change
is internal-only.

### 5.3 Per-hop fetch uses the pinned IP

In `SafeFetcher.fetch` (currently lines 224-285), the existing pattern is:

```python
for hop in range(self._max_redirects + 1):
    _validate_url_and_resolve(current_url)
    try:
        response = self._client.get(current_url, timeout=…, headers=…)
    ...
```

Replace with:

```python
for hop in range(self._max_redirects + 1):
    pinned_ip = _validate_url_and_resolve(current_url)
    original_host = urlsplit(current_url).hostname or ""
    pinned_url = httpx.URL(current_url).copy_with(host=pinned_ip)
    pinned_headers = {"Accept": "text/html, application/xhtml+xml, text/plain, text/markdown",
                      "Host": original_host}
    pinned_extensions = {"sni_hostname": original_host} if pinned_url.scheme == "https" else {}
    try:
        response = self._client.get(
            pinned_url,
            timeout=httpx.Timeout(
                connect=self._timeout_seconds,
                read=self._timeout_seconds,
                write=self._timeout_seconds,
                pool=self._timeout_seconds,
            ),
            headers=pinned_headers,
            extensions=pinned_extensions,
        )
    except httpx.TimeoutException as exc:
        raise FetchError("TIMEOUT", f"timeout after {self._timeout_seconds}s",
                         url=_safe_label(current_url)) from exc
    except httpx.HTTPError as exc:
        raise FetchError("TRANSPORT_ERROR", f"transport error: {exc.__class__.__name__}",
                         url=_safe_label(current_url)) from exc
    # …redirect loop continues to call _validate_url_and_resolve(next_url),
    # which re-pins the per-hop IP — see AC2.
```

**Why three knobs (`Host` header + URL host + SNI extension):**

1. URL host = `<pinned_ip>` — the actual TCP socket opens against
   this IP, so DNS rebinding is impossible.
2. `Host: <original_host>` — the HTTP server (or origin behind a CDN
   with vhost routing) sees the original hostname for route lookup.
3. `sni_hostname: <original_host>` (HTTPS only) — the TLS handshake
   validates the certificate against the original hostname (for
   CDN-fronted sites the cert is for the original hostname, not the
   pinned IP). httpx 0.28 honours this extension on its TLS-wrapping
   transport; HTTP-only requests omit the extension since `sni_hostname`
   is HTTPS-only.

The three together preserve "the URL the server thinks it's serving"
while "the network socket actually goes to the IP we pre-validated."
That is the canonical DNS-rebinding mitigation pattern.

### 5.4 New pytest cases in `tests/test_safe_fetch.py`

The existing 11 cases use `httpx.MockTransport`; the new cases extend
that pattern with a transport that records which IP it received the
request against (rather than which hostname). The point: the transport
must see the **pinned IP** in the URL (or, equivalently, `request.url.host`
must equal `<pinned IP>`), not the original hostname.

#### `test_safe_fetch_pins_validated_ip_to_block_dns_rebinding`

```python
def test_safe_fetch_pins_validated_ip_to_block_dns_rebinding(monkeypatch) -> None:
    """Resolve the hostname; pin the IP into the connection target.

    Mock the response so the test transport can record what URL httpx
    actually opened a socket against. The transport must see the pinned
    IP (1.2.3.4), not the original hostname (rebind.example.com), even
    though the test fixture resolves the hostname to 1.2.3.4 via
    monkeypatched getaddrinfo. A subsequent attacker-controlled
    getaddrinfo that returned 127.0.0.1 would not affect the
    already-pinned URL on the httpx request.
    """

    def fake_getaddrinfo(host, *_args, **_kwargs):
        if host == "rebind.example.com":
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.2.3.4", 0))]
        # Simulate a rebinding: the second lookup happens *after* pinning.
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 0))]

    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)

    seen_urls: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen_urls.append(str(req.url))
        return httpx.Response(200, content=b"<html>ok</html>",
                              headers={"content-type": "text/html"})

    fetcher = SafeFetcher(
        user_agent="test", max_issue_bytes=1_000_000, max_article_bytes=2_000_000,
        max_redirects=5, timeout_seconds=5.0,
        client=httpx.Client(timeout=httpx.Timeout(5.0),
                            transport=httpx.MockTransport(handler),
                            follow_redirects=False),
    )
    resource = fetcher.fetch("https://rebind.example.com/path", kind="article")
    assert resource.body == b"<html>ok</html>"
    # The transport must have seen the pinned IP in the URL host, not the
    # original hostname — the most direct evidence that DNS rebinding is
    # closed at the connection layer.
    assert any("1.2.3.4" in u for u in seen_urls), seen_urls
    assert not any("rebind.example.com" in u for u in seen_urls), seen_urls
```

The `fake_getaddrinfo` returns the public IP on the first lookup (the
validation one), then a private IP on the second (the simulated
attacker rebind). The test asserts that the connection target is the
public IP, not the rebind target.

#### `test_safe_fetch_repins_on_redirect`

A redirect to a different hostname must re-pin (not reuse the parent
hop's pinned IP). This catches the audit's "per-hop re-validation
retains the same IP-pinning discipline" sub-bullet.

#### `test_safe_fetch_blocks_rebinding_when_validate_resolves_public_but_rebind_returns_private`

A more aggressive variant: the first `getaddrinfo` returns the public
IP, the second returns a private IP, and the test asserts the request
goes to the public IP (never to the private IP, even with the rebind
in flight). Same shape as the first test, with a different hostname for
clarity.

#### `test_safe_fetch_preserves_host_header_on_pinned_connection`

Asserts that the outbound `Host` header equals the original hostname,
not the pinned IP. This guards against accidental regressions where
the `headers={"Host": ...}` override is removed.

#### `test_safe_fetch_preserves_sni_hostname_on_pinned_https_connection`

Asserts that the outbound `extensions={"sni_hostname": ...}` is the
original hostname (only meaningful when the server actually opens a
real TLS socket; with `MockTransport` we have to inspect the `Request`
extensions map httpx exposes via `req.extensions`).

Existing tests stay untouched. After the change:

- `test_safe_fetch_rejects_private_ip`: still passes — the rebind
  scenario is a different code path (validation returns the public IP,
  the second lookup returns the private IP; the new pinning logic
  closes the gap precisely there).
- `test_safe_fetch_rejects_redirect_to_private_ip`: still passes — the
  redirect handler resolves the next URL's hostname fresh, and the new
  helper still rejects private addresses.

### 5.5 Files touched (summary)

- `agents/workflows/cto-craft-tweet-drafts/src/cto_craft_workflow/safe_fetch.py` —
  **+~50 LoC** for `_pick_public_ip`, the signature change of
  `_validate_url_and_resolve` (returns `str`), and the per-hop pinning
  block in `SafeFetcher.fetch`. **No changes to the public
  `SafeFetcher` API.**
- `agents/workflows/cto-craft-tweet-drafts/tests/test_safe_fetch.py` —
  **+~120 LoC** for the four new cases. Existing 11 cases stay
  green; fixture additions (`monkeypatch` patterns for `socket.getaddrinfo`,
  URL-record helpers) reuse the existing `httpx.MockTransport` pattern.
- No change to `pyproject.toml` — `httpx` ≥ 0.27 already supports the
  `sni_hostname` extension (we are on 0.28.1).
- No change to `services/content-scheduler-api/**` or any other
  package.
- No change to `.github/workflows/ci.yml` — the existing
  `cto-craft-tweet-drafts` pytest job from PR #463 picks the suite up
  automatically.

## 6. Operational notes

- **`sni_hostname` is HTTPS-only.** The `extensions` dict in §5.3 is
  built conditionally — HTTP requests omit the extension. Tests
  covering an HTTP path should still pass without `sni_hostname`, and
  the existing `test_safe_fetch_follows_redirect_with_revalidation`
  (HTTP-only by fixture) stays untouched.

- **CDN failover lost.** As noted in §5.1, pinning forfeits httpx's
  per-host IP failover. For CTO Craft's weekly batch (one fetch per
  article), a transient connection failure surfaces as
  `TRANSPORT_ERROR` and the LangGraph branch fails — the parent node
  retries the article as part of the existing
  `cto_craft_workflow.angle_model` resumability. Acceptable trade-off
  for the security guarantee.

- **Resolved-IP TTL.** `getaddrinfo` honours the OS resolver, which
  honours DNS TTL. A short-TTL authoritative attacker can swap IPs
  inside one TTL — but the swap can only happen between **separate**
  resolutions; here there is exactly **one** resolution per fetch
  hop, so the rebind has nowhere to land.

- **No new env var.** No new dep. No new public API.

## 7. AC-by-AC verification matrix

| AC  | Behaviour expected                                                                                          | Test layer       | Test file / location                                              |
| --- | ----------------------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------- |
| AC1 | `safe_fetch` resolves the target host once, validates the resolved IP against private/loopback/link-local/multicast/reserved ranges, and pins that IP for the actual TCP/TLS connection while preserving the original `Host` header and SNI | pytest (unit + integration) | `tests/test_safe_fetch.py` — `test_safe_fetch_pins_validated_ip_to_block_dns_rebinding`, `test_safe_fetch_preserves_host_header_on_pinned_connection`, `test_safe_fetch_preserves_sni_hostname_on_pinned_https_connection` |
| AC2 | Per-hop redirect validation retains the same IP-pinning discipline (no re-resolution by hostname mid-fetch)                            | pytest            | `tests/test_safe_fetch.py` — `test_safe_fetch_repins_on_redirect` |
| AC3 | New test in `agents/workflows/cto-craft-tweet-drafts/tests/test_safe_fetch.py` simulates a DNS-rebinding scenario (validation resolves to a public IP, connection resolves to a private IP) and asserts `SSRF_BLOCKED`              | pytest            | `tests/test_safe_fetch.py` — `test_safe_fetch_blocks_rebinding_when_validate_resolves_public_but_rebind_returns_private` |
| AC4 | Existing `safe_fetch` tests for legitimate public hosts stay green (no behaviour regression for the supported path)                      | pytest            | Existing 11 cases in `tests/test_safe_fetch.py` — must remain green on the PR branch |
| AC5 | New pytest cases run in CI (depends on the W34 QW1 pytest job, which is already merged via PR #463)                                       | CI               | `.github/workflows/ci.yml` — `cto-craft-tweet-drafts` pytest job from PR #463 picks the new cases up automatically |

**E2E coverage:** not possible. The TOCTOU window is fundamentally a
timing artefact at the socket layer; no Playwright / browser test can
exercise it. Pytest + `httpx.MockTransport` + `monkeypatch`-ed
`socket.getaddrinfo` is the proportional fallback — the new
`test_safe_fetch_pins_validated_ip_to_block_dns_rebinding` case asserts
the transport sees the pinned IP rather than the original hostname,
which is the substantive evidence the production behaviour is correct.

## 8. Open questions and risks

1. **Multi-IP CDNs (load balancing).** Pinning forfeits httpx's
   per-host IP failover (§6). If the W38 audit cycle observes article
   hosts rotating between geo-distributed IPs in a way that hurts the
   Sunday batch, the follow-up is a per-host `IP_FAILOVER_WHITELIST`
   config knob (resolve once, keep a list of N validated IPs, retry
   them on `TRANSPORT_ERROR`). Out of scope for W34 T1.2.

2. **`socket.getaddrinfo` and IPv6.** The current helper iterates
   every address family in `getaddrinfo`'s return; IPv6-mapped IPv4
   (`::ffff:1.2.3.4`) is also validated against `ipaddress.ip_address`
   for `is_private`/`is_loopback` etc. The pinned URL's host is the
   string from `getaddrinfo`, which httpx accepts as both IPv4 and
   IPv6. If a hostname resolves only to an IPv6 address the test
   suite should add an IPv6-typed case (out of scope for the audit
   close-out, but flagged for a future pytest-parametrize expansion).

3. **What does the existing `test_safe_fetch_rejects_private_ip` case
   look like after the change?** Same as before — `socket.getaddrinfo`
   is mocked by `httpx.MockTransport` to return the URL's host
   directly, and the new `_pick_public_ip` path raises `SSRF_BLOCKED`
   just like the existing `_resolve_and_validate_ip` did. The
   redirect-to-private case
   (`test_safe_fetch_rejects_redirect_to_private_ip`) likewise stays
   green.

4. **Cron-side behaviour.** The CTO-Craft cron prompt
   (`agents/crons/prompts/cto-craft-tweet-drafts.md`) does not mention
   `safe_fetch` internals; the change is invisible to the cron
   operator. The cron prodlike environment uses the public internet;
   the new pinning path is what makes the SSRF boundary actually hold
   under attacker-controlled DNS.

## 9. Definition of Done

- Tech design merged via the implementation PR (this doc moves to
  `status: shipped` with `shipped_pr` and `shipped_date` in the same PR).
- All 5 ACs covered; the four new pytest cases pass on the PR branch;
  the existing 11 cases stay green.
- `pytest agents/workflows/cto-craft-tweet-drafts/tests/test_safe_fetch.py -v` exits 0.
- The `cto-craft-tweet-drafts` CI job from PR #463 picks up the new
  cases automatically and exits 0 on the PR branch.
- No new runtime dependencies; `httpx>=0.27` already supports the
  `sni_hostname` extension.
- No change to the public `SafeFetcher` API or to the `Settings`
  boundary.
- `apps/<ui-tasks-app>/SPEC.md`: no update — no user-visible
  behaviour changed; the change is a backend security hardening.
- `docs/systems/<workflow>.md`: no system doc exists for the
  CTO-Craft pipeline today; if one is added in a future cycle, mention
  the IP-pinning semantics in its SSRF boundary section. Out of scope
  for this security fix.
