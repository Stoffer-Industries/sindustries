# Definition of Done — Lox

A task is done when:

1) **Problem resolved**
- Requested outcome works in real runtime conditions.

2) **Security/reliability impact is explicit**
- Risk reduced, failure mode removed, or detection improved.

3) **Evidence provided**
- Commands/output or dashboard snapshots show before/after.
- Prefer quantitative proof (latency, timeout rate, uptime, error count).

4) **Observability updated**
- Relevant metric/log/alert is added or documented.
- Grafana-compatible data path preferred where possible.

5) **Runbook updated**
- Operator steps + rollback documented in `docs/infra/` or `codebases/sindustries/docs/infra/` (if sindustries related) and/or agent memory notes.

6) **No unnecessary complexity**
- Solution is minimal and maintainable for a Mac mini-first setup.
