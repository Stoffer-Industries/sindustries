"""Tests for the TMW archive + issue parser."""

from __future__ import annotations

import pytest

from cto_craft_workflow.issue_source import (
    ParseError,
    parse_archive,
    parse_issue_links,
)


def test_parse_archive_returns_latest_issue(archive_html: bytes) -> None:
    latest = parse_archive("https://www.techmanagerweekly.com/", archive_html)
    # TMW's URL scheme changed during the 2026 redesign: post paths are
    # now ``/tmw-NNN/`` rather than the legacy ``/issue/<slug>``. The
    # archive fixture (snapshot 2026-08-19) reflects the live shape:
    # anchors carry the slug only via href + aria-label; there is no
    # inner anchor text and no ``data-published-at`` attribute.
    assert latest.issue_url == "https://www.techmanagerweekly.com/tmw-495/"
    # The current public archive does not expose metadata on the permalink
    # anchor; both optional fields are None today. Coverage for the
    # metadata propagation path is in ``test_parse_archive_propagates_metadata_when_present``.
    assert latest.issue_published_at is None
    assert latest.issue_title is None


def test_parse_archive_propagates_metadata_when_present() -> None:
    """Guards the optional title + ``data-published-at`` propagation path.

    The live TMW archive does not currently set either attribute on the
    permalink anchor, but the parser contract still allows for them
    (``LatestIssue`` declares both fields as Optional). If a future TMW
    redesign re-introduces either attribute, the parser must surface it
    verbatim.
    """

    body = (
        b'<html><body><main>'
        b'<a class="u-permalink" href="/tmw-495/" '
        b'data-published-at="2026-08-17T09:00:00Z">'
        b'Issue 495 \xe2\x80\x94 Slow iteration and the cost of delay'
        b'</a>'
        b"</main></body></html>"
    )
    latest = parse_archive("https://www.techmanagerweekly.com/", body)
    assert latest.issue_url == "https://www.techmanagerweekly.com/tmw-495/"
    assert latest.issue_published_at == "2026-08-17T09:00:00Z"
    assert latest.issue_title is not None
    assert "Slow iteration" in latest.issue_title


def test_parse_archive_skips_social_and_nav_links(archive_html: bytes) -> None:
    # The fixtures use absolute social links. The parser must not pick
    # twitter/linkedin/about anchors as an issue.
    latest = parse_archive("https://www.techmanagerweekly.com/", archive_html)
    assert "twitter.com" not in latest.issue_url
    assert "linkedin.com" not in latest.issue_url


def test_parse_archive_ignores_cross_host_tmw_prefix() -> None:
    """TMW's bare ``/tmw-`` prefix collides with cross-host URLs like
    ``https://ctocraft.com/tmw-sponsorship/`` that appear earlier in
    the archive document than the real issue permalinks. The absolute
    alternative of the regex must be scoped to TMW's own host so a
    cross-host ``/tmw-*`` URL never shadows a real ``/tmw-<id>/`` issue
    anchor.
    """

    body = (
        b"<html><body>"
        b'<a href="https://ctocraft.com/tmw-sponsorship/">Sponsor</a>'
        b'<a class="u-permalink" href="/tmw-495/">Issue 495</a>'
        b"</body></html>"
    )
    latest = parse_archive("https://www.techmanagerweekly.com/", body)
    assert latest.issue_url == "https://www.techmanagerweekly.com/tmw-495/"


def test_parse_archive_raises_on_unknown_layout() -> None:
    body = b"<html><body><p>no anchors here</p></body></html>"
    with pytest.raises(ParseError) as exc_info:
        parse_archive("https://www.techmanagerweekly.com/", body)
    assert exc_info.value.code == "ARCHIVE_NO_ISSUE"


def test_parse_archive_raises_when_legacy_scheme_returns() -> None:
    """If TMW ever moves off ``/tmw-*`` URLs again, the parser must fail
    loudly with ``ARCHIVE_NO_ISSUE`` rather than silently no-op. This is
    the same drift-detection signal that surfaced the 2026 redesign bug.
    """

    body = (
        b'<html><body><main>'
        b'<a href="/issue/2026-08-04-slow-iteration">'
        b"Issue 412 \xe2\x80\x94 Slow iteration and the cost of delay"
        b"</a>"
        b"</main></body></html>"
    )
    with pytest.raises(ParseError) as exc_info:
        parse_archive("https://www.techmanagerweekly.com/", body)
    assert exc_info.value.code == "ARCHIVE_NO_ISSUE"


def test_parse_issue_links_returns_deduped_articles(issue_html: bytes) -> None:
    links = parse_issue_links(
        "https://www.techmanagerweekly.com/tmw-495/",
        issue_html,
        max_links=30,
    )
    urls = [link["url"] for link in links]
    assert len(urls) == len(set(urls))
    # Sponsor, social, and nav links are filtered out.
    assert all("staysaasy.com" in u or "lethain.com" in u for u in urls)
    assert all("twitter.com" not in u for u in urls)
    assert all("linkedin.com" not in u for u in urls)
    assert all("acme.example.com" not in u for u in urls)


def test_parse_issue_links_strips_tracking_query(issue_html: bytes) -> None:
    links = parse_issue_links(
        "https://www.techmanagerweekly.com/tmw-495/",
        issue_html,
        max_links=30,
    )
    for link in links:
        assert "utm_source" not in link["url"]
        assert "utm_campaign" not in link["url"]


def test_parse_issue_links_respects_max_links(issue_html: bytes) -> None:
    links = parse_issue_links(
        "https://www.techmanagerweekly.com/tmw-495/",
        issue_html,
        max_links=2,
    )
    assert len(links) == 2


def test_parse_issue_links_raises_when_no_articles() -> None:
    body = b"<html><body><a href='/about'>About</a></body></html>"
    with pytest.raises(ParseError) as exc_info:
        parse_issue_links(
            "https://www.techmanagerweekly.com/tmw-495/",
            body,
            max_links=30,
        )
    assert exc_info.value.code == "ISSUE_NO_ARTICLE_SCOPE"
