#!/usr/bin/env python3
"""Tests for agents/workflows/bookmarks/scripts/x_author_tweet.py.

Covers AC1 (reply posted), AC2 (non-X silently skipped), AC3 (X API failure
records error, no exception bubbles up), AC4 (tweetLog-shaped payload),
and AC5 (reframed — getXClient() == null ⇒ MISSING_CREDENTIALS ⇒ skipped
without an upstream HTTP call).
"""
from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

THIS_DIR = Path(__file__).resolve().parent
SCRIPTS_DIR = THIS_DIR.parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from x_author_tweet import (  # noqa: E402  (import after sys.path tweak)
    POSTED,
    SKIPPED,
    ERROR,
    CredentialsMissingError,
    TasksApiUnreachableError,
    XApiError,
    call_x_tweets_route,
    compose_author_tweet,
    parse_x_link,
    parse_x_status_id,
    resolve_tweet_author,
    try_post_author_tweet,
)


# --- parse_x_link --------------------------------------------------------

class ParseXLinkTests(unittest.TestCase):
    def test_x_com_handle_and_status(self):
        self.assertEqual(parse_x_link("https://x.com/somebody/status/1234567890"),
                         ("somebody", "1234567890"))

    def test_twitter_com_handle_and_status(self):
        self.assertEqual(parse_x_link("https://twitter.com/somebody/status/1234567890"),
                         ("somebody", "1234567890"))

    def test_mobile_twitter_com_handle_and_status(self):
        self.assertEqual(parse_x_link("https://mobile.twitter.com/somebody/status/1234567890"),
                         ("somebody", "1234567890"))

    def test_www_prefix(self):
        self.assertEqual(parse_x_link("https://www.x.com/somebody/status/1234567890"),
                         ("somebody", "1234567890"))

    def test_statuses_alias(self):
        # /statuses/ is a legacy Twitter URL form.
        self.assertEqual(parse_x_link("https://twitter.com/somebody/statuses/1234567890"),
                         ("somebody", "1234567890"))

    def test_trailing_slash(self):
        self.assertEqual(parse_x_link("https://x.com/somebody/status/1234567890/"),
                         ("somebody", "1234567890"))

    def test_query_string_and_anchor(self):
        self.assertEqual(parse_x_link("https://x.com/somebody/status/1234567890?s=20&t=abc#anchor"),
                         ("somebody", "1234567890"))

    def test_utm_params(self):
        self.assertEqual(parse_x_link("https://x.com/somebody/status/1234567890?utm_source=feed"),
                         ("somebody", "1234567890"))

    def test_uppercase_host(self):
        self.assertEqual(parse_x_link("HTTPS://X.COM/somebody/status/1234567890"),
                         ("somebody", "1234567890"))

    def test_underscore_in_handle(self):
        self.assertEqual(parse_x_link("https://x.com/some_body/status/1234567890"),
                         ("some_body", "1234567890"))

    def test_non_x_url_returns_none(self):
        self.assertIsNone(parse_x_link("https://example.com/blog/post-123"))

    def test_youtube_url_returns_none(self):
        self.assertIsNone(parse_x_link("https://youtube.com/watch?v=abc"))

    def test_x_profile_url_returns_none(self):
        self.assertIsNone(parse_x_link("https://x.com/somebody"))

    def test_empty_string_returns_none(self):
        self.assertIsNone(parse_x_link(""))

    def test_none_returns_none(self):
        self.assertIsNone(parse_x_link(None))

    def test_non_string_returns_none(self):
        self.assertIsNone(parse_x_link(123))  # type: ignore[arg-type]

    def test_handle_too_long_returns_none(self):
        # 16-char handle is invalid per X's rules; regex caps at 15.
        self.assertIsNone(parse_x_link("https://x.com/somebody_with_a_long_handle_/status/1234567890"))

    def test_malformed_no_status_id(self):
        self.assertIsNone(parse_x_link("https://x.com/somebody/status/"))

    def test_malformed_handle_empty(self):
        # The regex requires a non-empty handle; this won't match.
        self.assertIsNone(parse_x_link("https://x.com//status/1234567890"))


