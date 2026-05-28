# Website Content

The SIndustries website uses repo-native content files so updates can be proposed, reviewed, and shipped through normal pull requests.

## Phase 1 Notes

Problem: homepage content was embedded in `App.jsx`, so content updates required application-code edits.

Scope: move the current homepage arrays into structured JSON files, validate the main content collections, and keep the homepage rendering unchanged.

Assumptions:

- `published` content is public-safe and can render on the live site.
- `draft`, `review`, and `archived` content stays out of the homepage until later detail/review flows exist.
- Richer fields can exist before the UI renders them; they support the content-ops workflow and future detail pages.

Non-goals:

- no CMS
- no story detail pages
- no autonomous publishing workflow
- no weekly review automation

Design decisions:

- JSON stays close to the repo so pull requests show readable content diffs.
- `App.jsx` adapts content into the legacy card/list shapes to preserve the existing homepage design.
- `SIGNALS` remains derived in `App.jsx` from the loaded content counts.
- AJV validation runs when the content module is imported, so test and build fail on malformed core content.

Rollback:

- Revert the content files, `src/content/index.js`, the `App.jsx` import/mapping changes, and the `ajv` dependency.
- The previous hard-coded arrays can be restored from git history.

Risks:

- Story JSON is not schema-validated yet; this is acceptable for Phase 1 because the required validation covers experiments, systems, releases, and stacks.
- Dates currently reflect the migration date where no earlier public source date exists.

## Files

- `experiments.json` feeds the Studio section.
- `systems.json` feeds the Systems section.
- `releases.json` feeds the Ships section.
- `stacks.json` feeds the Stacks marquee.
- `stories/*.json` feeds the Stories section.

Keep `SIGNALS` logic in `App.jsx`; it derives counts from the loaded content.

## Schemas

Experiments require:

- `title`, `slug`, `status`, `summary`, `why`, `successCriteria`, `currentLearning`, `startedAt`, `updatedAt`, `links`, `image`, `visibility`
- `status`: `idea`, `active`, `paused`, `shipped`, or `killed`
- `visibility`: `draft`, `review`, `published`, or `archived`

Systems require:

- `title`, `slug`, `status`, `summary`, `problem`, `howItWorks`, `proof`, `updatedAt`, `links`, `image`, `visibility`
- `status`: `designing`, `building`, `operating`, or `retired`

Releases require:

- `title`, `slug`, `releasedAt`, `summary`, `type`, `links`, `evidence`, `visibility`
- `type`: `product`, `system`, `content`, `experiment`, or `infrastructure`

Stacks require:

- `name`, `category`, `summary`, `whyWeUseIt`, `status`, `links`, `updatedAt`, `visibility`
- `category`: `agent`, `model`, `infra`, `app`, `workflow`, or `design`
- `status`: `core`, `testing`, or `retired`

Stories require:

- `title`, `slug`, `dek`, `body`, `source`, `topics`, `draftedAt`, `publishedAt`, `visibility`, `canonicalUrl`
- Create one file per story in `stories/`.

`links` should be an array of `{ "label": "...", "url": "..." }` objects. Use an empty array when there is no public link yet.

## Adding Content

1. Add or edit the relevant JSON item.
2. Use a stable lowercase slug with hyphens.
3. Set `visibility` to `draft` while shaping copy, `review` when it needs approval, and `published` only after approval.
4. Keep summaries concrete and evidence-backed. Avoid hype, private context, and unsupported claims.
5. Run `npm --workspace apps/website test` and `npm --workspace apps/website run build`.

## Approval Rules

Quinn can approve factual, low-risk content updates:

- typo fixes
- stack metadata
- release entries for already completed/public work
- factual status changes supported by task, release, or PR evidence

Tom must approve:

- stories and founder notes
- strategic claims or public positioning
- first-person copy in Tom's voice
- pricing, revenue, customer, investment, employer, family, or personal finance references
- anything that could be read as a public commitment

Do not publish secrets, credentials, private URLs, internal logs, screenshots of private systems, or confidential third-party information.
