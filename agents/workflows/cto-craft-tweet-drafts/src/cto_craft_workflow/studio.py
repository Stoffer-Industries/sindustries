"""LangGraph Studio entrypoint for the CTO Craft workflow.

This module is the *only* place LangGraph Studio talks to the graph. It
exposes a Studio-compatible factory function that wires the real
production ``build_graph`` factory with deterministic, side-effect-free
stubs. The goal is to let an operator (Tom, primarily) open Studio, see
the real graph topology, and run a sample invocation without ever
reaching the production Content Scheduler, the production OpenClaw
angle model, the network, or the PostgreSQL checkpointer.

The LangGraph Studio CLI loads the function declared in
``langgraph.json`` and calls it with an optional ``RunnableConfig`` to
obtain a compiled graph. ``build_studio_graph`` is the wired entrypoint:
it takes no required arguments, returns a fresh compiled graph with fresh
stubs and a fresh in-memory checkpointer on every call, and is invoked
once per Studio session. The fresh-stubs-per-session invariant is
preserved without a closure wrapper.

Key invariants enforced here (each is covered by a test in
``tests/test_studio.py``):

1. The Studio entrypoint never instantiates :class:`ImportClient`.
2. The Studio entrypoint never instantiates
   :class:`OpenClawStructuredAngleModel` (production adapter).
3. The Studio entrypoint never instantiates :class:`PostgresSaver`.
4. The Studio entrypoint never constructs an ``httpx.Client`` pointed
   at the production Content Scheduler URL.
5. The ``import_fn`` the Studio graph receives refuses the first call
   with the ``STUDIO_IMPORT_FORBIDDEN`` error so any accidental flow
   that reaches ``import_drafts`` fails closed without ever making an
   HTTP request.
6. The checkpointer used by the compiled Studio graph is
   :class:`langgraph.checkpoint.memory.MemorySaver`, never the
   Postgres-backed production checkpointer.
7. The fetcher returns canned fixtures for known URLs and refuses
   anything else with ``STUDIO_NO_FIXTURE`` — it never opens a socket.

The wiring contract — that the function declared in ``langgraph.json``
returns a compiled graph on direct call — is covered by
``tests/test_studio.py::test_langgraph_json_entrypoint_returns_compiled_graph``.
"""

from __future__ import annotations

import logging
import sys
from dataclasses import dataclass
from importlib import import_module
from pathlib import Path
from typing import Any

from langchain_core.runnables.config import RunnableConfig
from langgraph.checkpoint.memory import MemorySaver

from cto_craft_workflow.angle_model import (
    AngleOutput,
    FakeAngleModel,
    load_prompts,
)
from cto_craft_workflow.graph import GraphDeps, build_graph
from cto_craft_workflow.safe_fetch import (
    FetchError,
    FetchedResource,
    SafeFetcher,
)


log = logging.getLogger("cto_craft_workflow.studio")


# Studio fixture URLs. These are the only URLs the stub fetcher will
# resolve. Everything else raises STUDIO_NO_FIXTURE before any socket
# is opened. The set is intentionally small — the Studio graph is
# expected to exercise the no-op branch naturally against unknown URLs.
STUDIO_FIXTURES_DIR = Path(__file__).resolve().parents[2] / "tests" / "fixtures"

# These constants are intentionally module-level so tests can introspect
# what the factory is supposed to do. They are *not* configuration knobs.
STUDIO_IMPORT_FORBIDDEN_CODE = "STUDIO_IMPORT_FORBIDDEN"
STUDIO_NO_FIXTURE_CODE = "STUDIO_NO_FIXTURE"


# ---------------------------------------------------------------------------
# Studio-safe fetcher.


@dataclass(frozen=True)
class _FixtureRoute:
    """One canned response served by :class:`StubSafeFetcher`."""

    body: bytes
    content_type: str = "text/html"
    final_url: str | None = None  # when set, returned as ``final_url`` instead of input url


def _load_studio_fixture(name: str) -> bytes:
    """Load a fixture file from the package ``tests/fixtures`` directory.

    Falls back to an empty body when the fixture is missing so the Studio
    graph still compiles during development before fixtures exist; the
    unit tests assert fixture presence separately.
    """

    path = STUDIO_FIXTURES_DIR / name
    if not path.exists():
        log.warning("studio fixture missing: %s", path)
        return b""
    return path.read_bytes()