# --- parse_x_status_id ----------------------------------------------------

class ParseXStatusIdTests(unittest.TestCase):
    def test_web_intent_share_link(self):
        # No author handle in the path at all — this is the format that
        # made parse_x_link return None for a real bookmark (2026-08-18).
        self.assertEqual(
            parse_x_status_id("https://x.com/i/web/status/2087089133156208803"),
            "2087089133156208803",
        )

    def test_still_matches_handle_form(self):
        self.assertEqual(parse_x_status_id("https://x.com/somebody/status/1234567890"), "1234567890")

    def test_statuses_alias(self):
        self.assertEqual(parse_x_status_id("https://twitter.com/i/web/statuses/42"), "42")

    def test_non_x_url_returns_none(self):
        self.assertIsNone(parse_x_status_id("https://example.com/i/web/status/123"))

    def test_no_status_segment_returns_none(self):
        self.assertIsNone(parse_x_status_id("https://x.com/somebody"))

    def test_empty_string_returns_none(self):
        self.assertIsNone(parse_x_status_id(""))

    def test_none_returns_none(self):
        self.assertIsNone(parse_x_status_id(None))


# --- resolve_tweet_author --------------------------------------------------

class ResolveTweetAuthorTests(unittest.TestCase):
    def test_happy_path_returns_handle(self):
        fake_response = mock.MagicMock()
        fake_response.read.return_value = json.dumps({"data": {"handle": "polydao"}}).encode("utf-8")
        fake_response.__enter__ = lambda s: s
        fake_response.__exit__ = lambda s, *a: None
        with mock.patch("x_author_tweet.urllib.request.urlopen", return_value=fake_response):
            self.assertEqual(resolve_tweet_author("999"), "polydao")

    def test_404_returns_none(self):
        http_err = urllib_error("HTTP Error 404", code=404)
        with mock.patch("x_author_tweet.urllib.request.urlopen", side_effect=http_err):
            self.assertIsNone(resolve_tweet_author("999"))

    def test_missing_credentials_returns_none(self):
        http_err = urllib_error("HTTP Error 503", code=503)
        with mock.patch("x_author_tweet.urllib.request.urlopen", side_effect=http_err):
            self.assertIsNone(resolve_tweet_author("999"))

    def test_tasks_api_unreachable_returns_none(self):
        with mock.patch("x_author_tweet.urllib.request.urlopen",
                        side_effect=ConnectionRefusedError("refused")):
            self.assertIsNone(resolve_tweet_author("999"))

    def test_empty_handle_returns_none(self):
        fake_response = mock.MagicMock()
        fake_response.read.return_value = json.dumps({"data": {"handle": ""}}).encode("utf-8")
        fake_response.__enter__ = lambda s: s
        fake_response.__exit__ = lambda s, *a: None
        with mock.patch("x_author_tweet.urllib.request.urlopen", return_value=fake_response):
            self.assertIsNone(resolve_tweet_author("999"))


# --- compose_author_tweet ------------------------------------------------

