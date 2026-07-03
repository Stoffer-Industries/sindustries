# Tech Design — Move AC text check to doing → acceptance gate

## What changes

The AC text comparison currently lives in `verify_delivery` (called at the `done` stage after PR merge). It compares merged PR body ACs against task description ACs and bounces the task back to `doing` on mismatch.

**New flow:** Move this check to the `doing → acceptance` transition, checking the open PR body *before* merge. Remove the bounce from the done stage.

## Where in main.rs

- `block_on_spec_drift_fluid` / `ready_for_acceptance` stage: add a new step that fetches the open PR body (GitHub API, already available) and runs the AC text + evidence check
- `verify_delivery` (post-merge): remove the AC text mismatch check; keep all other post-merge checks (PR merged, system spec, etc.)

## AC check logic (reuse existing)

The evidence annotation parser already exists for the e2e task (AC1). The AC text comparison is in `verify_delivery`. Both move to the pre-merge gate; the post-merge path drops the text check.

## Tests

Add 4 unit tests: pass (all ACs + evidence), mismatch text (block), missing AC (block), missing evidence (block). Mirror the existing verify_delivery test structure.

## System doc

Update `docs/systems/feature-task-workflow.md` — note that AC text check runs pre-merge at doing → acceptance, not post-merge.
