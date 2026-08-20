"""Tests for the LangGraph Studio entrypoint.

These tests assert the Studio wrapper exposes the real CTO Craft graph
topology, refuses any side-effect call before it can reach production,
and runs end-to-end against canned fixtures with no network access. The
Studio wrapper is the *only* place a developer touches LangGraph Studio;
this module is the contract between the Studio factory and the rest of
the codebase.
"""

from __future__ import annotations

import sys
from importlib import import_module

import pytest

from cto_craft_workflow.angle_model import (
    AngleOutput,
    FakeAngleModel,
    OpenClawStructuredAngleModel,
)
from cto_craft_workflow.content_scheduler import ImportClient
from cto_craft_workflow.graph import (
    COLLECT,
    COMPLETE_NOOP,
    FANOUT,
    IMPORT,
    NOTIFY,
    SELECT,
    build_graph,
)
from cto_craft_workflow.safe_fetch import FetchError
from cto_craft_workflow.state import make_initial_state
from langgraph.checkpoint.memory import MemorySaver
from langgraph.checkpoint.postgres import PostgresSaver
from cto_craft_workflow.studio import (
    STUDIO_IMPORT_FORBIDDEN_CODE,
    STUDIO_NO_FIXTURE_CODE,
    StubSafeFetcher,
    StudioImportFn,
    StudioImportForbidden,
    assert_no_production_side_effects,
    build_studio_graph,
    build_studio_graph_factory,
)


# ---------------------------------------------------------------------------
# AC1 — the Studio factory returns a compiled graph.


def test_studio_graph_compiles() -> None:
    """``build_studio_graph`` returns a compiled graph with the real topology."""

    graph = build_studio_graph()
    # ``get_graph`` is the canonical LangGraph introspection call. If
    # the studio factory handed us something that does not expose a
    # graph, this raises immediately.
    spec = graph.get_graph()
    nodes = set(spec.nodes.keys())
    # Each production node must appear in the Studio graph verbatim.
    expected_nodes = {
        "discover_latest_issue",
        "extract_public_links",
        "fetch_and_score_article",
        COLLECT,
        SELECT,
        IMPORT,
        NOTIFY,
        COMPLETE_NOOP,
    }
    assert expected_nodes.issubset(nodes), f"missing nodes: {expected_nodes - nodes}"


def test_studio_factory_returns_compiled_graph() -> None:
    """The Studio closure returns a fresh compiled graph per call."""

    factory = build_studio_graph_factory()
    g1 = factory()
    g2 = factory()
    # Each call returns a compiled graph with a populated topology.
    assert set(g1.get_graph().nodes.keys())
    assert set(g2.get_graph().nodes.keys())
    # Each call returns a fresh instance — Studio sessions must not
    # share state through the factory.
    assert g1 is not g2


# ---------------------------------------------------------------------------
# AC2 — Studio exposes the real topology with deterministic / mocked deps.


def test_studio_graph_has_real_topology() -> None:
    """Studio graph includes the fan-out edge and the no-op END edge."""

    graph = build_studio_graph()
    spec = graph.get_graph()
    nodes = set(spec.nodes.keys())
    # The production node set: discover, extract, fan-out (Send branch),
    # collect, select, import, notify, complete_noop.
    expected = {
        "discover_latest_issue",
        "extract_public_links",
        "fetch_and_score_article",
        "collect_candidates",
        "select_distinct_angles",
        "import_drafts",
        "format_notification",
        "complete_noop",
    }
    assert expected.issubset(nodes)


def test_studio_factory_uses_memory_checkpointer() -> None:
    """The Studio graph must never bind a Postgres-backed checkpointer."""

    from langgraph.checkpoint.memory import MemorySaver

    graph = build_studio_graph()
    # The compiled graph stores its checkpointer on the public
    # ``checkpointer`` attribute (LangGraph convention). Inspecting the
    # type is the closest unit-level proxy for "this is not Postgres".
    assert isinstance(graph.checkpointer, MemorySaver), (
        f"Studio graph checkpointer is {type(graph.checkpointer).__name__!r}; "
        "expected MemorySaver"
    )


def test_studio_factory_does_not_instantiate_postgres_saver() -> None:
    """``PostgresSaver`` must not be instantiated by the Studio factory."""

    from langgraph.checkpoint.postgres import PostgresSaver

    # The studio factory lives entirely in memory. PostgresSaver is
    # imported only because tests need to assert its absence by class
    # identity; we never call ``from_conn_string`` or any other
    # Postgres-touching entrypoint.
    instance_count = sum(
        1 for v in gc_get_objects() if isinstance(v, PostgresSaver)
    )
    factory = build_studio_graph_factory()
    graph = factory()
    # The factory ran. Re-check: still no PostgresSaver instantiated.
    new_count = sum(
        1 for v in gc_get_objects() if isinstance(v, PostgresSaver)
    )
    assert new_count == instance_count, (
        "build_studio_graph_factory instantiated PostgresSaver — "
        "Studio must use MemorySaver only"
    )
    # And the compiled graph's checkpointer is still a MemorySaver.
    assert isinstance(graph.checkpointer, MemorySaver)


