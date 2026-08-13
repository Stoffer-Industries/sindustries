"""CLI entrypoint for the CTO Craft workflow.

The CLI exposes three subcommands:

- ``validate`` — load settings and print a one-line summary. Useful as a
  cron-side smoke check that env vars and the lock-only schema are
  wired up correctly. Exits non-zero on missing required env.
- ``run`` — invoke the graph once, write a JSON envelope to stdout,
  exit with the appropriate code per outcome.
- ``replay`` — replay a previously stored thread from the configured
  checkpointer. Replays are read-only against the live Content Scheduler
  (the import is gated by the same idempotent write path).

Both ``run`` and ``replay`` print a single JSON envelope on stdout. The
cron prompt announces the ``notification`` field verbatim only when
non-null; otherwise it returns ``NO_REPLY``.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from datetime import datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

from langgraph.checkpoint.postgres import PostgresSaver
import psycopg

from cto_craft_workflow.angle_model import (
    FakeAngleModel,
    OpenClawInvocationConfig,
    OpenClawStructuredAngleModel,
    StructuredAngleModel,
    load_prompts,
)
from cto_craft_workflow.content_scheduler import ImportClient
from cto_craft_workflow.graph import GraphDeps, build_graph
from cto_craft_workflow.locking import workflow_lock
from cto_craft_workflow.safe_fetch import make_fetcher
from cto_craft_workflow.settings import Settings, load_settings
from cto_craft_workflow.state import make_initial_state


log = logging.getLogger("cto_craft_workflow.cli")


def _auckland_iso_week_key(now: datetime | None = None) -> tuple[str, str]:
    """Return ``(run_key, thread_id)`` for the current Auckland ISO week."""

    auckland = now or datetime.now(tz=ZoneInfo("Pacific/Auckland"))
    iso = auckland.isocalendar()
    run_key = f"{iso.year}-W{iso.week:02d}"
    return run_key, f"cto-craft/{run_key}"


def _envelope(
    *,
    outcome: str,
    issue_url: str | None,
    eligible_links: int,
    candidates: int,
    selected: int,
    created_count: int,
    skipped_duplicate_count: int,
    notification: str | None,
    errors: list[str],
    started_at: str,
    durations_ms: dict[str, int] | None = None,
) -> dict:
    return {
        "ok": outcome == "created",
        "outcome": outcome,
        "issueUrl": issue_url,
        "eligibleLinks": eligible_links,
        "candidates": candidates,
        "selected": selected,
        "createdCount": created_count,
        "skippedDuplicateCount": skipped_duplicate_count,
        "notification": notification,
        "errors": errors,
        "startedAt": started_at,
        "durationsMs": durations_ms or {},
    }


def _print_envelope(envelope: dict) -> None:
    sys.stdout.write(json.dumps(envelope, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _build_real_model(settings: Settings) -> StructuredAngleModel:
    """Build the production angle model."""

    return OpenClawStructuredAngleModel(
        config=OpenClawInvocationConfig(
            model=settings.openclaw_model,
            max_attempts=settings.openclaw_max_attempts,
        )
    )


def _build_import_fn(settings: Settings):
    """Build the import function the graph will call.

    The wrapper exits cleanly if the import endpoint is not configured
    (development / CI) by returning a ``noop`` response.
    """

    if not settings.content_scheduler_ingest_secret and settings.require_ingest_secret:
        raise RuntimeError(
            "CONTENT_SCHEDULER_INGEST_SECRET is required for run/replay"
        )

    client = ImportClient(
        base_url=settings.content_scheduler_base_url,
        ingest_secret=settings.content_scheduler_ingest_secret,
        require_secret=settings.require_ingest_secret,
        timeout_seconds=settings.fetch_timeout_seconds,
    )

    def _import(items: list[dict]) -> dict:
        from cto_craft_workflow.content_scheduler import response_to_dict

        return response_to_dict(client.import_drafts(items))

    return _import, client


def _build_graph(
    *,
    settings: Settings,
    import_fn,
    model: StructuredAngleModel | None = None,
) -> Any:
    """Wire the graph with the configured dependencies."""

    system_prompt, worldview_profile = load_prompts()
    fetcher = make_fetcher(settings)
    return build_graph(
        GraphDeps(
            fetcher=fetcher,
            model=model or _build_real_model(settings),
            system_prompt=system_prompt,
            worldview_profile=worldview_profile,
            min_resonance_score=settings.min_resonance_score,
            max_selected_angles=settings.max_selected_angles,
            model_timeout_seconds=settings.model_timeout_seconds,
            archive_url=settings.tmw_archive_url,
            import_fn=import_fn,
        )
    )


def _run_checkpointer(settings: Settings):
    """Build a PostgresSaver checkpointer or raise.

    ``from_conn_string`` is the documented LangGraph entrypoint. It
    returns a context manager; the checkpointer is initialised on
    ``__enter__``.
    """

    if not settings.database_url:
        raise RuntimeError(
            "CTO_CRAFT_LANGGRAPH_DATABASE_URL is required for run/replay"
        )
    return PostgresSaver.from_conn_string(settings.database_url)


def cmd_validate(args: argparse.Namespace) -> int:
    settings = load_settings(require_secrets=False)
    summary = {
        "ok": True,
        "tmwArchiveUrl": settings.tmw_archive_url,
        "contentSchedulerBaseUrl": settings.content_scheduler_base_url,
        "ingestSecretConfigured": bool(settings.content_scheduler_ingest_secret),
        "databaseConfigured": bool(settings.database_url),
        "minResonanceScore": settings.min_resonance_score,
        "maxSelectedAngles": settings.max_selected_angles,
        "modelTimeoutSeconds": settings.model_timeout_seconds,
        "fetchTimeoutSeconds": settings.fetch_timeout_seconds,
        "openclawModel": settings.openclaw_model,
        "openclawMaxAttempts": settings.openclaw_max_attempts,
    }
    sys.stdout.write(json.dumps(summary, separators=(",", ":")) + "\n")
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    """Run the workflow once and print the envelope."""

    settings = load_settings(require_secrets=not args.dry_run)
    started_at = datetime.now(tz=timezone.utc).isoformat()
    run_key, thread_id = _auckland_iso_week_key()
    initial = make_initial_state(run_key=run_key, thread_id=thread_id, started_at=started_at)

    if args.dry_run:
        # Dry-run remains deterministic and side-effect free; graph behavior is
        # covered by fixture-backed tests rather than the live fetch/import path.
        from cto_craft_workflow.angle_model import AngleOutput

        model: StructuredAngleModel = FakeAngleModel(fixtures=[
            AngleOutput(canonical_url="https://example.com/strong-1", angle="Naming the cost of slow iteration", tweet_body="Slow iteration is paid for by the team closest to the user.", evidence_excerpt="The cost is paid by the wrong group.", resonance_score=0.84, evidence_strength=0.78, worldview_axes=["anti_rent_hours"]),
            AngleOutput(canonical_url="https://example.com/strong-2", angle="Boundaries decide ownership", tweet_body="Information architecture decides who owns the failure.", evidence_excerpt="Boundary decisions are made by the org chart.", resonance_score=0.81, evidence_strength=0.74, worldview_axes=["builder_architect"]),
            AngleOutput(canonical_url="https://example.com/strong-3", angle="Hire for the receiver", tweet_body="Most communication advice skips the receiving role.", evidence_excerpt="Clarity of the receiving role predicts success.", resonance_score=0.72, evidence_strength=0.71, worldview_axes=["anti_fluff"]),
        ])
        graph = _build_graph(
            settings=settings,
            import_fn=lambda items: {"createdCount": len(items), "skippedDuplicateCount": 0, "createdIds": [], "sourceRefs": [item["sourceRef"] for item in items]},
            model=model,
        )
        final = graph.invoke(initial, config={"configurable": {"thread_id": thread_id}})
    else:
        import_fn, client = _build_import_fn(settings)
        try:
            with _run_checkpointer(settings) as checkpointer:
                checkpointer.setup()
                with psycopg.connect(settings.database_url) as lock_connection:
                    with workflow_lock(lock_connection) as lock:
                        if not lock.acquired:
                            final = {"outcome": "noop", "diagnostics": [{"node": "run", "code": "ALREADY_RUNNING", "message": "another invocation holds the workflow lock"}]}
                        else:
                            system_prompt, worldview_profile = load_prompts()
                            graph = build_graph(
                                GraphDeps(
                                    fetcher=make_fetcher(settings),
                                    model=_build_real_model(settings),
                                    system_prompt=system_prompt,
                                    worldview_profile=worldview_profile,
                                    min_resonance_score=settings.min_resonance_score,
                                    max_selected_angles=settings.max_selected_angles,
                                    model_timeout_seconds=settings.model_timeout_seconds,
                                    archive_url=settings.tmw_archive_url,
                                    import_fn=import_fn,
                                ),
                                checkpointer=checkpointer,
                            )
                            final = graph.invoke(initial, config={"configurable": {"thread_id": thread_id}})
        finally:
            client.close()

    outcome = final.get("outcome") or "noop"
    import_result = final.get("import_result") or {}
    return _print_envelope_from_outcome(
        outcome=outcome, final_state=final, import_result=import_result, started_at=started_at
    )


def _print_envelope_from_outcome(
    *,
    outcome: str,
    final_state: dict,
    import_result: dict,
    started_at: str,
) -> int:
    notification = final_state.get("notification")
    envelope = _envelope(
        outcome=outcome,
        issue_url=final_state.get("issue_url"),
        eligible_links=len(final_state.get("article_links", []) or []),
        candidates=len(final_state.get("candidates", []) or []),
        selected=len(final_state.get("selected_angles", []) or []),
        created_count=int(import_result.get("createdCount", 0)),
        skipped_duplicate_count=int(import_result.get("skippedDuplicateCount", 0)),
        notification=notification,
        errors=[
            f"{d.get('node')}: {d.get('code')}: {d.get('message')}"
            for d in (final_state.get("diagnostics") or [])
        ],
        started_at=started_at,
    )
    _print_envelope(envelope)
    if outcome == "failed":
        return 2
    return 0


def cmd_replay(args: argparse.Namespace) -> int:
    """Replay a thread from the checkpointer and print the final state."""

    settings = load_settings(require_secrets=True)
    thread_id = args.thread_id
    if not thread_id:
        raise SystemExit("--thread-id is required for replay")

    import_bundle = _build_import_fn(settings)
    import_fn = import_bundle[0] if isinstance(import_bundle, tuple) else import_bundle
    graph = _build_graph(
        settings=settings,
        import_fn=import_fn,
    )

    with _run_checkpointer(settings) as checkpointer:
        # Re-attach the configured checkpointer to a fresh graph compile.
        graph = build_graph(
            GraphDeps(
                fetcher=make_fetcher(settings),
                model=_build_real_model(settings),
                system_prompt=load_prompts()[0],
                worldview_profile=load_prompts()[1],
                min_resonance_score=settings.min_resonance_score,
                max_selected_angles=settings.max_selected_angles,
                model_timeout_seconds=settings.model_timeout_seconds,
                archive_url=settings.tmw_archive_url,
                import_fn=import_fn,
            ),
            checkpointer=checkpointer,
        )
        config = {"configurable": {"thread_id": thread_id}}
        state = graph.get_state(config)
        if state is None:
            sys.stdout.write(json.dumps({"ok": False, "error": "thread not found", "threadId": thread_id}) + "\n")
            return 1
        final = graph.invoke(None, config=config)

    outcome = final.get("outcome") or "noop"
    import_result = final.get("import_result") or {}
    return _print_envelope_from_outcome(
        outcome=outcome,
        final_state=final,
        import_result=import_result,
        started_at=final.get("started_at") or datetime.now(tz=timezone.utc).isoformat(),
    )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="cto-craft-workflow")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("validate", help="print settings summary and exit")

    run_p = sub.add_parser("run", help="run the workflow once")
    run_p.add_argument("--json", action="store_true", help="emit JSON envelope (default)")
    run_p.add_argument(
        "--dry-run",
        action="store_true",
        help="run the graph against embedded fixtures; no real API calls",
    )

    replay_p = sub.add_parser("replay", help="replay a stored thread")
    replay_p.add_argument("--thread-id", required=True, help="LangGraph thread id")
    replay_p.add_argument("--json", action="store_true", help="emit JSON envelope (default)")

    return parser


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=os.environ.get("CTO_CRAFT_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    parser = _build_parser()
    args = parser.parse_args(argv)
    if args.command == "validate":
        return cmd_validate(args)
    if args.command == "run":
        return cmd_run(args)
    if args.command == "replay":
        return cmd_replay(args)
    parser.error(f"unknown command: {args.command}")
    return 2


__all__ = ["main"]


if __name__ == "__main__":
    raise SystemExit(main())
