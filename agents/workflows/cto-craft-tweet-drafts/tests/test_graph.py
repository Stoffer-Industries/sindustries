"""Offline graph integration tests for the CTO Craft workflow.

These tests use the ``FakeAngleModel`` and a fake HTTP transport to drive
the full graph end-to-end without any network or model dependencies. The
tests assert:

- a happy-path run with 3+ articles and 3+ strong candidates produces
  3 drafted items and a non-null notification;
- a run with fewer than 3 strong candidates is a no-op (no notification);
- a run with a source-layout parse failure is a failed outcome (no
  silent no-op);
- a run that fanouts off the issue URL fetches each article once and
  dedupes by canonical URL.

The tests deliberately keep external runtime dependencies out of scope.
Production adapter behavior and durability semantics are covered by
separate deterministic tests in ``test_angle_model.py`` and
``test_durability.py``.
"""

from __future__ import annotations

import httpx
import pytest

from cto_craft_workflow.angle_model import AngleOutput, FakeAngleModel
from cto_craft_workflow.graph import GraphDeps, build_graph
from cto_craft_workflow.safe_fetch import SafeFetcher
from cto_craft_workflow.state import make_initial_state


ARCHIVE_URL = "https://www.techmanagerweekly.com/"
ISSUE_URL = "https://www.techmanagerweekly.com/tmw-495/"
STRONG_URL = "https://staysaasy.com/p/slow-iteration"
GENERIC_URL = "https://lethain.com/fluff-receipts/"
BOUNDARY_URL = "https://lethain.com/boundaries/"
HIRING_URL = "https://lethain.com/hiring-receiving-role/"


def _transport(
    archive_html: bytes,
    issue_html: bytes,
    article_routes: dict[str, bytes],
) -> httpx.MockTransport:
    """Build an HTTP transport that serves per-URL article bodies.

    ``article_routes`` maps each article URL to its own HTML body so the
    extractor can read distinct ``<link rel="canonical">`` values per
    URL. Sharing one body across URLs would force every article to
    collapse to the same canonical and break the dedup tests.
    """

    routes: dict[str, tuple[int, bytes, dict[str, str]]] = {
        ARCHIVE_URL: (200, archive_html, {"content-type": "text/html"}),
        ISSUE_URL: (200, issue_html, {"content-type": "text/html"}),
    }
    for url, body in article_routes.items():
        routes[url] = (200, body, {"content-type": "text/html"})

    def handler(req: httpx.Request) -> httpx.Response:
        url = str(req.url)
        if url in routes:
            status, body, headers = routes[url]
            return httpx.Response(status, content=body, headers=headers)
        # Substring match for article URLs with query params.
        for prefix, (status, body, headers) in routes.items():
            if url.startswith(prefix):
                return httpx.Response(status, content=body, headers=headers)
        return httpx.Response(404, content=b"not found", headers={"content-type": "text/plain"})

    return httpx.MockTransport(handler)


def _build_graph(
    *,
    archive_html: bytes,
    issue_html: bytes,
    article_routes: dict[str, bytes],
    fixtures: list[AngleOutput],
    import_fn=None,
) -> object:
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
    from cto_craft_workflow.angle_model import load_prompts

    system_prompt, worldview_profile = load_prompts()
    deps = GraphDeps(
        fetcher=fetcher,
        model=FakeAngleModel(fixtures=fixtures),
        system_prompt=system_prompt,
        worldview_profile=worldview_profile,
        min_resonance_score=0.55,
        max_selected_angles=5,
        model_timeout_seconds=5.0,
        archive_url=ARCHIVE_URL,
        import_fn=import_fn,
    )
    return build_graph(deps)


# Default per-URL article bodies. Each URL maps to a fixture whose
# <link rel="canonical"> matches that URL, so the extractor returns a
# distinct canonical per article and the dedup logic has something to
# dedup against.
DEFAULT_ARTICLE_ROUTES: dict[str, str] = {
    STRONG_URL: "article-strong.html",
    BOUNDARY_URL: "article-boundary.html",
    GENERIC_URL: "article-generic.html",
    HIRING_URL: "article-hiring.html",
}


def test_happy_path_creates_three_drafts(
    archive_html, issue_html, article_routes
) -> None:
    fixtures = [
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
            angle="Org charts are the real source of boundary decisions",
            tweet_body="Information architecture, not process, decides who owns the failure. Cross-team incidents pull the right answer out of the org chart every time.",
            evidence_excerpt="Boundary decisions are made by the org chart, not by the process doc.",
            resonance_score=0.81,
            evidence_strength=0.74,
            worldview_axes=["builder_architect", "autonomy_ownership"],
        ),
        AngleOutput(
            canonical_url=GENERIC_URL,
            angle="Hire for the receiver, not the broadcaster",
            tweet_body="Most 'communicate better' advice skips the part where the listener has to act on it. Hire for the receiving role.",
            evidence_excerpt="The strongest predictor of team success is the clarity of the receiving role.",
            resonance_score=0.72,
            evidence_strength=0.71,
            worldview_axes=["anti_fluff", "autonomy_ownership"],
        ),
    ]
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
        fixtures=fixtures,
        import_fn=fake_import,
    )

    initial = make_initial_state(
        run_key="2026-W32",
        thread_id="cto-craft/2026-W32",
        started_at="2026-08-10T09:00:00Z",
    )
    final = graph.invoke(initial)

    assert final["outcome"] == "created"
    assert final["notification"] is not None
    assert "Created" in final["notification"]
    assert len(final["selected_angles"]) >= 3
    assert len(final["selected_angles"]) <= 5
    assert final["import_result"]["createdCount"] == len(import_calls[0])
    assert len(import_calls) == 1


