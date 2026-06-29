---
status: shipped
task_id: n/a
product_spec: n/a
shipped_pr: 35
shipped_date: 2026-05-29
---

# Website Detail Sheets

## Problem

The homepage has compact cards for releases and stories, but Phase 2 of the content-ops spec requires a way to inspect full release/story content without leaving the page.

## Scope

- Release cards in the `Ships` section open a bottom-sheet detail view.
- Story cards in the `Stories` section open the same bottom-sheet pattern.
- Detail content is read from the Phase 1 repo-native content files under `apps/website/src/content/`.
- Sheets close through the top-right close button, backdrop click, Escape, or a downward touch swipe.

## Assumptions

- Release and story detail views remain in-page overlays for this phase, not routed pages.
- Current release/story content is intentionally brief; the renderer supports longer body, evidence, topics, and links as content grows.
- Existing homepage visual language should remain intact.

## Non-goals

- No CMS, router, or URL-addressable detail route in this pass.
- No autonomous content publishing or approval workflow changes in this pass.
- No experiment/system detail sheets in this task slice.

## Design Notes

- `DetailSheet` owns modal behavior, body scroll locking, Escape handling, focus target, and touch dismissal.
- `App.jsx` only stores the selected item and type, keeping section rendering simple.
- Story cards no longer link directly to X from the grid; canonical source links are rendered inside the sheet so the card click consistently opens detail content.
- Swipe dismissal accepts either sufficient downward distance or high downward velocity to match the mobile bottom-sheet interaction requested in the spec.

## Rollback

Revert the `DetailSheet` component, the `App.jsx` release/story click wiring, related CSS, and detail tests. The homepage will fall back to static release rows and outbound story links.

## Risks

- The overlay is not URL-addressable, so direct sharing of a specific release/story still needs a later routed detail-page pass if required.
- Current stories duplicate `dek` and `body` in the content source; the sheet avoids duplicate display when they are identical.