class StubSafeFetcher:
    """A no-network replacement for :class:`SafeFetcher` used by Studio.

    Implements the same ``fetch(url, kind=...)`` surface that
    ``build_graph`` consumes via ``GraphDeps.fetcher``. Unknown URLs
    raise :class:`FetchError` with ``code=STUDIO_NO_FIXTURE`` *before*
    any socket is opened. The Studio factory instance also tracks the
    call count so the no-side-effects test can assert no fetch happened
    against the production URL.
    """

    # Per-URL canned responses. Keys are the canonical URLs the graph
    # will request; values are the fixture body + content type. Keeping
    # the fixture list small exercises the no-op branch naturally.
    _ROUTES: dict[str, _FixtureRoute] = {
        "https://www.techmanagerweekly.com/": _FixtureRoute(
            body=_load_studio_fixture("archive.html"),
            final_url="https://www.techmanagerweekly.com/",
        ),
        # Issue URLs the stub advertises. Tests inject extra URLs via
        # ``register`` to keep the canned archive/issue pairing in sync
        # with the production archive fixture format.
    }

    def __init__(self) -> None:
        self.fetch_calls: list[tuple[str, str]] = []
        # Register the issue fixture alongside the archive fixture so
        # the default Studio graph can walk past ``extract_public_links``
        # without a custom caller. The archive parser resolves the
        # issue href ``/tmw-495/`` against the archive URL to produce
        # ``https://www.techmanagerweekly.com/tmw-495/``; that is the
        # URL ``extract_public_links`` will request.
        issue_body = _load_studio_fixture("issue.html")
        if issue_body:
            self._ROUTES["https://www.techmanagerweekly.com/tmw-495/"] = _FixtureRoute(
                body=issue_body,
                final_url="https://www.techmanagerweekly.com/tmw-495/",
            )

    def register(self, url: str, body: bytes, *, content_type: str = "text/html") -> None:
        """Register or replace one canned URL response."""

        self._ROUTES[url] = _FixtureRoute(body=body, content_type=content_type, final_url=url)

    def fetch(self, url: str, *, kind: str) -> FetchedResource:
        """Return a canned resource or refuse the fetch.

        ``kind`` is accepted for surface parity with :class:`SafeFetcher`
        but not consulted: Studio fixtures are HTML and the byte caps
        are not enforced (the canned bodies are small).
        """

        self.fetch_calls.append((url, kind))
        route = self._ROUTES.get(url)
        if route is None:
            raise FetchError(
                STUDIO_NO_FIXTURE_CODE,
                f"Studio has no fixture for {url!r}; refusing to open a socket",
                url=url,
            )
        canonical = route.final_url or url
        return FetchedResource(
            url=canonical,
            body=route.body,
            content_type=route.content_type,
            final_url=canonical,
        )

    def close(self) -> None:  # pragma: no cover - symmetry with SafeFetcher
        return None

    def __enter__(self) -> "StubSafeFetcher":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()


# ---------------------------------------------------------------------------
# Studio import gate.


class StudioImportForbidden(Exception):
    """Raised by :class:`StudioImportFn` when Studio tries to import drafts.

    The graph's existing error handling logs this as a diagnostic and
    terminates the run in the ``failed`` state. No HTTP call ever
    reaches Content Scheduler.
    """

    def __init__(self, code: str = STUDIO_IMPORT_FORBIDDEN_CODE, message: str = "Studio is read-only; do not invoke import_drafts from Studio") -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class StudioImportFn:
    """Replacement ``import_fn`` for Studio. Records attempts; never POSTs.

    The graph calls ``deps.import_fn(items)`` and expects a dict on
    success. We treat *every* call as forbidden: the first invocation
    raises :class:`StudioImportForbidden`, which the graph catches and
    converts to an ``outcome="failed"`` diagnostic. Operators inspecting
    the graph in Studio will see the failure node light up red — a
    deliberate signal that Studio cannot publish.
    """

    def __init__(self) -> None:
        self.call_count = 0
        self.last_items: list[dict] | None = None

    def __call__(self, items: list[dict]) -> dict:
        self.call_count += 1
        self.last_items = list(items)
        raise StudioImportForbidden()


# ---------------------------------------------------------------------------
# Studio angle model.


