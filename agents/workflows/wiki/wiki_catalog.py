#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
import re
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path, PurePosixPath
from typing import Any

_env_ws = os.environ.get("OPENCLAW_WORKSPACE", "").strip()
WORKSPACE = Path(_env_ws).resolve() if _env_ws else Path(__file__).resolve().parents[3]
WIKI_ROOT = WORKSPACE / "brain" / "wiki"
INDEX_PATH = WIKI_ROOT / "index.md"
LOG_PATH = WIKI_ROOT / "log.md"
LOCK_PATH = WIKI_ROOT / ".wiki_catalog.lock"


def configure_workspace(workspace: Path) -> None:
    global WORKSPACE, WIKI_ROOT, INDEX_PATH, LOG_PATH, LOCK_PATH
    WORKSPACE = Path(workspace).resolve()
    WIKI_ROOT = WORKSPACE / "brain" / "wiki"
    INDEX_PATH = WIKI_ROOT / "index.md"
    LOG_PATH = WIKI_ROOT / "log.md"
    LOCK_PATH = WIKI_ROOT / ".wiki_catalog.lock"

EXIT_OK = 0
EXIT_CONTRACT = 2
EXIT_MISSING_OR_UNINDEXED = 3
EXIT_LINT_BROKEN = 4

INDEX_HEADER = "# Brain Wiki Index\n\n| Kind | Source | Title | Summary | Updated |\n|---|---|---|---|---|\n"
LOG_HEADER = "# Brain Wiki Log\n"
TABLE_HEADER = "| Kind | Source | Title | Summary | Updated |"
TABLE_SEPARATOR = "|---|---|---|---|---|"
LOG_ACTIONS = {"ingest", "query", "lint"}
ALLOWED_KINDS = {"bookmark", "summary", "spec", "memory", "daily-memory"}
CONTROL_CHAR_RE = re.compile(r"[\x00-\x1f\x7f]")
MULTISPACE_RE = re.compile(r"\s+")


class CatalogError(RuntimeError):
    pass


class MissingIndexedSourceError(CatalogError):
    pass


@contextmanager
def wiki_lock() -> Any:
    WIKI_ROOT.mkdir(parents=True, exist_ok=True)
    fd = os.open(LOCK_PATH, os.O_CREAT | os.O_RDWR, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def json_out(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, indent=2, ensure_ascii=False))


def normalize_whitespace(text: str) -> str:
    return MULTISPACE_RE.sub(" ", str(text or "")).strip()


def bounded_heading_artifact(text: str, limit: int = 180) -> str:
    normalized = normalize_whitespace(text)
    if len(normalized) <= limit:
        return normalized
    return normalized[: limit - 1].rstrip() + "…"


def escape_cell(value: str) -> str:
    text = str(value or "")
    text = text.replace("\\", "\\\\")
    text = text.replace("|", "\\|")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = text.replace("\n", "\\n")
    return text


def unescape_cell(value: str) -> str:
    out: list[str] = []
    i = 0
    while i < len(value):
        char = value[i]
        if char == "\\" and i + 1 < len(value):
            nxt = value[i + 1]
            if nxt == "n":
                out.append("\n")
            else:
                out.append(nxt)
            i += 2
            continue
        out.append(char)
        i += 1
    return "".join(out)


def split_markdown_row(line: str) -> list[str]:
    stripped = line.strip()
    if not stripped.startswith("|") or not stripped.endswith("|"):
        raise CatalogError(f"invalid table row: {line!r}")
    inner = stripped[1:-1]
    cells: list[str] = []
    buf: list[str] = []
    escaped = False
    for char in inner:
        if escaped:
            buf.append("\\")
            buf.append(char)
            escaped = False
            continue
        if char == "\\":
            escaped = True
            continue
        if char == "|":
            cells.append("".join(buf).strip())
            buf = []
            continue
        buf.append(char)
    if escaped:
        buf.append("\\")
    cells.append("".join(buf).strip())
    return [unescape_cell(cell) for cell in cells]


