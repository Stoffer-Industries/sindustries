"""End-to-end PostgresSaver checkpointer durability test for the CTO Craft workflow.

This is the regression test for task 60971f78 ("Fix cto-craft-tweet-drafts:
LangGraph Send objects not JSON-serializable by PostgresSaver").

Background
----------
``_route_after_extract_with_fanout`` (graph.py:461) returns a
``list[langgraph.types.Send]`` from a conditional edge so the graph can
fan out one ``fetch_and_score_article`` invocation per article URL. On
langgraph 0.3.x, ``PostgresSaver`` could not JSON-serialize those Send
objects at checkpoint time and crashed with::

    TypeError: Object of type Send is not JSON serializable

LangGraph 0.4.x registers a serde for Send, so the checkpointer can now
write the same fanout checkpoints cleanly.

What this test asserts
----------------------
With a real PostgresSaver wired into the graph (not the Studio
InMemorySaver or the test-only ``langgraph.checkpoint.memory.InMemorySaver``),
a happy-path run that triggers the fanout boundary completes end-to-end
and produces ``outcome == "created"`` plus ``createdCount == 3``. If
Send ever regresses on JSON serialization, this test reproduces the
production TypeError instead of producing a clean state object.

Test infrastructure
-------------------
The test requires a live Postgres reachable via
``CTO_CRAFT_LANGGRAPH_DATABASE_URL`` (matches the production env var
shape used by ``cto_craft_workflow.cli:_run_checkpointer``). When the
env var is absent the test is skipped — local developers without
docker-compose Postgres should not see a red test, only a one-line skip.
The CI job ``cto-craft-tweet-drafts-tests`` provides Postgres via
``services.postgres`` and exports the env var, mirroring the tasks-api
+ budget-api CI patterns.
"""

from __future__ import annotations

import os

import httpx
import pytest

from langgraph.checkpoint.postgres import PostgresSaver

from cto_craft_workflow.angle_model import AngleOutput, FakeAngleModel, load_prompts
from cto_craft_workflow.graph import GraphDeps, build_graph
from cto_craft_workflow.safe_fetch import SafeFetcher
from cto_craft_workflow.state import make_initial_state

from test_graph import (
    ARCHIVE_URL,
    BOUNDARY_URL,
    GENERIC_URL,
    STRONG_URL,
    _transport,
)


POSTGRES_ENV_VAR = "CTO_CRAFT_LANGGRAPH_DATABASE_URL"


# Per-URL fixtures used by the durability test. Mirrors the URL → fixture
# map in ``tests/conftest.py``; we redeclare it here so the test stays
# independent of fixture-parametrisation order.
ARTICLE_URL_TO_FIXTURE: dict[str, str] = {
    STRONG_URL: "article-strong.html",
    BOUNDARY_URL: "article-boundary.html",
    GENERIC_URL: "article-generic.html",
}


def _load_article_bodies() -> dict[str, bytes]:
    from pathlib import Path

    fixtures_dir = Path(__file__).parent / "fixtures"
    return {url: (fixtures_dir / name).read_bytes() for url, name in ARTICLE_URL_TO_FIXTURE.items()}


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


@pytest.fixture
def postgres_saver():
    """Yield an initialised PostgresSaver, or skip the test if no DB is configured.

    ``PostgresSaver.from_conn_string`` returns a context manager that
    opens the connection pool on ``__enter__``; we initialise the
    checkpointer schema with ``setup()`` so a fresh test database does
    not need a manual ``psql`` bootstrap step. ``yield`` inside the
    ``with`` block lets pytest tear down the saver cleanly even if the
    test raises mid-flight.
    """
    database_url = os.environ.get(POSTGRES_ENV_VAR)
    if not database_url:
        pytest.skip(
            f"{POSTGRES_ENV_VAR} is not set; skipping real PostgresSaver "
            "durability test (CI job provides services.postgres)."
        )
    with PostgresSaver.from_conn_string(database_url) as saver:
        saver.setup()
        yield saver


def test_postgres_saver_checkpoints_fanout_without_typeerror(
    archive_html,
    issue_html,
    postgres_saver,
) -> None:
    """Reproduce task 60971f78's pre-fix crash and verify it stays fixed.

    Drives the graph through the full happy-path run with three articles
    that triggers ``_route_after_extract_with_fanout`` (the only place
    that returns ``list[Send]``). On langgraph 0.3.x, PostgresSaver
    raises ``TypeError: Object of type Send is not JSON serializable``
    at the conditional-edge checkpoint. On langgraph 0.4.x with the
    registered Send serializer, the same run completes cleanly and
    imports three drafts.
    """
    article_routes = _load_article_bodies()
    import_calls: list[list[dict]] = []

    def fake_import(items: list[dict]) -> dict:
        import_calls.append(items)
        return {
            "createdCount": len(items),
            "skippedDuplicateCount": 0,
            "createdIds": [f"id-{i}" for i in range(len(items))],
            "sourceRefs": [item["sourceRef"] for item in items],
        }

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
        import_fn=fake_import,
    )

    graph = build_graph(deps, checkpointer=postgres_saver)
    initial = make_initial_state(
        run_key="2026-W34-send",
        thread_id="cto-craft/2026-W34-send-pgsaver",
        started_at="2026-08-24T09:00:00Z",
    )
    config = {"configurable": {"thread_id": "cto-craft/2026-W34-send-pgsaver"}}

    # The PostgresSaver writes at every superstep boundary, including
    # the conditional-edge transition where Send objects enter the
    # pending-sends table. If the Send serializer regresses, the call
    # below raises TypeError instead of returning a completed state.
    final = graph.invoke(initial, config=config)

    assert final["outcome"] == "created", (
        f"happy-path run with PostgresSaver failed: outcome={final.get('outcome')!r}, "
        f"errors={final.get('errors')!r}"
    )
    assert final["import_result"]["createdCount"] == 3, (
        f"expected 3 drafts created, got {final['import_result']!r}"
    )
    assert len(import_calls) == 1
    assert len(import_calls[0]) == 3

    # State-history retrieval exercises the read path too. The exact
    # structure of ``snap.metadata`` changed between langgraph 0.3.x
    # (the version pinned before this fix) and 0.4.x (the version we
    # validate against), so we only assert what AC1 requires: that a
    # checkpoint history exists and that the final state's outcome +
    # import_result are intact after a real Postgres round-trip. Any
    # TypeError or omitted checkpoint would surface as ``final is None``
    # or as an exception above this line.
    history = list(graph.get_state_history(config))
    assert history, "PostgresSaver returned no state history"
    final_snap = history[0]
    assert final_snap.values.get("outcome") == "created"
    assert final_snap.values.get("import_result", {}).get("createdCount") == 3


def test_postgres_saver_checkpointer_setup_is_idempotent(postgres_saver) -> None:
    """Calling ``setup()`` on an already-initialised schema is a no-op.

    Guards against future migrations that turn ``setup()`` into a
    destructive operation. The CTAS statements are guarded by
    ``IF NOT EXISTS`` upstream, so this should always pass — but if
    someone rewrites the migration logic naively, this test catches it
    before the CI run turns red.
    """
    postgres_saver.setup()  # type: ignore[attr-defined]
    # Second setup call should also be a no-op, not an exception.
    postgres_saver.setup()  # type: ignore[attr-defined]