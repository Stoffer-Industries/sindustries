# HEARTBEAT.md — Vara

**Scope of this file:** heartbeat cadence only.

Vara has no polling heartbeat work in v1. Scheduled dead-link lint runs through the isolated cron prompt `agents/crons/prompts/vara-deadlink-lint.md`.

If a heartbeat session is invoked directly without a specific task, do not roam the workspace. Confirm there is no explicit assigned recall/ingest/lint task and then reply `HEARTBEAT_OK`.
