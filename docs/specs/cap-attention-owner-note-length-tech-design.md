---
status: draft
task_id: d0f92258-c9ff-45d8-ae5c-1c9bd602e2ed
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Tech Design — Cap attention-owner note length in `tasks_api_client.py`

## Product intent

`reconcile_attention_owners` in the shared Python Tasks API client validates that `note` is non-empty after trim, but never checks it against the Tasks API's 500-character cap. Callers that build a long note get a raw `400 INVALID_ATTENTION_OWNER_NOTE` on the wire instead of a local, actionable failure.

This is the same latent 400 that PR #866 fixed on the Rust lobster side, one layer over in the shared Python client through which every agent and workflow calls. Goal: fail locally, with the limit named, and measure the note in the same unit the server measures it in.

## Task, branch, worktree

| | |
|---|---|
| Task | `d0f92258-c9ff-45d8-ae5c-1c9bd602e2ed` — Cap attention-owner note length in `tasks_api_client.py reconcile_attention_owners` |
| Branch | `task-d0f92258-cap-attention-note-length` |
| Worktree | `/Volumes/WD1/worktrees/rowan/task-d0f92258-cap-attention-note-length` |
| Repo | `Stoffer-Industries/sindustries` |
| Base | `origin/main` @ `f79eb5a1` |

## Service boundary and data ownership

**Natural source of truth: API-owned contract.**

The cap is a property of the `POST /tasks/:id/attention-owners/reconcile` request contract, owned by `services/tasks-api`. The server constant is the authority:

```ts
// services/tasks-api/src/routes/taskAttentionOwners.ts:31
const MAX_NOTE_LENGTH = 500;
```

```ts
// services/tasks-api/src/routes/taskAttentionOwners.ts:41-47
function normalizeNoteString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_NOTE_LENGTH) return null;
  return trimmed;
}
```

The Python client is a **consumer mirroring that contract**, not a second owner of it. It exists to turn a predictable server rejection into a local error at the call site, where the offending note text is still in scope. It does not relax, redefine, or extend the cap.

Consumers: every agent and lobster workflow that writes attention owners through `reconcile_attention_owners`. No direct app/service consumer changes — this is an internal client-library guard.

### Unit parity is the actual trap

The server measures JS `.length`, which counts **UTF-16 code units**. A plain Python `len()` counts Unicode scalar values. The two agree for every BMP character and **diverge on every astral character** (U+10000+), which this repo uses heavily — task titles are routinely emoji-prefixed (`🔧`, `🔗`, `🧪`, `🔮`).

Verified locally:

```
300 × 🔧  ->  len() = 300   utf-16 units = 600
500 × 'a' ->  len() = 500   utf-16 units = 500
```

A naive `len()` guard would let that 300-emoji note pass validation locally and still 400 on the wire — a guard that fails exactly when the repo's own conventions make it matter. PR #866 already worked through this reasoning on the Rust side; this mirrors it rather than re-deriving it.

Python must therefore measure:

```python
len(note.encode("utf-16-le", "surrogatepass")) // 2
```

The `surrogatepass` error handler is load-bearing, not incidental. A Python string may legally contain a lone surrogate, which JS counts as exactly one UTF-16 code unit. Strict `encode("utf-16-le")` raises `UnicodeEncodeError` on such input — converting a validation path into an unhandled crash. Verified:

```
"abc\ud800" strict      -> UnicodeEncodeError
"abc\ud800" surrogatepass -> 4   (matches JS "\u0061\u0062\u0063\ud800".length === 4)
```

### Ordering

The server trims **then** measures (`normalizeNoteString`). The client already sends `note.strip()` at `tasks_api_client.py:427`. Validation must measure the same string that is actually put on the wire — validate `trimmed = note.strip()`, then send `trimmed`. Measuring pre-trim input would reject notes the server accepts.

### Behaviour decision: raise, do not truncate

Task description asks to flag disagreement rather than silently choose. **Agreeing with the raise.**

Callers of this helper are agent-authored routing notes, not the lobster's template-generated text. A silently truncated note can drop the exact clause a human was meant to read, while the call still reports success — the failure mode is invisible. Truncation is only correct for machine-built notes guaranteed redundant past the cap, which this is not. Raising a `ValueError` that names the limit keeps the offending text in the caller's scope where it can be shortened deliberately.

## Implementation plan

**File scope — one production file, one test file. No server changes, no route/schema changes, no migration.**

### `agents/skills/ops/tasks-api/tasks_api_client.py`

1. Add module-level constant adjacent to the existing client constants:

   ```python
   # Mirrors MAX_NOTE_LENGTH in
   # services/tasks-api/src/routes/taskAttentionOwners.ts. Both must agree;
   # test_drift_with_server_note_cap enforces it in CI.
   MAX_ATTENTION_OWNER_NOTE_LENGTH = 500
   ```

2. Add a small helper:

   ```python
   def _utf16_len(value: str) -> int:
       """Length in UTF-16 code units, matching JS String.length.

       The server measures trimmed.length; Python's len() counts scalar
       values and under-counts astral characters (emoji), so it cannot be
       used for parity. surrogatepass keeps lone surrogates countable
       instead of raising UnicodeEncodeError.
       """
       return len(value.encode("utf-16-le", "surrogatepass")) // 2
   ```

3. In `reconcile_attention_owners`, after the existing non-empty check and **before** `api_request`, validate the trimmed string and raise `ValueError` naming the limit and the measured length. Keep the existing `note is required (non-empty after trim)` error untouched so the empty/whitespace path is unchanged (AC3).

### `agents/skills/ops/tasks-api/tests/test_tasks_api_client.py`

