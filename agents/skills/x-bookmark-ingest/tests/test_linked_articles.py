import json
import os
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[4]
PROCESS_SCRIPT = REPO_ROOT / "agents/skills/x-bookmark-ingest/scripts/x/process.cjs"
FETCH_SCRIPT = REPO_ROOT / "agents/skills/x-bookmark-ingest/scripts/x/fetch.cjs"
EXTRACT_SCRIPT = REPO_ROOT / "agents/skills/x-bookmark-ingest/scripts/x/lib/extract_article.cjs"
FIXTURES = Path(__file__).parent / "fixtures"


class FixtureHandler(BaseHTTPRequestHandler):
    routes = {}

    def do_GET(self):
        status, content_type, body = self.routes.get(
            self.path,
            (404, "text/html; charset=utf-8", b"<title>Missing</title>not found"),
        )
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


@pytest.fixture
def article_server():
    FixtureHandler.routes = {
        "/clean": (
            200,
            "text/html; charset=utf-8",
            (FIXTURES / "clean_article.html").read_bytes(),
        ),
        "/noisy": (
            200,
            "application/xhtml+xml",
            (FIXTURES / "script_heavy.html").read_bytes(),
        ),
        "/paywall": (
            200,
            "text/html",
            (FIXTURES / "paywall_stub.html").read_bytes(),
        ),
        "/document.pdf": (200, "application/pdf", b"%PDF-1.7 fake"),
        "/missing": (404, "text/html", b"<title>Missing</title>not found"),
    }
    server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        thread.join()


def run_node(source, *, env=None):
    result = subprocess.run(
        ["node", "-e", source],
        cwd=REPO_ROOT,
        env={**os.environ, **(env or {})},
        text=True,
        capture_output=True,
        check=True,
    )
    return result


def fetch_article(url):
    source = (
        f"const p = require({json.dumps(str(PROCESS_SCRIPT))});"
        f"p.fetchLinkedArticle({json.dumps(url)})"
        ".then(value => console.log(JSON.stringify(value)));"
    )
    result = run_node(source)
    return json.loads(result.stdout.strip().splitlines()[-1])


def enrich_quoted_articles(bookmarks, response, *, ok=True):
    source = (
        f"const f = require({json.dumps(str(FETCH_SCRIPT))});"
        f"const bookmarks = {json.dumps(bookmarks)};"
        "global.fetch = async () => ({"
        f"ok: {json.dumps(ok)},"
        f"json: async () => ({json.dumps(response)})"
        "});"
        "f.enrichQuotedTweetArticles(bookmarks, 'test-token')"
        ".then(value => console.log(JSON.stringify(value)));"
    )
    return run_node(source)


def test_clean_article_title_and_body_are_extracted(article_server):
    result = fetch_article(f"{article_server}/clean")

    assert result["title"] == "Clean & Useful Article"
    assert "durable bookmark archive" in result["article"]["body"]
    assert "preserves the original context" in result["article"]["body"]
    assert "display: none" not in result["article"]["body"]


def test_script_heavy_page_has_no_article_body(article_server):
    result = fetch_article(f"{article_server}/noisy")

    assert result["title"] == "Application Shell"
    assert result["article"] is None
    assert result["error"] == "body extraction returned no text"


def test_short_paywall_stub_is_kept(article_server):
    result = fetch_article(f"{article_server}/paywall")

    assert "Subscriber Analysis" in result["article"]["body"]
    assert "available to subscribers" in result["article"]["body"]


@pytest.mark.parametrize(
    ("path", "expected_error"),
    [
        ("/missing", "HTTP 404"),
        ("/document.pdf", "unsupported Content-Type application/pdf"),
    ],
)
def test_failed_or_non_html_fetch_skips_body(article_server, path, expected_error):
    result = fetch_article(f"{article_server}{path}")

    assert result["article"] is None
    assert result["error"] == expected_error