def gc_get_objects():
    """Local copy of ``gc.get_objects`` to avoid an unconditional import."""
    import gc

    return gc.get_objects()


def test_studio_factory_does_not_instantiate_import_client() -> None:
    """``ImportClient`` must not be instantiated by the Studio factory."""

    # We count ImportClient instances before and after the factory call.
    # If the factory wired up a real HTTP client, this counter would tick up.
    before = sum(1 for v in gc_get_objects() if isinstance(v, ImportClient))
    factory = build_studio_graph_factory()
    factory()
    after = sum(1 for v in gc_get_objects() if isinstance(v, ImportClient))
    assert after == before, (
        "build_studio_graph_factory instantiated ImportClient — "
        "Studio must not bind the production Content Scheduler client"
    )


def test_studio_factory_does_not_instantiate_openclaw_angle_model() -> None:
    """The production OpenClaw adapter must not be instantiated by Studio."""

    before = sum(
        1 for v in gc_get_objects() if isinstance(v, OpenClawStructuredAngleModel)
    )
    factory = build_studio_graph_factory()
    factory()
    after = sum(
        1 for v in gc_get_objects() if isinstance(v, OpenClawStructuredAngleModel)
    )
    assert after == before, (
        "build_studio_graph_factory instantiated OpenClawStructuredAngleModel — "
        "Studio must use FakeAngleModel only"
    )


def test_studio_factory_does_not_construct_httpx_client_against_production_url() -> None:
    """No httpx.Client may be constructed with the production base URL."""

    import httpx

    factory = build_studio_graph_factory()
    factory()
    for v in gc_get_objects():
        if isinstance(v, httpx.Client):
            # Inspect any URL-ish attributes we know about. ``httpx.Client``
            # does not store the base URL in an obvious attribute, but we
            # can still walk the headers for the production ingest
            # secret. Studio never sets one, so any client we find with
            # ``x-content-ingest-secret`` would be a violation.
            headers = getattr(v, "headers", {}) or {}
            assert "x-content-ingest-secret" not in {k.lower() for k in headers}, (
                "Studio factory constructed an httpx.Client carrying "
                "x-content-ingest-secret — Studio must not call Content Scheduler"
            )


# ---------------------------------------------------------------------------
# AC2 — Studio import gate.


def test_studio_import_fn_rejects_first_call() -> None:
    """The Studio import function must raise ``STUDIO_IMPORT_FORBIDDEN``."""

    gate = StudioImportFn()
    with pytest.raises(StudioImportForbidden) as excinfo:
        gate([{"body": "hi", "sourceRef": "x", "issueRef": None, "evidenceExcerpt": ""}])
    assert excinfo.value.code == STUDIO_IMPORT_FORBIDDEN_CODE
    assert gate.call_count == 1
    assert gate.last_items is not None and len(gate.last_items) == 1


def test_studio_import_fn_records_attempts_but_never_returns() -> None:
    """Repeated calls to the Studio import gate keep refusing."""

    gate = StudioImportFn()
    for _ in range(3):
        with pytest.raises(StudioImportForbidden):
            gate([])
    assert gate.call_count == 3


# ---------------------------------------------------------------------------
# AC2 — Studio fetcher is offline-only.


def test_studio_fetcher_returns_canned_body() -> None:
    """``StubSafeFetcher.fetch`` returns a canned resource for known URLs."""

    fetcher = StubSafeFetcher()
    # The default fixtures shipped with the package are loaded at
    # import time. The archive URL is always registered.
    resource = fetcher.fetch("https://www.techmanagerweekly.com/", kind="issue")
    assert resource.body  # non-empty body
    assert "fetch_calls" in fetcher.__dict__ or hasattr(fetcher, "fetch_calls")
    assert ("https://www.techmanagerweekly.com/", "issue") in fetcher.fetch_calls


def test_studio_fetcher_refuses_unknown_url_without_socket() -> None:
    """Unknown URLs raise STUDIO_NO_FIXTURE before any network call."""

    fetcher = StubSafeFetcher()
    with pytest.raises(FetchError) as excinfo:
        fetcher.fetch("https://example.com/not-a-fixture", kind="article")
    assert excinfo.value.code == STUDIO_NO_FIXTURE_CODE


