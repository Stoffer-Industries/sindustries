# Runbook — Bookmark Compounding Signal (`compute-compounding-signal`)

**Owner:** Rowan (engineering)
**Trigger:** Operators need a weekly prior-context reuse percentage, its four-week trend, and the current week's dossier-promotion count, surfaced on Pulse's Bookmarks tab as `Compounding % (7d)`. The artifact is the source of truth the dashboard reads; the Markdown is a deterministic operator rendering of the same JSON.
**Related:**

- Tech design: `docs/specs/compounding-signal-for-bookmark-pipeline-tech-design.md`
- Product spec: `brain/tasks/specs/in-progress/compounding-signal-for-bookmark-pipeline-f0331a69bfaf9aa7.md`
- Task: `faf260e9-fe7b-4ce5-86ba-e47acab0ddb3`
- Calculator: `agents/workflows/bookmarks/scripts/compute_compounding_signal.py`
- Tests: `agents/workflows/bookmarks/scripts/tests/test_compute_compounding_signal.py`
- Vite adapter: `apps/mission-control/vite.config.js` (`brainStateApi`)
- Pulse consumer: `apps/mission-control/src/tabs/BookmarksKpiRow.jsx`, `apps/mission-control/src/compoundingSignal.js`
- Cron prompt: `agents/crons/prompts/bookmark-compounding-signal.md`

## Why this exists

The bookmark pipeline stores prior-context references and (once the upstream
contracts ship) dossier-promotion events. Without a derived read, Tom has to
spot the trend by reading raw state files, which is not a question a
weekly cron can answer. The signal answers "are we compounding yet?" with
one number per week, a four-week trend, and an operator note when the
trend is low.

The calculator is intentionally read-only. It never imports or writes
upstream pipeline state, never calls another pipeline stage, and fails
closed on any parse, compute, validation, or write error. A failed run
leaves the previous successful pair in place; the dashboard then shows
the previous value with a stale marker rather than going blank.

## Modes

The script accepts the following flags. The default invocation publishes
both artifacts to `brain/state/`.

| Flag | Effect | Writes artifacts? | Source touched? |
|---|---|---|---|
| `--dry-run --print-json` | Read, validate, print candidate JSON to stdout | No | No |
| `--dry-run` (no `--print-json`) | Same as above, prints a one-line summary | No | No |
| (default) | Read, validate, write `compounding-signal.{json,md}` | Yes (atomic) | No |
| `--as-of <ISO-8601>` | Force a deterministic `as-of` for tests/manual reconstruction | As above | No |
| `--workspace-root <path>` | Override workspace discovery (`WORKSPACE_ROOT` is also honored) | As above | No |
| `--bookmark-state <path>` | Override `bookmark-review-state.json` location | As above | No |
| `--corpus-index <path>` | Override `bookmark-corpus-index.jsonl` location | As above | No |
| `--dossier-promotions <path>` | Override dossier-promotion log location | As above | No |
| `--json-path <path>` | Override `compounding-signal.json` output | As above | No |
| `--md-path <path>` | Override `compounding-signal.md` output | As above | No |

The script never touches upstream input files. Successful runs are atomic:
each artifact is written to a `.tmp` sibling, fsync'd, then renamed over
the destination. If the JSON write succeeds but the Markdown write fails,
the JSON remains and the operator can re-run; if the first write fails,
the destination is left untouched.

## Pre-flight

1. **Confirm the workspace root.** Run `echo "$WORKSPACE_ROOT"` (or pass
   `--workspace-root`). The script resolves the workspace from CLI, env
   var, or a canonical `<script>/../../../../` walk, and exits with code
   `2` if none of those resolve to a directory that contains
   `agents/workflows/bookmarks`.
2. **Confirm upstream artifacts are present.** A missing
   `bookmark-review-state.json` is a fatal error (exit `3`) — the signal
   has no observations to compute against. A missing corpus index or
   dossier-promotion log is treated as empty (operator note may select
   `corpus_too_small`), not as failure.