def test_fewer_than_three_strong_candidates_is_noop(
    archive_html, issue_html, article_routes
) -> None:
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
    ]
    import_calls: list[list[dict]] = []

    def fake_import(items: list[dict]) -> dict:
        import_calls.append(items)
        return {"createdCount": 0, "skippedDuplicateCount": 0, "createdIds": [], "sourceRefs": []}

    graph = _build_graph(
        archive_html=archive_html,
        issue_html=issue_html,
        article_routes=article_routes,
        fixtures=fixtures,
        import_fn=fake_import,
    )
    initial = make_initial_state(
        run_key="2026-W32",
        thread_id="cto-craft/2026-W32",
        started_at="2026-08-10T09:00:00Z",
    )
    final = graph.invoke(initial)

    assert final["outcome"] == "noop"
    assert final["notification"] is None
    assert import_calls == []


def test_low_resonance_score_is_noop(
    archive_html, issue_html, article_routes
) -> None:
    fixtures = [
        AngleOutput(
            canonical_url=STRONG_URL,
            angle="Weak",
            tweet_body="Some weak angle.",
            evidence_excerpt="evidence",
            resonance_score=0.30,
            evidence_strength=0.20,
            worldview_axes=["anti_fluff"],
        ),
        AngleOutput(
            canonical_url=BOUNDARY_URL,
            angle="Weak",
            tweet_body="Another weak angle.",
            evidence_excerpt="evidence",
            resonance_score=0.40,
            evidence_strength=0.30,
            worldview_axes=["anti_fluff"],
        ),
        AngleOutput(
            canonical_url=GENERIC_URL,
            angle="Weak",
            tweet_body="A third weak angle.",
            evidence_excerpt="evidence",
            resonance_score=0.45,
            evidence_strength=0.35,
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
        run_key="2026-W32",
        thread_id="cto-craft/2026-W32",
        started_at="2026-08-10T09:00:00Z",
    )
    final = graph.invoke(initial)

    assert final["outcome"] == "noop"
    assert final["notification"] is None


def test_archive_parse_failure_is_failed(
    archive_html, issue_html, article_routes
) -> None:
    fixtures: list[AngleOutput] = []
    graph = _build_graph(
        archive_html=b"<html><body>no anchors here</body></html>",
        issue_html=issue_html,
        article_routes=article_routes,
        fixtures=fixtures,
    )
    initial = make_initial_state(
        run_key="2026-W32",
        thread_id="cto-craft/2026-W32",
        started_at="2026-08-10T09:00:00Z",
    )
    final = graph.invoke(initial)

    assert final["outcome"] == "failed"
    assert final["notification"] is None
    diag_codes = [d.get("code") for d in (final.get("diagnostics") or [])]
    assert "ARCHIVE_NO_ISSUE" in diag_codes


def test_selection_dedupes_by_canonical_url(
    archive_html, issue_html, article_routes
) -> None:
    # Two fixtures share the same canonical URL — the selection logic must
    # only pick one of them per URL.
    fixtures = [
        AngleOutput(
            canonical_url=STRONG_URL,
            angle="First",
            tweet_body="First angle.",
            evidence_excerpt="e1",
            resonance_score=0.90,
            evidence_strength=0.80,
            worldview_axes=["anti_rent_hours"],
        ),
        AngleOutput(
            canonical_url=STRONG_URL,
            angle="Duplicate",
            tweet_body="Should not be picked.",
            evidence_excerpt="e2",
            resonance_score=0.85,
            evidence_strength=0.75,
            worldview_axes=["anti_rent_hours"],
        ),
        AngleOutput(
            canonical_url=BOUNDARY_URL,
            angle="Second",
            tweet_body="Second angle.",
            evidence_excerpt="e3",
            resonance_score=0.80,
            evidence_strength=0.70,
            worldview_axes=["builder_architect"],
        ),
        AngleOutput(
            canonical_url=GENERIC_URL,
            angle="Third",
            tweet_body="Third angle.",
            evidence_excerpt="e4",
            resonance_score=0.70,
            evidence_strength=0.65,
            worldview_axes=["autonomy_ownership"],
        ),
    ]
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
        fixtures=fixtures,
        import_fn=fake_import,
    )
    initial = make_initial_state(
        run_key="2026-W32",
        thread_id="cto-craft/2026-W32",
        started_at="2026-08-10T09:00:00Z",
    )
    final = graph.invoke(initial)

    selected_urls = [s["canonical_url"] for s in final["selected_angles"]]
    assert len(selected_urls) == len(set(selected_urls))
    # The duplicate STRONG_URL only appeared once.
    assert selected_urls.count(STRONG_URL) == 1
    assert final["outcome"] == "created"
