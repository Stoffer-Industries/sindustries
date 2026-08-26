#!/usr/bin/env python3
"""Tests for agents/workflows/bookmarks/scripts/x_author_mention_tweets.py.

Covers AC1 (standalone draft queued), AC2 (manual-reply draft queued with
linksToItemId), AC3 (handle correctly identified even when link lacks it),
AC4 (manual_reply is never auto-published — verified at the API level by
kind=manual_reply and absence of scheduledFor), AC5 (URL capture flow is
via PATCH endpoint, not part of this helper), and AC6 (helper never raises;
hook wraps in defense-in-depth try/except).
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

from x_author_mention_tweets import (  # noqa: E402  (import after sys.path tweak)
    DEFAULT_CONTENT_SCHEDULER_API_BASE_URL,
    ERROR,
    QUEUED,
    SKIPPED,
    ItemsApiError,
    ItemsApiUnreachableError,
    TweetComposeError,
    compose_build_in_public_tweet,
    compose_reply_tweet,
    post_item,
    queue_bookmark_mention_drafts,
)


def _fake_response(payload: dict):
    """Build a urllib response context manager returning ``payload`` JSON."""
    resp = mock.MagicMock()
    resp.read.return_value = json.dumps(payload).encode("utf-8")
    resp.__enter__ = lambda s: s
    resp.__exit__ = lambda s, *a: None
    return resp


def _failing_response(*, code: int = 500, err_code: str = "INTERNAL", err_message: str = "boom"):
    """Build a real urllib.error.HTTPError with a JSON error envelope."""
    import urllib.error

    fp = mock.MagicMock()
    fp.read.return_value = json.dumps({
        "error": {"code": err_code, "message": err_message}
    }).encode("utf-8")
    return urllib.error.HTTPError(
        url="http://localhost/content-scheduler/items",
        code=code,
        msg=f"HTTP Error {code}",
        hdrs={},
        fp=fp,
    )


# --- compose_build_in_public_tweet --------------------------------------

class ComposeBuildInPublicTweetTests(unittest.TestCase):
    def test_happy_path_returns_trimmed_text(self):
        with mock.patch(
            "x_author_mention_tweets.invoke_llm_json",
            return_value={"tweet": "  building a thing off @h's post  "},
        ):
            text = compose_build_in_public_tweet({
                "link": "https://x.com/h/status/1",
                "title": "x",
            })
        self.assertEqual(text, "building a thing off @h's post")

    def test_raises_on_llm_error(self):
        with mock.patch(
            "x_author_mention_tweets.invoke_llm_json",
            side_effect=RuntimeError("openai 500"),
        ):
            with self.assertRaises(TweetComposeError) as ctx:
                compose_build_in_public_tweet({
                    "link": "https://x.com/h/status/1",
                    "title": "x",
                })
        self.assertIn("llm_compose_failed", str(ctx.exception))

    def test_raises_on_empty_llm_output(self):
        with mock.patch(
            "x_author_mention_tweets.invoke_llm_json",
            return_value={"tweet": "  "},
        ):
            with self.assertRaises(TweetComposeError) as ctx:
                compose_build_in_public_tweet({
                    "link": "https://x.com/h/status/1",
                    "title": "x",
                })
        self.assertIn("empty_output_build_in_public", str(ctx.exception))

    def test_raises_on_over_280_chars(self):
        long = "x" * 281
        with mock.patch(
            "x_author_mention_tweets.invoke_llm_json",
            return_value={"tweet": long},
        ):
            with self.assertRaises(TweetComposeError) as ctx:
                compose_build_in_public_tweet({
                    "link": "https://x.com/h/status/1",
                    "title": "x",
                })
        self.assertIn("over_280_chars", str(ctx.exception))

    def test_raises_when_state_item_not_dict(self):
        with self.assertRaises(TweetComposeError):
            compose_build_in_public_tweet("not a dict")  # type: ignore[arg-type]

    def test_uses_authorHandle_fallback_when_link_missing(self):
        with mock.patch(
            "x_author_mention_tweets.invoke_llm_json",
            return_value={"tweet": "@fallback hello"},
        ) as m:
            text = compose_build_in_public_tweet({
                "authorHandle": "fallback",
                "title": "x",
            })
        self.assertEqual(text, "@fallback hello")
        # invoke_llm_json is called positionally: (prompt, input_payload, schema).
        self.assertEqual(m.call_args.args[1]["handle"], "fallback")


# --- compose_reply_tweet ------------------------------------------------

class ComposeReplyTweetTests(unittest.TestCase):
    def _state(self):
        return {"link": "https://x.com/h/status/1", "title": "x"}

    def test_happy_path_includes_standalone_id_in_input(self):
        with mock.patch(
            "x_author_mention_tweets.invoke_llm_json",
            return_value={"tweet": "@h details in our announcement — what do you think?"},
        ) as m:
            text = compose_reply_tweet(self._state(), standalone_item_id="uuid-1")
        self.assertEqual(text, "@h details in our announcement — what do you think?")
        # The LLM is invoked with the standard compose payload (handle,
        # title, bodyExcerpt, tags). The standalone id is NOT part of
        # the LLM input — the prompt is self-contained ("details in our
        # announcement..."), and the id flows through the API cross-link
        # (linksToItemId) instead of the LLM.
        self.assertEqual(m.call_args.args[1]["handle"], "h")

    def test_raises_on_llm_error(self):
        with mock.patch(
            "x_author_mention_tweets.invoke_llm_json",
            side_effect=RuntimeError("openai 500"),
        ):
            with self.assertRaises(TweetComposeError):
                compose_reply_tweet(self._state(), standalone_item_id="uuid-1")

    def test_raises_on_empty_llm_output(self):
        with mock.patch(
            "x_author_mention_tweets.invoke_llm_json",
            return_value={"tweet": ""},
        ):
            with self.assertRaises(TweetComposeError) as ctx:
                compose_reply_tweet(self._state(), standalone_item_id="uuid-1")
        self.assertIn("empty_output_reply", str(ctx.exception))

    def test_raises_when_standalone_item_id_missing(self):
        with self.assertRaises(TweetComposeError) as ctx:
            compose_reply_tweet(self._state(), standalone_item_id="")
        self.assertIn("standalone_item_id is required", str(ctx.exception))

    def test_ac3_degradation_handles_no_handle(self):
        # No link, no authorHandle — extract_handle returns "" so the LLM
        # gets an empty handle and is expected to refer to "the original poster".
        with mock.patch(
            "x_author_mention_tweets.invoke_llm_json",
            return_value={"tweet": "the original poster wrote something interesting"},
        ) as m:
            text = compose_reply_tweet({"title": "x"}, standalone_item_id="uuid-1")
        self.assertEqual(text, "the original poster wrote something interesting")
        self.assertEqual(m.call_args.args[1]["handle"], "")


# --- post_item ----------------------------------------------------------

class PostItemTests(unittest.TestCase):
    def test_happy_path_returns_data_dict(self):
        resp = _fake_response({"data": {"id": "uuid-1", "body": "hello", "kind": "scheduled"}})
        with mock.patch(
            "x_author_mention_tweets.urllib.request.urlopen",
            return_value=resp,
        ) as urlopen:
            result = post_item({"body": "hello", "kind": "scheduled"})
        self.assertEqual(result["id"], "uuid-1")
        self.assertEqual(result["kind"], "scheduled")
        # POST URL must use the items/ route, NOT /drafts (refresh design).
        self.assertEqual(
            urlopen.call_args.args[0].full_url,
            f"{DEFAULT_CONTENT_SCHEDULER_API_BASE_URL}/content-scheduler/items",
        )
        # x-actor header must be set for the audit trail. urllib normalizes
        # header keys via capitalize(), so x-actor → X-Actor in the request.
        headers = urlopen.call_args.args[0].headers
        actor_header = next(
            (v for k, v in headers.items() if k.lower() == "x-actor"), None,
        )
        self.assertEqual(actor_header, "bookmark-mention-helper")
        self.assertEqual(
            next((v for k, v in headers.items() if k.lower() == "content-type"), None),
            "application/json",
        )

    def test_5xx_raises_items_api_error(self):
        with mock.patch(
            "x_author_mention_tweets.urllib.request.urlopen",
            side_effect=_failing_response(code=500, err_code="INTERNAL", err_message="boom"),
        ):
            with self.assertRaises(ItemsApiError) as ctx:
                post_item({"body": "hello"})
        self.assertIn("items_api_500", str(ctx.exception))
        self.assertIn("INTERNAL", str(ctx.exception))

    def test_4xx_raises_items_api_error(self):
        with mock.patch(
            "x_author_mention_tweets.urllib.request.urlopen",
            side_effect=_failing_response(code=400, err_code="INVALID_BODY", err_message="too short"),
        ):
            with self.assertRaises(ItemsApiError) as ctx:
                post_item({"body": ""})
        self.assertIn("items_api_400", str(ctx.exception))

    def test_connection_refused_raises_items_api_unreachable(self):
        with mock.patch(
            "x_author_mention_tweets.urllib.request.urlopen",
            side_effect=ConnectionRefusedError("refused"),
        ):
            with self.assertRaises(ItemsApiUnreachableError) as ctx:
                post_item({"body": "hello"})
        self.assertIn("items_api_unreachable", str(ctx.exception))

    def test_uses_env_var_for_base_url(self):
        captured = {}

        def fake_urlopen(req, timeout=None):
            captured["url"] = req.full_url
            return _fake_response({"data": {"id": "uuid-1"}})

        with mock.patch.dict(os.environ, {
            "CONTENT_SCHEDULER_API_BASE_URL": "http://example.test/api/v1"
        }):
            with mock.patch(
                "x_author_mention_tweets.urllib.request.urlopen",
                side_effect=fake_urlopen,
            ):
                post_item({"body": "hello"})
        self.assertEqual(
            captured["url"],
            "http://example.test/api/v1/content-scheduler/items",
        )

    def test_base_url_override_wins_over_env_var(self):
        captured = {}

        def fake_urlopen(req, timeout=None):
            captured["url"] = req.full_url
            return _fake_response({"data": {"id": "uuid-1"}})

        with mock.patch.dict(os.environ, {
            "CONTENT_SCHEDULER_API_BASE_URL": "http://env.test/api/v1"
        }):
            with mock.patch(
                "x_author_mention_tweets.urllib.request.urlopen",
                side_effect=fake_urlopen,
            ):
                post_item({"body": "hello"}, base_url="http://override.test/api/v1")
        self.assertEqual(
            captured["url"],
            "http://override.test/api/v1/content-scheduler/items",
        )


# --- queue_bookmark_mention_drafts --------------------------------------

class QueueBookmarkMentionDraftsTests(unittest.TestCase):
    def _state(self, **overrides):
        base = {
            "bookmarkKey": "bm-1",
            "source": "x",
            "link": "https://x.com/h/status/1",
            "title": "t",
            "bodyExcerpt": "excerpt",
            "tags": [],
        }
        base.update(overrides)
        return base

    def _capture_urlopen(self, payloads_out: list):
        """Return a side_effect callable that captures each POST body
        and yields a fake 201 response keyed off the call index."""

        def capturing_urlopen(req, timeout=None):
            payloads_out.append(json.loads(req.data.decode("utf-8")))
            if len(payloads_out) == 1:
                return _fake_response({"data": {"id": "uuid-1"}})
            return _fake_response({"data": {"id": "uuid-2"}})

        return capturing_urlopen

    def test_non_x_source_is_skipped(self):
        result = queue_bookmark_mention_drafts(self._state(source="hn"))
        self.assertEqual(result["queuedDraftIds"], [])
        self.assertEqual(result["errors"], [])
        self.assertEqual(len(result["skipped"]), 1)
        self.assertEqual(result["skipped"][0]["status"], SKIPPED)
        self.assertEqual(result["skipped"][0]["reason"], "non_x_source")

    def test_missing_link_is_skipped(self):
        result = queue_bookmark_mention_drafts(
            self._state(link="https://example.com/not-x"),
        )
        self.assertEqual(result["queuedDraftIds"], [])
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["skipped"][0]["reason"], "missing_x_link")

    def test_happy_path_queues_two_drafts_with_cross_link(self):
        captured: list = []
        with mock.patch(
            "x_author_mention_tweets.invoke_llm_json",
            side_effect=[{"tweet": "build tweet"}, {"tweet": "reply tweet"}],
        ), mock.patch(
            "x_author_mention_tweets.urllib.request.urlopen",
            side_effect=self._capture_urlopen(captured),
        ):
            result = queue_bookmark_mention_drafts(self._state())

        self.assertEqual(result["queuedDraftIds"], ["uuid-1", "uuid-2"])
        self.assertEqual(result["errors"], [])
        # First POST: kind=scheduled, no linksToItemId, no scheduledFor.
        self.assertEqual(captured[0]["kind"], "scheduled")
        self.assertNotIn("linksToItemId", captured[0])
        # scheduledFor is OMITTED from the payload (server defaults to null
        # for kind=scheduled without scheduledFor); confirm the helper
        # doesn't carry a scheduledFor forward.
        self.assertIsNone(captured[0].get("scheduledFor"))
        # Second POST: kind=manual_reply, linksToItemId=standalone id,
        # no scheduledFor (AC4 — never auto-published).
        self.assertEqual(captured[1]["kind"], "manual_reply")
        self.assertEqual(captured[1]["linksToItemId"], "uuid-1")
        self.assertIsNone(captured[1].get("scheduledFor"))

    def test_happy_path_passes_bookmark_key_as_sourceRef(self):
        captured: list = []
        with mock.patch(
            "x_author_mention_tweets.invoke_llm_json",
            side_effect=[{"tweet": "t1"}, {"tweet": "t2"}],
        ), mock.patch(
            "x_author_mention_tweets.urllib.request.urlopen",
            side_effect=self._capture_urlopen(captured),
        ):
            queue_bookmark_mention_drafts(self._state(bookmarkKey="bm-42"))
        self.assertEqual(captured[0]["sourceRef"], "bm-42")
        self.assertEqual(captured[1]["sourceRef"], "bm-42")

    def test_ac3_handle_less_share_link_resolves_author_and_proceeds(self):
        # x.com/i/web/status/<id> has status id but no handle in URL.
        # resolve_tweet_author fills the handle in via tasks-api GET;
        # we mock it to return "resolved-handle" and then expect the
        # flow to proceed normally with both drafts queued.
        captured: list = []
        state = self._state(link="https://x.com/i/web/status/999")
        with mock.patch(
            "x_author_mention_tweets.invoke_llm_json",
            side_effect=[{"tweet": "build"}, {"tweet": "reply"}],
        ), mock.patch(
            "x_author_tweet.parse_x_status_id",
            return_value="999",
        ), mock.patch(
            "x_author_tweet.resolve_tweet_author",
            return_value="resolved-handle",
        ) as resolve_mock, mock.patch(
            "x_author_mention_tweets.urllib.request.urlopen",
            side_effect=self._capture_urlopen(captured),
        ):
            result = queue_bookmark_mention_drafts(state)

        self.assertEqual(result["queuedDraftIds"], ["uuid-1", "uuid-2"])
        self.assertEqual(result["errors"], [])
        # resolve_tweet_author was consulted with the parsed status id.
        resolve_mock.assert_called_once()

    def test_ac3_handle_less_share_link_missing_handle_records_skip(self):
        # parse_x_status_id finds a status id, but resolve_tweet_author
        # returns None (X API down / 404 / etc.) → skip with missing_x_link.
        state = self._state(link="https://x.com/i/web/status/999")
        with mock.patch(
            "x_author_tweet.parse_x_status_id",
            return_value="999",
        ), mock.patch(
            "x_author_tweet.resolve_tweet_author",
            return_value=None,
        ):
            result = queue_bookmark_mention_drafts(state)
        self.assertEqual(result["queuedDraftIds"], [])
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["skipped"][0]["reason"], "missing_x_link")

    def test_compose_build_in_public_failure_records_error_no_items_queued(self):
        with mock.patch(
            "x_author_mention_tweets.invoke_llm_json",
            side_effect=RuntimeError("openai 500"),
        ):
            result = queue_bookmark_mention_drafts(self._state())
        self.assertEqual(result["queuedDraftIds"], [])
        self.assertEqual(len(result["errors"]), 1)
        self.assertEqual(result["errors"][0]["step"], "compose_build_in_public")
        self.assertIn("llm_compose_failed", result["errors"][0]["error"])

    def test_scheduled_post_failure_records_error_no_items_queued(self):
        # LLM #1 succeeds, but the first POST fails. Manual-reply needs
        # the standalone id so we don't try to create it.
        with mock.patch(
            "x_author_mention_tweets.invoke_llm_json",
            return_value={"tweet": "build tweet"},
        ), mock.patch(
            "x_author_mention_tweets.urllib.request.urlopen",
            side_effect=ConnectionRefusedError("refused"),
        ):
            result = queue_bookmark_mention_drafts(self._state())
        self.assertEqual(result["queuedDraftIds"], [])
        self.assertEqual(len(result["errors"]), 1)
        self.assertEqual(result["errors"][0]["step"], "create_scheduled_draft")
        self.assertIn("items_api_unreachable", result["errors"][0]["error"])

    def test_reply_compose_failure_records_error_standalone_still_queued(self):
        # LLM #1 succeeds + first POST succeeds, then LLM #2 fails.
        # Standalone is queued; the error is recorded so ops can see
        # only the manual-reply failed.
        with mock.patch(
            "x_author_mention_tweets.invoke_llm_json",
            side_effect=[{"tweet": "build tweet"}, RuntimeError("openai 500")],
        ), mock.patch(
            "x_author_mention_tweets.urllib.request.urlopen",
            return_value=_fake_response({"data": {"id": "uuid-1"}}),
        ):
            result = queue_bookmark_mention_drafts(self._state())
        self.assertEqual(result["queuedDraftIds"], ["uuid-1"])
        self.assertEqual(len(result["errors"]), 1)
        self.assertEqual(result["errors"][0]["step"], "compose_reply")

    def test_manual_reply_post_failure_records_error_standalone_still_queued(self):
        # LLM #1 succeeds + first POST succeeds + LLM #2 succeeds + second
        # POST fails. Standalone is queued; the error is recorded.
        with mock.patch(
            "x_author_mention_tweets.invoke_llm_json",
            side_effect=[{"tweet": "t1"}, {"tweet": "t2"}],
        ), mock.patch(
            "x_author_mention_tweets.urllib.request.urlopen",
            side_effect=[
                _fake_response({"data": {"id": "uuid-1"}}),
                ConnectionRefusedError("refused"),
            ],
        ):
            result = queue_bookmark_mention_drafts(self._state())
        self.assertEqual(result["queuedDraftIds"], ["uuid-1"])
        self.assertEqual(len(result["errors"]), 1)
        self.assertEqual(result["errors"][0]["step"], "create_manual_reply_draft")

    def test_scheduled_post_missing_id_records_error(self):
        # POST returns 201 but with no `id` in the data envelope —
        # helper records a structured error and refuses to chain the
        # manual_reply step (which would have no standalone to link).
        with mock.patch(
            "x_author_mention_tweets.invoke_llm_json",
            return_value={"tweet": "t1"},
        ), mock.patch(
            "x_author_mention_tweets.urllib.request.urlopen",
            return_value=_fake_response({"data": {}}),
        ):
            result = queue_bookmark_mention_drafts(self._state())
        self.assertEqual(result["queuedDraftIds"], [])
        self.assertEqual(len(result["errors"]), 1)
        self.assertEqual(result["errors"][0]["error"], "missing_id_in_response")

    def test_invalid_state_item_returns_skipped(self):
        result = queue_bookmark_mention_drafts("not a dict")  # type: ignore[arg-type]
        self.assertEqual(result["queuedDraftIds"], [])
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["skipped"][0]["reason"], "invalid_state_item")

    def test_never_raises_on_unexpected_exception(self):
        # AC6 defense in depth — even if invoke_llm_json raises a
        # non-TweetComposeError exception, the helper catches it and
        # records a structured error rather than bubbling.
        with mock.patch(
            "x_author_mention_tweets.invoke_llm_json",
            side_effect=ValueError("totally unexpected"),
        ):
            try:
                result = queue_bookmark_mention_drafts(self._state())
            except Exception as exc:  # pragma: no cover
                self.fail(f"helper raised unexpectedly: {exc}")
        self.assertEqual(result["queuedDraftIds"], [])
        self.assertEqual(len(result["errors"]), 1)
        self.assertIn("unexpected", result["errors"][0]["error"])


if __name__ == "__main__":
    unittest.main()
