/**
 * Synchronous fatal-error output for tasks-api (task 20195ce7).
 *
 * Why this is not `console.error`
 * -------------------------------
 * Node writes `process.stdout`/`process.stderr` **asynchronously when the
 * destination is a pipe** on macOS (synchronously on Linux; files and
 * TTYs are synchronous on POSIX). Tilt and Fly both run tasks-api with
 * stdout/stderr piped, so `console.error(payload)` immediately followed by
 * `process.exit(1)` can cut the payload off mid-write — leaving the
 * operator with a bare exit code and no column names. That is precisely
 * the failure mode the AC2 startup preflight exists to eliminate,
 * reproduced one layer down.
 *
 * `fs.writeSync(fd, ...)` goes straight to the file descriptor and blocks
 * until the bytes have been handed to the destination, so the payload is
 * complete before the process exits. The exit code is the caller's
 * business — this module only guarantees the bytes are out.
 *
 * The file descriptor is a parameter so the property can be proven in a
 * test against a regular file (see `test/fatalStderr.test.ts`): with a
 * file, the bytes are readable the instant the call returns, with no
 * flush and no await.
 */
import fs from 'node:fs';

/** The standard error file descriptor. */
export const STDERR_FD = 2;

/**
 * Block the current thread for `ms` milliseconds.
 *
 * Used only to back off between retries of a non-blocking write; it
 * avoids a hot spin without pulling in a timer dependency.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Write `payload` to `fd` **synchronously**, in full.
 *
 * @throws Whatever `fs.writeSync` throws for a non-retryable error.
 */
export function writeFatalToStderr(payload: string, fd: number = STDERR_FD): void {
  const buffer = Buffer.from(payload, 'utf8');
  let written = 0;
  while (written < buffer.length) {
    try {
      written += fs.writeSync(fd, buffer, written, buffer.length - written);
    } catch (error) {
      // A non-blocking destination can report EAGAIN; back off briefly and
      // retry rather than drop the diagnostic.
      if ((error as NodeJS.ErrnoException).code === 'EAGAIN') {
        sleepSync(1);
        continue;
      }
      throw error;
    }
  }
}