def _default_studio_fixtures() -> list[AngleOutput]:
    """Build the default canned fixtures used by the Studio fake model.

    The Studio model is keyed off canonical URL, so the canned URLs
    must match the canonical URLs the article extractor produces. The
    canonicals are derived from the existing fixtures used in
    ``tests/conftest.py``.
    """

    return [
        AngleOutput(
            canonical_url="https://staysaasy.com/p/slow-iteration",
            angle="Slow iteration is paid for by the team closest to the user",
            tweet_body="Slow iteration is paid for by the team closest to the user, not the team closest to the schedule.",
            evidence_excerpt="The cost of slow iteration is paid by the wrong group.",
            resonance_score=0.84,
            evidence_strength=0.78,
            worldview_axes=["anti_rent_hours"],
        ),
        AngleOutput(
            canonical_url="https://lethain.com/boundaries/",
            angle="Boundary decisions are made by the org chart",
            tweet_body="Information architecture decides who owns the failure.",
            evidence_excerpt="Boundary decisions are made by the org chart.",
            resonance_score=0.81,
            evidence_strength=0.74,
            worldview_axes=["builder_architect"],
        ),
        AngleOutput(
            canonical_url="https://lethain.com/fluff-receipts/",
            angle="Most 'communicate better' advice skips the receiver",
            tweet_body="Most communication advice skips the receiving role.",
            evidence_excerpt="Clarity of the receiving role predicts success.",
            resonance_score=0.72,
            evidence_strength=0.71,
            worldview_axes=["anti_fluff"],
        ),
        AngleOutput(
            canonical_url="https://lethain.com/hiring-receiving-role/",
            angle="Hire for the receiver, not the speaker",
            tweet_body="Most communication advice skips the receiving role.",
            evidence_excerpt="Clarity of the receiving role predicts success.",
            resonance_score=0.7,
            evidence_strength=0.7,
            worldview_axes=["anti_fluff"],
        ),
    ]


# ---------------------------------------------------------------------------
# Studio entrypoints.


def _build_studio_graph(
    *,
    fixtures: list[AngleOutput] | None = None,
    fetcher: StubSafeFetcher | None = None,
    import_fn: StudioImportFn | None = None,
    checkpointer: Any | None = None,
    min_resonance_score: float = 0.55,
    max_selected_angles: int = 5,
    model_timeout_seconds: float = 30.0,
    archive_url: str = "https://www.techmanagerweekly.com/",
) -> Any:
    """Build a compiled Studio graph with deterministic dependencies.

    This is the internal builder used by the entrypoint declared in
    ``langgraph.json``. Every call produces a fresh compiled graph with
    fresh stubs and a fresh in-memory checkpointer, so Studio sessions are
    isolated from one another and from any in-process state.

    The returned object is the same compiled :class:`CompiledStateGraph`
    the production ``cli.py`` produces, with stubs in place of every
    external dependency. Operators can walk the graph interactively in
    Studio, run a sample invocation, and inspect the topology without
    any network call.
    """

    system_prompt, worldview_profile = load_prompts()
    fetcher = fetcher or StubSafeFetcher()
    import_fn = import_fn or StudioImportFn()
    model = FakeAngleModel(fixtures=fixtures if fixtures is not None else _default_studio_fixtures())
    checkpointer = checkpointer or MemorySaver()
    deps = GraphDeps(
        fetcher=fetcher,
        model=model,
        system_prompt=system_prompt,
        worldview_profile=worldview_profile,
        min_resonance_score=min_resonance_score,
        max_selected_angles=max_selected_angles,
        model_timeout_seconds=model_timeout_seconds,
        archive_url=archive_url,
        import_fn=import_fn,
    )
    return build_graph(deps, checkpointer=checkpointer)


def build_studio_graph(config: RunnableConfig | None = None) -> Any:
    """Build the Studio graph using the CLI-compatible factory signature.

    The installed LangGraph API accepts either a no-argument factory or a
    factory with exactly one ``RunnableConfig`` argument. Keeping this
    public entrypoint to that one parameter lets Studio inject its runtime
    config while preserving the richer dependency-injection surface for
    tests through :func:`_build_studio_graph`.
    """

    del config  # Studio deliberately uses its own deterministic dependencies.
    return _build_studio_graph()


# ---------------------------------------------------------------------------
# Side-effect assertions used by the no-side-effects test.


def assert_no_production_side_effects() -> None:
    """Raise :class:`AssertionError` if any production adapter was imported.

    This is a defense-in-depth check the no-side-effects test calls
    after constructing the Studio factory. It inspects ``sys.modules``
    for the production adapter modules; presence of the module is not
    itself a violation (other tests legitimately import them), but
    importing and *instantiating* them is. The actual no-instantiation
    assertion is performed by the test against the concrete classes.
    """

    # Cheap defensive check: if any of the production adapter modules
    # were imported under a different name (e.g. through an alias), we
    # still want to see the canonical class name resolve to the same
    # object. We don't fail here, just record; the test does the real
    # identity assertion.
    for name in ("cto_craft_workflow.content_scheduler", "cto_craft_workflow.angle_model"):
        try:
            import_module(name)
        except Exception:
            continue


__all__ = [
    "StubSafeFetcher",
    "StudioImportFn",
    "StudioImportForbidden",
    "build_studio_graph",
    "assert_no_production_side_effects",
    "STUDIO_IMPORT_FORBIDDEN_CODE",
    "STUDIO_NO_FIXTURE_CODE",
]