def format_row(entry: dict[str, str]) -> str:
    return (
        f"| {escape_cell(entry['kind'])} | `{entry['source']}` | {escape_cell(entry['title'])} | "
        f"{escape_cell(entry['summary'])} | {escape_cell(entry['updated'])} |"
    )


def classify_source(source: str) -> str:
    if not isinstance(source, str):
        raise CatalogError("source must be a string")
    cleaned = source.strip()
    if not cleaned:
        raise CatalogError("source must not be empty")
    if CONTROL_CHAR_RE.search(cleaned):
        raise CatalogError("source contains control characters")
    if cleaned != source:
        raise CatalogError("source must not have surrounding whitespace")
    if cleaned.startswith("/") or cleaned.startswith("~") or "\\" in cleaned:
        raise CatalogError("source must be a workspace-relative POSIX path")

    path = PurePosixPath(cleaned)
    if ".." in path.parts or "." in path.parts:
        raise CatalogError("source must not contain path traversal")

    if cleaned == "MEMORY.md":
        return "memory"
    if re.fullmatch(r"memory/[^/]+\.md", cleaned):
        return "daily-memory"
    if cleaned.startswith("brain/bookmarks/summaries/") and cleaned.endswith(".md"):
        return "summary"
    if cleaned == "brain/spec.md":
        return "spec"
    if cleaned.startswith("brain/specs/") and cleaned.endswith(".md"):
        return "spec"
    if cleaned.startswith("brain/bookmarks/specs/") and cleaned.endswith(".md"):
        return "spec"
    if cleaned.startswith("brain/tasks/specs/") and cleaned.endswith(".md"):
        return "spec"
    if cleaned.startswith("brain/bookmarks/") and cleaned.endswith(".md"):
        return "bookmark"
    raise CatalogError("source is outside the wiki allowlist")


def validate_source_kind(source: str, expected_kind: str | None = None) -> str:
    kind = classify_source(source)
    if expected_kind and expected_kind != kind:
        raise CatalogError(f"source kind mismatch: expected {expected_kind!r}, got {kind!r}")
    return kind


def resolve_workspace_path(source: str) -> Path:
    validate_source_kind(source)
    return WORKSPACE / source


def ensure_source_exists(source: str) -> None:
    source_path = resolve_workspace_path(source)
    if not source_path.exists():
        raise CatalogError(f"source does not exist on disk: {source}")


def default_index_text() -> str:
    return INDEX_HEADER


def default_log_text() -> str:
    return LOG_HEADER


def parse_index_text(text: str) -> tuple[str, list[dict[str, str]], list[dict[str, str]]]:
    lines = text.splitlines()
    header_index = None
    for i, line in enumerate(lines):
        if line.strip() == TABLE_HEADER:
            header_index = i
            break
    if header_index is None:
        raise CatalogError("index is missing the canonical wiki table header")
    if header_index + 1 >= len(lines) or lines[header_index + 1].strip() != TABLE_SEPARATOR:
        raise CatalogError("index is missing the canonical wiki table separator")

    preamble = "\n".join(lines[:header_index]).rstrip() + "\n\n"
    rows: list[dict[str, str]] = []
    duplicates: list[dict[str, str]] = []
    seen_sources: set[str] = set()
    for line in lines[header_index + 2 :]:
        if not line.strip():
            continue
        cells = split_markdown_row(line)
        if len(cells) != 5:
            raise CatalogError(f"index row must have 5 cells, got {len(cells)}")
        kind, raw_source, title, summary, updated = cells
        source = raw_source
        if source.startswith("`") and source.endswith("`"):
            source = source[1:-1]
        validated_kind = validate_source_kind(source, kind)
        row = {
            "kind": validated_kind,
            "source": source,
            "title": title,
            "summary": summary,
            "updated": updated,
        }
        if source in seen_sources:
            duplicates.append(dict(row))
        else:
            rows.append(row)
            seen_sources.add(source)
    return preamble, rows, duplicates


