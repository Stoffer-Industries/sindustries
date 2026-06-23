# Bookmark approval debug notes

Use the real production path when testing bookmark approvals and revisions.

## Recommended path

Run the bookmark cron entrypoint manually:

```bash
python3 codebases/sindustries/agents/workflows/bookmarks/run.py
```

That path is preferred because it exercises the full real flow:
- review/spec generation
- approval package preparation
- Lobster approval context creation
- Telegram approval request delivery
- real resume tokens for later `approve` / `decline` / `revise`

## Approval-Reply Audit
There is an audit log of messages going in and out of the plugin at /brain/state/approval-reply-audit.csv

## Why not use the helper for end-to-end revise tests?

The helper script is useful for ad hoc approval-request experiments, but it does not replace the real Lobster-backed cron path for true end-to-end revision-flow tests.

## Helper script

Ad hoc helper moved here:

```bash
python3 codebases/sindustries/agents/workflows/bookmarks/scripts/debug/request_single_spec_approval.py <bookmarkKey>
```

Examples:

```bash
python3 codebases/sindustries/agents/workflows/bookmarks/scripts/debug/request_single_spec_approval.py dummycrypto20260420 --reset-to-approval-ready
python3 codebases/sindustries/agents/workflows/bookmarks/scripts/debug/request_single_spec_approval.py dummycrypto20260420
python3 codebases/sindustries/agents/workflows/bookmarks/scripts/debug/request_single_spec_approval.py dummycrypto20260420 --allow-revision-requested
```

## Safe workflow for future fixture tests

1. Reset the fixture bookmark to approval-ready state:
   `python3 codebases/sindustries/agents/workflows/bookmarks/scripts/debug/request_single_spec_approval.py dummycrypto20260420 --reset-to-approval-ready`
2. Run `python3 codebases/sindustries/agents/workflows/bookmarks/run.py`
3. Wait for the real Telegram approval request
4. Reply in Telegram with `approve`, `decline`, or `revise #apxxxxxx: ...`
5. Only use the helper for isolated debugging, not as proof that the Lobster-backed revise flow works
