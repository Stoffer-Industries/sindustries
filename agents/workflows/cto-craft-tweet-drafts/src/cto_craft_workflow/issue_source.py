"""TMW archive + issue parsing.

The CTO Craft pipeline is intentionally narrow: one source (Tech Manager
Weekly), one URL pattern, and a small set of selectors that return a
``LatestIssue`` or a list of ``ArticleLink`` rows. When the source layout
changes, the parser fails visibly as a soft operational failure rather
than silently degrading to no-op behavior.

This module is the only place that knows about TMW's HTML structure. The
graph itself is generic and consumes plain dataclasses.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable
from urllib.parse import urlsplit, urlunsplit

from bs4 import BeautifulSoup


class ParseError(Exception):
    """Raised when the source layout cannot be parsed.

    The graph treats this as a soft operational failure, not a no-op. A
    no-op is for "nothing new this week"; a parse error is "I could not
    read the source — please investigate."
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class LatestIssue:
    """Latest issue discovered on the TMW archive page."""

    issue_url: str
    issue_title: str | None
    issue_published_at: str | None  # ISO-8601 if present, else None


# The selector patterns below are deliberately specific to the current
# public TMW archive. Anything that returns no match on a known fixture
# is treated as a parse error, not a silent no-op.
#
# TMW's URL scheme has drifted at least once (was ``/issue/<slug>`` before
# the 2026 redesign; is now ``/tmw-<id>/``). When it drifts again the
# pattern below is the only line that needs to change — see the
# ``tests/fixtures/archive.html`` snapshot date in the test docstring for
# the latest known-good scheme.
#
# The absolute alternative is scoped to TMW's own host on purpose: the
# bare ``/tmw-`` prefix collides with cross-host URLs such as
# ``https://ctocraft.com/tmw-sponsorship/`` that appear earlier in the
# archive document than the real issue anchors and would otherwise be
# picked as the "latest issue". Relative paths resolve against the
# archive URL (which is always TMW's host), so the relative alternative
# does not need the same scoping.
_ARCHIVE_HREF_PATTERN = re.compile(
    r"^/tmw-[\w\-/]+/?$"
    r"|^https?://(?:[^/]+\.)?techmanagerweekly\.com/tmw-[\w\-/]+/?$"
)
# Article anchors inside an issue page are absolute third-party URLs
# (e.g. staysaasy.com, lethain.com, substack.com) — those hosts are
# unaffected by TMW's own URL-scheme drift, so this pattern doesn't need
# the ``tmw-`` prefix and is intentionally broad.
_ARTICLE_HREF_PATTERN = re.compile(r"^https?://[^/]+/[\w\-/]+/?$")


def _strip_tracking_query(url: str) -> str:
    """Defensive in case the parser sees URLs with tracking params."""

    parts = urlsplit(url)
    if not parts.query:
        return url
    cleaned = []
    for pair in parts.query.split("&"):
        if not pair:
            continue
        name = pair.split("=", 1)[0].lower()
        if name in {"utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "ref", "fbclid", "gclid"}:
            continue
        cleaned.append(pair)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "&".join(cleaned), parts.fragment))


def _http_or_relative(base_url: str, href: str) -> str | None:
    """Make sure an href is an http(s) URL and not a fragment or mailto."""

    parts = urlsplit(href)
    if parts.scheme in ("", "http", "https"):
        if not parts.netloc:
            # Relative URL — resolve against the base.
            base = urlsplit(base_url)
            if not href.startswith("/"):
                return None
            return urlunsplit((base.scheme, base.netloc, parts.path, parts.query, parts.fragment))
        return urlunsplit(parts)
    return None


