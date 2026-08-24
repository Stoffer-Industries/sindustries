"""Regression tests for the reducer-writeback-collision bug (task 402d39fe).

Pre-fix, ``collect_candidates`` wrote its deduped output back to the
``candidates`` reducer field, which caused the
``Annotated[list[AngleCandidate], operator.add]`` reducer to append the
already-deduped list on top of the raw scored list still held in
``state["candidates"]``. The net effect was a doubled-length
``state["candidates"]`` after the node fired. The bug was masked by the
prior Send crash (PR #523, task 60971f78).

Path A fix (per the approved tech design): add a non-reducer
``deduped_candidates`` field, route the deduped output there, and have
``select_distinct_angles`` read from it instead. These tests verify the
fix end-to-end through the real graph wiring.
"""

from __future__ import annotations

import httpx
import pytest

from cto_craft_workflow.angle_model import AngleOutput, FakeAngleModel
from cto_craft_workflow.graph import (
    GraphDeps,
    build_graph,
    collect_candidates,
)
from cto_craft_workflow.safe_fetch import SafeFetcher
from cto_craft_workflow.state import make_initial_state

from test_graph import (
    ARCHIVE_URL,
    ISSUE_URL,
    STRONG_URL,
    BOUNDARY_URL,
    GENERIC_URL,
    HIRING_URL,
    _build_graph,
    _transport,
)


def _unit_deps() -> GraphDeps:
    """Minimal deps for calling ``collect_candidates`` directly."""

    fetcher = SafeFetcher(
        user_agent="test",
        max_issue_bytes=1_000_000,
        max_article_bytes=2_000_000,
        max_redirects=5,
        timeout_seconds=5.0,
        client=httpx.Client(timeout=httpx.Timeout(5.0)),
    )
    return GraphDeps(
        fetcher=fetcher,
        model=FakeAngleModel(fixtures=[]),
        system_prompt="",
        worldview_profile={},
        min_resonance_score=0.55,
        max_selected_angles=5,
        model_timeout_seconds=5.0,
        archive_url=ARCHIVE_URL,
        import_fn=None,
    )


def test_collect_writes_to_deduped_candidates_not_candidates(
    archive_html, issue_html, article_routes
) -> None:
    """``collect_candidates`` must NOT write back to the ``candidates`` reducer.

    Pre-fix, the deduped list flowed through the
    ``Annotated[list[AngleCandidate], operator.add]`` reducer and
    appended on top of the raw scored list, doubling the length. The fix
    routes the deduped output to a non-reducer field.
    """

    fixtures = [
        AngleOutput(
            canonical_url=STRONG_URL,
            angle="Concrete cost framing",
            tweet_body="Slow iteration is paid for by the team closest to the user.",
            evidence_excerpt="When teams track effort without measuring exposure to delay, the cost is paid by the wrong group.",
            resonance_score=0.84,
            evidence_strength=0.78,
            worldview_axes=["anti_rent_hours"],
        ),
        AngleOutput(
            canonical_url=BOUNDARY_URL,
            angle="Boundary setting",
            tweet_body="Set the boundary before you set the policy.",
            evidence_excerpt="Boundaries are pre-decisional; policies are post-decisional. Conflating them produces inconsistent enforcement.",
            resonance_score=0.80,
            evidence_strength=0.74,
            worldview_axes=["builder_architect"],
        ),
        AngleOutput(
            canonical_url=GENERIC_URL,
            angle="Generic",
            tweet_body="A third angle.",
            evidence_excerpt="Generic excerpt.",
            resonance_score=0.72,
            evidence_strength=0.68,
            worldview_axes=["anti_fluff"],
        ),
    ]
    graph = _build_graph(
        archive_html=archive_html,
        issue_html=issue_html,
        article_routes=article_routes,
        fixtures=fixtures,
    )
    initial = make_initial_state(
        run_key="2026-W34",
        thread_id="cto-craft/2026-W34",
        started_at="2026-08-24T09:00:00Z",
    )
    final = graph.invoke(initial)

    # After Path A: state["candidates"] holds ONLY the raw scored list
    # (no writeback from collect_candidates). Its length equals the
    # number of unique articles scored, which is 3 for this fixture set.
    assert "candidates" in final
    assert len(final["candidates"]) == 3, (
        f"reducer-writeback-collision bug: state['candidates'] length "
        f"{len(final['candidates'])} != 3 (raw scored count); "
        f"collect_candidates wrote back into the reducer"
    )

    # state["deduped_candidates"] holds the deduped set: same length as
    # the raw set when all canonical URLs are unique.
    assert "deduped_candidates" in final
    assert len(final["deduped_candidates"]) == 3

    # And the two fields must not be the same list object — that would
    # indicate a leaky reducer alias.
    assert final["candidates"] is not final["deduped_candidates"]


