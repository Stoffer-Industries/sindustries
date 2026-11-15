"""Tests for the curl-backed pinned-IP transport."""

from __future__ import annotations

import subprocess
from types import SimpleNamespace

import pytest

from cto_craft_workflow.safe_fetch import (
    CurlTransport,
    FetchError,
    SafeFetcher,
    TransportResponse,
)


def _transport(binary: str = "curl") -> CurlTransport:
    return CurlTransport(user_agent="test-agent", timeout_seconds=5.0, binary=binary)


def test_curl_argv_preserves_pinning_and_security_invariants(monkeypatch) -> None:
    captured = {}

    def fake_run(argv, **kwargs):
        captured["argv"] = argv
        captured["kwargs"] = kwargs
        header_path = argv[argv.index("--dump-header") + 1]
        body_path = argv[argv.index("--output") + 1]
        with open(header_path, "w", encoding="utf-8") as handle:
            handle.write("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n")
        with open(body_path, "wb") as handle:
            handle.write(b"ok")
        return subprocess.CompletedProcess(argv, 0, stdout=b"200", stderr=b"")

    monkeypatch.setattr(subprocess, "run", fake_run)

    response = _transport().fetch(
        url="https://example.com/article?secret=query",
        hostname="example.com",
        pinned_ip="93.184.216.34",
        max_bytes=1024,
    )

    argv = captured["argv"]
    assert "--resolve" in argv
    assert argv[argv.index("--resolve") + 1] == "example.com:443:93.184.216.34"
    assert "--location" not in argv
    assert "-L" not in argv
    assert argv[argv.index("--max-redirs") + 1] == "0"
    assert "--insecure" not in argv
    assert "-k" not in argv
    assert "--cacert" not in argv
    assert "--cookie" not in argv
    assert "-b" not in argv
    assert "-u" not in argv
    assert "--oauth2-bearer" not in argv
    assert "--max-filesize" in argv
    assert argv[argv.index("--max-filesize") + 1] == "1024"
    assert "--connect-timeout" in argv
    assert argv[argv.index("--connect-timeout") + 1] == "5"
    assert "--max-time" in argv
    assert argv[argv.index("--max-time") + 1] == "5"
    assert argv[argv.index("--proto") + 1] == "=http,https"
    assert captured["kwargs"]["shell"] if "shell" in captured["kwargs"] else False is False
    assert response.status_code == 200
    assert response.body == b"ok"
    assert response.headers["content-type"] == "text/html"


def test_curl_exit_47_with_captured_redirect_is_a_response(monkeypatch) -> None:
    def fake_run(argv, **kwargs):
        header_path = argv[argv.index("--dump-header") + 1]
        body_path = argv[argv.index("--output") + 1]
        with open(header_path, "w", encoding="utf-8") as handle:
            handle.write(
                "HTTP/1.1 302 Found\r\nLocation: https://example.org/next\r\n\r\n"
            )
        with open(body_path, "wb") as handle:
            handle.write(b"")
        return subprocess.CompletedProcess(argv, 47, stdout=b"302", stderr=b"")

    monkeypatch.setattr(subprocess, "run", fake_run)

    response = _transport().fetch(
        url="https://example.com/redirect",
        hostname="example.com",
        pinned_ip="93.184.216.34",
        max_bytes=1024,
    )

    assert response.status_code == 302
    assert response.headers["location"] == "https://example.org/next"


def test_curl_rejects_non_public_pinned_address_before_running(monkeypatch) -> None:
    called = False

    def fake_run(*args, **kwargs):
        nonlocal called
        called = True
        raise AssertionError("curl must not run for a non-public address")

    monkeypatch.setattr(subprocess, "run", fake_run)

    with pytest.raises(FetchError) as exc_info:
        _transport().fetch(
            url="https://example.com/",
            hostname="example.com",
            pinned_ip="100.64.0.1",
            max_bytes=1024,
        )

    assert exc_info.value.code == "SSRF_BLOCKED"
    assert called is False