def test_bookmark_omits_linked_article_section_on_fetch_failure(
    article_server, tmp_path
):
    acpx = tmp_path / "fake-acpx"
    acpx.write_text("#!/bin/sh\necho '{\"tags\":[\"testing\",\"bookmarks\"]}'\n")
    acpx.chmod(0o755)
    workspace = tmp_path / "workspace"
    bookmark = {
        "id": "12345",
        "url": f"{article_server}/missing",
        "text": "A missing article",
    }
    source = (
        f"const p = require({json.dumps(str(PROCESS_SCRIPT))});"
        f"p.processBookmark({json.dumps(bookmark)})"
        ".then(() => console.log('done'));"
    )

    run_node(
        source,
        env={
            "OPENCLAW_WORKSPACE": str(workspace),
            "OPENCLAW_STATE_DIR": str(workspace / "brain/state"),
            "BOOKMARK_LLM_ACPX_COMMAND": str(acpx),
        },
    )

    output = (
        workspace / "brain/bookmarks/x/a-missing-article.md"
    ).read_text()
    assert "**Original Tweet:**\nA missing article" in output
    assert "**Linked Article:**" not in output


def test_bookmark_includes_linked_article_and_respects_body_limit(
    article_server, tmp_path
):
    acpx = tmp_path / "fake-acpx"
    acpx.write_text("#!/bin/sh\necho '{\"tags\":[\"testing\",\"bookmarks\"]}'\n")
    acpx.chmod(0o755)
    workspace = tmp_path / "workspace"
    bookmark = {
        "id": "67890",
        "url": f"{article_server}/clean",
        "text": "Archive the source material",
    }
    source = (
        f"const p = require({json.dumps(str(PROCESS_SCRIPT))});"
        f"p.processBookmark({json.dumps(bookmark)})"
        ".then(() => console.log('done'));"
    )

    run_node(
        source,
        env={
            "OPENCLAW_WORKSPACE": str(workspace),
            "OPENCLAW_STATE_DIR": str(workspace / "brain/state"),
            "BOOKMARK_LLM_ACPX_COMMAND": str(acpx),
            "BOOKMARK_INGEST_MAX_BODY_BYTES": "120",
        },
    )

    output = (
        workspace / "brain/bookmarks/x/clean-useful-article.md"
    ).read_text()
    assert "**Linked Article:**" in output
    assert f"Source: {article_server}/clean" in output
    assert "Domain: 127.0.0.1" in output
    assert "...[truncated]" in output


def test_extractor_decodes_common_and_numeric_entities():
    html = "<main><p>Rock &amp; roll &#8212; &#x1F680;</p></main>"
    source = (
        f"const e = require({json.dumps(str(EXTRACT_SCRIPT))});"
        f"console.log(e.extractArticleText({json.dumps(html)}));"
    )

    result = run_node(source)

    assert result.stdout.strip() == "Rock & roll — 🚀"


def test_utf8_body_truncation_never_exceeds_byte_limit():
    source = (
        f"const e = require({json.dumps(str(EXTRACT_SCRIPT))});"
        "const value = e.truncateUtf8('🚀'.repeat(100), 37);"
        "console.log(JSON.stringify({value, bytes: Buffer.byteLength(value, 'utf8')}));"
    )

    result = run_node(source)
    payload = json.loads(result.stdout)

    assert payload["bytes"] <= 37
    assert payload["value"].endswith("...[truncated]")