class ComposeAuthorTweetTests(unittest.TestCase):
    def test_compose_returns_string_when_llm_succeeds(self):
        state_item = {
            "source": "x",
            "link": "https://x.com/somebody/status/1234567890",
            "title": "An interesting thread on tiny base models",
            "bodyExcerpt": "Tiny models are beating expectations on long-context tasks.",
            "tags": ["ml", "models"],
        }
        with mock.patch(
            "x_author_tweet.invoke_llm_json",
            return_value={"tweet": "@somebody interesting thread — what's your eval setup?"},
        ):
            text = compose_author_tweet(state_item)
        self.assertTrue(text.startswith("@somebody"))
        self.assertLessEqual(len(text), 280)

    def test_compose_strips_whitespace(self):
        with mock.patch(
            "x_author_tweet.invoke_llm_json",
            return_value={"tweet": "   @h hello world   "},
        ):
            text = compose_author_tweet({"link": "https://x.com/h/status/1", "title": "x"})
        self.assertEqual(text, "@h hello world")

    def test_compose_raises_on_llm_error(self):
        with mock.patch(
            "x_author_tweet.invoke_llm_json",
            side_effect=RuntimeError("openai 500"),
        ):
            with self.assertRaises(Exception) as ctx:
                compose_author_tweet({
                    "link": "https://x.com/h/status/1",
                    "title": "x",
                })
        self.assertIn("llm_compose_failed", str(ctx.exception))

    def test_compose_raises_on_empty_llm_output(self):
        with mock.patch(
            "x_author_tweet.invoke_llm_json",
            return_value={"tweet": "  "},
        ):
            with self.assertRaises(Exception) as ctx:
                compose_author_tweet({
                    "link": "https://x.com/h/status/1",
                    "title": "x",
                })
        self.assertIn("empty_output", str(ctx.exception))

    def test_compose_raises_when_no_handle(self):
        with mock.patch("x_author_tweet.invoke_llm_json") as m:
            with self.assertRaises(Exception) as ctx:
                compose_author_tweet({"title": "no link here"})
            m.assert_not_called()
        self.assertIn("no author handle", str(ctx.exception).lower())

    def test_compose_uses_authorHandle_fallback(self):
        with mock.patch(
            "x_author_tweet.invoke_llm_json",
            return_value={"tweet": "@fallback hi"},
        ) as m:
            text = compose_author_tweet({
                "authorHandle": "fallback",
                "title": "x",
            })
        self.assertEqual(text, "@fallback hi")
        # invoke_llm_json is called positionally: (prompt, input_payload, schema).
        self.assertEqual(m.call_args.args[1]["handle"], "fallback")

    def test_compose_rejects_non_dict_state(self):
        with self.assertRaises(Exception):
            compose_author_tweet("not a dict")  # type: ignore[arg-type]


# --- call_x_tweets_route -------------------------------------------------

class CallXTweetsRouteTests(unittest.TestCase):
    def test_happy_path_returns_url_and_posted_at(self):
        fake_response = mock.MagicMock()
        fake_response.read.return_value = json.dumps({
            "data": {"url": "https://x.com/sindustries/status/abc", "postedAt": "2026-07-19T00:00:00.000Z"}
        }).encode("utf-8")
        fake_response.__enter__ = lambda s: s
        fake_response.__exit__ = lambda s, *a: None
        with mock.patch("x_author_tweet.urllib.request.urlopen", return_value=fake_response):
            result = call_x_tweets_route("hello", "999")
        self.assertEqual(result["url"], "https://x.com/sindustries/status/abc")
        self.assertEqual(result["postedAt"], "2026-07-19T00:00:00.000Z")

    def test_503_raises_credentials_missing(self):
        err = mock.MagicMock()
        err.code = 503
        err.read.return_value = json.dumps({"error": {"code": "MISSING_CREDENTIALS", "message": "nope"}}).encode("utf-8")
        err.reason = "Service Unavailable"
        http_err = urllib_error("HTTP Error 503", code=503)
        with mock.patch("x_author_tweet.urllib.request.urlopen", side_effect=http_err):
            with self.assertRaises(CredentialsMissingError) as ctx:
                call_x_tweets_route("hi", "1")
        self.assertIn("missing_credentials", str(ctx.exception))

    def test_502_raises_x_api_error(self):
        http_err = urllib_error("HTTP Error 502", code=502)
        with mock.patch("x_author_tweet.urllib.request.urlopen", side_effect=http_err):
            with self.assertRaises(XApiError) as ctx:
                call_x_tweets_route("hi", "1")
        self.assertIn("x_api_502", str(ctx.exception))

    def test_connection_refused_raises_tasks_api_unreachable(self):
        with mock.patch("x_author_tweet.urllib.request.urlopen",
                        side_effect=ConnectionRefusedError("refused")):
            with self.assertRaises(TasksApiUnreachableError) as ctx:
                call_x_tweets_route("hi", "1")
        self.assertIn("tasks_api_unreachable", str(ctx.exception))

    def test_uses_env_var_for_base_url(self):
        fake_response = mock.MagicMock()
        fake_response.read.return_value = json.dumps({
            "data": {"url": "https://x.com/u/status/x", "postedAt": "now"}
        }).encode("utf-8")
        fake_response.__enter__ = lambda s: s
        fake_response.__exit__ = lambda s, *a: None
        captured = {}

        def fake_urlopen(req, timeout=None):
            captured["url"] = req.full_url
            return fake_response

        with mock.patch.dict(os.environ, {"TASKS_API_BASE_URL": "http://example.test/api/v1"}):
            with mock.patch("x_author_tweet.urllib.request.urlopen", side_effect=fake_urlopen):
                call_x_tweets_route("hi", "1")
        self.assertEqual(captured["url"], "http://example.test/api/v1/x/tweets")