3. **Confirm the dashboard has the right view of the artifact.** If
   `brain/state/compounding-signal.json` is missing, the Pulse tile shows
   `awaiting first weekly run`. If it's malformed, the tile shows
   `malformed artifact` with the validation error in the page title. Both
   are visible in the Bookmarks tab; neither blocks the rest of the
   dashboard.
4. **Confirm the dev-only Vite plugin is active.** The adapter at
   `GET /api/compounding-signal` only exists in `vite dev` mode
   (`apps/mission-control/vite.config.js`). In `vite build` (production)
   the route is a no-op, the dashboard receives `404`, and the tile shows
   `awaiting first weekly run`. This is the shipped boundary; production
   Pulse needs a hosted bookmark-domain read service (see Open Questions
   in the tech design).

## Procedure

### 1. Manual dry-run

Always do a dry-run before publishing for the first time in a workspace:

```sh
python3 agents/workflows/bookmarks/scripts/compute_compounding_signal.py \
  --workspace-root /Users/quinnstoffer/.openclaw/workspace \
  --dry-run --print-json \
  | jq '.'
```

Confirm the candidate JSON has:

- `schemaVersion: 1`
- `headlinePercentage` equal to `trend[0].percentage`
- `trend` is an array of exactly four windows, ordered current → oldest
- `operatorNote` is either `null` or `{id, text}` where `id` is one of
  the three closed-set IDs (`corpus_too_small`,
  `retrieval_path_may_be_broken`, `mostly_unrelated_intake`)
- `decisionPolicy.lowPercentageBelow: 25.0`

### 2. Publish

When the dry-run looks right, drop `--dry-run`:

```sh
python3 agents/workflows/bookmarks/scripts/compute_compounding_signal.py \
  --workspace-root /Users/quinnstoffer/.openclaw/workspace
```

The script prints one JSON line to stdout, e.g.:

```json
{"published": true, "runId": "2026-08-17T20:15:00Z", "headlinePercentage": 37.5, "jsonPath": ".../compounding-signal.json", "mdPath": ".../compounding-signal.md"}
```

Verify the Pulse tile shows the new value (focus the browser window or
hit the toolbar's Refresh button — focus reloads the data via
`loadBookmarkState()`).

### 3. Deterministic reconstruction

If the team needs to reproduce a published artifact exactly, pass
`--as-of`:

```sh
python3 agents/workflows/bookmarks/scripts/compute_compounding_signal.py \
  --workspace-root /Users/quinnstoffer/.openclaw/workspace \
  --as-of 2026-08-17T20:15:00Z \
  --dry-run --print-json
```

The trend windows and headline are computed from the as-of timestamp
plus windowing constants (one calendar week per window, four windows).
Deterministic reconstruction works for both `--dry-run` and the default
publish path; the Markdown also carries the same `runId`.

## Health by pipeline maturity

| Stage | Duration | What "healthy" looks like | Tile state |
|---|---|---|---|
| **Early / pre-corpus** | First ~4 weeks | Insufficient data to draw a trend. The headline is `null` (em-dash) for at least one window. | Tile shows `—` and `Signal unavailable` until the first run completes; subsequent weeks may show `null` until the corpus grows. |
| **Measuring** | Weeks ~5-8 with some eligible items, corpus < 25 docs | The headline starts to land as a finite percentage, but the corpus is still small. A four-week `null` trend is normal. | Tile shows a finite headline and color band; an `operatorNote` may select `corpus_too_small` when the corpus is below 25 documents. |
| **Established** | Corpus ≥ 25 docs, ≥ 4 weeks of prior-context data | Headline ≥ 35% is the healthy target. Bands: green ≥ 50%, amber 25-49%, red < 25%. | Tile shows the headline with its band color and the subtitle `<referenced>/<eligible> referenced · <n> dossier promotions`. |