def test_curl_missing_binary_reports_unavailable(monkeypatch) -> None:
    monkeypatch.setattr("cto_craft_workflow.safe_fetch.shutil.which", lambda _: None)

    with pytest.raises(FetchError) as exc_info:
        _transport().fetch(
            url="https://example.com/",
            hostname="example.com",
            pinned_ip="93.184.216.34",
            max_bytes=1024,
        )

    assert exc_info.value.code == "TRANSPORT_UNAVAILABLE"


def test_redirect_is_revalidated_and_repins_in_python(monkeypatch) -> None:
    resolutions = []

    def resolve(host, url):
        resolutions.append(host)
        if host == "example.com":
            return "93.184.216.34"
        return "93.184.216.35"

    monkeypatch.setattr(
        "cto_craft_workflow.safe_fetch._resolve_and_validate_ip",
        resolve,
    )

    requested_hosts = []

    def handler(request):
        requested_hosts.append(request.url.host)
        if len(requested_hosts) == 1:
            return __import__("httpx").Response(
                302,
                headers={"location": "https://other.example/next"},
            )
        return __import__("httpx").Response(
            200,
            content=b"ok",
            headers={"content-type": "text/html"},
        )

    fetcher = SafeFetcher(
        user_agent="test",
        max_issue_bytes=1024,
        max_article_bytes=1024,
        max_redirects=5,
        timeout_seconds=5.0,
        client=__import__("httpx").Client(
            transport=__import__("httpx").MockTransport(handler)
        ),
    )

    resource = fetcher.fetch("https://example.com/start", kind="issue")

    assert resource.body == b"ok"
    assert resolutions == ["example.com", "other.example"]
    assert requested_hosts == ["93.184.216.34", "93.184.216.35"]


def test_curl_python_cap_rejects_oversized_chunked_body(monkeypatch) -> None:
    def fake_run(argv, **kwargs):
        header_path = argv[argv.index("--dump-header") + 1]
        body_path = argv[argv.index("--output") + 1]
        with open(header_path, "w", encoding="utf-8") as handle:
            handle.write("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n")
        with open(body_path, "wb") as handle:
            handle.write(b"x" * 2048)
        return subprocess.CompletedProcess(argv, 0, stdout=b"200", stderr=b"")

    monkeypatch.setattr(subprocess, "run", fake_run)

    with pytest.raises(FetchError) as exc_info:
        _transport().fetch(
            url="https://example.com/chunked",
            hostname="example.com",
            pinned_ip="93.184.216.34",
            max_bytes=1024,
        )

    assert exc_info.value.code == "RESPONSE_TOO_LARGE"


def test_curl_stderr_is_not_included_in_error(monkeypatch) -> None:
    def fake_run(argv, **kwargs):
        return subprocess.CompletedProcess(
            argv,
            7,
            stdout=b"",
            stderr=b"failed to fetch https://example.com/?secret=do-not-leak",
        )

    monkeypatch.setattr(subprocess, "run", fake_run)

    with pytest.raises(FetchError) as exc_info:
        _transport().fetch(
            url="https://example.com/?secret=do-not-leak",
            hostname="example.com",
            pinned_ip="93.184.216.34",
            max_bytes=1024,
        )

    assert exc_info.value.code == "TRANSPORT_ERROR"
    assert "do-not-leak" not in exc_info.value.message
    assert exc_info.value.url == "https://example.com/"


def test_curl_does_not_accept_auth_or_cookie_flags(monkeypatch) -> None:
    captured = {}

    def fake_run(argv, **kwargs):
        captured["argv"] = argv
        return subprocess.CompletedProcess(argv, 0, stdout=b"200", stderr=b"")

    monkeypatch.setattr(subprocess, "run", fake_run)

    _transport().fetch(
        url="https://example.com/",
        hostname="example.com",
        pinned_ip="93.184.216.34",
        max_bytes=1024,
    )

    argv = captured["argv"]
    assert not {"--cookie", "-b", "-c", "-u", "--user", "--oauth2-bearer"} & set(argv)
    header_values = [argv[index + 1] for index, value in enumerate(argv[:-1]) if value == "--header"]
    assert all(not value.lower().startswith("authorization:") for value in header_values)