def test_article_body_is_passed_to_llm_within_combined_cap(tmp_path):
    acpx = tmp_path / "capture-acpx"
    captured = tmp_path / "prompt.txt"
    acpx.write_text(
        "#!/bin/sh\n"
        'tee "$CAPTURE_FILE" >/dev/null\n'
        "echo '{\"tags\":[\"article-context\"]}'\n"
    )
    acpx.chmod(0o755)
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    source = (
        f"const p = require({json.dumps(str(PROCESS_SCRIPT))});"
        "p.generateMetadata("
        "'https://example.com/article',"
        "'tweet context',"
        "false,"
        "{body: 'article body detail '.repeat(100)},"
        "'Article Title'"
        ").then(value => console.log(JSON.stringify(value)));"
    )

    run_node(
        source,
        env={
            "OPENCLAW_WORKSPACE": str(workspace),
            "BOOKMARK_LLM_ACPX_COMMAND": str(acpx),
            "BOOKMARK_LLM_MAX_CHARS": "240",
            "CAPTURE_FILE": str(captured),
        },
    )

    prompt = captured.read_text()
    contextual_text = prompt.split("Title: Article Title\n", 1)[1]
    assert "Tweet Text:\ntweet context" in contextual_text
    assert "Linked Article:" in contextual_text
    assert len(contextual_text) <= 240


def test_quoted_tweet_article_is_extracted():
    bookmark = json.loads((FIXTURES / "quoted_article_tweet.json").read_text())
    response = json.loads((FIXTURES / "quoted_article_response.json").read_text())

    result = enrich_quoted_articles([bookmark], response)
    enriched = json.loads(result.stdout.strip().splitlines()[-1])[0]

    assert enriched["linkedArticle"]["body"] == response["data"]["article"]["plain_text"]
    assert enriched["linkedArticle"]["source"] == "quoted-tweet"
    assert enriched["linkedArticle"]["title"] == response["data"]["article"]["title"]


def test_quoted_article_does_not_override_direct_article():
    bookmark = json.loads((FIXTURES / "quoted_article_tweet.json").read_text())
    bookmark["article"] = {
        "title": "Primary article",
        "plain_text": "The bookmarked tweet's own article body.",
    }
    response = json.loads((FIXTURES / "quoted_article_response.json").read_text())

    result = enrich_quoted_articles([bookmark], response)
    enriched = json.loads(result.stdout.strip().splitlines()[-1])[0]

    assert "linkedArticle" not in enriched
    assert enriched["article"]["title"] == "Primary article"


def test_quoted_tweet_api_failure_falls_back_safely():
    bookmark = json.loads((FIXTURES / "quoted_article_tweet.json").read_text())

    result = enrich_quoted_articles([bookmark], {}, ok=False)
    enriched = json.loads(result.stdout.strip().splitlines()[-1])[0]

    assert "linkedArticle" not in enriched
    assert enriched["text"] == bookmark["text"]
    assert "Quoted tweet article lookup skipped" in result.stderr


def test_process_writes_quoted_article_section(tmp_path):
    acpx = tmp_path / "fake-acpx"
    acpx.write_text("#!/bin/sh\necho '{\"tags\":[\"testing\",\"bookmarks\"]}'\n")
    acpx.chmod(0o755)
    workspace = tmp_path / "workspace"
    response = json.loads((FIXTURES / "quoted_article_response.json").read_text())
    article = response["data"]["article"]
    bookmark = {
        "id": "2063272524927103459",
        "text": "Quoted article context",
        "linkedArticle": {
            "title": article["title"],
            "body": article["plain_text"],
            "source": "quoted-tweet",
            "sourceUrl": "https://x.com/i/article/2063186252606865711",
        },
    }
    source = (
        f"const p = require({json.dumps(str(PROCESS_SCRIPT))});"
        f"p.processBookmark({json.dumps(bookmark)})"
        ".then(() => console.log('done'));"
    )

    run_node(
        source,
        env={
            "OPENCLAW_WORKSPACE": str(workspace),
            "OPENCLAW_STATE_DIR": str(workspace / "brain/state"),
            "BOOKMARK_LLM_ACPX_COMMAND": str(acpx),
        },
    )

    output_files = list((workspace / "brain/bookmarks/x").glob("*.md"))
    assert len(output_files) == 1
    output = output_files[0].read_text()
    assert "**Linked Article:** (from quoted tweet)" in output
    assert article["title"] in output
    assert article["plain_text"] in output