The 35% target for established corpora is a policy value, not a
calculator constant. It is documented here and in `decisionPolicy` of
the JSON; changing it is a reviewed code/config change, not a prose edit.

## Failure cases

The script returns the following exit codes. Cron and operator scripts
should treat any non-zero exit as a soft failure (do not retry
destructively, do not block the bookmark pipeline).

| Exit | Meaning | Action |
|---|---|---|
| 0 | Successful run (publish or dry-run) | None — publish ran, or dry-run produced a validated candidate. |
| 2 | Workspace resolution failed, or `--as-of` invalid | Pass `--workspace-root` or set `WORKSPACE_ROOT`; pass a valid ISO-8601 timestamp. |
| 3 | `bookmark-review-state.json` missing | Confirm the upstream bookmark pipeline is running; do not retry until bookmark state exists. |
| 4 | Parse, compute, or validation error | Inspect stderr JSON `{"error": "..."}`. Common causes: an upstream review-status outside the closed set, an empty `items` field, or a corrupted bookmark state file. |
| 5 | Filesystem write failure | Inspect stderr JSON. The destination directory may not exist; create it manually and re-run. |

### Stale artifact

The Pulse tile marks a valid artifact stale when `generatedAt` is more
than `STALE_AFTER_DAYS` (8 days) old. This is a read-time condition: the
artifact itself is never rewritten to say "stale," and a failed weekly
run naturally leaves the previous successful value visible with a stale
marker rather than blanking the tile.

**Diagnosis:** open the Bookmarks tab, check the tile's small caption.
If it says `stale`, the JSON on disk is more than 8 days old.

**Recovery:** re-run the calculator manually (step 2). Investigate why
the cron did not run (job disabled, host outage, isolated session
error). Do not edit the artifact by hand — schema validation will reject
the next publish attempt.

### Missing artifact

The Pulse tile shows `—` and `awaiting first weekly run` when no JSON
exists on disk and the Vite plugin returns `404`.

**Diagnosis:** confirm `brain/state/compounding-signal.json` exists.
If absent, the cron has never run successfully or the artifact was
removed.

**Recovery:** run the calculator manually (step 2), then investigate
cron state.

### Malformed artifact

The Pulse tile shows `—` and `malformed artifact` when the Vite plugin
returns `500` (the JSON parser inside the plugin rejected the file) or
the React layer's schema validation rejected the parsed payload.

**Diagnosis:** open the browser dev tools; the page title for the
`compounding` KPI carries the validation error. Cross-check against the
Python `validate_signal` invariants — a mismatch usually means the
artifact was hand-edited or written by a different calculator version.

**Recovery:** delete the artifact and re-run the calculator manually
(step 2). If the new publish fails too, the calculator invariants have
drifted from the JSON schema in `compoundingSignal.js`; either revert
the calculator or update the React schema to match.

## Rollback

1. Disable the weekly cron (set `enabled: false` on the OpenClaw job).
2. Revert the implementation PR.
3. Optionally move the artifact pair to trash:
   `mv brain/state/compounding-signal.{json,md} ~/.Trash/`. The dashboard
   returns to its pre-feature state immediately.

The signal does not write to any upstream pipeline state, so no upstream
rollback is needed. Existing dossier-promotion events and bookmark
state are untouched.

## Open follow-ups

These are intentionally deferred and live outside the runbook:

- The dossier-promotion event contract is pending the upstream evidence-
  layer spec. Until then, the `dossierPromotionCount` field may be `0`
  even when promotions occurred — the calculator rejects any event that
  does not carry `eventId` and `promotedAt`.
- The prior-context timestamp/field contract is pending the upstream
  knowledge-base spec. The calculator falls back from `reviewedAt` to
  `lastUpdatedAt` to `firstSeenAt` so a draft contract does not lock the
  metric.
- Production Pulse needs a hosted bookmark-domain read service. The
  current Vite plugin is dev-only; the feature follows that shipped
  boundary rather than introducing a new backend.
