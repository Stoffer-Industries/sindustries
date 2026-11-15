/**
 * Deterministic proof that the tasks-api fatal diagnostic is written
 * **synchronously** (task 20195ce7).
 *
 * Rowan's review flagged that `console.error(...)` followed by
 * `process.exit(1)` can truncate the `schema_preflight_failed` payload,
 * because Node writes to a pipe asynchronously on macOS while Tilt and Fly
 * both pipe tasks-api's stderr.
 *
 * The truncation is not reliably reproducible end-to-end: a ~2.5 KB
 * payload fits in the pipe buffer, and libuv's "try the write inline"
 * path completes it before `process.exit()` — so a spawn-based test can
 * pass even with the buggy `console.error` implementation. This file
 * closes that gap at the level where the property actually lives:
 *
 *   after `writeFatalToStderr(...)` returns, the bytes are already on the
 *   file descriptor — no flush, no await, no event-loop turn.
 *
 * With a `console.error` implementation the equivalent assertion would
 * fail, because the write is queued rather than completed.
 */
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { STDERR_FD, writeFatalToStderr } from '../src/lib/fatalStderr.ts';

function withTempFile<T>(run: (filePath: string, fd: number) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), 'tasks-api-fatal-stderr-'));
  const filePath = path.join(dir, 'stderr.txt');
  const fd = openSync(filePath, 'w');
  try {
    return run(filePath, fd);
  } finally {
    closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('writeFatalToStderr', () => {
  it('has the bytes on the descriptor the moment the call returns', () => {
    withTempFile((filePath, fd) => {
      const payload = '{"event":"schema_preflight_failed","message":"boom"}\n';

      writeFatalToStderr(payload, fd);

      // Read back immediately — no flush, no await, no event-loop turn.
      // An asynchronous write (`console.error`) would not be readable yet.
      expect(readFileSync(filePath, 'utf8')).toBe(payload);
    });
  });

  it('writes multi-kilobyte payloads in full', () => {
    withTempFile((filePath, fd) => {
      const payload = `${'x'.repeat(200_000)}\n`;

      writeFatalToStderr(payload, fd);

      expect(readFileSync(filePath, 'utf8')).toBe(payload);
    });
  });

  it('appends to the descriptor without truncating earlier content', () => {
    withTempFile((filePath, fd) => {
      writeSync(fd, 'earlier\n');
      writeFatalToStderr('later\n', fd);

      expect(readFileSync(filePath, 'utf8')).toBe('earlier\nlater\n');
    });
  });

  it('defaults to the standard error descriptor', () => {
    expect(STDERR_FD).toBe(2);
  });
});