def test_collect_node_dedupes_and_writes_to_deduped_field() -> None:
    """Unit-level: ``collect_candidates`` writes to ``deduped_candidates``
    only and does NOT touch the ``candidates`` reducer field. This is the
    structural fix for the reducer-writeback-collision bug (task 402d39fe).

    Pre-fix, the node returned ``{"candidates": cleaned}`` and the
    ``operator.add`` reducer appended ``cleaned`` on top of whatever was
    already in ``state["candidates"]``. Post-fix, the node writes to a
    separate non-reducer field, so the reducer cannot fire on the
    deduped set.
    """

    duplicate_candidate = {
        "canonical_url": STRONG_URL,
        "angle": "First",
        "tweet_body": "First angle body that fits within 280 chars and is non-empty for the structural validator.",
        "evidence_excerpt": "e1",
        "resonance_score": 0.90,
        "evidence_strength": 0.80,
        "worldview_axes": ["anti_rent_hours"],
    }
    duplicate_copy = dict(duplicate_candidate)
    duplicate_copy["angle"] = "Duplicate URL"
    boundary_candidate = {
        "canonical_url": BOUNDARY_URL,
        "angle": "Boundary",
        "tweet_body": "Boundary setting body that fits within 280 chars and is non-empty.",
        "evidence_excerpt": "e2",
        "resonance_score": 0.80,
        "evidence_strength": 0.74,
        "worldview_axes": ["builder_architect"],
    }

    state: dict = {
        "candidates": [duplicate_candidate, duplicate_copy, boundary_candidate],
    }

    deps = _unit_deps()
    result = collect_candidates(state, deps)  # type: ignore[arg-type]

    # The fix: the result must NOT carry a ``candidates`` key. If it
    # does, the reducer-writeback-collision bug is back.
    assert "candidates" not in result, (
        f"collect_candidates wrote to 'candidates' (reducer field): {list(result)}; "
        f"this re-introduces the reducer-writeback-collision bug"
    )
    # The fix: the result MUST carry ``deduped_candidates``.
    assert "deduped_candidates" in result
    deduped = result["deduped_candidates"]
    deduped_urls = [c["canonical_url"] for c in deduped]
    assert len(deduped_urls) == len(set(deduped_urls)), (
        f"deduped_candidates contains duplicate canonical_urls: {deduped_urls}"
    )
    # 2 unique URLs in the input, so 2 entries in the deduped set.
    assert len(deduped) == 2
    assert STRONG_URL in deduped_urls
    assert BOUNDARY_URL in deduped_urls


def test_graph_state_candidates_not_doubled_end_to_end(
    archive_html, issue_html, article_routes
) -> None:
    """End-to-end: drive the full graph with 4 unique articles and
    assert ``state['candidates']`` length equals the raw scored count
    (4), not doubled (8) by a writeback from ``collect_candidates``.

    With 4 unique canonical URLs and 4 distinct fixtures, the bug would
    surface as ``state['candidates']`` having 8 entries (4 raw scored
    from fetch_and_score + 4 deduped-appended from collect_candidates).
    Post-fix, ``state['candidates']`` stays at 4.
    """

    fixtures = [
        AngleOutput(
            canonical_url=STRONG_URL,
            angle="Concrete cost framing",
            tweet_body="Slow iteration is paid for by the team closest to the user. Measure who is exposed to the delay.",
            evidence_excerpt="When teams track effort without measuring exposure to delay, the cost is paid by the wrong group.",
            resonance_score=0.84,
            evidence_strength=0.78,
            worldview_axes=["anti_rent_hours"],
        ),
        AngleOutput(
            canonical_url=BOUNDARY_URL,
            angle="Boundary",
            tweet_body="Set the boundary before you set the policy. Boundaries are pre-decisional; policies are post-decisional.",
            evidence_excerpt="Conflating boundaries with policies produces inconsistent enforcement.",
            resonance_score=0.81,
            evidence_strength=0.74,
            worldview_axes=["builder_architect"],
        ),
        AngleOutput(
            canonical_url=GENERIC_URL,
            angle="Generic",
            tweet_body="Hire for the receiving role, not the broadcaster role.",
            evidence_excerpt="The strongest predictor of team success is the clarity of the receiving role.",
            resonance_score=0.72,
            evidence_strength=0.71,
            worldview_axes=["anti_fluff"],
        ),
        AngleOutput(
            canonical_url=HIRING_URL,
            angle="Hiring",
            tweet_body="Hiring for the role you have, not the role you wish you had.",
            evidence_excerpt="Hiring for the role you wish you had produces roles that don't exist.",
            resonance_score=0.78,
            evidence_strength=0.72,
            worldview_axes=["autonomy_ownership"],
        ),
    ]
    graph = _build_graph(
        archive_html=archive_html,
        issue_html=issue_html,
        article_routes=article_routes,
        fixtures=fixtures,
    )
    initial = make_initial_state(
        run_key="2026-W34",
        thread_id="cto-craft/2026-W34",
        started_at="2026-08-24T09:00:00Z",
    )
    final = graph.invoke(initial)

    # Raw scored set is 4 unique URLs.
    raw_scored = final["candidates"]
    assert len(raw_scored) == 4, (
        f"reducer-writeback-collision bug: state['candidates'] length "
        f"{len(raw_scored)} != 4 (raw scored count); collect_candidates "
        f"wrote back into the reducer"
    )
    assert len({c["canonical_url"] for c in raw_scored}) == 4

    # deduped_candidates is the same set (4 unique URLs, no dedup
    # needed) but lives in its own field.
    assert len(final["deduped_candidates"]) == 4