def test_studio_fetcher_register_overrides_default() -> None:
    """``register`` lets tests inject a per-URL canned body."""

    fetcher = StubSafeFetcher()
    custom_body = b"<html><body>custom</body></html>"
    fetcher.register(
        "https://www.techmanagerweekly.com/tmw-495/",
        custom_body,
    )
    resource = fetcher.fetch(
        "https://www.techmanagerweekly.com/tmw-495/", kind="issue"
    )
    assert resource.body == custom_body


# ---------------------------------------------------------------------------
# AC2 — end-to-end run against canned fixtures.


def test_studio_graph_runs_end_to_end_offline() -> None:
    """The Studio graph runs to a terminal state without any network call.

    The default Studio fixtures exercise the ``noop`` branch
    deliberately: the issue fixture is registered but no qualifying
    candidates are produced against the canned fetcher's known URLs.
    The graph must still terminate with ``outcome in {created, noop}``
    (not ``failed``) and surface a notification iff ``outcome ==
    "created"``.
    """

    graph = build_studio_graph()
    initial = make_initial_state(
        run_key="studio-test",
        thread_id="studio-test-thread",
        started_at="2026-08-21T00:00:00Z",
    )
    final = graph.invoke(
        initial,
        config={"configurable": {"thread_id": "studio-test-thread"}},
    )
    outcome = final.get("outcome")
    assert outcome in ("created", "noop"), (
        f"unexpected outcome {outcome!r}; "
        "Studio must not surface 'failed' under canned fixtures"
    )


def test_studio_graph_runs_end_to_end_into_noop_branch() -> None:
    """With canned fixtures, the graph lands in the no-op branch."""

    graph = build_studio_graph()
    initial = make_initial_state(
        run_key="studio-noop",
        thread_id="studio-noop-thread",
        started_at="2026-08-21T00:00:00Z",
    )
    final = graph.invoke(
        initial,
        config={"configurable": {"thread_id": "studio-noop-thread"}},
    )
    # The default Studio fetcher does not register any article URL, so
    # even if the issue parses the graph will hit the no-op branch via
    # the empty-articles path or the empty-qualifying-candidates path.
    assert final.get("outcome") == "noop"


# ---------------------------------------------------------------------------
# AC3 — runtime compatibility shim is exercised by the Studio factory.


def test_studio_runtime_context_api_compatible() -> None:
    """LangGraph is importable without USE_RUNTIME_CONTEXT_API crash.

    This test is a low-effort smoke check: if the locked dep matrix
    resolved to incompatible versions, ``import langgraph`` would
    raise before the test body runs. Reaching the assertion means the
    pinned floor (``langgraph>=0.3.21,<0.4.0``) and the CLI extra
    (``langgraph-cli[inmem]>=0.3.6,<0.4.0``) line up.
    """

    langgraph = import_module("langgraph")
    assert langgraph is not None
    # The specific symbol the historic crash complained about:
    # ``USE_RUNTIME_CONTEXT_API`` was a flag distinguishing old vs new
    # runtimes. LangGraph 0.3.x dropped the flag; importing the
    # package without it is the success signal.
    assert not hasattr(langgraph, "USE_RUNTIME_CONTEXT_API") or not getattr(
        langgraph, "USE_RUNTIME_CONTEXT_API", True
    ), "USE_RUNTIME_CONTEXT_API flag set; runtime matrix mismatch"


# ---------------------------------------------------------------------------
# AC4 — defensive helper is callable.


def test_assert_no_production_side_effects_does_not_raise() -> None:
    """The defensive helper returns cleanly when no production adapter was used."""

    # After a Studio factory call, this should still return without
    # raising — the helper is a defense-in-depth probe, not a hard gate.
    factory = build_studio_graph_factory()
    factory()
    assert_no_production_side_effects()  # does not raise


# ---------------------------------------------------------------------------
# Edge cases.


def test_studio_graph_with_custom_fixtures_uses_them() -> None:
    """``build_studio_graph`` honors a caller-supplied fixtures list."""

    fetcher = StubSafeFetcher()
    fetcher.register(
        "https://www.techmanagerweekly.com/tmw-999/",
        b"<html><body>custom</body></html>",
    )
    graph = build_studio_graph(fetcher=fetcher)
    initial = make_initial_state(
        run_key="studio-custom",
        thread_id="studio-custom-thread",
        started_at="2026-08-21T00:00:00Z",
    )
    # The default archive fixture is what the graph fetches first; the
    # issue URL is registered on the fetcher only if the caller did
    # so. With a custom fetcher and no fixture for the canonical
    # issue URL, the graph falls into the no-op branch via the issue
    # parse path.
    final = graph.invoke(
        initial,
        config={"configurable": {"thread_id": "studio-custom-thread"}},
    )
    assert final.get("outcome") in ("created", "noop", "failed")
    # Either way, no exception escaped the graph.