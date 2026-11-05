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
    try:
        queue = read_queue_file(args.queue_file) if args.queue_file else fetch_queue(agent, args.tasks_api_base)
    except Exception as exc:  # noqa: BLE001 — a preflight error must fail open
        decision = rc.unknown_decision(args.category, agent, reason=f"preflight-error: {exc}")
        print(json.dumps(decision.to_dict(), sort_keys=True), file=sys.stderr)
        if args.mode == "heartbeat":
            # The agent is expected to fall back to the plain queue command.
            print(f"{UNKNOWN_TOKEN} fallback=agent_task_queue.py")
        elif args.json:
            print(json.dumps(decision.to_dict(), sort_keys=True))
        else:
            print(UNKNOWN_TOKEN)
        return 0

    decision = rc.preflight(queue, args.category, agent=agent)
    _record(decision, args)

    if args.mode == "heartbeat":
        payload = dict(queue) if isinstance(queue, dict) else {"queue": queue}
        payload["routingDecision"] = decision.to_dict()
        print(json.dumps(payload, indent=2, sort_keys=True))
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


def _record(decision: rc.RoutingDecision, args: argparse.Namespace) -> None:
    if getattr(args, "no_record", False):
        return
    state = rc.load_state(args.state_file)
    rc.record_decision(state, decision, day=args.day)
    rc.save_state(state, args.state_file)
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
            "modelInvoked": decision.model_invoked,
            "unclassified": decision.unclassified,
        },
        args.event_log,
    )


def _now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


def cmd_record_actual(args: argparse.Namespace) -> int:
    violation = rc.check_declaration(
        args.declared_tier,
        actual_model=args.actual_model,
        actual_tier=args.actual_tier,
    )
    if violation is None:
        print(f"routing: match tier={args.declared_tier} model={args.actual_model or '-'}")
        return 0
    violation = dict(violation)
    violation["category"] = args.category
    violation["agent"] = args.agent
    if not getattr(args, "no_record", False):
        state = rc.load_state(args.state_file)
        rc.record_violation(state, violation, day=args.day)
        rc.save_state(state, args.state_file)
        rc.append_event(
            {
                "at": _now(),
                "decision": "violation" if violation.get("kind") == "violation" else "unmeasured",
                "tier": violation.get("declaredTier"),
                "actualTier": violation.get("actualTier"),
                "actualModel": violation.get("actualModel"),
                "category": args.category,
                "agent": args.agent,
                "modelInvoked": True,
            },
            args.event_log,
        )
    print(
        f"routing: {violation.get('kind')} declared={violation.get('declaredTier')} "
        f"actual={violation.get('actualTier') or '-'} model={violation.get('actualModel') or '-'}"
    )
    return 0


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
        default="heartbeat-scan",
        help="Work category being routed (see agents/lib/routing_contract.py)",
    )
    parser.add_argument(
        "--mode",
        choices=("probe", "heartbeat"),
        default="probe",
        help="probe: compact decision line; heartbeat: full queue payload + decision",
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
