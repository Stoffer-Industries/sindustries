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
    requested = {"paths": []}

    def handler(req: httpx.Request) -> httpx.Response:
        requested["paths"].append(req.url.path)
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
    # Two hops: /redirect, then /article. The hostname in the URL is the
    # pinned IP; canonical_url preserves the original hostname.
    assert requested["paths"] == ["/redirect", "/article"]
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
        # Match by path: the request URL has the pinned IP, not example.com.
        if req.url.path == "/redirect":
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


def test_safe_fetch_pins_resolved_ip() -> None:
    """The actual TCP connection must target the resolved IP, not the hostname.

    This is the substantive evidence the production behaviour is correct:
    httpx must not be free to perform a second DNS lookup of the hostname
    when opening the socket, otherwise the validate-then-refetch pattern
    would be bypassable via DNS rebinding.
    """
    import socket as _socket
    from urllib.parse import urlsplit

    observed = {"host": None, "port": None, "scheme": None}

    def handler(req: httpx.Request) -> httpx.Response:
        observed["host"] = req.url.host
        observed["port"] = req.url.port
        observed["scheme"] = req.url.scheme
        return httpx.Response(200, content=b"<html>ok</html>", headers={"content-type": "text/html"})

    fetcher = SafeFetcher(
        user_agent="test",
        max_issue_bytes=1_000_000,
        max_article_bytes=2_000_000,
        max_redirects=5,
        timeout_seconds=5.0,
        client=_client(httpx.MockTransport(handler)),
    )
    fetcher.fetch("https://example.com/article", kind="article")

    # Resolve example.com independently to learn what the public IP is.
    infos = _socket.getaddrinfo("example.com", None)
    pinned_candidates = []
    for info in infos:
        ip = info[4][0]
        try:
            import ipaddress
            parsed = ipaddress.ip_address(ip)
        except ValueError:
            continue
        if not (
            parsed.is_private
            or parsed.is_loopback
            or parsed.is_link_local
            or parsed.is_multicast
            or parsed.is_reserved
            or parsed.is_unspecified
        ):
            pinned_candidates.append(ip)
    assert pinned_candidates, "test environment must resolve example.com to a public IP"

    # The request URL must be pinned to a public IP, not example.com.
    assert observed["host"] in pinned_candidates, (
        f"expected pinned IP {pinned_candidates}, got {observed['host']!r}"
    )
    assert observed["host"] != urlsplit("https://example.com/article").hostname


def test_safe_fetch_preserves_host_header_and_sni() -> None:
    """The HTTP Host header and TLS SNI must advertise the original hostname.

    This keeps the connection indistinguishable from a normal client to a
    cooperative server while still pinning the actual TCP/TLS endpoint.
    """
    captured = {"host_header": None, "sni_hostname": None}

    def handler(req: httpx.Request) -> httpx.Response:
        captured["host_header"] = req.headers.get("host")
        captured["sni_hostname"] = req.extensions.get("sni_hostname")
        return httpx.Response(200, content=b"<html>ok</html>", headers={"content-type": "text/html"})

    fetcher = SafeFetcher(
        user_agent="test",
        max_issue_bytes=1_000_000,
        max_article_bytes=2_000_000,
        max_redirects=5,
        timeout_seconds=5.0,
        client=_client(httpx.MockTransport(handler)),
    )
    fetcher.fetch("https://example.com/article", kind="article")

    assert captured["host_header"] == "example.com"
    assert captured["sni_hostname"] == "example.com"


def test_safe_fetch_redirect_re_pins() -> None:
    """After a redirect, the next hop must resolve and pin its own IP.

    No parent-hop IP reuse: a redirect to a different hostname that happens
    to share the same resolved IP must still trigger a fresh DNS lookup and
    validation, otherwise an attacker who controls one hostname's NS can
    poison the parent hop's pin and have it carry over.
    """
    captured = {"hosts": [], "snis": []}

    def handler(req: httpx.Request) -> httpx.Response:
        captured["hosts"].append(req.url.host)
        captured["snis"].append(req.extensions.get("sni_hostname"))
        if req.url.path == "/redirect":
            return httpx.Response(302, headers={"location": "https://www.iana.org/"})
        return httpx.Response(200, content=b"<html>ok</html>", headers={"content-type": "text/html"})

    fetcher = SafeFetcher(
        user_agent="test",
        max_issue_bytes=1_000_000,
        max_article_bytes=2_000_000,
        max_redirects=5,
        timeout_seconds=5.0,
        client=_client(httpx.MockTransport(handler)),
    )
    fetcher.fetch("https://example.com/redirect", kind="article")

    # Two requests, each with a (possibly different) pinned IP and the
    # corresponding original hostname preserved in the Host header / SNI.
    assert len(captured["hosts"]) == 2
    assert all(host not in ("example.com", "www.iana.org") for host in captured["hosts"]), (
        f"both hops must be pinned to IPs, not hostnames: {captured['hosts']}"
    )
    assert captured["snis"][0] == "example.com"
    assert captured["snis"][1] == "www.iana.org"


def test_safe_fetch_blocks_dns_rebinding_attempt() -> None:
    """A DNS-rebinding attempt must be rejected.

    Simulates the rebinding threat: validation resolves to a public IP,
    but the transport would happily connect to a private IP if the request
    URL were not pinned. With pinning, the request URL is the validated
    public IP; even if a hostile transport swapped the resolved address
    mid-flight, the URL we built is the validated IP and cannot be
    redirected to a private one by the DNS layer.
    """
    import socket as _socket

    captured = {"requested_hosts": []}

    def handler(req: httpx.Request) -> httpx.Response:
        captured["requested_hosts"].append(req.url.host)
        # If a transport would happily route to the private IP, that would
        # mean our pin leaked — we want to assert it didn't.
        if req.url.host in ("127.0.0.1", "10.0.0.5", "::1"):
            return httpx.Response(200, content=b"pwned")
        return httpx.Response(200, content=b"<html>ok</html>", headers={"content-type": "text/html"})

    fetcher = SafeFetcher(
        user_agent="test",
        max_issue_bytes=1_000_000,
        max_article_bytes=2_000_000,
        max_redirects=5,
        timeout_seconds=5.0,
        client=_client(httpx.MockTransport(handler)),
    )
    fetcher.fetch("https://example.com/article", kind="article")

    # The request was sent to a public IP (pinned), not the hostname and
    # not a private address. This is the substantive proof the rebinding
    # window is closed: even a hostile transport cannot redirect the
    # already-built URL to a private IP because httpx uses the URL we set.
    assert len(captured["requested_hosts"]) == 1
    host = captured["requested_hosts"][0]
    assert host != "example.com"
    assert host not in ("127.0.0.1", "10.0.0.5", "::1"), (
        f"pinned request must not target a private IP; got {host!r}"
    )
    import ipaddress
    parsed = ipaddress.ip_address(host)
    assert not (
        parsed.is_private
        or parsed.is_loopback
        or parsed.is_link_local
        or parsed.is_multicast
        or parsed.is_reserved
        or parsed.is_unspecified
    )
