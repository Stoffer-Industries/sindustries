#!/usr/bin/env python3
"""Empty-queue preflight for the three-tier model routing contract.

Task ``d38c6aa5`` — Three-Tier Model Routing Contract With Empty-Queue Preflight.
Contract: ``docs/systems/model-routing-contract.md`` (the written half) and
``agents/lib/routing_contract.py`` (the machine-readable half).

This command is the piece that lets a scheduled pass cost *nothing* when there
is nothing to do. It runs as a Gateway scheduler command payload — a shell
process on the Gateway host, with no model call — so an empty work queue is
recognised without paying for a model turn. It also works as the first step
of an agent heartbeat, where the queue payload it prints is the same payload
the agent already reads.

Usage
-----
Probe mode (scheduler command payload — one compact line on stdout)::

    routing_preflight.py --agent Quinn --category heartbeat-scan

Heartbeat mode (prints the queue payload the agent needs, plus the routing
decision)::

    routing_preflight.py --agent Quinn --category heartbeat-scan --mode heartbeat

Trigger mode (Gateway automation condition-watcher contract — ``json({fire,
message?, state?})`` on stdout; ``fire:false`` saves state and runs **no
model at all**)::

    routing_preflight.py --agent Quinn --category heartbeat-scan --mode trigger

Operator surface (per-category, per-tier counters)::

    routing_preflight.py --stats

Record what actually ran, so a run against the wrong tier becomes a recorded
routing violation instead of a silent one::

    routing_preflight.py --record-actual --agent Quinn \
        --category heartbeat-scan --declared-tier routine \
        --actual-model minimax-portal/MiniMax-M3

Exit codes are always ``0`` unless the command itself could not run. A
preflight failure must never mute an agent's pass, so an evaluation error is
reported as ``PREFLIGHT-UNKNOWN`` (carry on normally), never as a skip.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import subprocess
import sys
from typing import Any

# Bootstrap `agents.lib` so `from agents.lib import routing_contract` works
# under plain `python3 <this>.py` invocations.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from agents.lib import routing_contract as rc  # noqa: E402

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
QUEUE_SCRIPT = REPO_ROOT / "agents" / "skills" / "ops" / "tasks-api" / "scripts" / "agent_task_queue.py"
DEFAULT_TASKS_API_BASE = "http://localhost:4001/api/v1"

SILENT_TOKEN = "NO_REPLY"
UNKNOWN_TOKEN = "PREFLIGHT-UNKNOWN"

#: Category used when a preflight mode is invoked without one.
DEFAULT_CATEGORY = "heartbeat-scan"


def fetch_queue(agent: str, tasks_api_base: str) -> Any:
    """Fetch the agent's work queue using the shared read-only queue script."""
    env = dict(os.environ)
    env["TASKS_API_BASE_URL"] = tasks_api_base
    proc = subprocess.run(
        [sys.executable, str(QUEUE_SCRIPT), "--assignee", agent, "--json"],
        capture_output=True,
        text=True,
        env=env,
        timeout=120,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"queue fetch failed (exit {proc.returncode}): {proc.stderr.strip()[:400]}")
    payload = proc.stdout.strip()
    if not payload:
        raise RuntimeError("queue fetch returned no output")
    return json.loads(payload)


def read_queue_file(path: str) -> Any:
    with open(path) as handle:
        return json.load(handle)


def _decision_line(decision: rc.RoutingDecision) -> str:
    return (
        f"routing: {decision.decision} tier={decision.tier} "
        f"model_class={decision.model_class} category={decision.category} "
        f"work={decision.work_count} agent={decision.agent or '-'}"
    )


