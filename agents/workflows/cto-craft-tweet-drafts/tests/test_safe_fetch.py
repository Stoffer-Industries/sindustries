"""Tests for the SSRF-safe HTTP fetcher."""

from __future__ import annotations

import httpx
import pytest

from cto_craft_workflow.safe_fetch import FetchError, SafeFetcher


def _client(transport: httpx.BaseTransport) -> httpx.Client:
    return httpx.Client(timeout=httpx.Timeout(5.0), transport=transport, follow_redirects=False)


def test_safe_fetch_returns_resource_for_valid_url(archive_html: bytes) -> None:
    t = httpx.MockTransport(lambda req: httpx.Response(200, content=archive_html, headers={"content-type": "text/html; charset=utf-8"}))
    fetcher = SafeFetcher(
        user_agent="test",
        max_issue_bytes=1_000_000,
        max_article_bytes=2_000_000,
        max_redirects=5,
        timeout_seconds=5.0,
        client=_client(t),
    )
    resource = fetcher.fetch("https://www.techmanagerweekly.com/", kind="issue")
    assert resource.body == archive_html
    assert resource.content_type.startswith("text/html")


def test_safe_fetch_rejects_non_http_scheme() -> None:
    fetcher = SafeFetcher(
        user_agent="test",
        max_issue_bytes=1_000_000,
        max_article_bytes=2_000_000,
        max_redirects=5,
        timeout_seconds=5.0,
        client=_client(httpx.MockTransport(lambda req: httpx.Response(200))),
    )
    with pytest.raises(FetchError) as exc_info:
        fetcher.fetch("file:///etc/passwd", kind="issue")
    assert exc_info.value.code == "UNSAFE_SCHEME"


def test_safe_fetch_rejects_embedded_credentials() -> None:
    fetcher = SafeFetcher(
        user_agent="test",
        max_issue_bytes=1_000_000,
        max_article_bytes=2_000_000,
        max_redirects=5,
        timeout_seconds=5.0,
        client=_client(httpx.MockTransport(lambda req: httpx.Response(200))),
    )
    with pytest.raises(FetchError) as exc_info:
        fetcher.fetch("https://user:pass@example.com/", kind="issue")
    assert exc_info.value.code == "UNSAFE_URL"


def test_safe_fetch_rejects_loopback_host() -> None:
    fetcher = SafeFetcher(
        user_agent="test",
        max_issue_bytes=1_000_000,
        max_article_bytes=2_000_000,
        max_redirects=5,
        timeout_seconds=5.0,
        client=_client(httpx.MockTransport(lambda req: httpx.Response(200))),
    )
    with pytest.raises(FetchError) as exc_info:
        fetcher.fetch("http://localhost:8080/", kind="issue")
    assert exc_info.value.code == "SSRF_BLOCKED"


def test_safe_fetch_rejects_private_ip() -> None:
    fetcher = SafeFetcher(
        user_agent="test",
        max_issue_bytes=1_000_000,
        max_article_bytes=2_000_000,
        max_redirects=5,
        timeout_seconds=5.0,
        client=_client(httpx.MockTransport(lambda req: httpx.Response(200))),
    )
    with pytest.raises(FetchError) as exc_info:
        fetcher.fetch("http://10.0.0.5/", kind="issue")
    assert exc_info.value.code == "SSRF_BLOCKED"


def test_safe_fetch_strips_tracking_query_on_canonical_url() -> None:
    body = b"<html><body>ok</body></html>"
    t = httpx.MockTransport(lambda req: httpx.Response(200, content=body, headers={"content-type": "text/html"}))
    fetcher = SafeFetcher(
        user_agent="test",
        max_issue_bytes=1_000_000,
        max_article_bytes=2_000_000,
        max_redirects=5,
        timeout_seconds=5.0,
        client=_client(t),
    )
    resource = fetcher.fetch("https://example.com/article?utm_source=tmw&id=42", kind="article")
    assert "utm_source" not in resource.url
    assert "id=42" in resource.url


def test_safe_fetch_enforces_size_cap() -> None:
    too_big = b"x" * 10
    t = httpx.MockTransport(lambda req: httpx.Response(200, content=too_big, headers={"content-type": "text/html"}))
    fetcher = SafeFetcher(
        user_agent="test",
        max_issue_bytes=5,
        max_article_bytes=5,
        max_redirects=5,
        timeout_seconds=5.0,
        client=_client(t),
    )
    with pytest.raises(FetchError) as exc_info:
        fetcher.fetch("https://example.com/article", kind="issue")
    assert exc_info.value.code == "RESPONSE_TOO_LARGE"


def test_safe_fetch_rejects_unsupported_content_type() -> None:
    t = httpx.MockTransport(lambda req: httpx.Response(200, content=b"data", headers={"content-type": "application/octet-stream"}))
    fetcher = SafeFetcher(
        user_agent="test",
        max_issue_bytes=1_000_000,
        max_article_bytes=2_000_000,
        max_redirects=5,
        timeout_seconds=5.0,
        client=_client(t),
    )
    with pytest.raises(FetchError) as exc_info:
        fetcher.fetch("https://example.com/file", kind="issue")
    assert exc_info.value.code == "UNSUPPORTED_CONTENT_TYPE"


def test_safe_fetch_follows_redirect_with_revalidation() -> None:
    body = b"<html><body>ok</body></html>"
    target = "https://example.com/article"
    requested = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        requested["n"] += 1
        if req.url.path == "/redirect":
            return httpx.Response(302, headers={"location": target})
        return httpx.Response(200, content=body, headers={"content-type": "text/html"})

    t = httpx.MockTransport(handler)
    fetcher = SafeFetcher(
        user_agent="test",
        max_issue_bytes=1_000_000,
        max_article_bytes=2_000_000,
        max_redirects=5,
        timeout_seconds=5.0,
        client=_client(t),
    )
    resource = fetcher.fetch("https://example.com/redirect", kind="article")
    assert requested["n"] == 2
    assert resource.url == target


def test_safe_fetch_caps_redirect_count() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": f"https://example.com/loop?n={req.url.params.get('n', 0)}"})

    fetcher = SafeFetcher(
        user_agent="test",
        max_issue_bytes=1_000_000,
        max_article_bytes=2_000_000,
        max_redirects=2,
        timeout_seconds=5.0,
        client=_client(httpx.MockTransport(handler)),
    )
    with pytest.raises(FetchError) as exc_info:
        fetcher.fetch("https://example.com/loop", kind="issue")
    assert exc_info.value.code == "TOO_MANY_REDIRECTS"


def test_safe_fetch_rejects_redirect_to_private_ip() -> None:
    target = "http://10.0.0.5/"

    def handler(req: httpx.Request) -> httpx.Response:
        if str(req.url) == "https://example.com/redirect":
            return httpx.Response(302, headers={"location": target})
        return httpx.Response(200, content=b"x", headers={"content-type": "text/html"})

    fetcher = SafeFetcher(
        user_agent="test",
        max_issue_bytes=1_000_000,
        max_article_bytes=2_000_000,
        max_redirects=5,
        timeout_seconds=5.0,
        client=_client(httpx.MockTransport(handler)),
    )
    with pytest.raises(FetchError) as exc_info:
        fetcher.fetch("https://example.com/redirect", kind="issue")
    assert exc_info.value.code == "SSRF_BLOCKED"
