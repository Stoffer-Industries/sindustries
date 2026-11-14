---
status: draft
task_id: 006ff10b-de40-4b3a-9c18-5490755fc67c
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Tech Design — Make the cto-craft newsletter fetch survive a TLS-fingerprint block, retry transient failures, and never report a fetch failure as `noop`

## Links and scope

- Task: `006ff10b-de40-4b3a-9c18-5490755fc67c` — 💻 cto-craft pipeline: TLS-fingerprint 502 silently blocks weekly TMW archive fetch, zero drafts ever created
- Task type: `code` (`code-task-workflow`)
- Delivery assignee: Rowan (unchanged by this design)
- Design author: Quinn (commissioned as position-0 attention owner because the code-task lobster's tech-design gate was unsatisfied and Rowan was at his doing-task limit at commissioning time)
- Repository: `Stoffer-Industries/sindustries`
- Primary surfaces:
  - `agents/workflows/cto-craft-tweet-drafts/src/cto_craft_workflow/safe_fetch.py` (the only place the workflow talks to the network)
  - `agents/workflows/cto-craft-tweet-drafts/src/cto_craft_workflow/graph.py` (`discover_latest_issue`, `_is_transient_fetch_error`)
- Branch: to be created by the implementer (`task-006ff10b-cto-craft-tls-fetch`)

## Problem statement

The weekly `cto-craft-tweet-drafts` cron (Monday 08:00 NZT) has reported `noop` on every observed run and has never created a draft. `noop` is the pipeline's healthy "no new issue published" outcome, so a permanent fetch failure has been indistinguishable from an ordinary quiet week — for as long as the pipeline has been running. The failure is silent by construction, not by accident.

Observed behaviour (task description, reproduced 2026-11-13):

```
{"ok":false,"outcome":"noop","errors":["discover_latest_issue: HTTP_ERROR: HTTP 502"]}
```

## Root cause

Two defects stack.

### Defect 1 — the edge blocks our TLS fingerprint

`SafeFetcher` fetches `https://www.techmanagerweekly.com/` through Python's `httpx` client:

- `safe_fetch.py:244` — `pinned_url = httpx.URL(url).copy_with(host=pinned_ip)`
- `safe_fetch.py:245` — original hostname preserved in the `Host` header
- `safe_fetch.py:258` — `request.extensions["sni_hostname"] = hostname` for the TLS SNI
- `safe_fetch.py:215` — the client is `httpx.Client(...)`, i.e. Python's `ssl` module

Reproduction against the **same pinned IP, same `Host`, same `User-Agent`**:

| Client | Result |
|---|---|
| `httpx` / Python OpenSSL ClientHello | HTTP 502 — 5/5 |
| `curl` (same URL, same IP, same headers) | HTTP 200 — 5/5 |

DNS chain: `www.techmanagerweekly.com` → `tech-manager-weekly.ghost.io` → `ghost.map.fastly.net` → `151.101.167.7` (shared Fastly anycast).

The discriminator is the **TLS ClientHello**, not the request. Two different stacks, same wire request, opposite verdicts at the Fastly/Ghost edge is the signature of JA3/JA4-style fingerprint classification. Python's OpenSSL offers a cipher order and extension set that this edge treats as non-browser; curl's stack does not. The fix therefore has to change the TLS client — retrying the same blocked handshake cannot succeed.

This is not a DNS-rebinding or SSRF-protection problem. The SSRF controls are working exactly as designed; they are simply implemented on top of a TLS stack the edge refuses.

### Defect 2 — a permanent block is classified as a safe, retry-free `noop`

`graph.py:100 _is_transient_fetch_error` treats any `FetchError` with `code == "HTTP_ERROR"` and status `429` or `>= 500` as transient. `graph.py:137` and `graph.py:164` then return `{"outcome": "noop"}` with **zero retries**.

That rule was written for an occasional CDN blip, where "skip this week" is correct and cheap. It is the wrong rule for a deterministic per-client block, where every future attempt fails identically. The combination is what made the outage invisible: a hard, permanent, 100%-reproducible failure was reported as the pipeline's most boring success outcome.

## Design

### 1. Transport abstraction with a curl-backed implementation that preserves every SSRF control (AC2)

`SafeFetcher` keeps ownership of *what* is fetched and *whether* it is safe to fetch. Only the byte-moving layer changes.

Introduce a transport seam in `safe_fetch.py`:

```
SafeFetcher
  ├── policy  (unchanged): scheme allow-list, credential rejection,
  │           DNS resolve + public-IP validation, per-hop re-resolve,
  │           redirect re-validation, byte cap, content-type allow-list,
  │           no cookies / no auth headers / no tracking params
  └── transport (new seam):
        ├── HttpXTransport   — today's httpx client, unchanged semantics
        └── CurlTransport    — libcurl via a bounded subprocess
```

**The curl transport must preserve, and the tests must prove, all of:**

| Property | How the curl transport keeps it |
|---|---|
| DNS/IP pinning (no rebinding) | Python resolves and validates the IP; curl is given `--resolve <host>:<port>:<validated-ip>` so it never performs its own resolution |
| Host header + TLS SNI | `--resolve` keeps the hostname in the TLS handshake (SNI) and the `Host` header; curl is never told to talk to the raw IP as a hostname |
| Redirect re-validation | curl is invoked **without `-L`**, so it never follows a redirect, and with `--max-redirs 0` as a defence-in-depth assertion. The response status and headers are captured explicitly (`-D <header-file>`, `-o <body-file>`, `-w '%{http_code}'`), so Python sees the 3xx and the `Location` header, re-resolves, re-validates and re-pins the next hop exactly as today. If curl exits with its redirect-refusal code (47, "Maximum (0) redirects followed"), the transport **maps that to "a 3xx response"** — reading the status and `Location` from the captured headers — and never to a transport error; a 3xx with no `Location` is a protocol error, not a transport failure |
| TLS verification | certificate verification **stays on** for both transports: `-k` / `--insecure` is never passed and no `--cacert` override is introduced. `--resolve <host>:443:<validated-ip>` keeps the hostname in the SNI extension and the `Host` header, so the certificate is validated against the hostname exactly as on the httpx path — pinning the IP does not weaken certificate checking |
| Time bounds | `--connect-timeout` / `--max-time` derived from the existing per-fetch timeout |
| Size cap | `--max-filesize <cap>` is passed so an oversized response is cut off at the transport rather than fully buffered first. curl can only enforce `--max-filesize` when the response carries a `Content-Length`, so Python's byte cap stays authoritative for chunked responses (it truncates/rejects at the cap). Both layers enforce the same cap; neither is removed |
| Content-type allow-list | enforced in Python, as today |
| No cookies / credentials / custom auth headers | curl is invoked with an explicit header allow-list; no cookie jar (`--cookie` never used), no `-u`, no `-H Authorization` |
| Transport availability | curl is present on macOS and on `ubuntu-latest`; the transport reports `TRANSPORT_UNAVAILABLE` if the binary is missing, and the fetcher falls back to the httpx transport rather than failing the run |

**Transport selection (decided — this is not an implementer choice).** The default is **httpx first, curl fallback on any 5xx**: the pinned-IP httpx request is made first; if it returns a 5xx, the same request is immediately re-issued through the curl transport. Every outbound network request records the transport that carried it.

- The curl fallback **consumes one of the three network requests in the budget** (§2). It is not an extra request on top of the budget.
- There is **no per-host transport allow-list and no per-host default pinning**. Host-specific pinning was considered and rejected for now: it would make the attempt-list shape depend on a maintained host list, and the fallback already produces the live evidence needed to justify changing the default later. Changing the default is a separate, evidence-backed change to this design.
- The deciding criterion for the default is unchanged: the *observable* result (a 200 from the pinned IP) is obtained without weakening the policy layer.

**Explicitly rejected:** swapping in a browser-impersonation library (`curl_cffi`, `tls-client`). It adds a heavy, frequently-updated dependency with its own supply-chain surface to a pipeline whose SSRF posture is the reason it is safe. The curl transport achieves the same observable result using a binary already present on every runner.

### 2. Bounded retry with backoff, and visible attempts (AC1)

Add a retry policy to the fetcher for the transient classes only: `TIMEOUT`, `TRANSPORT_ERROR`, and `HTTP_ERROR` with status `429` or `>= 500`.

- **Budget:** at most **3 network requests per URL**, with exponential backoff and jitter (e.g. 1s, 4s, capped at 30s) between requests. The budget is a constant in settings, not scattered through call sites. It is counted in **network requests, not logical attempts**: a transport fallback (§1) is a network request and consumes the budget exactly like a retry does. A URL therefore causes at most 3 outbound requests in total, whatever transport mix produced them.
- **One record per network request.** Every outbound request produces exactly one attempt record — there is no attempt that did not hit the network, and no network request without a record.
- **`Retry-After`:** honoured on `429` when the header is present and parseable, capped at the same maximum.
- **No retry on:** `SSRF_BLOCKED`, `UNSAFE_SCHEME`, `UNSAFE_URL`, `TOO_MANY_REDIRECTS`, `HTTP_ERROR` 4xx other than 429 — these are policy decisions or client errors, and retrying them is wrong.
- **Visible attempts:** every network request is recorded with `request`, `transport`, `code`, `status`, `delay_ms`, and the attempt list is attached to the fetch result and surfaced in the workflow's `errors`/diagnostics output, e.g.

  ```
  fetch_attempts: [
    {request: 1, transport: httpx, code: HTTP_ERROR, status: 502, delay_ms: 1000},
    {request: 2, transport: curl,  code: OK,         status: 200, delay_ms: 0}
  ]
  ```

  This is what makes the next run diagnosable instead of silent: a reader sees how many network requests were made, over which transports, with which statuses.

### 3. `noop` must mean "no new issue", never "could not reach the source" (AC3 and the durable guard)

After the retry budget is exhausted, the workflow outcome for a fetch failure changes from `noop` to `failed`.

- `outcome: noop` is reserved for exactly one meaning: the archive was successfully fetched and contained no issue newer than the last processed one.
- A fetch failure that exhausts its retries is `outcome: failed` with the attempt list attached. The cron then treats it as a failure (soft-fail notification per `agents/skills/ops/notify-soft-fail/SKILL.md`), rather than as a quiet week.

This is the single most important line in the design: the silent-break class existed because the pipeline had a success-shaped outcome available to a failure-shaped condition. Removing that shape is what stops the next occurrence from being invisible.

### 4. Production verification (AC3)

A real run of `cto-craft-tweet-drafts` — manually triggered or scheduled — must produce one of:

- `outcome: created` with the created drafts, or
- `outcome: noop` whose reason is explicitly "no new issue since last run", evidenced by a successful fetch in the same envelope,

and never a fetch-error `noop`. The run's JSON envelope is the evidence and is attached to the task.

## Acceptance criteria mapping

| AC | Design element | What proves it |
|---|---|---|
| AC1 (bounded retries with backoff; attempts visible) | §2 | Unit test: a transport that fails twice with 502 then succeeds → **3 network requests** recorded, backoff honoured, attempt list in the workflow output; a transport that always fails → bounded at **3 network requests**, outcome `failed`. The test asserts the number of **network requests** (not logical attempts) and that the attempt list length equals the number of requests made, including the httpx→curl fallback request |
| AC2 (no 502 from the edge, without weakening SSRF protection) | §1 | Live/integration test: the pinned-IP request returns 200 through the curl transport; plus unit tests asserting `--resolve` carries the validated IP, `-L` is absent and `--max-redirs 0` is set, certificate verification stays on (no `-k`/`--insecure`), `--max-filesize` is set to the cap, and a redirect is re-resolved and re-pinned by Python rather than followed by curl |
| AC3 (a real run fetches the archive; not a fetch-error noop) | §3, §4 | The production run's JSON envelope, attached to the task |

## Test plan

1. **Request budget.** Stub the transport to fail N times; assert the number of **network requests** stops at 3 and the recorded delays are non-decreasing and capped. A variant asserts that an httpx 5xx followed by a curl success uses exactly **2** network requests — the fallback is inside the budget, not on top of it.
2. **Attempts visible.** Assert the workflow's `errors`/diagnostics output contains the attempt list with per-request transport, code and status, and that the list length equals the number of network requests made.
3. **Pinning preserved.** Assert the curl invocation includes `--resolve <host>:443:<validated-ip>` and that the IP passed is the validated one (never a second resolution).
4. **Redirects not followed by curl.** Assert `-L` is absent and `--max-redirs 0` is present, and that a 302 response causes a fresh Python-side resolve + validation + pin for the next hop.
5. **Redirect refusal is not a transport error.** Simulate curl exiting 47 (redirect refusal) with a captured 302 + `Location` header; assert the transport classifies it as a 3xx response (not `TRANSPORT_ERROR`), surfaces the `Location` to the policy layer, and re-resolves and re-pins the next hop. A 3xx with no `Location` is classified as a protocol error, not a transport error.
6. **TLS verification stays on.** Assert the curl invocation contains no `-k` / `--insecure`, and that the hostname (not the pinned IP) is what is presented for certificate validation.
7. **Byte cap at the transport.** Assert `--max-filesize` is set to the cap, and that a response larger than the cap is rejected by Python even when the transport did not stop it (the chunked / no `Content-Length` case).
8. **SSRF policy unchanged.** The existing policy tests for `SSRF_BLOCKED` (loopback / private / link-local / reserved), `UNSAFE_SCHEME` and embedded-credential rejection must still pass unchanged against both transports. A test must show the curl transport is never used for a host whose resolved IP failed validation.
9. **Outcome semantics.** A fetch failure that exhausts retries yields `outcome: failed`, never `noop`. A successful fetch of an unchanged archive yields `noop` with the "no new issue" reason. These two tests are the regression guard for the silent-break class.
10. **Production run.** A real run's envelope, attached to the task.

## Scope

In scope:

- The transport seam and the curl-backed transport in `safe_fetch.py`.
- The retry policy, backoff, and attempt recording.
- The `noop` → `failed` outcome change for exhausted fetch failures, and the attempt list in diagnostics.
- Tests for every case above.

Out of scope:

- Replacing `SafeFetcher` wholesale, or changing the SSRF policy layer's rules.
- Changing how the newsletter is parsed, how candidates are scored, or how drafts are created — the pipeline is downstream of a working fetch.
- Changing which sources the workflow reads.
- Adding a browser-impersonation dependency (explicitly rejected above).
- Changing the cron's schedule.

## `.openclaw` boundary notes

- None. No secrets, no OpenClaw runtime configuration, no cron changes, no environment variables. The change is confined to `agents/workflows/cto-craft-tweet-drafts/`.
- The curl transport executes a fixed local binary with an argument list built from validated values. No shell interpolation of remote data: arguments are passed as an argv list, never through a shell, and the validated IP is checked to be a literal public address before it is placed on the command line.

## Risks and open questions

1. **The fingerprint hypothesis could be wrong.** The reproduction is strong (same IP, same headers, different client, opposite verdict) but it is still an inference from 5/5 samples. Mitigation: the transport fallback runs automatically on a 5xx and records `transport` per attempt, so the first production run either succeeds (hypothesis confirmed) or produces a per-transport attempt list that refutes it. The design therefore does not depend on the hypothesis being correct to be useful.
2. **Edge behaviour may change.** A future Fastly/Ghost change could block curl as well, or begin serving both. Mitigation: the attempt list makes the new behaviour immediately visible instead of silent.
3. **`curl` absence on a runner.** Mitigated by the `TRANSPORT_UNAVAILABLE` fallback to httpx plus an explicit error in the attempt list rather than a silent degradation.
4. **Request budget vs cron wall-clock.** 3 network requests with 1s/4s backoff plus the per-fetch timeout must fit inside the cron slot. The implementer should assert the worst case against the existing per-fetch timeout setting before merging. The budget is counted in network requests precisely so this worst case is computable: 3 requests × (connect + response time) + 5s of backoff, bounded by the per-fetch timeout.
5. **`--max-filesize` is not enforced for chunked responses.** curl can only apply `--max-filesize` when the response carries a `Content-Length`; a chunked oversized response is buffered by curl and then truncated/rejected by Python's cap. This is why Python's cap stays authoritative and the transport-level flag is defence in depth, not the enforcement point.
6. **Open question (implementation-time, non-blocking):** whether other sources behind the same edge need the curl transport. Recommendation: keep the selection dynamic (5xx → curl fallback) — the design deliberately carries no host allow-list (§1) until a second source is actually observed to be blocked.
