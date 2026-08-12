"""Tests for the article text extractor."""

from __future__ import annotations

import pytest

from cto_craft_workflow.article_extract import extract_article
from cto_craft_workflow.state import MAX_ARTICLE_TEXT_CHARS


def test_extract_article_returns_canonical_url(article_strong_html: bytes) -> None:
    extracted = extract_article(
        "https://staysaasy.com/p/slow-iteration?utm_source=tmw",
        article_strong_html,
    )
    assert extracted.canonical_url == "https://staysaasy.com/p/slow-iteration"
    assert extracted.title == "Slow iteration is paid for by the team closest to the user"
    assert extracted.author == "Will Larson"
    assert extracted.char_count > 200


def test_extract_article_strips_scripts_and_styles(article_strong_html: bytes) -> None:
    extracted = extract_article(
        "https://staysaasy.com/p/slow-iteration",
        article_strong_html,
    )
    assert "analytics.js" not in extracted.text
    assert "display: none" not in extracted.text


def test_extract_article_drops_footer_and_nav(article_strong_html: bytes) -> None:
    extracted = extract_article(
        "https://staysaasy.com/p/slow-iteration",
        article_strong_html,
    )
    # The fixture has a footer link to twitter; the footer text should not
    # be in the extracted article.
    assert "Twitter" not in extracted.text.split("\n\n")[0]


def test_extract_article_handles_gated_as_short(article_gated_html: bytes) -> None:
    extracted = extract_article(
        "https://example.com/article",
        article_gated_html,
    )
    # The gated fixture is intentionally short.
    assert extracted.char_count < 200


def test_extract_article_bounds_long_text() -> None:
    body = (
        b"<html><body><article>"
        + b"<p>" + (b"word " * 8000) + b"</p>"
        + b"</article></body></html>"
    )
    extracted = extract_article("https://example.com/x", body)
    assert extracted.char_count <= MAX_ARTICLE_TEXT_CHARS
    assert "[truncated]" in extracted.text


def test_extract_article_handles_missing_article_tag() -> None:
    body = b"<html><body><p>One short paragraph only.</p></body></html>"
    extracted = extract_article("https://example.com/x", body)
    assert extracted.text == "One short paragraph only."
    assert extracted.canonical_url == "https://example.com/x"