def cmd_probe(args: argparse.Namespace) -> int:
    agent = args.agent
    category = args.category or DEFAULT_CATEGORY
    try:
        queue = read_queue_file(args.queue_file) if args.queue_file else fetch_queue(agent, args.tasks_api_base)
    except Exception as exc:  # noqa: BLE001 — a preflight error must fail open
        decision = rc.unknown_decision(category, agent, reason=f"preflight-error: {exc}")
        _record(decision, args)
        print(UNKNOWN_TOKEN, file=sys.stderr)
        print(json.dumps(decision.to_dict(), sort_keys=True), file=sys.stderr)
        if args.mode == "heartbeat":
            # The agent is expected to fall back to the plain queue command.
            print(f"{UNKNOWN_TOKEN} fallback=agent_task_queue.py")
        elif args.mode == "trigger":
            # Fail open: a broken queue read must never mute the pass.
            print(
                json.dumps(
                    {
                        "fire": True,
                        "message": (
                            "Routing preflight could not evaluate the work queue "
                            f"({exc}). Run the normal heartbeat procedure."
                        ),
                        "state": {"lastError": str(exc)[:200]},
                    },
                    sort_keys=True,
                )
            )
        elif args.json:
            print(json.dumps(decision.to_dict(), sort_keys=True))
        else:
            print(UNKNOWN_TOKEN)
        return 0

    decision = rc.preflight(queue, category, agent=agent)
    _record(decision, args)

    if args.mode == "heartbeat":
        payload = dict(queue) if isinstance(queue, dict) else {"queue": queue}
        payload["routingDecision"] = decision.to_dict()
        print(json.dumps(payload, indent=2, sort_keys=True))
        return 0

    if args.mode == "trigger":
        print(json.dumps(_trigger_payload(decision), sort_keys=True))
        return 0

    if decision.skipped:
        # stdout wins over stderr for scheduler delivery, so the silent token
        # suppresses the chat post while the decision stays visible in stderr
        # and in the run history.
        print(SILENT_TOKEN)
        print(json.dumps(decision.to_dict(), sort_keys=True), file=sys.stderr)
        return 0

    if args.json:
        print(json.dumps(decision.to_dict(), sort_keys=True))
    else:
        print(_decision_line(decision))
    return 0


def _trigger_payload(decision: rc.RoutingDecision) -> dict[str, Any]:
    """Build the Gateway automation condition-watcher trigger contract.

    The scheduler's ``trigger: {script}`` expects ``json({fire, message?,
    state?})`` on stdout. ``fire:false`` saves the state and runs **no model
    at all** — that is the only construction where an empty scheduled pass is
    genuinely free. ``fire:true`` runs the job's payload, and ``message`` is
    that run's entire context, so it has to stand alone.
    """
    state = {
        "lastDecision": decision.decision,
        "at": _now(),
        "category": decision.category,
        "tier": decision.tier,
        "workCount": decision.work_count,
    }
    if decision.skipped:
        return {"fire": False, "state": state}
    message = (
        f"Routing contract: proceed on the {decision.tier} tier "
        f"(model class {decision.model_class}) for category {decision.category}; "
        f"{decision.work_count} actionable item(s) in the work queue. "
        "Run the normal procedure and declare the tier before the work starts."
    )
    return {"fire": True, "message": message, "state": state}


def _record(decision: rc.RoutingDecision, args: argparse.Namespace) -> None:
    if getattr(args, "no_record", False):
        return

    def mutate(state: dict[str, Any]) -> None:
        rc.record_decision(state, decision, day=args.day)

    rc.mutate_state(args.state_file, mutate)
    rc.append_event(
        {
            "at": _now(),
            "decision": decision.decision,
            "tier": decision.tier,
            "modelClass": decision.model_class,
            "category": decision.category,
            "workCount": decision.work_count,
            "reason": decision.reason,
            "agent": decision.agent,
            "modelDeclared": decision.model_declared,
            "unclassified": decision.unclassified,
        },
        args.event_log,
    )


def _now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