def parse_archive(archive_url: str, body: bytes) -> LatestIssue:
    """Parse the TMW archive page and return the latest issue.

    The current public archive lists issues in chronological order. We pick
    the first anchor whose href matches the issue-path pattern and is not
    the archive itself. If no anchor matches, raise :class:`ParseError`.
    """

    soup = BeautifulSoup(body, "html.parser")
    anchors = soup.find_all("a", href=True)

    archive_parts = urlsplit(archive_url)
    archive_path = archive_parts.path.rstrip("/")

    seen: set[str] = set()
    for anchor in anchors:
        href = anchor.get("href") or ""
        if not href or href.startswith("#"):
            continue
        absolute = _http_or_relative(archive_url, href)
        if not absolute:
            continue
        clean = _strip_tracking_query(absolute)
        parts = urlsplit(clean)
        if parts.path.rstrip("/") == archive_path:
            continue
        if not _ARCHIVE_HREF_PATTERN.match(clean):
            continue
        if clean in seen:
            continue
        seen.add(clean)
        return LatestIssue(
            issue_url=clean,
            issue_title=_normalize_title(anchor.get_text(strip=True)),
            issue_published_at=anchor.get("data-published-at"),
        )

    raise ParseError(
        "ARCHIVE_NO_ISSUE",
        "archive page did not contain any recognisable issue link",
    )


def _normalize_title(raw: str | None) -> str | None:
    if not raw:
        return None
    collapsed = " ".join(raw.split())
    return collapsed or None


# Tokenlist of host fragments that should never be treated as article links.
_NEVER_LINK_HOST_HINTS = (
    "twitter.com",
    "x.com",
    "facebook.com",
    "linkedin.com",
    "instagram.com",
    "youtube.com",
    "youtu.be",
    "apple.com",
    "google.com",
    "policies.google",
    "substack.com",
    "mailchi.mp",
    "buysublands.com",
)


def _is_probably_article(href: str, anchor_text: str | None) -> bool:
    """Heuristic filter: a real article link points to a wholly different host.

    We deliberately over-include (we'd rather fan out and skip than miss).
    The article fetch node is the final say via safe_fetch and content-type
    checks.
    """

    parts = urlsplit(href)
    host = parts.netloc.lower()
    if not host:
        return False
    for hint in _NEVER_LINK_HOST_HINTS:
        if hint in host:
            return False
    if parts.path in ("", "/"):
        return False
    if not _ARTICLE_HREF_PATTERN.match(href):
        return False
    if anchor_text is not None and len(anchor_text.strip()) < 3:
        return False
    return True


def parse_issue_links(
    issue_url: str,
    body: bytes,
    *,
    max_links: int,
) -> list[dict]:
    """Parse the TMW issue page and return a deduplicated list of article links.

    Each link is a dict with ``url`` and ``title`` keys. Order is preserved
    from the source page; duplicates (after tracking-param stripping) are
    removed while keeping the first occurrence. The list is capped at
    ``max_links`` to bound runtime cost.

    Only anchors inside the article body (the first ``<article>`` element,
    or ``<main>`` if no article tag is present) are considered. Header,
    nav, footer, and aside links are deliberately excluded so sponsor,
    social, and navigation links are filtered at the source.
    """

    if max_links <= 0:
        raise ValueError("max_links must be positive")

    soup = BeautifulSoup(body, "html.parser")
    scope = soup.find("article") or soup.find("main")
    if scope is None:
        raise ParseError(
            "ISSUE_NO_ARTICLE_SCOPE",
            "issue page does not contain an <article> or <main> element",
        )
    anchors = scope.find_all("a", href=True)

    seen: set[str] = set()
    links: list[dict] = []
    for anchor in anchors:
        href = anchor.get("href") or ""
        if not href or href.startswith("#"):
            continue
        absolute = _http_or_relative(issue_url, href)
        if not absolute:
            continue
        clean = _strip_tracking_query(absolute)
        if not _is_probably_article(clean, anchor.get_text(strip=True)):
            continue
        if clean in seen:
            continue
        seen.add(clean)
        links.append({"url": clean, "title": _normalize_title(anchor.get_text(strip=True))})
        if len(links) >= max_links:
            break

    if not links:
        raise ParseError(
            "ISSUE_NO_LINKS",
            "issue page did not contain any recognisable article links",
        )

    return links


__all__ = [
    "ParseError",
    "LatestIssue",
    "parse_archive",
    "parse_issue_links",
]