Add the test cases in the matrix below. Suite currently passes 68 tests; all must stay green (AC5).

### On AC4 — "not hardcoded a second time"

Python cannot import a TypeScript `const` at runtime. Three options were considered:

| Option | Verdict |
|---|---|
| Parse the `.ts` file at module import time | **Rejected.** Adds filesystem I/O to every import of the client, breaks when the client is used from outside a repo checkout (agents, cron, deployed environments), and turns an import into a repo-layout dependency. |
| Codegen a shared constant | **Rejected as disproportionate.** A build step for one validation constant introduces more failure modes than it removes. |
| Python constant + CI drift test | **Chosen.** Makes drift a test failure rather than a silent runtime mismatch — the strongest guarantee available without codegen. |

The constant is declared once in Python with a comment naming the TS coupling, and a test parses the TypeScript source and asserts equality. This satisfies the intent of AC4 — the two cannot drift *unnoticed* — while keeping the client importable anywhere. If the server cap changes, `test_drift_with_server_note_cap` fails and names both values.

## Data model / API contract changes

None. This adds no server behaviour, no route, no field, and no schema change. The Python client continues to POST the same `{"attentionOwners": [...], "note": ...}` payload. The only observable difference is that over-long notes now fail locally instead of over the wire.

## `.openclaw` boundary notes

No work falls outside this repo. No gateway config, cron, skill, or credential change is required.

One behaviour change does cross into agent runtimes: a caller that previously received a `400` from the API now receives a `ValueError` from the Python client, raised before any network call. This is the intended improvement, but callers with a broad `except Exception` around the reconcile call could swallow it silently. Existing in-repo callers will be checked during implementation; agent-authored callers outside the repo are flagged as a risk below.

## Test plan and AC verification matrix

E2E is **not applicable**: no user-visible app flow changes, and no app surface is touched. This is an internal agent-library validation guard with no browser or UI component. Per the tech-design skill this records the reason up front; the fallback layer is **unit tests** in the existing client test module.

| AC | Verification | Layer | Test |
|---|---|---|---|
| AC1 | Over-cap note raises local `ValueError` naming the limit, measured in UTF-16 units after trim — not a wire `400` | unit | `test_reconcile_rejects_over_cap_note_before_request` — assert `api_request` is never called |
| AC1 | Same for an astral-heavy note where units and `len()` disagree | unit | `test_reconcile_rejects_astral_note_by_utf16_length` |
| AC2 | 300 × 🔧 = 300 scalars / 600 units is rejected, **and** the test asserts the two measurements differ, so a refactor to plain `len()` fails the suite rather than silently regressing | unit | `test_astral_fixture_diverges_from_len` |
| AC3 | Exactly 500 UTF-16 units accepted and forwarded unmodified | unit | `test_reconcile_accepts_note_at_exact_cap` — assert payload `note` is byte-identical |
| AC3 | 501 units rejected | unit | `test_reconcile_rejects_one_over_cap` |
| AC3 | `""` and `"   "` still raise the pre-existing `note is required` error, not the new cap error | unit | `test_reconcile_empty_note_error_unchanged` |
| AC4 | Python constant equals the server's `MAX_NOTE_LENGTH`, parsed from the TypeScript source | unit | `test_drift_with_server_note_cap` — reads `services/tasks-api/src/routes/taskAttentionOwners.ts`, extracts `const MAX_NOTE_LENGTH = <n>;`, asserts equality on both value and threshold direction (`>` not `>=`) |
| AC4 | Lone surrogate counts as one unit rather than crashing | unit | `test_utf16_len_handles_lone_surrogate` |
| AC5 | Full client suite green; existing callers unchanged | unit | `pytest agents/skills/ops/tasks-api/tests/test_tasks_api_client.py` |

AC2 deserves emphasis: the value of the astral test is not that it rejects a long note — it is that it **fails if someone replaces the UTF-16 measurement with `len()`**. The fixture must assert the divergence explicitly (`len(note) != _utf16_len(note)`) so the test cannot pass for the wrong reason.

## Open questions and risks

**Open question for Quinn — none blocking.** The raise-vs-truncate decision is taken and justified above; flagged here per the task's request rather than left implicit.

**Risk: agent-authored callers with broad exception handling.** Over-long notes previously produced an HTTP `400`; they now raise `ValueError` before the call. A caller wrapping `reconcile_attention_owners` in a broad `except Exception` could swallow the local error and behave as if the routing note succeeded. In-repo callers will be audited during implementation. Out-of-repo agent callers are the residual exposure — accepted, since the alternative (silently truncated routing notes) fails more quietly and more dangerously.

**Risk: threshold direction drift.** The server rejects on `> MAX_NOTE_LENGTH`, so exactly 500 is valid. The Python guard must reject on `>` as well. An `>=` would reject a legal 500-unit note; the drift test covers this explicitly.

**Risk: whitespace and trim asymmetry.** Server trims, then measures. If Python measured the untrimmed string it would reject notes the server accepts. Validation reads the same `trimmed` value that is serialized into the payload, making the two structurally impossible to diverge.

**Non-risk, stated for the record:** `_is_identity_provisioned`-style "silent degradation" is *not* a concern here. A `ValueError` is raised, not warned-and-continued, so an over-long note can never be silently dropped.

**Doc drift noticed during implementation (not in scope for this task):** `AGENTS.md` documents `infra/guards/sindustries-worktree.sh` for creating worktrees, but `infra/guards/` does not exist in the repository. This worktree was created with plain `git worktree add` off `origin/main`, which achieves the same isolation. Flagging for a separate cleanup task rather than bundling unrelated changes into this PR.