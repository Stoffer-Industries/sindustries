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
    assert latest.issue_url.endswith("/issue/2026-08-04-slow-iteration")
    assert latest.issue_published_at == "2026-08-04T09:00:00Z"
    assert latest.issue_title is not None
    assert "412" in latest.issue_title


def test_parse_archive_skips_social_and_nav_links(archive_html: bytes) -> None:
    # The fixtures use absolute social links. The parser must not pick
    # twitter/linkedin/about anchors as an issue.
    latest = parse_archive("https://www.techmanagerweekly.com/", archive_html)
    assert "twitter.com" not in latest.issue_url
    assert "linkedin.com" not in latest.issue_url


def test_parse_archive_raises_on_unknown_layout() -> None:
    body = b"<html><body><p>no anchors here</p></body></html>"
    with pytest.raises(ParseError) as exc_info:
        parse_archive("https://www.techmanagerweekly.com/", body)
    assert exc_info.value.code == "ARCHIVE_NO_ISSUE"


def test_parse_issue_links_returns_deduped_articles(issue_html: bytes) -> None:
    links = parse_issue_links(
        "https://www.techmanagerweekly.com/issue/2026-08-04-slow-iteration",
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
        "https://www.techmanagerweekly.com/issue/2026-08-04-slow-iteration",
        issue_html,
        max_links=30,
    )
    for link in links:
        assert "utm_source" not in link["url"]
        assert "utm_campaign" not in link["url"]


def test_parse_issue_links_respects_max_links(issue_html: bytes) -> None:
    links = parse_issue_links(
        "https://www.techmanagerweekly.com/issue/2026-08-04-slow-iteration",
        issue_html,
        max_links=2,
    )
    assert len(links) == 2


def test_parse_issue_links_raises_when_no_articles() -> None:
    body = b"<html><body><a href='/about'>About</a></body></html>"
    with pytest.raises(ParseError) as exc_info:
        parse_issue_links(
            "https://www.techmanagerweekly.com/issue/2026-08-04-slow-iteration",
            body,
            max_links=30,
        )
    assert exc_info.value.code == "ISSUE_NO_ARTICLE_SCOPE"
