#!/usr/bin/env python3
"""Regression test for the chunk-boundary UTF-8 decode fix in `common.py`.

Original bug (d09bbbac, 2026-06-02): ``read_first_json_value()`` decoded each
4096-byte ``os.read()`` chunk independently with ``chunk.decode("utf-8")``.
When a multi-byte UTF-8 sequence (e.g. an emoji) straddled the chunk boundary,
the trailing chunk raised ``UnicodeDecodeError``.

This bit content-task task ``70970701-16aa-4ebc-a5c8-bf4979b4c3e4`` when the
title's ``✍️`` emoji (U+270D, encoded as ``E2 9C 8D``) split at byte 4096 and
``merge_transition.py`` raised ``UnicodeDecodeError: 'utf-8' codec can't
decode byte 0xe2 in position 4095: unexpected end of data``. The Content Task
Lobster flagged the task with ``workflow command failed (1)``.

Fix: ``codecs.getincrementaldecoder("utf-8")`` buffers trailing partial
sequences across chunk boundaries. These tests assert:

  1. Emoji-free payloads still decode (no regression in the
     ``decoder.raw_decode()`` path).
  2. An emoji straddling byte 4096 decodes intact with the new function —
     i.e. the original failure shape is gone.
  3. A lone leading byte from a multi-byte UTF-8 sequence raises
     ``UnicodeDecodeError`` under strict decode — positive control proving
     the bug class the fix addresses still exists in CPython's stdlib,
     so the regression test above is meaningful (not a fluke pass).
"""
from __future__ import annotations

import codecs
import json
import os
import sys
import threading
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
SCRIPTS_DIR = TESTS_DIR.parent / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import common  # noqa: E402


CHUNK_SIZE = 4096


def _feed_pipe(write_fd: int, payload: bytes) -> None:
    try:
        os.write(write_fd, payload)
    finally:
        os.close(write_fd)


def _read_via_read_first_json_value(payload: bytes, *, timeout: float = 2.0):
    """Feed `payload` into a real os.pipe and run read_first_json_value on it."""
    read_fd, write_fd = os.pipe()
    reader = os.fdopen(read_fd, "r", encoding="utf-8")
    thread = threading.Thread(target=_feed_pipe, args=(write_fd, payload), daemon=True)
    thread.start()
    try:
        return common.read_first_json_value(reader, timeout_seconds=timeout)
    finally:
        reader.close()


def _payload_with_emoji_at_chunk_boundary() -> bytes:
    """Build a JSON payload where the first byte of an emoji lands at index 4096.

    Layout:
        b'{"title": "' + 4085 * b'a' + b'\xe2\x9c\x8d\xef\xb8\x8f done", "x": 1}'

    The string ``\xe2\x9c\x8d\xef\xb8\x8f`` is UTF-8 for ``✍️`` (U+270D + U+FE0F).
    Its first byte (0xE2) sits exactly at index CHUNK_SIZE, so when the
    function's ``os.read(fd, CHUNK_SIZE)`` returns, the next read starts with
    a partial multi-byte sequence that strict UTF-8 would reject.
    """
    head = b'{"title": "'
    pad_len = CHUNK_SIZE - len(head)
    emoji = "\u270d\ufe0f".encode("utf-8")
    tail = b' done", "x": 1}'
    payload = head + (b"a" * pad_len) + emoji + tail
    assert payload[CHUNK_SIZE] == 0xE2, (
        f"payload boundary sanity check failed: byte at {CHUNK_SIZE} is 0x{payload[CHUNK_SIZE]:02x}"
    )
    return payload


class ChunkedDecodeRegressionTests(unittest.TestCase):
    def test_emoji_free_payload_decodes(self) -> None:
        payload = b'{"title": "weekly review", "tags": ["a", "b"]}'
        result = _read_via_read_first_json_value(payload)
        self.assertEqual(result["title"], "weekly review")
        self.assertEqual(result["tags"], ["a", "b"])

    def test_emoji_at_chunk_boundary_decodes_intact(self) -> None:
        payload = _payload_with_emoji_at_chunk_boundary()
        result = _read_via_read_first_json_value(payload)
        self.assertEqual(result["x"], 1)
        # Title starts with 4085 a's, contains the full ✍️ + VS-16 sequence,
        # then ends with " done" — proves the trailing chunk's partial UTF-8
        # bytes were correctly reassembled across the boundary.
        self.assertTrue(result["title"].startswith("a" * 100))
        self.assertIn("\u270d\ufe0f", result["title"])
        self.assertTrue(result["title"].endswith(" done"))

    def test_lone_utf8_leading_byte_raises_under_strict_decode(self) -> None:
        """Positive control: prove the bug class still exists in CPython.

        The pre-fix code did ``chunk.decode("utf-8")`` on each ``os.read()``
        result. When the pipe delivered a chunk that ended mid-emoji (e.g. a
        trailing ``b'\\xe2'`` or ``b'\\xe2\\x9c'`` from a 3-byte sequence),
        strict UTF-8 raised ``UnicodeDecodeError: ... unexpected end of
        data`` — exactly what ``merge_transition.py`` hit on 2026-08-07.
        The incremental decoder added in the fix buffers those leading
        bytes until the next chunk completes the sequence. If this positive
        control stops raising, the bug class no longer exists and the
        regression test above has lost its meaning.
        """
        for partial in (b"\xe2", b"\xe2\x9c"):
            with self.assertRaises(UnicodeDecodeError):
                partial.decode("utf-8")
        # Sanity: the new function's decoder accepts the same partial bytes
        # because they will be completed by the next chunk.
        decoder = codecs.getincrementaldecoder("utf-8")("strict")
        out = decoder.decode(b"\xe2", final=False)
        out += decoder.decode(b"\x9c\x8d", final=True)
        self.assertEqual(out, "\u270d")


if __name__ == "__main__":
    unittest.main()