def load_index_rows() -> tuple[str, dict[str, dict[str, str]], list[dict[str, str]]]:
    if not INDEX_PATH.exists():
        text = default_index_text()
    else:
        text = INDEX_PATH.read_text(encoding="utf-8")
    preamble, rows, duplicates = parse_index_text(text)
    by_source = {row["source"]: row for row in rows}
    return preamble, by_source, duplicates


def write_index(preamble: str, rows: dict[str, dict[str, str]]) -> None:
    INDEX_PATH.parent.mkdir(parents=True, exist_ok=True)
    ordered = sorted(rows.values(), key=lambda row: (row["kind"], row["source"]))
    text = preamble.rstrip() + "\n\n" + TABLE_HEADER + "\n" + TABLE_SEPARATOR + "\n"
    if ordered:
        text += "\n".join(format_row(row) for row in ordered) + "\n"
    fd, tmp_name = tempfile.mkstemp(prefix="index.", suffix=".tmp", dir=str(INDEX_PATH.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, INDEX_PATH)
    finally:
        if os.path.exists(tmp_name):
            os.unlink(tmp_name)


def ensure_log_exists() -> None:
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    if not LOG_PATH.exists():
        LOG_PATH.write_text(default_log_text(), encoding="utf-8")


def log_contains_event_key(event_key: str) -> bool:
    if not event_key or not LOG_PATH.exists():
        return False
    needle = f"- Event-Key: {event_key}"
    try:
        return needle in LOG_PATH.read_text(encoding="utf-8")
    except OSError:
        return False


def append_log_entry(action: str, artifact: str, details: list[str] | None = None, *, event_key: str | None = None, dedupe_on_event_key: bool = False) -> bool:
    if action not in LOG_ACTIONS:
        raise CatalogError(f"unsupported log action: {action}")
    artifact_text = bounded_heading_artifact(artifact)
    normalized_details = [normalize_whitespace(detail) for detail in (details or []) if normalize_whitespace(detail)]
    if event_key:
        normalized_details.append(f"Event-Key: {event_key}")
    with wiki_lock():
        ensure_log_exists()
        if dedupe_on_event_key and event_key and log_contains_event_key(event_key):
            return False
        with LOG_PATH.open("a", encoding="utf-8") as handle:
            handle.write(f"\n## [{now_iso()}] {action} | {artifact_text}\n")
            for detail in normalized_details:
                handle.write(f"- {detail}\n")
            handle.flush()
            os.fsync(handle.fileno())
    return True


def event_key_for_payload(prefix: str, payload: dict[str, str]) -> str:
    digest = hashlib.sha1(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()[:16]
    return f"{prefix}:{digest}"


def upsert_entry(kind: str, source: str, title: str, summary: str, *, event_key: str | None = None) -> dict[str, Any]:
    if kind not in ALLOWED_KINDS:
        raise CatalogError(f"unsupported kind: {kind}")
    validate_source_kind(source, kind)
    ensure_source_exists(source)
    title_text = normalize_whitespace(title)
    summary_text = normalize_whitespace(summary)
    if not title_text:
        raise CatalogError("title must not be empty")
    if not summary_text:
        raise CatalogError("summary must not be empty")

    with wiki_lock():
        preamble, rows, duplicates = load_index_rows()
        if duplicates:
            raise CatalogError("index contains duplicate sources; fix before mutating")
        existing = rows.get(source)
        result = "indexed"
        changed = False
        if existing is None:
            changed = True
            row = {
                "kind": kind,
                "source": source,
                "title": title_text,
                "summary": summary_text,
                "updated": now_iso(),
            }
            rows[source] = row
        else:
            if existing["kind"] != kind:
                raise CatalogError(f"existing row kind mismatch for {source}")
            if existing["title"] != title_text or existing["summary"] != summary_text:
                changed = True
                result = "updated"
                existing.update({
                    "title": title_text,
                    "summary": summary_text,
                    "updated": now_iso(),
                })
            else:
                result = "unchanged"
        if changed:
            write_index(preamble, rows)
        ensure_log_exists()
        if not (event_key and log_contains_event_key(event_key)):
            with LOG_PATH.open("a", encoding="utf-8") as handle:
                handle.write(f"\n## [{now_iso()}] ingest | {source}\n")
                handle.write(f"- Result: {result}\n")
                if event_key:
                    handle.write(f"- Event-Key: {event_key}\n")
                handle.flush()
                os.fsync(handle.fileno())
    return {
        "ok": True,
        "operation": "upsert",
        "source": source,
        "changed": changed,
        "result": result,
    }


def retarget_entry(old_source: str, new_source: str, *, event_key: str | None = None) -> dict[str, Any]:
    old_kind = validate_source_kind(old_source)
    new_kind = validate_source_kind(new_source)
    if old_kind != "spec" or new_kind != "spec":
        raise CatalogError("retarget is only supported for spec sources")
    if not old_source.startswith("brain/bookmarks/specs/"):
        raise CatalogError("retarget old_source must be a bookmark spec path")
    if not new_source.startswith("brain/tasks/specs/"):
        raise CatalogError("retarget new_source must be a task spec path")
    ensure_source_exists(new_source)

    with wiki_lock():
        preamble, rows, duplicates = load_index_rows()
        if duplicates:
            raise CatalogError("index contains duplicate sources; fix before mutating")
        old_row = rows.get(old_source)
        new_row = rows.get(new_source)
        changed = False
        result = "unchanged"

        if old_row is None and new_row is None:
            raise CatalogError(f"source is not indexed: {old_source}")
        if old_row is not None:
            moved_row = {
                "kind": "spec",
                "source": new_source,
                "title": (new_row or old_row)["title"],
                "summary": (new_row or old_row)["summary"],
                "updated": now_iso(),
            }
            rows.pop(old_source, None)
            rows[new_source] = moved_row
            changed = True
            result = "retargeted"
        elif new_row is not None:
            result = "unchanged"

        if changed:
            write_index(preamble, rows)
        ensure_log_exists()
        if not (event_key and log_contains_event_key(event_key)):
            with LOG_PATH.open("a", encoding="utf-8") as handle:
                handle.write(f"\n## [{now_iso()}] ingest | {new_source}\n")
                handle.write(f"- Result: {result}\n")
                handle.write(f"- Moved-From: {old_source}\n")
                if event_key:
                    handle.write(f"- Event-Key: {event_key}\n")
                handle.flush()
                os.fsync(handle.fileno())
    return {
        "ok": True,
        "operation": "retarget",
        "source": new_source,
        "changed": changed,
        "result": result,
        "movedFrom": old_source,
    }


def read_source(source: str) -> dict[str, Any]:
    validate_source_kind(source)
    with wiki_lock():
        _, rows, duplicates = load_index_rows()
        if duplicates:
            raise CatalogError("index contains duplicate sources; fix before reading")
        if source not in rows:
            raise MissingIndexedSourceError(f"source is not indexed: {source}")
        source_path = WORKSPACE / source
        if not source_path.exists():
            raise MissingIndexedSourceError(f"indexed source is missing on disk: {source}")
        content = source_path.read_text(encoding="utf-8")
    return {
        "ok": True,
        "operation": "read",
        "source": source,
        "content": content,
    }


def lint_index() -> tuple[dict[str, Any], int]:
    with wiki_lock():
        broken: list[dict[str, str]] = []
        checked = 0
        try:
            _, rows, duplicates = load_index_rows()
            for duplicate in duplicates:
                broken.append({"source": duplicate["source"], "reason": "duplicate row"})
            for source in sorted(rows):
                checked += 1
                row = rows[source]
                try:
                    validate_source_kind(source, row["kind"])
                except CatalogError as exc:
                    broken.append({"source": source, "reason": str(exc)})
                    continue
                if not (WORKSPACE / source).exists():
                    broken.append({"source": source, "reason": "missing on disk"})
            ensure_log_exists()
            with LOG_PATH.open("a", encoding="utf-8") as handle:
                handle.write(f"\n## [{now_iso()}] lint | brain/wiki/index.md\n")
                handle.write(f"- Checked: {checked}\n")
                handle.write(f"- Broken: {len(broken)}\n")
                for entry in broken:
                    handle.write(f"- Broken-Path: {entry['source']} ({entry['reason']})\n")
                handle.flush()
                os.fsync(handle.fileno())
        except CatalogError as exc:
            ensure_log_exists()
            with LOG_PATH.open("a", encoding="utf-8") as handle:
                handle.write(f"\n## [{now_iso()}] lint | brain/wiki/index.md\n")
                handle.write("- Result: parser-error\n")
                handle.write(f"- Error: {normalize_whitespace(str(exc))}\n")
                handle.flush()
                os.fsync(handle.fileno())
            return {
                "ok": False,
                "checked": checked,
                "broken": broken,
                "error": str(exc),
            }, EXIT_CONTRACT

    payload = {"ok": True, "checked": checked, "broken": broken}
    return payload, EXIT_LINT_BROKEN if broken else EXIT_OK


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Maintain the markdown-first brain wiki catalog")
    sub = parser.add_subparsers(dest="command", required=True)

    upsert = sub.add_parser("upsert")
    upsert.add_argument("--kind", required=True, choices=sorted(ALLOWED_KINDS))
    upsert.add_argument("--source", required=True)
    upsert.add_argument("--title", required=True)
    upsert.add_argument("--summary", required=True)
    upsert.add_argument("--event-key")
    upsert.add_argument("--json", action="store_true")

    retarget = sub.add_parser("retarget")
    retarget.add_argument("--old-source", required=True)
    retarget.add_argument("--new-source", required=True)
    retarget.add_argument("--event-key")
    retarget.add_argument("--json", action="store_true")

    log = sub.add_parser("log")
    log.add_argument("--action", required=True, choices=sorted(LOG_ACTIONS))
    log.add_argument("--artifact", required=True)
    log.add_argument("--detail", action="append", default=[])
    log.add_argument("--event-key")
    log.add_argument("--dedupe-on-event-key", action="store_true")
    log.add_argument("--json", action="store_true")

    lint = sub.add_parser("lint")
    lint.add_argument("--json", action="store_true")

    read_cmd = sub.add_parser("read-source")
    read_cmd.add_argument("--source", required=True)
    read_cmd.add_argument("--json", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "upsert":
            payload = upsert_entry(args.kind, args.source, args.title, args.summary, event_key=args.event_key)
            if args.json:
                json_out(payload)
            else:
                print(f"{payload['result']}: {args.source}")
            return EXIT_OK

        if args.command == "retarget":
            payload = retarget_entry(args.old_source, args.new_source, event_key=args.event_key)
            if args.json:
                json_out(payload)
            else:
                print(f"{payload['result']}: {args.old_source} -> {args.new_source}")
            return EXIT_OK

        if args.command == "log":
            changed = append_log_entry(
                args.action,
                args.artifact,
                args.detail,
                event_key=args.event_key,
                dedupe_on_event_key=args.dedupe_on_event_key,
            )
            payload = {
                "ok": True,
                "operation": "log",
                "source": args.artifact,
                "changed": changed,
            }
            if args.json:
                json_out(payload)
            else:
                print(f"logged: {args.action}")
            return EXIT_OK

        if args.command == "lint":
            payload, code = lint_index()
            if args.json:
                json_out(payload)
            else:
                print(json.dumps(payload, ensure_ascii=False))
            return code

        if args.command == "read-source":
            payload = read_source(args.source)
            if args.json:
                json_out(payload)
            else:
                print(payload["content"])
            return EXIT_OK

        raise CatalogError(f"unsupported command: {args.command}")
    except MissingIndexedSourceError as exc:
        payload = {
            "ok": False,
            "error": str(exc),
            "source": getattr(args, "source", None),
        }
        if getattr(args, "json", False):
            json_out(payload)
        else:
            print(payload["error"], file=sys.stderr)
        return EXIT_MISSING_OR_UNINDEXED
    except CatalogError as exc:
        payload = {
            "ok": False,
            "error": str(exc),
        }
        if getattr(args, "json", False):
            json_out(payload)
        else:
            print(payload["error"], file=sys.stderr)
        return EXIT_CONTRACT


if __name__ == "__main__":
    raise SystemExit(main())
