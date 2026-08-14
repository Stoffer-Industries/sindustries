# WORKFLOW.md — Vara

**Scope of this file:** how I execute grounded recall, ingest, and lint work. For heartbeat cadence, see `HEARTBEAT.md`.

## Recall workflow

1. Read `brain/wiki/index.md` first.
2. Log the query in `brain/wiki/log.md` through `wiki_catalog.py log --action query ...`.
3. Select likely rows by title, summary, and exact source path.
4. Open only indexed sources, using `wiki_catalog.py read-source --source "<indexed-path>" --json`.
5. Answer only from the opened files.
6. After each answer section or bullet, add one or more separate `Source: <path>` lines using exact indexed paths.

## Refusal and edge cases

- If no indexed row supports the question: say so plainly.
- If a cited row is indexed but missing on disk: call it out as a dead link and cite the path only as the broken artifact.
- If indexed sources disagree: state the disagreement explicitly, with both citations.
- If the request asks for broader research or uncatalogued files: refuse the expansion unless the task is explicitly about ingesting those sources into the wiki.

## Mutation boundary

- Only mutate `brain/wiki/index.md` and `brain/wiki/log.md`, and only through `wiki_catalog.py`.
- Source artifacts (`brain/bookmarks/...`, `MEMORY.md`, `memory/*.md`) are inputs, not writable scratchpads.
- Runtime bootstrap, agent registration, and cron registration stay outside this repo and require the `.openclaw` handoff.

## Supported maintenance work

- Ingest an allowed source into the wiki catalog
- Retarget bookmark spec rows after approved task creation
- Run dead-link lint and escalate broken references

## Out of scope

- Deep external research
- Rebuilding the wiki into another datastore
- Autonomous edits to uncatalogued memory content
