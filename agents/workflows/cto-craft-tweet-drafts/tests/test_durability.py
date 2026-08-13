from __future__ import annotations

import httpx

from langgraph.checkpoint.memory import InMemorySaver

from cto_craft_workflow.angle_model import AngleOutput, FakeAngleModel, load_prompts
from cto_craft_workflow.graph import GraphDeps, build_graph
from cto_craft_workflow.safe_fetch import SafeFetcher
from cto_craft_workflow.state import make_initial_state

from test_graph import ARCHIVE_URL, _transport

STRONG_URL = "https://staysaasy.com/p/slow-iteration"
BOUNDARY_URL = "https://lethain.com/boundaries/"
GENERIC_URL = "https://lethain.com/fluff-receipts/"


def _fixtures() -> list[AngleOutput]:
    return [
        AngleOutput(
            canonical_url=STRONG_URL,
            angle="Concrete cost framing",
            tweet_body="Slow iteration is paid for by the team closest to the user. Measure who is exposed to the delay.",
            evidence_excerpt="When teams track effort without measuring exposure to delay, the cost is paid by the wrong group.",
            resonance_score=0.84,
            evidence_strength=0.78,
            worldview_axes=["anti_rent_hours", "hard_money"],
        ),
        AngleOutput(
            canonical_url=BOUNDARY_URL,
            angle="Boundaries decide ownership",
            tweet_body="Information architecture, not process, decides who owns the failure.",
            evidence_excerpt="Boundary decisions are made by the org chart, not by the process doc.",
            resonance_score=0.81,
            evidence_strength=0.74,
            worldview_axes=["builder_architect", "autonomy_ownership"],
        ),
        AngleOutput(
            canonical_url=GENERIC_URL,
            angle="Hire for the receiver",
            tweet_body="Most 'communicate better' advice skips the receiver. Hire for the receiving role.",
            evidence_excerpt="The strongest predictor of team success is the clarity of the receiving role.",
            resonance_score=0.72,
            evidence_strength=0.71,
            worldview_axes=["anti_fluff", "autonomy_ownership"],
        ),
    ]


def _build_graph(*, archive_html: bytes, issue_html: bytes, article_routes: dict[str, bytes], import_fn, checkpointer, interrupt_before=None):
    fetcher = SafeFetcher(
        user_agent="test",
        max_issue_bytes=1_000_000,
        max_article_bytes=2_000_000,
        max_redirects=5,
        timeout_seconds=5.0,
        client=httpx.Client(
            timeout=httpx.Timeout(5.0),
            transport=_transport(archive_html, issue_html, article_routes),
            follow_redirects=False,
        ),
    )
    system_prompt, worldview_profile = load_prompts()
    deps = GraphDeps(
        fetcher=fetcher,
        model=FakeAngleModel(fixtures=_fixtures()),
        system_prompt=system_prompt,
        worldview_profile=worldview_profile,
        min_resonance_score=0.55,
        max_selected_angles=5,
        model_timeout_seconds=5.0,
        archive_url=ARCHIVE_URL,
        import_fn=import_fn,
    )
    return build_graph(deps, checkpointer=checkpointer, interrupt_before=interrupt_before)


def test_checkpoint_resume_does_not_repeat_completed_work(archive_html, issue_html, article_routes) -> None:
    checkpointer = InMemorySaver()
    import_calls: list[list[dict]] = []

    def fake_import(items: list[dict]) -> dict:
        import_calls.append(items)
        return {
            "createdCount": len(items),
            "skippedDuplicateCount": 0,
            "createdIds": [f"id-{i}" for i in range(len(items))],
            "sourceRefs": [item["sourceRef"] for item in items],
        }

    graph = _build_graph(
        archive_html=archive_html,
        issue_html=issue_html,
        article_routes=article_routes,
        import_fn=fake_import,
        checkpointer=checkpointer,
        interrupt_before=["import_drafts"],
    )
    initial = make_initial_state(run_key="2026-W32", thread_id="cto-craft/2026-W32", started_at="2026-08-10T09:00:00Z")
    config = {"configurable": {"thread_id": "cto-craft/2026-W32"}}

    first = graph.invoke(initial, config=config)
    assert first is not None
    state_before_resume = graph.get_state(config)
    assert state_before_resume is not None
    assert state_before_resume.next == ("import_drafts",)
    assert len(state_before_resume.values.get("candidates", []) or []) >= 3

    resumed = graph.invoke(None, config=config)
    assert resumed["outcome"] == "created"
    assert len(import_calls) == 1

    history = list(graph.get_state_history(config))
    collect_writes = [snap for snap in history if (snap.metadata.get("writes") or {}).get("collect_candidates")]
    assert len(collect_writes) == 1


def test_commit_then_lost_response_retry_stays_idempotent(archive_html, issue_html, article_routes) -> None:
    created_refs: set[str] = set()
    attempts = 0

    def flaky_import(items: list[dict]) -> dict:
        nonlocal attempts
        attempts += 1
        refs = [item["sourceRef"] for item in items]
        if attempts == 1:
            created_refs.update(refs)
            raise RuntimeError("response lost after commit")
        created = [ref for ref in refs if ref not in created_refs]
        created_refs.update(refs)
        return {
            "createdCount": len(created),
            "skippedDuplicateCount": len(refs) - len(created),
            "createdIds": [f"id-{i}" for i, _ in enumerate(created)],
            "sourceRefs": refs,
        }

    checkpointer = InMemorySaver()
    graph = _build_graph(
        archive_html=archive_html,
        issue_html=issue_html,
        article_routes=article_routes,
        import_fn=flaky_import,
        checkpointer=checkpointer,
    )
    initial = make_initial_state(run_key="2026-W32", thread_id="cto-craft/2026-W32-idempotent", started_at="2026-08-10T09:00:00Z")
    config = {"configurable": {"thread_id": "cto-craft/2026-W32-idempotent"}}

    first = graph.invoke(initial, config=config)
    assert first["outcome"] == "failed"
    assert attempts == 1
    assert len(created_refs) == 3

    second = graph.invoke(initial, config=config)
    assert second["outcome"] == "noop"
    assert second["import_result"]["createdCount"] == 0
    assert second["import_result"]["skippedDuplicateCount"] == 3
    assert attempts == 2