def cmd_record_actual(args: argparse.Namespace) -> int:
    actual_model = args.actual_model or os.environ.get("OPENCLAW_ROUTING_ACTUAL_MODEL") or None
    violation = rc.check_declaration(
        args.declared_tier,
        actual_model=actual_model,
        actual_tier=args.actual_tier,
    )
    if violation is None:
        if not getattr(args, "no_record", False):
            _record_observation(args, actual_model=actual_model, kind="match")
        print(f"routing: match tier={args.declared_tier} model={actual_model or '-'}")
        return 0
    violation = dict(violation)
    # The category is recorded only when it was given explicitly. An
    # un-attributed violation must not land in a misleading bucket — it goes
    # to the global bucket instead.
    violation["category"] = args.category
    violation["agent"] = args.agent
    kind = violation.get("kind", "violation")
    if not getattr(args, "no_record", False):
        _record_observation(args, actual_model=actual_model, kind=kind)
    print(
        f"routing: {kind} declared={violation.get('declaredTier')} "
        f"actual={violation.get('actualTier') or '-'} model={actual_model or '-'}"
    )
    return 0


def _record_observation(
    args: argparse.Namespace,
    actual_model: str | None,
    kind: str,
) -> None:
    """Record the observed tier next to the declared one."""
    actual_tier = args.actual_tier or rc.model_tier(actual_model or "")

    def mutate(state: dict[str, Any]) -> None:
        rc.record_observation(
            state,
            category=args.category,
            declared_tier=args.declared_tier,
            actual_tier=actual_tier,
            actual_model=actual_model,
            agent=args.agent,
            day=args.day,
            kind=kind,
        )

    rc.mutate_state(args.state_file, mutate)
    rc.append_event(
        {
            "at": _now(),
            "decision": kind,
            "tier": args.declared_tier,
            "declaredTier": args.declared_tier,
            "actualTier": actual_tier,
            "actualModel": actual_model,
            "category": args.category,
            "agent": args.agent,
            "modelInvoked": actual_model is not None,
        },
        args.event_log,
    )


def cmd_stats(args: argparse.Namespace) -> int:
    state = rc.load_state(args.state_file)
    if args.json:
        print(json.dumps(rc.daily_counts(state, args.day), indent=2, sort_keys=True))
    else:
        print(rc.render_stats(state, args.day))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Three-tier model routing preflight")
    parser.add_argument("--agent", default="Quinn", help="Agent whose queue is checked")
    parser.add_argument(
        "--category",
        default=None,
        help=(
            "Work category being routed (see agents/lib/routing_contract.py). "
            f"Defaults to {DEFAULT_CATEGORY} in preflight modes; an omitted "
            "category in --record-actual is recorded in the global bucket."
        ),
    )
    parser.add_argument(
        "--mode",
        choices=("probe", "heartbeat", "trigger"),
        default="probe",
        help=(
            "probe: compact decision line; heartbeat: full queue payload + decision; "
            "trigger: the scheduler's {fire, message?, state?} condition-watcher contract"
        ),
    )
    parser.add_argument("--queue-file", help="Read the queue payload from a file instead of fetching it")
    parser.add_argument(
        "--tasks-api-base",
        default=os.environ.get("TASKS_API_BASE_URL", DEFAULT_TASKS_API_BASE),
        help="Tasks API base URL",
    )
    parser.add_argument("--state-file", help="Override the counters state path")
    parser.add_argument("--event-log", help="Override the JSONL event log path")
    parser.add_argument("--day", help="Day bucket (YYYY-MM-DD); defaults to today (UTC)")
    parser.add_argument("--no-record", action="store_true", help="Do not write counters or events")
    parser.add_argument("--json", action="store_true", help="Emit JSON on stdout")
    parser.add_argument("--stats", action="store_true", help="Print the counter table instead of running a preflight")
    parser.add_argument("--record-actual", action="store_true", help="Record what actually ran for an invocation")
    parser.add_argument("--declared-tier", help="Tier that was declared before the invocation")
    parser.add_argument("--actual-model", help="Model id that actually ran")
    parser.add_argument("--actual-tier", help="Tier that actually ran (when the model id is unknown)")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.stats:
        return cmd_stats(args)
    if args.record_actual:
        if not args.declared_tier:
            print("--record-actual requires --declared-tier", file=sys.stderr)
            return 2
        return cmd_record_actual(args)
    return cmd_probe(args)


if __name__ == "__main__":
    raise SystemExit(main())
