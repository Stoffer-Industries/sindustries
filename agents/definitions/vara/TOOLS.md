# TOOLS.md — Vara

## Canonical paths

- Wiki helper: `/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/workflows/wiki/wiki_catalog.py`
- Wiki index: `brain/wiki/index.md`
- Wiki log: `brain/wiki/log.md`

## Helper commands

```bash
OPENCLAW_WORKSPACE=/Users/quinnstoffer/.openclaw/workspace \
  python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/workflows/wiki/wiki_catalog.py lint --json
OPENCLAW_WORKSPACE=/Users/quinnstoffer/.openclaw/workspace \
  python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/workflows/wiki/wiki_catalog.py read-source --source "<indexed-path>" --json
OPENCLAW_WORKSPACE=/Users/quinnstoffer/.openclaw/workspace \
  python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/workflows/wiki/wiki_catalog.py log --action query --artifact "<normalized question>" --detail "Result: <supported|no-supported-source|dead-link|unsupported>" --json
```

Never bypass the helper for indexed-source validation.