def urllib_error(msg: str, *, code: int):
    """Build a real ``urllib.error.HTTPError`` with a JSON body."""
    import urllib.error

    err = urllib.error.HTTPError(
        url="http://localhost/x/tweets",
        code=code,
        msg=msg,
        hdrs={},
        fp=None,
    )
    # Provide a .read() that returns a useful body for some tests.
    body = json.dumps({"error": {"code": "MISSING_CREDENTIALS" if code == 503 else "X_API_ERROR",
                                  "message": msg}}).encode("utf-8")
    err.read = lambda: body  # type: ignore[method-append]
    return err


# --- try_post_author_tweet -----------------------------------------------

class TryPostAuthorTweetTests(unittest.TestCase):
    def test_non_x_source_is_silently_skipped(self):
        result = try_post_author_tweet({
            "source": "web",
            "link": "https://example.com/article",
            "title": "x",
        })
        self.assertEqual(result, {"status": SKIPPED, "error": "non_x_source"})

    def test_missing_link_skipped(self):
        result = try_post_author_tweet({
            "source": "x",
            "link": "",
            "title": "x",
        })
        self.assertEqual(result, {"status": SKIPPED, "error": "missing_x_link"})

    def test_malformed_link_skipped(self):
        result = try_post_author_tweet({
            "source": "x",
            "link": "not-a-url",
            "title": "x",
        })
        self.assertEqual(result, {"status": SKIPPED, "error": "missing_x_link"})

    def test_web_intent_link_resolves_author_and_posts(self):
        # x.com/i/web/status/<id> has no handle in the path; try_post_author_tweet
        # must fall back to resolve_tweet_author instead of skipping outright.
        with mock.patch(
            "x_author_tweet.resolve_tweet_author",
            return_value="polydao",
        ) as resolve_mock, mock.patch(
            "x_author_tweet.compose_author_tweet",
            return_value="@polydao nice thread",
        ) as compose_mock, mock.patch(
            "x_author_tweet.call_x_tweets_route",
            return_value={"url": "https://x.com/sindustries/status/1", "postedAt": "now"},
        ):
            result = try_post_author_tweet({
                "source": "x",
                "link": "https://x.com/i/web/status/2087089133156208803",
                "title": "x",
            })
        resolve_mock.assert_called_once_with("2087089133156208803", base_url=None)
        # compose_author_tweet must see the resolved handle via authorHandle.
        self.assertEqual(compose_mock.call_args[0][0]["authorHandle"], "polydao")
        self.assertEqual(result["status"], POSTED)

    def test_web_intent_link_skipped_when_author_unresolvable(self):
        with mock.patch("x_author_tweet.resolve_tweet_author", return_value=None):
            result = try_post_author_tweet({
                "source": "x",
                "link": "https://x.com/i/web/status/2087089133156208803",
                "title": "x",
            })
        self.assertEqual(result, {"status": SKIPPED, "error": "missing_x_link"})

    def test_llm_failure_records_error(self):
        with mock.patch(
            "x_author_tweet.compose_author_tweet",
            side_effect=RuntimeError("llm timeout"),
        ):
            result = try_post_author_tweet({
                "source": "x",
                "link": "https://x.com/somebody/status/1234567890",
                "title": "x",
            })
        self.assertEqual(result["status"], ERROR)
        self.assertIn("llm_compose_failed", result["error"])

    def test_missing_credentials_skipped(self):
        with mock.patch(
            "x_author_tweet.compose_author_tweet",
            return_value="@somebody nice thread",
        ), mock.patch(
            "x_author_tweet.call_x_tweets_route",
            side_effect=CredentialsMissingError("missing_credentials:nope"),
        ):
            result = try_post_author_tweet({
                "source": "x",
                "link": "https://x.com/somebody/status/1234567890",
                "title": "x",
            })
        self.assertEqual(result, {"status": SKIPPED, "error": "missing_credentials"})

    def test_x_api_error_records_error(self):
        with mock.patch(
            "x_author_tweet.compose_author_tweet",
            return_value="@somebody nice thread",
        ), mock.patch(
            "x_author_tweet.call_x_tweets_route",
            side_effect=XApiError("x_api_500:boom"),
        ):
            result = try_post_author_tweet({
                "source": "x",
                "link": "https://x.com/somebody/status/1234567890",
                "title": "x",
            })
        self.assertEqual(result["status"], ERROR)
        self.assertEqual(result["error"], "x_api_500:boom")

    def test_tasks_api_unreachable_records_error(self):
        with mock.patch(
            "x_author_tweet.compose_author_tweet",
            return_value="@somebody nice thread",
        ), mock.patch(
            "x_author_tweet.call_x_tweets_route",
            side_effect=TasksApiUnreachableError("tasks_api_unreachable:refused"),
        ):
            result = try_post_author_tweet({
                "source": "x",
                "link": "https://x.com/somebody/status/1234567890",
                "title": "x",
            })
        self.assertEqual(result["status"], ERROR)
        self.assertIn("tasks_api_unreachable", result["error"])

    def test_happy_path_returns_posted(self):
        with mock.patch(
            "x_author_tweet.compose_author_tweet",
            return_value="@somebody great post",
        ), mock.patch(
            "x_author_tweet.call_x_tweets_route",
            return_value={"url": "https://x.com/u/status/abc", "postedAt": "2026-07-19T00:00:00.000Z"},
        ):
            result = try_post_author_tweet({
                "source": "x",
                "link": "https://x.com/somebody/status/1234567890",
                "title": "x",
            })
        self.assertEqual(result["status"], POSTED)
        self.assertEqual(result["tweetUrl"], "https://x.com/u/status/abc")
        self.assertEqual(result["postedAt"], "2026-07-19T00:00:00.000Z")

    def test_compose_returns_empty_records_error(self):
        with mock.patch(
            "x_author_tweet.compose_author_tweet",
            return_value="",
        ):
            result = try_post_author_tweet({
                "source": "x",
                "link": "https://x.com/somebody/status/1234567890",
                "title": "x",
            })
        self.assertEqual(result["status"], ERROR)
        self.assertIn("empty_output", result["error"])

    def test_compose_returns_over_280_records_error(self):
        with mock.patch(
            "x_author_tweet.compose_author_tweet",
            return_value="x" * 281,
        ):
            result = try_post_author_tweet({
                "source": "x",
                "link": "https://x.com/somebody/status/1234567890",
                "title": "x",
            })
        self.assertEqual(result["status"], ERROR)
        self.assertIn("over_280_chars", result["error"])

    def test_invalid_state_item(self):
        result = try_post_author_tweet("not a dict")  # type: ignore[arg-type]
        self.assertEqual(result, {"status": SKIPPED, "error": "invalid_state_item"})


if __name__ == "__main__":
    unittest.main()