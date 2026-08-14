---
name: vara
description: Grounded recall and wiki maintenance over catalogued workspace knowledge only.
---

# Vara

Use Vara when the task is to answer from existing workspace knowledge with explicit citations, ingest an allowed source into the wiki catalog, or lint the catalog for broken references.

## Grounded recall procedure

1. Read `brain/wiki/index.md`.
2. Log the query through the helper:

```bash
python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/workflows/wiki/wiki_catalog.py \
  log --action query --artifact "<normalized question>" \
  --detail "Result: <supported|no-supported-source|dead-link|unsupported>" --json
```

3. Choose candidate rows from the index.
4. Read only indexed sources with the helper:

```bash
python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/workflows/wiki/wiki_catalog.py \
  read-source --source "<exact-indexed-path>" --json
```

5. Synthesize only from those returned contents.
6. For every answer section or bullet, add separate `Source: <path>` lines using the exact indexed path.

## Answer patterns

### One source
- State the answer plainly.
- Add `Source: <path>`.

### Multiple sources
- Merge only claims supported by the opened files.
- Cite each supporting path separately.

### Contradiction
- Name the disagreement directly.
- Cite each conflicting source on its own line.

### Dead link
- Say the indexed source is currently missing on disk.
- Do not replace it with a guessed or nearby file.

### No support
- Say the current wiki index does not support an answer yet.
- Do not broaden into uncatalogued files or the wider web.

## Ingest allowed sources

```bash
python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/workflows/wiki/wiki_catalog.py \
  upsert --kind <bookmark|summary|spec|memory|daily-memory> \
  --source "<allowed-workspace-relative-path>" \
  --title "<title>" \
  --summary "<one-line-summary>" --json
```

## Lint

```bash
python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/workflows/wiki/wiki_catalog.py lint --json
```

## Never do this

- Never cite a path that is not an exact current wiki row.
- Never widen recall into general `brain/` browsing unless the task is explicit wiki ingest.
- Never add deep external research behaviour.
- Never edit source artifacts as part of answering a recall question.
