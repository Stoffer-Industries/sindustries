"""Typed graph state and DTOs for the CTO Craft pipeline.

The persisted state is JSON-serializable and exposes only one reducer
boundary (``candidates`` via :func:`operator.add`). Everything else is plain
assignment. The state is intentionally narrow: products of derived work
(``selected_angles``, ``import_result``, ``notification``) are committed
only when the graph has actually decided on them, so a crash in an
intermediate node replays cleanly from the last committed checkpoint.
"""

from __future__ import annotations

import operator
from typing import Annotated, Any, Literal, TypedDict


MAX_TWEET_CHARS = 280
"""Hard cap on a single tweet body. Matches X's own limit."""


MAX_MIN_TEXT_CHARS = 200
"""Articles shorter than this are treated as not useful."""


MAX_ARTICLE_TEXT_CHARS = 20_000
"""Bounded by the safe fetcher; the graph trims beyond this defensively."""


MAX_ELIGIBLE_LINKS = 30
"""Hard cap on how many article links a single issue can fan out to."""


MIN_QUALIFIED_CANDIDATES = 3
"""Fewer than this means the run is a no-op, not a forced top-up."""


MAX_SELECTED_ANGLES = 5
"""Per AC2: no run produces more than 5 angles."""


Outcome = Literal["created", "noop", "failed"]


class ArticleLink(TypedDict):
    """A public article link extracted from a TMW issue."""

    url: str
    title: str | None


class ArticleContent(TypedDict):
    """Fetched and sanitized article content for one link."""

    url: str
    canonical_url: str
    title: str
    author: str | None
    text: str
    char_count: int


class AngleCandidate(TypedDict):
    """One angle emitted by the structured angle model for one article."""

    canonical_url: str
    angle: str
    tweet_body: str
    evidence_excerpt: str
    resonance_score: float
    evidence_strength: float
    worldview_axes: list[str]


class SelectedAngle(TypedDict):
    """An angle that survived selection and is destined for import."""

    canonical_url: str
    tweet_body: str
    evidence_excerpt: str
    resonance_score: float
    issue_ref: str | None


class ImportItem(TypedDict):
    """One row to send to the Content Scheduler import endpoint."""

    body: str
    sourceRef: str
    issueRef: str | None
    evidenceExcerpt: str | None


class ImportResponse(TypedDict):
    """What the Content Scheduler import endpoint returns on success."""

    createdCount: int
    skippedDuplicateCount: int
    createdIds: list[str]
    sourceRefs: list[str]


class ImportResult(TypedDict):
    """Persisted on the graph state after a successful import call."""

    createdCount: int
    skippedDuplicateCount: int
    createdIds: list[str]
    sourceRefs: list[str]


class Diagnostic(TypedDict):
    """One classified diagnostic emitted from a node."""

    node: str
    url: str | None
    code: str
    message: str


class PipelineState(TypedDict, total=False):
    """The full persisted graph state for one weekly invocation."""

    run_key: str
    started_at: str
    thread_id: str

    issue_url: str | None
    issue_title: str | None
    issue_published_at: str | None

    article_links: list[ArticleLink]

    # Reducer boundary: parallel `Send` branches append here. Kept as the
    # contract for any future parallel producer of raw scored candidates;
    # downstream selection reads from `deduped_candidates` instead so the
    # reducer does not double-accumulate on top of an already-deduped
    # writeback from `collect_candidates` (see task 402d39fe).
    candidates: Annotated[list[AngleCandidate], operator.add]

    # Overwrite field: `collect_candidates` writes the deduped set here.
    # Selection reads from this key, NOT from `candidates`, to avoid the
    # reducer-writeback-collision bug surfaced after PR #523 (task
    # 60971f78). Pre-existing latent issue masked by the prior Send
    # crash; now visible because the cron completes.
    deduped_candidates: list[AngleCandidate]

    selected_angles: list[SelectedAngle]
    import_result: ImportResult | None
    outcome: Outcome | None
    notification: str | None

    diagnostics: list[Diagnostic]


def make_initial_state(
    *,
    run_key: str,
    thread_id: str,
    started_at: str,
) -> PipelineState:
    """Build the canonical zero-state for a fresh weekly run."""

    return PipelineState(
        run_key=run_key,
        thread_id=thread_id,
        started_at=started_at,
        issue_url=None,
        issue_title=None,
        issue_published_at=None,
        article_links=[],
        candidates=[],
        deduped_candidates=[],
        selected_angles=[],
        import_result=None,
        outcome=None,
        notification=None,
        diagnostics=[],
    )


def is_valid_candidate_shape(candidate: Any) -> bool:
    """Quick structural check used by the collect reducer.

    Mirrors the strict Pydantic schema in :mod:`cto_craft_workflow.angle_model`
    but stays dependency-light so reducer code does not import Pydantic.
    """

    if not isinstance(candidate, dict):
        return False
    required = ("canonical_url", "angle", "tweet_body", "evidence_excerpt",
                "resonance_score", "evidence_strength", "worldview_axes")
    for key in required:
        if key not in candidate:
            return False
    tweet_body = candidate.get("tweet_body")
    if not isinstance(tweet_body, str) or len(tweet_body) == 0:
        return False
    if len(tweet_body) > MAX_TWEET_CHARS:
        return False
    canonical_url = candidate.get("canonical_url")
    if not isinstance(canonical_url, str) or not canonical_url.startswith(("http://", "https://")):
        return False
    return True