def test_selection_reads_from_deduped_candidates(
    archive_html, issue_html, article_routes
) -> None:
    """``select_distinct_angles`` must read from deduped_candidates, not candidates.

    Pre-fix, ``select_distinct_angles`` read from the reducer-managed
    ``candidates`` field which had a doubled length. The selection
    output itself was correct (picked_urls dedupe) but the bug was
    visible at the state level. After Path A, selection reads from the
    clean deduped set.
    """

    fixtures = [
        AngleOutput(
            canonical_url=STRONG_URL,
            angle="Concrete cost framing",
            tweet_body="Slow iteration is paid for by the team closest to the user.",
            evidence_excerpt="When teams track effort without measuring exposure to delay, the cost is paid by the wrong group.",
            resonance_score=0.84,
            evidence_strength=0.78,
            worldview_axes=["anti_rent_hours"],
        ),
        AngleOutput(
            canonical_url=BOUNDARY_URL,
            angle="Boundary setting",
            tweet_body="Set the boundary before you set the policy.",
            evidence_excerpt="Boundaries are pre-decisional; policies are post-decisional. Conflating them produces inconsistent enforcement.",
            resonance_score=0.80,
            evidence_strength=0.74,
            worldview_axes=["builder_architect"],
        ),
        AngleOutput(
            canonical_url=GENERIC_URL,
            angle="Generic",
            tweet_body="A third angle.",
            evidence_excerpt="Generic excerpt.",
            resonance_score=0.72,
            evidence_strength=0.68,
            worldview_axes=["anti_fluff"],
        ),
        AngleOutput(
            canonical_url=HIRING_URL,
            angle="Hiring",
            tweet_body="Hiring for the role you have, not the role you wish you had.",
            evidence_excerpt="Hiring for the role you wish you had produces roles that don't exist; hiring for the role you have produces growth.",
            resonance_score=0.78,
            evidence_strength=0.72,
            worldview_axes=["autonomy_ownership"],
        ),
    ]

    def fake_import(items: list[dict]) -> dict:
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
        fixtures=fixtures,
        import_fn=fake_import,
    )
    initial = make_initial_state(
        run_key="2026-W34",
        thread_id="cto-craft/2026-W34",
        started_at="2026-08-24T09:00:00Z",
    )
    final = graph.invoke(initial)

    # selection must succeed and pick distinct URLs.
    assert final["outcome"] == "created"
    selected_urls = [s["canonical_url"] for s in final["selected_angles"]]
    assert len(selected_urls) == len(set(selected_urls))
    # selection's input was deduped_candidates; verify that field's
    # length is the unique-URL count, not doubled.
    assert len(final["deduped_candidates"]) == len(
        {c["canonical_url"] for c in final["deduped_candidates"]}
    )


def test_noop_outcome_still_writes_deduped_candidates(
    archive_html, issue_html, article_routes
) -> None:
    """When below MIN_QUALIFIED_CANDIDATES, collect_candidates still
    writes the cleaned list to deduped_candidates (and outcome='noop'),
    so downstream code reading state['deduped_candidates'] sees the
    deduped set even when below threshold. selection_distinct_angles
    then short-circuits because deduped_candidates length is below
    MIN_QUALIFIED_CANDIDATES.
    """

    fixtures = [
        AngleOutput(
            canonical_url=STRONG_URL,
            angle="Single",
            tweet_body="Only one angle.",
            evidence_excerpt="e1",
            resonance_score=0.90,
            evidence_strength=0.80,
            worldview_axes=["anti_rent_hours"],
        ),
    ]
    graph = _build_graph(
        archive_html=archive_html,
        issue_html=issue_html,
        article_routes=article_routes,
        fixtures=fixtures,
    )
    initial = make_initial_state(
        run_key="2026-W34",
        thread_id="cto-craft/2026-W34",
        started_at="2026-08-24T09:00:00Z",
    )
    final = graph.invoke(initial)

    assert final["outcome"] == "noop"
    # collect_candidates writes the cleaned list (1 entry here) into
    # deduped_candidates even on the noop branch, so downstream reads
    # see a consistent view of the deduped set.
    assert len(final["deduped_candidates"]) == 1
    assert final["deduped_candidates"][0]["canonical_url"] == STRONG_URL
    # state["candidates"] still holds the raw scored list — the noop
    # branch does not clear it (preserved for diagnostic value).
    assert len(final["candidates"]) == 1